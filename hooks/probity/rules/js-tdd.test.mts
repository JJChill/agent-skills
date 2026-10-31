import assert from 'node:assert/strict'
import test from 'node:test'

import type { Rule, RuleContext } from '@nizos/probity'

import { jsRuleEntries } from '../presets/js.ts'
import { enforceJsTdd, JS_TDD_ADDENDUM } from './js-tdd.ts'

// A production write: it always reaches the judge (a one-new-test write
// to a test file is passed by the fast path without it).
const testWrite = {
  kind: 'write' as const,
  path: '/repo/src/domain/account.ts',
  content: 'export const canName = () => false\n',
}

function presetTddRule(): Rule {
  const entry = jsRuleEntries().find((candidate) =>
    candidate.rules?.some((rule) => rule.name === 'enforceTdd'),
  )
  const rule = entry?.rules?.find((candidate) => candidate.name === 'enforceTdd')
  assert.ok(rule, 'JS preset should wire a TDD rule named enforceTdd')
  return rule
}

async function capturedPrompt(rule: Rule): Promise<string> {
  let prompt = ''
  const ctx: RuleContext = {
    readFile: async () => ({ kind: 'present', content: "describe('invite', () => {})" }),
    rawHistory: async () => [],
    agent: {
      reason: async (value) => {
        prompt = value
        return { kind: 'pass', reason: '' }
      },
    },
  }
  await rule(testWrite, ctx)
  return prompt
}

const sources = [
  ['jsRuleEntries', presetTddRule],
  ['enforceJsTdd standalone', enforceJsTdd],
] as const

test('JS TDD judge lets a new red test in without a prior run of it (#73)', async () => {
  for (const [source, make] of sources) {
    const prompt = await capturedPrompt(make())
    assert.match(prompt, /Adding a failing test is the red step itself/, source)
    assert.match(prompt, /passes without any prior run of that test/, source)
    assert.match(prompt, /applies only to the production write that follows it/, source)
    assert.match(prompt, /only green->red question is whether the prior green left an unmistakable refactor unmade/, source)
    assert.match(prompt, /never a reason to block it/, source)
  }
})

test('JS TDD judge still requires an observed failing run before production code', async () => {
  for (const [source, make] of sources) {
    const prompt = await capturedPrompt(make())
    assert.match(prompt, /more than one new test is a violation/, source)
    assert.match(prompt, /A test written in the session with no run after it has not been observed failing/, source)
  }
})

test('JS TDD addendum extends the default rules rather than replacing them', async () => {
  const prompt = await capturedPrompt(enforceJsTdd())
  assert.match(prompt, /### Red phase: write a failing test first/)
  assert.match(prompt, /#### Enforcing the refactor phase/)
  assert.ok(
    prompt.indexOf('#### Enforcing the refactor phase') < prompt.indexOf('## Adding a red test'),
    'addendum comes after the defaults',
  )
})

// Issue #166: vitest doesn't type-check, so a green step can leave
// `tsc --noEmit` failing; the judge refused every type-only fix as "not
// driven by a failing test" and left no path.
test('the JS TDD addendum allows a type-only fix for a type-check failure', () => {
  assert.match(JS_TDD_ADDENDUM, /type-check failure/)
  assert.match(JS_TDD_ADDENDUM, /changes only types/)
  assert.match(JS_TDD_ADDENDUM, /at least as strong/)
  assert.match(JS_TDD_ADDENDUM, /runtime behavior/)
})

// ── Deterministic paths (#169, #170, #171) ─────────────────────────
// A Sonnet judge miscounted single-test writes and refused a lone
// import; these writes no longer reach the judge.

function judgeCountingCtx(before: string) {
  let calls = 0
  const ctx: RuleContext = {
    readFile: async () => ({ kind: 'present', content: before }),
    rawHistory: async () => [],
    agent: {
      reason: async () => {
        calls++
        return { kind: 'violation', reason: 'judge denies' }
      },
    },
  }
  return { ctx, calls: () => calls }
}

const SUITE = [
  "import { describe, expect, it } from 'vitest'",
  '',
  "describe('matching', () => {",
  "  it('matches a whole parcel', () => { expect(1).toBe(1) })",
  "  it('matches part of a parcel', () => { expect(2).toBe(2) })",
  '})',
  '',
].join('\n')
const testPath = '/repo/src/core/matching.test.ts'

test('one new test in a test file passes without the judge, against the file on disk', async () => {
  // The two existing tests may be uncommitted (#170): the baseline is the file on disk.
  const { ctx, calls } = judgeCountingCtx(SUITE)
  const after = SUITE.replace('\n})\n', "\n  it('spills into a second parcel', () => { expect(3).toBe(3) })\n})\n")
  const result = await presetTddRule()({ kind: 'write', path: testPath, content: after }, ctx)
  assert.equal(result.kind, 'pass')
  assert.equal(calls(), 0)
})

test('two new tests still go to the judge', async () => {
  const { ctx, calls } = judgeCountingCtx(SUITE)
  const after = SUITE.replace('\n})\n', "\n  it('c', () => {})\n  it('d', () => {})\n})\n")
  const result = await presetTddRule()({ kind: 'write', path: testPath, content: after }, ctx)
  assert.equal(result.kind, 'violation')
  assert.ok(calls() >= 1)
})

const ENGINE = ["import { parcels } from './parcels'", '', 'export function match() {', '  return parcels()', '}', ''].join('\n')
const enginePath = '/repo/src/core/engine.ts'

for (const [label, after] of [
  ['one static import', ENGINE.replace("from './parcels'\n", "from './parcels'\nimport { Special } from './special'\n")],
  ['a type import', `import type { Gap } from './gaps'\n${ENGINE}`],
  ['a multi-line import', `import {\n  a,\n  b,\n} from './ab'\n${ENGINE}`],
] as const) {
  test(`a write adding only ${label} passes without the judge (#171)`, async () => {
    const { ctx, calls } = judgeCountingCtx(ENGINE)
    const result = await presetTddRule()({ kind: 'write', path: enginePath, content: after }, ctx)
    assert.equal(result.kind, 'pass')
    assert.equal(calls(), 0)
  })
}

for (const [label, after] of [
  ['a side-effect import', `import './polyfill'\n${ENGINE}`],
  ['an import and code', ENGINE.replace('return parcels()', "return parcels().concat(special)").replace("from './parcels'\n", "from './parcels'\nimport { special } from './special'\n")],
] as const) {
  test(`a write adding ${label} goes to the judge`, async () => {
    const { ctx, calls } = judgeCountingCtx(ENGINE)
    await presetTddRule()({ kind: 'write', path: enginePath, content: after }, ctx)
    assert.ok(calls() >= 1)
  })
}

test('an import in a new file goes to the judge', async () => {
  let calls = 0
  const ctx: RuleContext = {
    readFile: async () => ({ kind: 'absent' }),
    rawHistory: async () => [],
    agent: { reason: async () => (calls++, { kind: 'violation', reason: 'no red' }) },
  }
  await presetTddRule()({ kind: 'write', path: '/repo/src/core/new.ts', content: "import { a } from './a'\n" }, ctx)
  assert.equal(calls, 1)
})
