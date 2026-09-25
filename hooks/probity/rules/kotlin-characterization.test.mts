import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Rule, RuleContext, RuleEntry, SessionEvent } from '@nizos/probity'

import { kmpRuleEntries } from '../presets/kmp.ts'
import { kotlinRuleEntries } from '../presets/kotlin.ts'

const presets = [
  [
    'KMP',
    kmpRuleEntries,
    '/repo/sdk/core/src/commonTest/kotlin/PathIdTest.kt',
    '/repo/sdk/core/src/commonMain/kotlin/PathId.kt',
  ],
  [
    'classic Kotlin',
    kotlinRuleEntries,
    '/repo/app/src/test/kotlin/PathIdTest.kt',
    '/repo/app/src/main/kotlin/PathId.kt',
  ],
] as const

const EXISTING_TEST = `class PathIdTest {
    @Test
    fun \`accepts plain ids\`() {
        assertTrue(PathId.isValid("abc"))
    }
}
`

// Extends an existing test class with a second test — the case the
// Kotlin fast path cannot pass, so the unwrapped judge would be asked.
const MARKED_TEST = `class PathIdTest {
    @Test
    fun \`accepts plain ids\`() {
        assertTrue(PathId.isValid("abc"))
    }

    // probity: characterization
    @Test
    fun \`rejects ids containing slashes\`() {
        assertFalse(PathId.isValid("a/b"))
        assertFalse(PathId.isValid("a\\\\b"))
    }
}
`

const RESOLVED_TEST = MARKED_TEST.replace('    // probity: characterization\n', '')

// Adds an assertion to an existing test — never a fast-path pass, so
// the judge (and its denial) is reached.
const EXTENDED_TEST = EXISTING_TEST.replace(
  '        assertTrue(PathId.isValid("abc"))\n',
  '        assertTrue(PathId.isValid("abc"))\n        assertFalse(PathId.isValid("a/b"))\n',
)

function tddRule(entries: RuleEntry[], preset: string): Rule {
  for (const entry of entries) {
    if (typeof entry === 'function') continue
    const rule = entry.rules.find((candidate) => candidate.name.includes('enforceTdd'))
    if (rule) return rule
  }
  assert.fail(`${preset} preset should expose a TDD rule`)
}

function commitGate(entries: RuleEntry[]): Rule {
  const gate = entries.find(
    (entry): entry is Rule =>
      typeof entry === 'function' && entry.name === 'enforceCharacterizationResolution',
  )
  assert.ok(gate, 'preset should include enforceCharacterizationResolution')
  return gate
}

function context(
  before: string,
  history: SessionEvent[] = [],
  verdict: { kind: 'pass' | 'violation'; reason: string } = { kind: 'pass', reason: '' },
) {
  let judged = 0
  const ctx: RuleContext = {
    readFile: async () => ({ kind: 'present', content: before }),
    rawHistory: async () => [],
    history: async () => history,
    agent: {
      reason: async () => {
        judged++
        return verdict
      },
    },
  }
  return { ctx, judgeCalls: () => judged }
}

for (const [preset, factory, testPath, productionPath] of presets) {
  const rule = tddRule(factory('/repo'), preset)

  test(`${preset}: a marked characterization test passes without the judge`, async () => {
    const { ctx, judgeCalls } = context(EXISTING_TEST, [], {
      kind: 'violation',
      reason: 'The new test must be observed failing first.',
    })
    const marked = EXTENDED_TEST.replace('    @Test', '    // probity: characterization\n    @Test')
    const result = await rule({ kind: 'write', path: testPath, content: marked }, ctx)
    assert.equal(result.kind, 'pass')
    assert.deepEqual(result.notes, [{ kind: 'characterization' }])
    assert.equal(judgeCalls(), 0)
  })

  test(`${preset}: the marker does nothing in production source`, async () => {
    const { ctx, judgeCalls } = context('object PathId', [], {
      kind: 'violation',
      reason: 'No failing test drives this.',
    })
    const result = await rule(
      {
        kind: 'write',
        path: productionPath,
        content: '// probity: characterization\nobject PathId { fun isValid(id: String) = true }',
      },
      ctx,
    )
    assert.equal(result.kind, 'violation')
    assert.equal(judgeCalls(), 1)
  })

  test(`${preset}: an unmarked test denied for lacking a red names the marker`, async () => {
    const { ctx } = context(EXISTING_TEST, [], {
      kind: 'violation',
      reason:
        'This test asserts new unimplemented behavior; it must be observed failing first.',
    })
    const result = await rule({ kind: 'write', path: testPath, content: EXTENDED_TEST }, ctx)
    assert.equal(result.kind, 'violation')
    assert.match(result.reason ?? '', /probity: characterization/)
    assert.match(result.reason ?? '', /Do not break production to manufacture a red/)
  })

  test(`${preset}: unrelated test denials carry no characterization note`, async () => {
    const { ctx } = context(EXISTING_TEST, [], {
      kind: 'violation',
      reason: 'Adds three tests in one write; add one at a time.',
    })
    const result = await rule({ kind: 'write', path: testPath, content: EXTENDED_TEST }, ctx)
    assert.equal(result.kind, 'violation')
    assert.doesNotMatch(result.reason ?? '', /probity: characterization/)
  })

  test(`${preset}: removing the marker needs a recorded failure of that backticked test`, async () => {
    const unrelatedFailure: SessionEvent = {
      kind: 'command',
      command: './gradlew test',
      output: 'PathIdTest > rejects blank ids() FAILED',
    }
    const denied = await rule(
      { kind: 'write', path: testPath, content: RESOLVED_TEST },
      context(MARKED_TEST, [unrelatedFailure]).ctx,
    )
    assert.equal(denied.kind, 'violation')
    assert.match(denied.reason ?? '', /rejects ids containing slashes/)

    const proof: SessionEvent = {
      kind: 'command',
      command: './gradlew test',
      output: 'PathIdTest > rejects ids containing slashes() FAILED\n  AssertionError',
    }
    const allowed = await rule(
      { kind: 'write', path: testPath, content: RESOLVED_TEST },
      context(MARKED_TEST, [proof]).ctx,
    )
    assert.equal(allowed.kind, 'pass')
  })

  test(`${preset}: commits are blocked while a marker is on disk`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'probity-characterization-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const dir = join(root, 'app/src/test/kotlin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'PathIdTest.kt'), MARKED_TEST)
    const gate = commitGate(factory(root))
    const blocked = await gate({ kind: 'command', command: 'git commit -m "test"' })
    assert.equal(blocked.kind, 'violation')
    assert.match(blocked.reason ?? '', /PathIdTest\.kt/)

    writeFileSync(join(dir, 'PathIdTest.kt'), RESOLVED_TEST)
    const open = await gate({ kind: 'command', command: 'git commit -m "test"' })
    assert.equal(open.kind, 'pass')
  })
}

test('a judge infrastructure failure on a test write gets no characterization note', async () => {
  const rule = tddRule(kmpRuleEntries('/repo'), 'KMP')
  const { ctx } = context(EXISTING_TEST, [], {
    kind: 'violation',
    reason: "could not parse verdict from validator output: You've hit your org's monthly spend limit",
  })
  const result = await rule(
    {
      kind: 'write',
      path: '/repo/sdk/core/src/commonTest/kotlin/PathIdTest.kt',
      content: EXTENDED_TEST,
    },
    ctx,
  )
  assert.equal(result.kind, 'violation')
  assert.match(result.reason ?? '', /NOT judged/)
  assert.doesNotMatch(result.reason ?? '', /Do not break production to manufacture a red/)
})
