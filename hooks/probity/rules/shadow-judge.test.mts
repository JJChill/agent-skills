// Run: npx tsx --test rules/shadow-judge.test.mts
//
// shadowJudge lets a project measure a cheaper (or different) judge on its
// real traffic: the primary judge decides every verdict, candidates answer
// the same prompt on the side, and both are logged for comparison.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Agent, Verdict } from '@nizos/probity'

import { shadowJudge, summarizeShadowLog, type ShadowLogEntry } from './shadow-judge.ts'

function dir(t: { after: (fn: () => void) => void }) {
  const path = mkdtempSync(join(tmpdir(), 'shadow-judge-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function judge(name: string, answer: (prompt: string) => Promise<Verdict>) {
  const prompts: string[] = []
  const agent = {
    name,
    reason: async (prompt: string) => {
      prompts.push(prompt)
      return answer(prompt)
    },
  } as Agent & { name: string }
  return { agent, prompts }
}

const pass = (reason = 'ok', meta?: Verdict['meta']): Verdict => ({ kind: 'pass', reason, ...(meta && { meta }) })
const deny = (reason = 'no red'): Verdict => ({ kind: 'violation', reason })

function readLog(path: string): ShadowLogEntry[] {
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

test('the primary verdict decides, and both verdicts are logged with the prompt', async (t) => {
  const log = join(dir(t), 'nested', 'shadow.jsonl')
  const primary = judge('claude', async () => deny('production write with no failing test'))
  const candidate = judge('claude:claude-haiku-5-5', async () =>
    pass('looks fine', { models: [{ model: 'claude-haiku-5-5', inputTokens: 900, outputTokens: 40 }] }),
  )
  const shadow = shadowJudge(primary.agent, [candidate.agent], { log })

  const verdict = await shadow.reason('## Rules\nJudge this write.')
  assert.equal(verdict.kind, 'violation')
  assert.equal(verdict.reason, 'production write with no failing test')
  assert.deepEqual(candidate.prompts, ['## Rules\nJudge this write.'])

  const [entry] = readLog(log)
  assert.equal(entry!.prompt, '## Rules\nJudge this write.')
  assert.match(entry!.promptSha256, /^[0-9a-f]{64}$/)
  assert.equal(entry!.primary.name, 'claude')
  assert.equal(entry!.primary.kind, 'violation')
  assert.equal(entry!.candidates[0]!.name, 'claude:claude-haiku-5-5')
  assert.equal(entry!.candidates[0]!.kind, 'pass')
  assert.deepEqual(entry!.candidates[0]!.meta, { models: [{ model: 'claude-haiku-5-5', inputTokens: 900, outputTokens: 40 }] })
  // Prompts hold source code: the log is private to the user.
  assert.equal(statSync(log).mode & 0o777, 0o600)
})

test('the shadow judge carries the primary judge\'s name, so judgeChain treats it as the primary', () => {
  const shadow = shadowJudge(judge('kiro', async () => pass()).agent, [], { log: '/dev/null' }) as Agent & { name?: string }
  assert.equal(shadow.name, 'kiro')
})

test('a candidate that fails or hangs never changes or holds up the verdict', async (t) => {
  const log = join(dir(t), 'shadow.jsonl')
  const primary = judge('claude', async () => pass())
  const broken = judge('broken', async () => {
    throw new Error('socket hang up')
  })
  const hung = judge('hung', () => new Promise<Verdict>(() => {}))
  const shadow = shadowJudge(primary.agent, [broken.agent, hung.agent], { log, candidateTimeoutMs: 50 })

  const started = Date.now()
  const verdict = await shadow.reason('p')
  assert.equal(verdict.kind, 'pass')
  assert.ok(Date.now() - started < 1_000, 'waited for the hung candidate')
  const [entry] = readLog(log)
  assert.equal(entry!.candidates[0]!.error, 'socket hang up')
  assert.equal(entry!.candidates[1]!.timedOut, true)
})

test('a log that cannot be written never changes the verdict', async (t) => {
  const blocker = join(dir(t), 'file')
  writeFileSync(blocker, '')
  const shadow = shadowJudge(judge('claude', async () => deny()).agent, [judge('c', async () => pass()).agent], {
    log: join(blocker, 'shadow.jsonl'),
  })
  assert.equal((await shadow.reason('p')).kind, 'violation')
})

test('includePrompt: false logs only the prompt hash', async (t) => {
  const log = join(dir(t), 'shadow.jsonl')
  const shadow = shadowJudge(judge('claude', async () => pass()).agent, [judge('c', async () => pass()).agent], {
    log,
    includePrompt: false,
  })
  await shadow.reason('secret source')
  const [entry] = readLog(log)
  assert.equal('prompt' in entry!, false)
  assert.match(entry!.promptSha256, /^[0-9a-f]{64}$/)
})

function entry(primary: Verdict, candidate: Partial<ShadowLogEntry['candidates'][number]>, durations = [1000, 400]): ShadowLogEntry {
  return {
    at: '2026-10-21T00:00:00.000Z',
    promptSha256: 'x',
    primary: { name: 'claude', kind: primary.kind, reason: primary.reason, durationMs: durations[0]!, meta: { models: [{ model: 'opus', inputTokens: 10, outputTokens: 1 }] } },
    candidates: [{ name: 'haiku', durationMs: durations[1]!, ...candidate }],
  }
}

test('summarizeShadowLog splits disagreements into leaks and friction, apart from unavailable answers', () => {
  const usage = { models: [{ model: 'claude-haiku-5-5', inputTokens: 100, outputTokens: 10 }] }
  const summary = summarizeShadowLog([
    entry(pass(), { kind: 'pass', reason: 'ok', meta: usage }),
    entry(deny(), { kind: 'violation', reason: 'no red', meta: usage }),
    // Candidate lets through what the primary denied: a leak.
    entry(deny(), { kind: 'pass', reason: 'fine', meta: usage }),
    // Candidate denies what the primary passed: friction.
    entry(pass(), { kind: 'violation', reason: 'retrofit' }),
    entry(pass(), { kind: 'violation', reason: 'Claude judge unavailable: spend limit reached' }),
    entry(pass(), { error: 'socket hang up' }),
    entry(pass(), { timedOut: true }),
    // The primary was unavailable: nothing to compare against.
    entry(deny('Kiro judge unavailable: kiro-cli was not found on PATH'), { kind: 'pass', reason: 'ok' }),
  ])
  const haiku = summary.find((row) => row.candidate === 'haiku')!
  assert.equal(haiku.compared, 4)
  assert.equal(haiku.agreed, 2)
  assert.equal(haiku.leaks.length, 1)
  assert.equal(haiku.friction.length, 1)
  assert.equal(haiku.unavailable, 3)
  assert.equal(haiku.skipped, 1)
  assert.deepEqual(haiku.tokens, { 'claude-haiku-5-5': { input: 300, output: 30 } })
  assert.deepEqual(haiku.primaryTokens, { opus: { input: 80, output: 8 } })
  assert.equal(haiku.medianMs, 400)
  assert.equal(haiku.primaryMedianMs, 1000)
})
