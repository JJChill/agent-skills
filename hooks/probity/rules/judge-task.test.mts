// Run: npx tsx --test rules/judge-task.test.mts
//
// A judge only sees a prompt, never the rule that asked. The presets run
// each rule labelled with its judging task, so shadowJudge can record which
// task every verdict was for.
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import test from 'node:test'

import type { Rule, RuleEntry } from '@nizos/probity'

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

/** Drives a rule with a context that records the judging task whenever the rule reads from it. */
async function tasksSeenBy(rule: Rule, path: string): Promise<Set<string | undefined>> {
  const seen = new Set<string | undefined>()
  const note = <T>(value: T) => (seen.add(judgeTask()), value)
  const ctx = {
    history: async () => note([]),
    readFile: async () => note({ kind: 'absent' as const }),
    agent: { reason: async () => note({ kind: 'pass' as const, reason: 'ok' }) },
  }
  try {
    await rule({ kind: 'write', path, content: 'x' }, ctx as never)
  } catch {
    // A rule that rejects this synthetic write still read its context first.
  }
  return seen
}

// Every preset runs its rules under their tasks, so a judge asked from any
// of them knows which task it is judging. The presets are found by listing
// presets/, so a new one is checked without anyone adding it here.
test('every preset in presets/ runs each rule under the task its name stands for', async () => {
  const dir = new URL('../presets/', import.meta.url)
  const presets: Array<[string, () => RuleEntry[]]> = []
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
    const module = (await import(new URL(file, dir).href)) as Record<string, unknown>
    for (const [name, value] of Object.entries(module)) {
      if (!name.endsWith('RuleEntries') || typeof value !== 'function') continue
      // `(root, options?)` presets take the project root; `(options?)` ones don't.
      presets.push([name, () => (value.length >= 1 ? value('/repo') : value()) as RuleEntry[]])
    }
  }
  assert.ok(presets.length >= 4, `found only ${presets.map(([name]) => name).join(', ')}`)
  for (const [preset, entries] of presets) {
    const rules = entries().flatMap((entry) => (typeof entry === 'function' ? [entry] : [...entry.rules]))
    let observed = 0
    for (const path of ['/repo/src/core/a.ts', '/repo/App/Sources/A.swift', '/repo/app/src/main/kotlin/A.kt']) {
      for (const rule of rules) {
        const seen = await tasksSeenBy(rule, path)
        if (seen.size === 0) continue
        observed++
        assert.deepEqual([...seen], [taskOf(rule.name)], `${preset}: ${rule.name}`)
      }
    }
    assert.ok(observed > 0, `${preset}: no rule read its context`)
  }
})

test('withJudgeTasks leaves rules it already labelled as they are', () => {
  const { rule } = recorder('enforceTdd')
  const once = withJudgeTasks([rule])[0] as Rule
  assert.equal(withJudgeTasks([once])[0], once)
})
