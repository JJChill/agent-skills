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

// ── Review of #169–#171: writes that must still reach the judge ─────
// Each changes behavior or weakens the suite, so skipping the judge
// would let a TDD violation through.

const withOne = (suite: string, extra = '') =>
  suite.replace('\n})\n', `\n  it('spills into a second parcel', () => { expect(3).toBe(3) })\n${extra}})\n`)

for (const [label, path, before, after] of [
  ['one new test plus a weakened assertion', testPath, SUITE, withOne(SUITE).replace('toBe(2)', 'toBeDefined()')],
  ['one new test plus .only on an existing test', testPath, SUITE, withOne(SUITE).replace("it('matches a whole", "it.only('matches a whole")],
  ['one new test plus .skip on an existing test', testPath, SUITE, withOne(SUITE).replace("it('matches part", "it.skip('matches part")],
  ['two tests added and one deleted', testPath, SUITE, SUITE.replace("  it('matches part of a parcel', () => { expect(2).toBe(2) })\n", "  it('c', () => {})\n  it('d', () => {})\n")],
  ['one new test plus production code in the test file', testPath, SUITE, withOne(SUITE) + 'export function compute() { return 1 }\n'],
  ['one new test and a helper in one insertion', testPath, SUITE, withOne(SUITE, '  const helper = () => 1\n')],
  ['a skipped new test', testPath, SUITE, SUITE.replace('\n})\n', "\n  it.skip('c', () => {})\n})\n")],
  ['a new xit', testPath, SUITE, SUITE.replace('\n})\n', "\n  xit('c', () => {})\n})\n")],
  ['a new test that skips itself at runtime', testPath, SUITE, SUITE.replace('\n})\n', "\n  it('c', (ctx) => { ctx.skip() })\n})\n")],
  ['a new describe holding one test', testPath, SUITE, SUITE + "describe('more', () => {\n  it('c', () => {})\n})\n"],
  ['one new test plus an import', testPath, SUITE, `import { x } from './x'\n${withOne(SUITE)}`],
  ['an in-source test in a production file', enginePath, ENGINE, ENGINE + "if (import.meta.vitest) { const { it } = import.meta.vitest; it('x', () => {}) }\n"],
] as const) {
  test(`${label} goes to the judge`, async () => {
    const { ctx, calls } = judgeCountingCtx(before)
    await presetTddRule()({ kind: 'write', path, content: after }, ctx)
    assert.ok(calls() >= 1, 'judge was asked')
  })
}

test('one new test between two existing ones skips the judge', async () => {
  const { ctx, calls } = judgeCountingCtx(SUITE)
  const after = SUITE.replace("  it('matches part", "  it('spills', () => { expect(3).toBe(3) })\n  it('matches part")
  assert.equal((await presetTddRule()({ kind: 'write', path: testPath, content: after }, ctx)).kind, 'pass')
  assert.equal(calls(), 0)
})

test('a multi-line new test with nested calls skips the judge', async () => {
  const { ctx, calls } = judgeCountingCtx(SUITE)
  const after = SUITE.replace('\n})\n', "\n  it('spills (into) a second parcel', () => {\n    const r = match([1, 2], { take: 3 })\n    expect(r).toEqual([1, 2])\n  })\n})\n")
  assert.equal((await presetTddRule()({ kind: 'write', path: testPath, content: after }, ctx)).kind, 'pass')
  assert.equal(calls(), 0)
})

for (const [label, after] of [
  ['a changed import source', ENGINE.replace("'./parcels'", "'./other-parcels'")],
  ['an aliased import', ENGINE.replace('{ parcels }', '{ fakeParcels as parcels }')],
  ['a named import made default', ENGINE.replace('{ parcels }', 'parcels')],
  ['a removed import', ENGINE.replace("import { parcels } from './parcels'\n", '')],
  ['an added import the code already names', `import { parcels as other, match } from './m'\n${ENGINE}`],
  ['an import-shaped line in a template literal', ENGINE.replace('  return parcels()', "  return parcels(`\nimport { a } from 'b'\n`)").replace('`\nimport', '`\nimport')],
  ['an import that joins two statements', ENGINE.replace('export function match() {\n  return parcels()', "export function match() {\n  const f = parcels\nimport { q } from './q'\n  (1)\n  return f()")],
] as const) {
  test(`${label} goes to the judge`, async () => {
    const { ctx, calls } = judgeCountingCtx(ENGINE)
    await presetTddRule()({ kind: 'write', path: enginePath, content: after }, ctx)
    assert.ok(calls() >= 1, 'judge was asked')
  })
}

test('an added import in a CRLF file skips the judge', async () => {
  const crlf = ENGINE.replace(/\n/g, '\r\n')
  const { ctx, calls } = judgeCountingCtx(crlf)
  const after = crlf.replace("from './parcels'\r\n", "from './parcels'\r\nimport { Special } from './special'\r\n")
  assert.equal((await presetTddRule()({ kind: 'write', path: enginePath, content: after }, ctx)).kind, 'pass')
  assert.equal(calls(), 0)
})

// ── Second review: text scanning could be fooled ───────────────────
// A quote in a regex literal or a template literal hid a second,
// focused test from the old scanner; the fast paths now parse.

for (const [label, block] of [
  ['a regex quote hiding it.only', "  it('a', () => { /'/; }); it.only('evil', () => {\n  })"],
  ['a regex backtick hiding describe.skip', "  it('a', () => { /`/ }) }); describe.skip('rest', () => {\n  // `})"],
  ['a template literal hiding it.only', "  it('a', () => { `${\"`\"}`; }); it.only('evil', () => {\n  })"],
  ['an extra argument run at registration', "  it('a', () => {}, (vi.useFakeTimers(), 5000))"],
  ['a test replacing expect', "  it('a', () => { globalThis.expect = () => ({ toBe() {} }) })"],
  ['a test reassigning a module binding', "  it('a', () => { expect = undefined })"],
  ['a test stubbing a global through vi', "  it('a', () => { vi.stubGlobal('fetch', () => 1) })"],
] as const) {
  test(`${label} goes to the judge`, async () => {
    const { ctx, calls } = judgeCountingCtx(SUITE)
    await presetTddRule()({ kind: 'write', path: testPath, content: SUITE.replace('\n})\n', `\n${block}\n})\n`) }, ctx)
    assert.ok(calls() >= 1, 'judge was asked')
  })
}

test('lines inserted inside an existing template literal go to the judge', async () => {
  const snapshot = SUITE.replace('\n})\n', "\n  it('renders', () => { expect(render()).toBe(`\n<p/>\n`) })\n})\n")
  const { ctx, calls } = judgeCountingCtx(snapshot)
  const after = snapshot.replace('`\n<p/>\n`', "`\n<p/>\n  it('x', () => {})\n`")
  await presetTddRule()({ kind: 'write', path: testPath, content: after }, ctx)
  assert.ok(calls() >= 1, 'judge was asked')
})

test('a test using its own locals and vi.fn skips the judge', async () => {
  const { ctx, calls } = judgeCountingCtx(SUITE)
  const block = "  it('counts calls', () => {\n    const spy = vi.fn()\n    let n = 0\n    n += 1\n    spy(n)\n    expect(spy).toHaveBeenCalledWith(1)\n  })"
  assert.equal((await presetTddRule()({ kind: 'write', path: testPath, content: SUITE.replace('\n})\n', `\n${block}\n})\n`) }, ctx)).kind, 'pass')
  assert.equal(calls(), 0)
})

const DIRECTIVE = `'use client'\n${ENGINE}`

for (const [label, before, after] of [
  ['an import whose name the code uses inside a template', "export const label = (d: number) => `Due ${fetch(String(d))}`\n", "import { fetch } from './fake'\nexport const label = (d: number) => `Due ${fetch(String(d))}`\n"],
  ['an import above a directive', DIRECTIVE, `import { clamp } from './clamp'\n${DIRECTIVE}`],
  ['an import with no bindings', ENGINE, `import {} from './polyfill'\n${ENGINE}`],
] as const) {
  test(`${label} goes to the judge`, async () => {
    const { ctx, calls } = judgeCountingCtx(before)
    await presetTddRule()({ kind: 'write', path: enginePath, content: after }, ctx)
    assert.ok(calls() >= 1, 'judge was asked')
  })
}

test('an import added after a directive skips the judge', async () => {
  const { ctx, calls } = judgeCountingCtx(DIRECTIVE)
  const after = DIRECTIVE.replace("from './parcels'\n", "from './parcels'\nimport { clamp } from './clamp'\n")
  assert.equal((await presetTddRule()({ kind: 'write', path: enginePath, content: after }, ctx)).kind, 'pass')
  assert.equal(calls(), 0)
})
