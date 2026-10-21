// Run: npx tsx --test rules/probity-config.test.mts
//
// probityConfig labels every rule a project's config lists, the ones it adds
// next to a preset included, so shadowJudge can file each verdict by task.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Agent, Rule } from '@nizos/probity'

import { judgeTask } from './judge-task.ts'
import { probityConfig } from './probity-config.ts'

test('probityConfig runs every rule in the config under its judging task, and keeps ai', async () => {
  const seen: Array<string | undefined> = []
  const custom: Rule = async function requireChangelogEntry() {
    seen.push(judgeTask())
    return { kind: 'pass' }
  }
  const scoped: Rule = async function checkApiNaming() {
    seen.push(judgeTask())
    return { kind: 'pass' }
  }
  const ai: Agent = { reason: async () => ({ kind: 'pass', reason: '' }) }
  const config = probityConfig({ rules: [custom, { files: ['src/**'], rules: [scoped] }], ai })
  assert.equal(config.ai, ai)
  const [flat, block] = config.rules as [Rule, { files: string[]; rules: Rule[] }]
  assert.equal(flat.name, 'requireChangelogEntry')
  assert.deepEqual(block.files, ['src/**'])
  await flat({ kind: 'command', command: 'x' })
  await block.rules[0]!({ kind: 'command', command: 'x' })
  assert.deepEqual(seen, ['requireChangelogEntry', 'checkApiNaming'])
})
