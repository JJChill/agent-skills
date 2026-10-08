// Issue #85: the Swift preset's TDD judge carries the three #80 rules the
// Kotlin/KMP addendum has (a port method as the minimal green, a tried
// route ruled out, tightening a red test).
import assert from 'node:assert/strict'
import test from 'node:test'

import type { RuleContext, RuleEntry } from '@nizos/probity'

import { swiftRuleEntries } from '../presets/swift.ts'

function swiftTddRule(entries: RuleEntry[]) {
  const block = entries.find(
    (entry) => typeof entry !== 'function' && entry.files?.includes('App/Sources/**') && entry.rules?.some((rule) => rule.name.includes('enforceTdd')),
  )
  const rule = typeof block === 'function' ? undefined : block?.rules?.find((candidate) => candidate.name.includes('enforceTdd'))
  assert.ok(rule, 'the Swift preset exposes its wrapped TDD rule')
  return rule
}

async function capturedPrompt(): Promise<string> {
  let prompt = ''
  const ctx: RuleContext = {
    readFile: async () => ({ kind: 'present', content: 'protocol MessageGateway {}' }),
    rawHistory: async () => [],
    agent: {
      reason: async (value) => {
        prompt = value
        return { kind: 'pass', reason: '' }
      },
    },
  }
  const write = { kind: 'write' as const, path: '/repo/App/Sources/Modules/Messages/MessageStore.swift', content: 'final class MessageStore {}' }
  await swiftTddRule(swiftRuleEntries('/repo'))(write, ctx)
  return prompt
}

test('the Swift TDD judge treats a missing protocol requirement as a possible minimal green', async () => {
  const prompt = await capturedPrompt()
  assert.match(prompt, /A port method can be the minimal green/)
  assert.match(prompt, /protocol requirements in the current file content/)
  assert.match(prompt, /do not deny it over its signature/)
  assert.match(prompt, /paging, cursors, retries, or deletion handling the test does not assert are still over-implementation/)
})

test('the Swift TDD judge rules out a route that was tried and still failed', async () => {
  assert.match(await capturedPrompt(), /A route that was tried and still fails is ruled out/)
})

test('the Swift TDD judge lets a red test be tightened but not weakened', async () => {
  const prompt = await capturedPrompt()
  assert.match(prompt, /Tightening a red test is part of the red step/)
  assert.match(prompt, /replacing or loosening the asserted outcome so that the current production code passes is weakening/)
  assert.match(prompt, /may name a member the fake or a port does not have yet/)
  assert.match(prompt, /does not replace the earlier assertion failure as the red/)
})
