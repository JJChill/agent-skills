import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'shadow-report.ts')
const TSX = join(HERE, '..', 'node_modules', '.bin', 'tsx')

function line(primaryKind, candidateKind, extra = {}) {
  return JSON.stringify({
    at: '2026-10-21T10:00:00.000Z',
    promptSha256: `sha-${primaryKind}-${candidateKind}`,
    primary: { name: 'claude', kind: primaryKind, reason: `primary says ${primaryKind}`, durationMs: 8000 },
    candidates: [{ name: 'claude:claude-haiku-5-5', kind: candidateKind, reason: `haiku says ${candidateKind}`, durationMs: 2000, ...extra }],
  })
}

function report(t, content, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-report-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = join(dir, 'shadow.jsonl')
  writeFileSync(log, content)
  return spawnSync(TSX, [SCRIPT, log, ...args], { encoding: 'utf8' })
}

test('reports agreement, leaks and friction per candidate', (t) => {
  const usage = { meta: { models: [{ model: 'claude-haiku-5-5', inputTokens: 1000, outputTokens: 50 }] } }
  const res = report(t, [line('pass', 'pass', usage), line('violation', 'violation', usage), line('violation', 'pass'), line('pass', 'violation'), 'not json'].join('\n') + '\n')
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /4 verdicts/)
  assert.match(res.stdout, /1 unreadable line skipped/)
  assert.match(res.stdout, /claude:claude-haiku-5-5/)
  assert.match(res.stdout, /agreed 2 of 4 \(50\.0%\)/)
  assert.match(res.stdout, /leaks 1 /)
  assert.match(res.stdout, /friction 1 /)
  assert.match(res.stdout, /median 2\.0 s \(primary 8\.0 s\)/)
  assert.match(res.stdout, /tokens:\n    claude-haiku-5-5: in 2,000, out 100/)
  assert.match(res.stdout, /primary tokens: none recorded/)
  // Disagreements are listed only on request.
  assert.doesNotMatch(res.stdout, /haiku says pass/)
})

test('--show leaks lists each leak with both reasons and the prompt hash to find it by', (t) => {
  const res = report(t, [line('violation', 'pass'), line('pass', 'violation')].join('\n') + '\n', ['--show', 'leaks'])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /sha-violation-pass/)
  assert.match(res.stdout, /primary: primary says violation/)
  assert.match(res.stdout, /candidate: haiku says pass/)
  assert.doesNotMatch(res.stdout, /sha-pass-violation/)
})

test('a missing log is an error with usage', (t) => {
  const res = spawnSync(TSX, [SCRIPT, join(tmpdir(), 'no-such-shadow.jsonl')], { encoding: 'utf8' })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /cannot read/)
})
