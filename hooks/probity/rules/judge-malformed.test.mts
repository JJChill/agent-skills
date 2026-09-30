import assert from 'node:assert/strict'
import test from 'node:test'

import type { Rule, RuleResult } from '@nizos/probity'
import { toVerdict } from '../node_modules/@nizos/probity/dist/vendors/to-verdict.js'

import { withJudgeFailureDiagnostics } from './gates.ts'

// Issue #52: the judge answered with a verdict that was not valid JSON.
// Probity reported "could not parse verdict", and the wrapper called it
// an outage that a retry would not fix. These run the judge's text
// through Probity's real parser, so they break if the parser changes.

const write = {
  kind: 'write' as const,
  path: '/repo/src/Thing.kt',
  content: 'val thing = 1',
}

const LONG_REASON =
  'The green write implements unfinished() but omits the LIST_PROVISIONAL ' +
  'constant it references, and more importantly over-implements beyond the ' +
  'failing test. The test only asserts the happy path filtering PROVISIONING ' +
  'vs COMPLETED/FAILED. That is fine, but the added "type" filter and the ' +
  'second sort branch are asserted by nothing in the observed failing test, ' +
  'so they are over-implementation.'

const MALFORMED = {
  unescapedQuote: `{"kind":"violation","reason":"${LONG_REASON}"}`,
  rawNewline: '{"kind":"violation","reason":"over-implements.\nThe sort branch is unasserted."}',
  cutOff: `{"kind":"violation","reason":"${LONG_REASON.slice(0, 120)}`,
  malformedPass: '{"kind":"pass","reason":"only one "new" test"}',
  prose: 'I think this write is fine.',
}

async function judged(text: string): Promise<RuleResult> {
  return toVerdict(async () => ({ text }))
}

function sequence(...results: RuleResult[]): { rule: Rule; calls: () => number } {
  let calls = 0
  const rule: Rule = async function enforceTdd() {
    return results[Math.min(calls++, results.length - 1)]!
  }
  return { rule, calls: () => calls }
}

test('the reproduced shapes are rejected by the installed parser', async () => {
  for (const text of [MALFORMED.unescapedQuote, MALFORMED.rawNewline, MALFORMED.cutOff]) {
    assert.match((await judged(text)).reason ?? '', /^could not parse verdict/)
  }
})

test('a malformed answer is judged once more, and a clean pass stands', async () => {
  const { rule, calls } = sequence(await judged(MALFORMED.unescapedQuote), { kind: 'pass' })
  const result = await withJudgeFailureDiagnostics(rule)(write)
  assert.equal(result.kind, 'pass')
  assert.equal(calls(), 2)
})

test('a malformed answer is judged once more, and a clean deny stands as written', async () => {
  const { rule, calls } = sequence(
    await judged(MALFORMED.rawNewline),
    { kind: 'violation', reason: 'Adds two tests in one write.' },
  )
  const result = await withJudgeFailureDiagnostics(rule)(write)
  assert.deepEqual(result, { kind: 'violation', reason: 'Adds two tests in one write.' })
  assert.equal(calls(), 2)
})

for (const shape of ['unescapedQuote', 'rawNewline', 'cutOff'] as const) {
  test(`a malformed deny twice is a policy block with its reason (${shape})`, async () => {
    const malformed = await judged(MALFORMED[shape])
    const { rule, calls } = sequence(malformed, malformed)
    const result = await withJudgeFailureDiagnostics(rule)(write)
    const reason = result.reason ?? ''
    assert.equal(result.kind, 'violation')
    assert.equal(calls(), 2)
    assert.match(reason, /AI judge \(enforceTdd\) denied this write/)
    assert.doesNotMatch(reason, /NOT judged|infrastructure|will not help/)
    const quoted = shape === 'cutOff' ? LONG_REASON.slice(0, 120) : shape === 'rawNewline'
      ? 'The sort branch is unasserted.'
      : 'so they are over-implementation.'
    assert.ok(reason.includes(quoted), `reason is quoted in full: ${reason}`)
  })
}

test('a malformed pass twice stays blocked and says a retry may help', async () => {
  const malformed = await judged(MALFORMED.malformedPass)
  const { rule, calls } = sequence(malformed, malformed)
  const result = await withJudgeFailureDiagnostics(rule)(write)
  const reason = result.reason ?? ''
  assert.equal(result.kind, 'violation')
  assert.equal(calls(), 2)
  assert.match(reason, /not in the expected format/)
  assert.match(reason, /retrying the same write may/i)
  assert.doesNotMatch(reason, /will not help/)
})

test('a malformed answer twice quotes the judge output in full, not a 300-character excerpt', async () => {
  const long = `{"kind":"pass","reason":"${'x'.repeat(400)} "quoted" tail-marker"}`
  const malformed = await judged(long)
  const { rule } = sequence(malformed, malformed)
  const reason = (await withJudgeFailureDiagnostics(rule)(write)).reason ?? ''
  assert.ok(reason.includes('tail-marker'), 'judge output is cut off')
})

test('prose instead of a verdict twice stays blocked and says a retry may help', async () => {
  const malformed = await judged(MALFORMED.prose)
  const { rule, calls } = sequence(malformed, malformed)
  const reason = (await withJudgeFailureDiagnostics(rule)(write)).reason ?? ''
  assert.equal(calls(), 2)
  assert.match(reason, /retrying the same write may/i)
})

test('a provider outage is not retried and still says a retry will not help', async () => {
  const { rule, calls } = sequence({
    kind: 'violation',
    reason:
      "could not parse verdict from validator output: You've hit your org's monthly spend limit",
  })
  const reason = (await withJudgeFailureDiagnostics(rule)(write)).reason ?? ''
  assert.equal(calls(), 1)
  assert.match(reason, /will not help until the judge is back/)
})

test('a missing AI agent is a configuration error and is not retried', async () => {
  const { rule, calls } = sequence({
    kind: 'violation',
    reason: 'enforceTdd: no AI agent available; configure Config.ai or use a vendor that ships one.',
  })
  await withJudgeFailureDiagnostics(rule)(write)
  assert.equal(calls(), 1)
})

test('a transport failure is judged once more', async () => {
  const { rule, calls } = sequence(
    { kind: 'violation', reason: 'no result message received: SDK query stream ended' },
    { kind: 'pass' },
  )
  assert.equal((await withJudgeFailureDiagnostics(rule)(write)).kind, 'pass')
  assert.equal(calls(), 2)
})
