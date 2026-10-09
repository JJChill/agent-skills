// Coverage for issue #102: vendor adapters whose success path can't be
// tested offline (SDK callbacks that fire only during a live call) leave
// the TDD gate and are held to forwarding-only instead.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Rule, RuleBlock, RuleContext, RuleEntry } from '@nizos/probity'

import { kmpRuleEntries } from '../presets/kmp.ts'
import { kotlinRuleEntries } from '../presets/kotlin.ts'
import { swiftRuleEntries } from '../presets/swift.ts'
import { enforceForwardingOnlyAdapter } from './ports-and-adapters.ts'
import { anchorGlob, buildMatcher, isRuleBlock } from './scoping.ts'

function capture(prompts: string[], before?: string): RuleContext {
  return {
    readFile: async () => (before === undefined ? { kind: 'absent' } : { kind: 'present', content: before }),
    agent: {
      reason: async (prompt: string) => {
        prompts.push(prompt)
        return { kind: 'pass', reason: '' }
      },
    },
  } as RuleContext
}

const ADAPTER = '/repo/sdk/calling/src/androidMain/kotlin/x/adapter/TwilioRoomConnection.kt'

test('the forwarding-only judge sees the rules, the current file and the pending write', async () => {
  const prompts: string[] = []
  const write = { kind: 'write' as const, path: ADAPTER, content: 'override fun onConnected(room: Room) = events.joined(room.sid)' }
  const result = await enforceForwardingOnlyAdapter()(write, capture(prompts, 'class TwilioRoomConnection'))
  assert.equal(result.kind, 'pass')
  const prompt = prompts[0] ?? ''
  assert.match(prompt, /forwarding-only validator for vendor adapters whose success\npath cannot run offline/)
  assert.match(prompt, /Holding and releasing the vendor objects/)
  assert.match(prompt, /\*\*A decision\*\*/)
  assert.match(prompt, /\*\*Policy\*\*: retries, backoff/)
  assert.match(prompt, /behind the\nport, into the plain code the port leads to/)
  assert.match(prompt, /## Current file content\n\nclass TwilioRoomConnection/)
  assert.match(prompt, /events\.joined\(room\.sid\)/)
})

test('the forwarding-only judge passes commands and needs an AI agent for writes', async () => {
  const rule = enforceForwardingOnlyAdapter()
  assert.equal((await rule({ kind: 'command', command: 'ls' })).kind, 'pass')
  const noAgent = await rule({ kind: 'write', path: ADAPTER, content: 'x' }, { readFile: async () => ({ kind: 'absent' }) })
  assert.equal(noAgent.kind, 'violation')
  assert.match(noAgent.reason ?? '', /no AI agent available/)
})

// ── Preset wiring ──────────────────────────────────────────────────

function blockWith(entries: readonly RuleEntry[], name: string): number {
  return entries.findIndex((entry) => isRuleBlock(entry) && (entry.rules ?? []).some((r: Rule) => r.name.includes(name)))
}

function covers(entry: RuleEntry | undefined, path: string): boolean {
  return !!entry && isRuleBlock(entry) && !!entry.files && buildMatcher(entry.files.map((g) => anchorGlob(g, '/repo')))(path)
}

const PRESETS = [
  {
    name: 'kmpRuleEntries',
    build: (options = {}) => kmpRuleEntries('/repo', options),
    globs: ['**/src/androidMain/kotlin/**/adapter/Twilio*.kt'],
    path: ADAPTER,
  },
  {
    name: 'kotlinRuleEntries',
    build: (options = {}) => kotlinRuleEntries('/repo', options),
    globs: ['**/src/main/**/adapter/Twilio*.kt'],
    path: '/repo/app/src/main/kotlin/x/adapter/TwilioRoomConnection.kt',
  },
  {
    name: 'swiftRuleEntries',
    build: (options = {}) => swiftRuleEntries('/repo', options),
    globs: ['App/Sources/**/Adapters/Twilio*.swift'],
    path: '/repo/App/Sources/Calling/Adapters/TwilioRoomConnection.swift',
  },
] as const

for (const preset of PRESETS) {
  test(`${preset.name} wires no forwarding-only block by default`, () => {
    assert.equal(blockWith(preset.build(), 'enforceForwardingOnlyAdapter'), -1)
  })

  test(`${preset.name}: vendorAdapterGlobs moves the files from the TDD judge to the forwarding-only judge`, () => {
    const before = preset.build()
    const after = preset.build({ vendorAdapterGlobs: preset.globs })
    const index = blockWith(after, 'enforceForwardingOnlyAdapter')
    const tdd = blockWith(after, 'enforceTdd')
    assert.ok(index >= 0, 'expected the block')
    assert.ok(index < tdd, 'listed before the TDD judge')
    assert.ok(covers(after[index], preset.path))
    assert.ok(covers(before[blockWith(before, 'enforceTdd')], preset.path), 'in the TDD block by default')
    assert.equal(covers(after[tdd], preset.path), false, 'and out of it once marked')
    const observability = blockWith(after, 'enforceAdapterObservability')
    assert.ok(covers(after[observability], preset.path), 'observability still applies')
    assert.equal(typeof after[0], 'function', 'the shell-write screen still runs first')
    assert.deepEqual((after[index] as RuleBlock).rules?.map((r) => r.name), ['enforceForwardingOnlyAdapter'])
  })
}
