import assert from 'node:assert/strict'
import test from 'node:test'

import type { Rule, RuleContext, RuleEntry, RuleResult } from '@nizos/probity'
import { toVerdict } from '../node_modules/@nizos/probity/dist/vendors/to-verdict.js'

import { jsRuleEntries } from '../presets/js.ts'
import { kmpRuleEntries } from '../presets/kmp.ts'
import { kotlinRuleEntries } from '../presets/kotlin.ts'
import { swiftRuleEntries } from '../presets/swift.ts'
import { withContradictionRetry } from './gates.ts'

// Issue #45, the judge's reason as recorded. The identical retry passed.
const CONTRADICTION =
  'This write adds a new test `should delete one Text Message, then the ' +
  'whole conversation` while the prior test `should show a Text Message ' +
  'received unread, and mark the conversation read and unread` was just ' +
  'added and its green (the mark commands) has been implemented. That is ' +
  'fine, but the current file already contains the mark test and this ' +
  'write adds a second, distinct behavior-driving test (delete). Red ' +
  'allows at most one new test per write; add the delete test in its own ' +
  'write after the mark slice is green — which it is — so this is a ' +
  'single new test, which is allowed. Re-examining: the diff versus ' +
  'current file content adds only ONE new test (the delete test). This ' +
  'is permitted.'

const write = {
  kind: 'write' as const,
  path: '/repo/src/Thing.ts',
  content: 'export const thing = 1',
}

function sequence(...results: RuleResult[]): { rule: Rule; calls: () => number } {
  let calls = 0
  const rule: Rule = async function enforceTdd() {
    return results[Math.min(calls++, results.length - 1)]!
  }
  return { rule, calls: () => calls }
}

test('a deny whose reason concludes the write is permitted is judged once more', async () => {
  const { rule, calls } = sequence(
    { kind: 'violation', reason: CONTRADICTION },
    { kind: 'pass' },
  )
  const result = await withContradictionRetry(rule)(write)
  assert.equal(result.kind, 'pass')
  assert.equal(calls(), 2)
})

test('the second verdict stands when it denies again', async () => {
  const { rule, calls } = sequence(
    { kind: 'violation', reason: CONTRADICTION },
    { kind: 'violation', reason: 'adds two tests' },
  )
  const result = await withContradictionRetry(rule)(write)
  assert.equal(result.kind, 'violation')
  assert.equal(result.reason, 'adds two tests')
  assert.equal(calls(), 2)
})

for (const reason of [
  'This write adds two new tests. This is not permitted.',
  'Over-implementation: the NotSent branch is not required by the failing test.',
  'Adding a test is permitted, but this production write has no observed red.',
]) {
  test(`a consistent deny is not retried: ${reason.slice(0, 40)}`, async () => {
    const { rule, calls } = sequence({ kind: 'violation', reason })
    const result = await withContradictionRetry(rule)(write)
    assert.equal(result.kind, 'violation')
    assert.equal(calls(), 1)
  })
}

test('a pass is not retried', async () => {
  const { rule, calls } = sequence({ kind: 'pass' })
  assert.equal((await withContradictionRetry(rule)(write)).kind, 'pass')
  assert.equal(calls(), 1)
})

function tddRules(entries: RuleEntry[]): Rule[] {
  const rules: Rule[] = []
  const visit = (entry: unknown) => {
    if (typeof entry === 'function') rules.push(entry as Rule)
    else if (entry && typeof entry === 'object' && 'rules' in entry) {
      for (const inner of (entry as { rules: unknown[] }).rules) visit(inner)
    }
  }
  for (const entry of entries) visit(entry)
  return rules
}

for (const [preset, entries, path, content] of [
  ['js', jsRuleEntries('/repo'), '/repo/src/Thing.ts', 'export const thing = 1'],
  ['kotlin', kotlinRuleEntries('/repo'), '/repo/src/main/kotlin/Thing.kt', 'val thing = 1'],
  [
    'kmp',
    kmpRuleEntries('/repo'),
    '/repo/shared/src/commonMain/kotlin/Thing.kt',
    'val thing = 1',
  ],
  ['swift', swiftRuleEntries('/repo'), '/repo/Sources/App/Thing.swift', 'let thing = 1'],
] as const) {
  test(`${preset} preset: the TDD judge retries a self-contradicting deny`, async () => {
    let tddCalls = 0
    const ctx = {
      readFile: async () => ({ kind: 'absent' as const }),
      rawHistory: async () => [],
      agent: {
        reason: async (prompt: string) => {
          const tdd = prompt.includes('You are a TDD validator')
          const first = tdd && tddCalls++ === 0
          const text = first
            ? JSON.stringify({ kind: 'violation', reason: CONTRADICTION })
            : '{"kind":"pass","reason":""}'
          return toVerdict(async () => ({ text }))
        },
      },
    } as unknown as RuleContext
    for (const rule of tddRules(entries as RuleEntry[])) {
      await rule({ kind: 'write', path, content }, ctx)
    }
    assert.equal(tddCalls, 2, 'TDD judge was not asked again')
  })
}
