import assert from 'node:assert/strict'
import test from 'node:test'

import type { Rule, RuleContext, RuleEntry } from '@nizos/probity'

import { jsRuleEntries } from '../presets/js.ts'
import { kmpRuleEntries } from '../presets/kmp.ts'
import { kotlinRuleEntries } from '../presets/kotlin.ts'
import { swiftRuleEntries } from '../presets/swift.ts'
import { withJudgeFailureDiagnostics } from './gates.ts'

const SPEND_LIMIT =
  "could not parse verdict from validator output: You've hit your org's " +
  'monthly spend limit · run /usage-credits to ask your admin for a higher limit'

const write = {
  kind: 'write' as const,
  path: '/repo/src/Thing.ts',
  content: 'export const thing = 1',
}

function fixed(result: Awaited<ReturnType<Rule>>): Rule {
  return async function enforceTdd() {
    return result
  }
}

test('spend-limit output reads as an infrastructure failure, still blocked', async () => {
  const result = await withJudgeFailureDiagnostics(
    fixed({ kind: 'violation', reason: SPEND_LIMIT }),
    { deterministicPaths: 'Single-test writes still go through.' },
  )(write)
  assert.equal(result.kind, 'violation')
  assert.match(result.reason ?? '', /AI judge \(enforceTdd\) returned no verdict/)
  assert.match(result.reason ?? '', /NOT judged/)
  assert.match(result.reason ?? '', /not a policy decision/)
  assert.match(result.reason ?? '', /spend limit, quota, rate limit, or authentication/)
  assert.match(result.reason ?? '', /Single-test writes still go through\./)
  assert.match(result.reason ?? '', /Judge output: You've hit your org's monthly spend limit/)
  assert.doesNotMatch(result.reason ?? '', /could not parse verdict/)
})

test('other unparsable output gets the generic provider check', async () => {
  const result = await withJudgeFailureDiagnostics(
    fixed({
      kind: 'violation',
      reason: 'could not parse verdict from validator output: I think this is fine',
    }),
  )(write)
  assert.match(result.reason ?? '', /Check the judge provider/)
  assert.doesNotMatch(result.reason ?? '', /usage-credits/)
})

test('shape errors keep where the shape broke', async () => {
  const result = await withJudgeFailureDiagnostics(
    fixed({ kind: 'violation', reason: 'validator returned unexpected shape at kind: Invalid enum value' }),
  )(write)
  assert.match(result.reason ?? '', /Judge output: at kind: Invalid enum value/)
})

test('genuine verdicts and passes pass through unchanged', async () => {
  const genuine = { kind: 'violation' as const, reason: 'Adds two tests in one write.' }
  assert.deepEqual(await withJudgeFailureDiagnostics(fixed(genuine))(write), genuine)
  const pass = { kind: 'pass' as const, reason: '' }
  assert.deepEqual(await withJudgeFailureDiagnostics(fixed(pass))(write), pass)
})

test('the wrapper keeps the wrapped rule name', () => {
  assert.equal(withJudgeFailureDiagnostics(fixed({ kind: 'pass' })).name, 'enforceTdd')
})

const presets: [string, RuleEntry[], string][] = [
  ['KMP', kmpRuleEntries('/repo'), '/repo/sdk/core/src/commonMain/kotlin/FileStore.kt'],
  ['classic Kotlin', kotlinRuleEntries('/repo'), '/repo/app/src/main/kotlin/FileStore.kt'],
  ['JS', jsRuleEntries(), '/repo/src/domain/FileStore.ts'],
  ['Swift', swiftRuleEntries('/repo'), '/repo/App/Sources/FileStore.swift'],
]

for (const [preset, entries, path] of presets) {
  test(`${preset} preset reports a judge spend limit as infrastructure`, async () => {
    const entry = entries.find(
      (candidate) =>
        typeof candidate !== 'function' &&
        candidate.rules.some((rule) => rule.name.includes('enforceTdd')),
    )
    assert.ok(entry && typeof entry !== 'function', `${preset} exposes a TDD block`)
    const rule = entry.rules.find((candidate) => candidate.name.includes('enforceTdd'))!
    const ctx: RuleContext = {
      readFile: async () => ({ kind: 'present', content: 'class FileStore' }),
      rawHistory: async () => [],
      history: async () => [],
      agent: { reason: async () => ({ kind: 'violation', reason: SPEND_LIMIT }) },
    }
    const result = await rule({ kind: 'write', path, content: 'class FileStore { }' }, ctx)
    assert.equal(result.kind, 'violation', preset)
    assert.match(result.reason ?? '', /NOT judged/, preset)
    assert.match(result.reason ?? '', /usage-credits/, preset)
  })
}
