// Coverage for issue #119 (item 2): a judged isolation check on the
// acceptance DSL. Every entity a test creates in a SUT that outlives
// the test is aliased; no shared writable fixtures; no clean-up of
// test data. The model sees the change and the file's head, not the
// whole file, and is skipped when the write adds no code.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Rule, RuleBlock, RuleContext, RuleEntry } from '@nizos/probity'

import { enforceTestIsolation } from './acceptance-language.ts'
import { isRuleBlock } from './scoping.ts'
import { jsRuleEntries } from '../presets/js.ts'
import { kmpRuleEntries } from '../presets/kmp.ts'
import { kotlinRuleEntries } from '../presets/kotlin.ts'
import { swiftRuleEntries } from '../presets/swift.ts'

function judge(verdict: 'pass' | 'violation' = 'pass', reason = '') {
  const prompts: string[] = []
  const ctx = (before?: string): RuleContext =>
    ({
      readFile: async () =>
        before === undefined ? { kind: 'absent' } : { kind: 'present', content: before },
      agent: {
        reason: async (prompt: string) => {
          prompts.push(prompt)
          return { kind: verdict, reason }
        },
      },
    }) as unknown as RuleContext
  return { prompts, ctx }
}

const PATH = '/repo/acceptance/dsl/Invoices.kt'
const write = (content: string) => ({ kind: 'write' as const, path: PATH, content })

const HEAD = 'package shop.acceptance.dsl\n\nimport shop.acceptance.drivers.InvoiceDriver\n\nclass Invoices(private val driver: InvoiceDriver, private val alias: Alias) {\n'
const filler = Array.from({ length: 200 }, (_, i) => `    fun step${i}() = driver.noop(${i})\n`).join('')

test('a new DSL step is judged with the isolation rules', async () => {
  const j = judge('pass')
  const before = HEAD + filler + '}\n'
  const after = HEAD + filler + '    fun createAccount(name: String) = driver.createAccount(name)\n}\n'
  const result = await enforceTestIsolation()(write(after), j.ctx(before))
  assert.equal(result.kind, 'pass')
  assert.equal(j.prompts.length, 1)
  assert.match(j.prompts[0]!, /alias/i)
  assert.match(j.prompts[0]!, /clean/i)
  assert.match(j.prompts[0]!, /createAccount\(name: String\)/)
})

test('the judge sees the file head and the change, not the whole file', async () => {
  const j = judge('pass')
  const before = HEAD + filler + '}\n'
  const after = HEAD + filler + '    fun createAccount(name: String) = driver.createAccount(name)\n}\n'
  await enforceTestIsolation()(write(after), j.ctx(before))
  assert.match(j.prompts[0]!, /class Invoices\(private val driver: InvoiceDriver/)
  assert.doesNotMatch(j.prompts[0]!, /fun step100\(\)/, 'unchanged middle of a long file is left out')
  assert.match(j.prompts[0]!, /fun step199\(\)/, 'a little context around the change is kept')
})

test("the judge's violation blocks with its reason", async () => {
  const j = judge('violation', 'createAccount passes the test name straight to the SUT; alias it.')
  const result = await enforceTestIsolation()(
    write(HEAD + '    fun createAccount(name: String) = driver.createAccount(name)\n}\n'),
    j.ctx(HEAD + '}\n'),
  )
  assert.equal(result.kind, 'violation')
  assert.match((result as { reason: string }).reason, /alias it/)
})

test('a write that adds no code (removals, comments, imports) is not judged', async () => {
  const j = judge('violation')
  const before = HEAD + '    fun a() = driver.a()\n    fun b() = driver.b()\n}\n'
  const after =
    HEAD.replace('import shop', 'import shop.acceptance.Alias\nimport shop') +
    '    // a is the first step\n    fun a() = driver.a()\n}\n'
  const result = await enforceTestIsolation()(write(after), j.ctx(before))
  assert.equal(result.kind, 'pass')
  assert.equal(j.prompts.length, 0)
})

test('the prompt accepts a fresh SUT per test as isolated', async () => {
  const j = judge('pass')
  await enforceTestIsolation()(write(HEAD + '    fun x() = driver.x()\n}\n'), j.ctx(HEAD + '}\n'))
  assert.match(j.prompts[0]!, /fresh/i)
})

test('with no model available, a write that needs judging fails closed', async () => {
  const ctx = { readFile: async () => ({ kind: 'absent' }) } as unknown as RuleContext
  const result = await enforceTestIsolation()(write(HEAD + '    fun x() = driver.x()\n}\n'), ctx)
  assert.equal(result.kind, 'violation')
})

test('non-write actions pass', async () => {
  const j = judge('violation')
  const result = await enforceTestIsolation()({ kind: 'command', command: 'ls' } as never, j.ctx())
  assert.equal(result.kind, 'pass')
})

// ── Preset wiring: opt-in through dslIsolationGlobs ────────────────

function isolationBlock(entries: readonly RuleEntry[]): RuleBlock | undefined {
  return entries.find(
    (entry): entry is RuleBlock =>
      isRuleBlock(entry) && !!entry.rules?.some((rule: Rule) => /enforceTestIsolation/.test(rule.name)),
  )
}

const presets: Array<[string, (opts?: { dslIsolationGlobs?: string[] }) => RuleEntry[]]> = [
  ['kmpRuleEntries', (opts) => kmpRuleEntries('/repo', opts)],
  ['kotlinRuleEntries', (opts) => kotlinRuleEntries('/repo', opts)],
  ['swiftRuleEntries', (opts) => swiftRuleEntries('/repo', opts)],
  ['jsRuleEntries', (opts) => jsRuleEntries(opts)],
]

for (const [label, build] of presets) {
  test(`${label}: the isolation judge is off by default`, () => {
    assert.equal(isolationBlock(build()), undefined)
  })

  test(`${label}: dslIsolationGlobs turns it on for those files`, () => {
    const block = isolationBlock(build({ dslIsolationGlobs: ['**/acceptance/dsl/**'] }))
    assert.ok(block)
    assert.deepEqual(block!.files!.filter((glob: string) => !glob.startsWith('!')), ['**/acceptance/dsl/**'])
  })
}
