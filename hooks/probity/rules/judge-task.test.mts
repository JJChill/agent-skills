// Run: npx tsx --test rules/judge-task.test.mts
//
// A judge only sees a prompt, never the rule that asked. The presets run
// each rule labelled with its judging task, so shadowJudge can record which
// task every verdict was for.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Rule } from '@nizos/probity'

import { judgeTask, taskOf, withJudgeTask, withJudgeTasks } from './judge-task.ts'

function recorder(name: string) {
  const seen: Array<string | undefined> = []
  const rule = {
    [name]: async () => {
      seen.push(judgeTask())
      await new Promise((resolve) => setTimeout(resolve, 1))
      seen.push(judgeTask())
      return { kind: 'pass' as const }
    },
  }[name]! as Rule
  return { rule, seen }
}

test('taskOf names the innermost rule of a wrapper chain', () => {
  assert.equal(taskOf('characterizationTest(mutationProbe(telemetryFastPath(kotlinFastPath(enforceTdd))))'), 'enforceTdd')
  assert.equal(taskOf('enforcePortsBoundary'), 'enforcePortsBoundary')
  assert.equal(taskOf(''), '(unnamed)')
})

test('withJudgeTasks runs each rule, flat or in a block, under its task and keeps its name', async () => {
  const flat = recorder('forbidStaticMocks')
  const tdd = recorder('kotlinFastPath(enforceTdd)')
  const entries = withJudgeTasks([flat.rule, { files: ['src/**'], rules: [tdd.rule] }])
  const wrappedFlat = entries[0] as Rule
  const block = entries[1] as { files: string[]; rules: Rule[] }
  assert.equal(wrappedFlat.name, 'forbidStaticMocks')
  assert.deepEqual(block.files, ['src/**'])
  assert.equal(block.rules[0]!.name, 'kotlinFastPath(enforceTdd)')
  await wrappedFlat({ kind: 'command', command: 'x' })
  await block.rules[0]!({ kind: 'command', command: 'x' })
  assert.deepEqual(flat.seen, ['forbidStaticMocks', 'forbidStaticMocks'])
  assert.deepEqual(tdd.seen, ['enforceTdd', 'enforceTdd'])
  assert.equal(judgeTask(), undefined)
})

test('withJudgeTask labels a judge call inside a rule with its own task', async () => {
  const inner: Array<string | undefined> = []
  await withJudgeTask('enforceTdd', async () => {
    await withJudgeTask('extractionUnderGreen', async () => {
      inner.push(judgeTask())
    })
    inner.push(judgeTask())
  })
  assert.deepEqual(inner, ['extractionUnderGreen', 'enforceTdd'])
})

// Every preset runs its rules under their tasks, so a judge asked from any
// of them knows which task it is judging. Each rule is driven with a context
// that records the task whenever the rule reads anything from it.
test('every preset runs each rule under the task its name stands for', async () => {
  const { kmpRuleEntries } = await import('../presets/kmp.ts')
  const { kotlinRuleEntries } = await import('../presets/kotlin.ts')
  const { swiftRuleEntries } = await import('../presets/swift.ts')
  const { jsRuleEntries } = await import('../presets/js.ts')
  const presets = {
    kmp: kmpRuleEntries('/repo'),
    kotlin: kotlinRuleEntries('/repo'),
    swift: swiftRuleEntries('/repo'),
    js: jsRuleEntries(),
  }
  for (const [preset, entries] of Object.entries(presets)) {
    const rules = entries.flatMap((entry) => (typeof entry === 'function' ? [entry] : [...entry.rules]))
    let observed = 0
    for (const rule of rules) {
      const seen = new Set<string | undefined>()
      const note = <T>(value: T) => (seen.add(judgeTask()), value)
      const ctx = {
        history: async () => note([]),
        readFile: async () => note({ kind: 'absent' as const }),
        agent: { reason: async () => note({ kind: 'pass' as const, reason: 'ok' }) },
      }
      const path = preset === 'js' ? '/repo/src/core/a.ts' : preset === 'swift' ? '/repo/App/Sources/A.swift' : '/repo/app/src/main/kotlin/A.kt'
      try {
        await rule({ kind: 'write', path, content: 'x' }, ctx as never)
      } catch {
        // A rule that rejects this synthetic write still read its context first.
      }
      if (seen.size === 0) continue
      observed++
      assert.deepEqual([...seen], [taskOf(rule.name)], `${preset}: ${rule.name}`)
    }
    assert.ok(observed > 0, `${preset}: no rule read its context`)
  }
})
