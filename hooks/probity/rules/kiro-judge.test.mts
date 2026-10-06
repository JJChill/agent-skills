// A Probity judge on kiro-cli, and a chain that falls back between
// judges, so judged writes keep working when the Claude login's spend
// limit is reached (requested from mysudo-core).
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Agent, Rule, RuleContext } from '@nizos/probity'

import { isJudgeUnavailable, withJudgeFailureDiagnostics } from './gates.ts'
import { KIRO_JUDGE_AGENT, judgeChain, kiroJudge, type KiroRun, type KiroRunResult } from './kiro-judge.ts'

const ok = (stdout: string, extra: Partial<KiroRunResult> = {}): KiroRunResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  timedOut: false,
  ...extra,
})

function fakeRun(result: KiroRunResult) {
  const calls: { command: string; args: string[]; cwd: string; input: string; timeoutMs: number }[] = []
  const run: KiroRun = async (command, args, options) => {
    calls.push({ command, args, ...options })
    return result
  }
  return { run, calls }
}

const cwd = () => mkdtempSync(join(tmpdir(), 'kiro-judge-test-'))

test('runs kiro-cli with the judge-only agent, no trusted tools, and the prompt on stdin', async () => {
  const dir = cwd()
  const { run, calls } = fakeRun(ok('{"kind":"pass","reason":"fine"}'))
  const verdict = await kiroJudge({ run, cwd: dir, model: 'm1', effort: 'high', timeoutMs: 5_000 }).reason('PROMPT')
  assert.equal(verdict.kind, 'pass')
  assert.equal(verdict.reason, 'fine')
  assert.deepEqual(verdict.meta && { judge: verdict.meta.judge, model: verdict.meta.model }, { judge: 'kiro', model: 'm1' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.command, 'kiro-cli')
  assert.deepEqual(calls[0]!.args, [
    'chat', '--no-interactive', '--agent', KIRO_JUDGE_AGENT, '--model', 'm1', '--effort', 'high', '--trust-tools=',
  ])
  assert.equal(calls[0]!.input, 'PROMPT')
  assert.equal(calls[0]!.cwd, dir)
  assert.equal(calls[0]!.timeoutMs, 5_000)
})

test('writes a judge agent with no tools and no hooks into its working directory', async () => {
  const dir = cwd()
  const { run } = fakeRun(ok('{"kind":"pass","reason":""}'))
  await kiroJudge({ run, cwd: dir }).reason('p')
  const config = JSON.parse(readFileSync(join(dir, '.kiro', 'agents', `${KIRO_JUDGE_AGENT}.json`), 'utf8'))
  assert.equal(config.name, KIRO_JUDGE_AGENT)
  assert.deepEqual(config.tools, [])
  assert.deepEqual(config.hooks, {})
  assert.deepEqual(config.resources, [])
})

test('a named agent is used as is, and no judge agent is written', async () => {
  const dir = cwd()
  const { run, calls } = fakeRun(ok('{"kind":"pass","reason":""}'))
  await kiroJudge({ run, cwd: dir, agent: 'my-judge' }).reason('p')
  assert.equal(calls[0]!.args[3], 'my-judge')
  assert.equal(existsSync(join(dir, '.kiro', 'agents', `${KIRO_JUDGE_AGENT}.json`)), false)
})

test('parses a fenced verdict, and the last verdict after prose and colour codes', async () => {
  const fenced = fakeRun(ok('```json\n{"kind":"violation","reason":"no red"}\n```'))
  assert.deepEqual(
    { ...(await kiroJudge({ run: fenced.run, cwd: cwd() }).reason('p')), meta: undefined },
    { kind: 'violation', reason: 'no red', meta: undefined },
  )
  const prose = fakeRun(ok('\u001b[38;5;244mThinking {about it}\u001b[0m\nSo: {"kind":"pass","reason":"has a {brace}"}\n'))
  const verdict = await kiroJudge({ run: prose.run, cwd: cwd() }).reason('p')
  assert.equal(verdict.kind, 'pass')
  assert.equal(verdict.reason, 'has a {brace}')
})

test('an answer that is not a verdict is reported as Probity reports one, so the presets ask again', async () => {
  const { run } = fakeRun(ok('I think this is fine.'))
  const verdict = await kiroJudge({ run, cwd: cwd() }).reason('p')
  assert.equal(verdict.kind, 'violation')
  assert.match(verdict.reason, /^could not parse verdict from validator output: I think this is fine\./)
  assert.equal(isJudgeUnavailable(verdict.reason), false)

  const shape = fakeRun(ok('{"kind":"maybe","reason":"x"}'))
  const bad = await kiroJudge({ run: shape.run, cwd: cwd() }).reason('p')
  assert.match(bad.reason, /^validator returned unexpected shape at kind/)
})

test('missing kiro-cli, a non-zero exit, a timeout, or no output: Kiro judge unavailable', async () => {
  const enoent = Object.assign(new Error('spawn kiro-cli ENOENT'), { code: 'ENOENT' })
  const cases: [KiroRunResult, RegExp][] = [
    [{ exitCode: null, stdout: '', stderr: '', timedOut: false, error: enoent }, /kiro-cli was not found on PATH/],
    [ok('', { exitCode: 1, stderr: "Error: The model 'x' is not available." }), /exited with code 1\. Output: Error: The model 'x' is not available\./],
    [ok('', { exitCode: null, timedOut: true }), /no answer within 60000 ms/],
    [ok('  \n'), /printed no answer/],
  ]
  for (const [result, cause] of cases) {
    const verdict = await kiroJudge({ run: fakeRun(result).run, cwd: cwd() }).reason('p')
    assert.equal(verdict.kind, 'violation')
    assert.match(verdict.reason, /^Kiro judge unavailable: /)
    assert.match(verdict.reason, cause)
    assert.equal(isJudgeUnavailable(verdict.reason), true)
  }
})

test('an unavailable Kiro judge is reported as an infrastructure failure and not retried', async () => {
  let calls = 0
  const rule: Rule = async function enforceTdd(_action, ctx) {
    calls++
    const verdict = await ctx!.agent!.reason('p')
    return verdict.kind === 'pass' ? { kind: 'pass' } : { kind: 'violation', reason: verdict.reason }
  }
  const { run } = fakeRun(ok('', { exitCode: 1, stderr: 'Error: monthly spend limit reached' }))
  const ctx = { agent: kiroJudge({ run, cwd: cwd() }) } as unknown as RuleContext
  const result = await withJudgeFailureDiagnostics(rule)({ kind: 'write', path: '/r/a.ts', content: 'x' }, ctx)
  assert.equal(calls, 1)
  assert.equal(result.kind, 'violation')
  assert.match(result.reason ?? '', /returned no verdict, so this write was NOT judged/)
  assert.match(result.reason ?? '', /spend limit, quota, rate limit, or authentication/)
  assert.match(result.reason ?? '', /Judge output: kiro-cli exited with code 1\. Output: Error: monthly spend limit reached/)
})

function scripted(...verdicts: { kind: 'pass' | 'violation'; reason: string }[]) {
  let calls = 0
  const agent: Agent = {
    reason: async () => verdicts[Math.min(calls++, verdicts.length - 1)]!,
  }
  return { agent, calls: () => calls }
}

test('judgeChain falls back only when a judge is unavailable', async () => {
  const down = scripted({ kind: 'violation', reason: 'Kiro judge unavailable: kiro-cli was not found on PATH' })
  const claude = scripted({ kind: 'pass', reason: '' })
  assert.equal((await judgeChain([down.agent, claude.agent]).reason('p')).kind, 'pass')
  assert.equal(claude.calls(), 1)

  const deny = scripted({ kind: 'violation', reason: 'No failing test was observed.' })
  const unused = scripted({ kind: 'pass', reason: '' })
  const verdict = await judgeChain([deny.agent, unused.agent]).reason('p')
  assert.equal(verdict.reason, 'No failing test was observed.')
  assert.equal(unused.calls(), 0)

  const garbled = scripted({ kind: 'violation', reason: 'could not parse verdict from validator output: hmm' })
  const notAsked = scripted({ kind: 'pass', reason: '' })
  await judgeChain([garbled.agent, notAsked.agent]).reason('p')
  assert.equal(notAsked.calls(), 0)
})

test('judgeChain treats a Claude spend limit as unavailable, so the order can be either way', async () => {
  const claude = scripted({
    kind: 'violation',
    reason: "could not parse verdict from validator output: You've hit your org's monthly spend limit",
  })
  const kiro = scripted({ kind: 'violation', reason: 'Production code without a failing test.' })
  const verdict = await judgeChain([claude.agent, kiro.agent]).reason('p')
  assert.equal(verdict.reason, 'Production code without a failing test.')
})

test('judgeChain skips a judge that was just unavailable, then tries it again later', async () => {
  const down = scripted({ kind: 'violation', reason: 'Kiro judge unavailable: no answer within 60000 ms' })
  const claude = scripted({ kind: 'pass', reason: '' })
  const chain = judgeChain([down.agent, claude.agent], { skipUnavailableMs: 50 })
  await chain.reason('p')
  await chain.reason('p')
  assert.equal(down.calls(), 1)
  assert.equal(claude.calls(), 2)
  await new Promise((resolve) => setTimeout(resolve, 60))
  await chain.reason('p')
  assert.equal(down.calls(), 2)
})

test('judgeChain reports every judge when none is available, first judge first', async () => {
  const kiro = scripted({ kind: 'violation', reason: 'Kiro judge unavailable: kiro-cli was not found on PATH' })
  const claude = scripted({ kind: 'violation', reason: 'no result message received: stream ended' })
  const verdict = await judgeChain([kiro.agent, claude.agent]).reason('p')
  assert.equal(verdict.kind, 'violation')
  assert.match(verdict.reason, /^Kiro judge unavailable: kiro-cli was not found on PATH\n\nFallback judge: no result message received/)
  assert.equal(isJudgeUnavailable(verdict.reason), true)
})

test('runs a real process: prompt on stdin, answer on stdout, killed on timeout', async () => {
  const dir = cwd()
  const fake = join(dir, 'fake-kiro')
  writeFileSync(
    fake,
    '#!/usr/bin/env node\n' +
      "let input = ''\n" +
      "process.stdin.on('data', (c) => { input += c })\n" +
      "process.stdin.on('end', () => {\n" +
      "  if (input.includes('SLOW')) { setTimeout(() => {}, 60_000); return }\n" +
      "  const agent = process.argv[process.argv.indexOf('--agent') + 1]\n" +
      "  process.stdout.write(JSON.stringify({ kind: 'pass', reason: `${input.length} ${agent} ${process.env.PROBITY_JUDGE}` }))\n" +
      '})\n',
  )
  chmodSync(fake, 0o755)
  const big = 'x'.repeat(300_000)
  const verdict = await kiroJudge({ command: fake, cwd: dir }).reason(big)
  assert.equal(verdict.kind, 'pass')
  assert.equal(verdict.reason, `300000 ${KIRO_JUDGE_AGENT} 1`)

  const started = Date.now()
  const slow = await kiroJudge({ command: fake, cwd: dir, timeoutMs: 300 }).reason('SLOW')
  assert.match(slow.reason, /^Kiro judge unavailable: no answer within 300 ms/)
  assert.ok(Date.now() - started < 5_000)

  const missing = await kiroJudge({ command: join(dir, 'no-such-kiro'), cwd: dir }).reason('p')
  assert.match(missing.reason, /^Kiro judge unavailable: .*no-such-kiro was not found on PATH/)
})
