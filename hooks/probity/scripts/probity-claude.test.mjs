// Issue #40: a sub-agent's PreToolUse payload carries the PARENT
// session's transcript_path plus an agent_id; the sub-agent's own tool
// calls live in <session>/subagents/agent-<id>.jsonl. probity-claude
// repoints transcript_path so history-based rules see the sub-agent's
// work.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { PROBITY_MAX_TRANSCRIPT_BYTES, preparePayload, subagentTranscript, transcriptTail } from './probity-claude.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WRAPPER = join(HERE, 'probity-claude.mjs')

function bashCall(id, command, output, extra = {}) {
  return [
    { type: 'assistant', ...extra, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
    { type: 'user', ...extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: false }] } },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')
}

/** A parent transcript plus one sub-agent transcript, laid out as Claude Code writes them. */
function session(t) {
  const dir = mkdtempSync(join(tmpdir(), 'probity-claude-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const parent = join(dir, 'session-1.jsonl')
  writeFileSync(parent, bashCall('toolu_parent', 'echo parent-run', 'parent-run') + '\n')
  mkdirSync(join(dir, 'session-1', 'subagents'), { recursive: true })
  const child = join(dir, 'session-1', 'subagents', 'agent-a1b2.jsonl')
  const failing = 'TokenClientTest[jvm] > rejects expired tokens[jvm] FAILED\n    AssertionError'
  writeFileSync(
    child,
    bashCall('toolu_child', './gradlew :sdk:anonyome:jvmTest', failing, { isSidechain: true, agentId: 'a1b2' }) + '\n',
  )
  return { dir, parent, child }
}

test('subagentTranscript points at the agent transcript beside the parent', (t) => {
  const { parent, child } = session(t)
  assert.equal(subagentTranscript({ transcript_path: parent, agent_id: 'a1b2' }), child)
})

test('payloads without an agent, or with no agent transcript on disk, are left alone', (t) => {
  const { parent } = session(t)
  assert.equal(subagentTranscript({ transcript_path: parent }), null)
  assert.equal(subagentTranscript({ transcript_path: parent, agent_id: 'missing' }), null)
  assert.equal(subagentTranscript({ transcript_path: parent, agent_id: '../../etc' }), null)
  const raw = JSON.stringify({ transcript_path: parent, tool_name: 'Bash' })
  assert.equal(preparePayload(raw).input, raw)
  assert.equal(preparePayload('not json').input, 'not json')
})

/** A project dir whose Probity config denies with every command it sees in history. */
function historyProject(dir) {
  const project = join(dir, 'project')
  mkdirSync(project)
  symlinkSync(join(HERE, '..', 'node_modules'), join(project, 'node_modules'), 'dir')
  writeFileSync(
    join(project, 'probity.config.mjs'),
    `export default { rules: [async function showHistory(action, ctx) {
      const commands = ((await ctx.history?.()) ?? []).filter((e) => e.kind === 'command')
      return { kind: 'violation', reason: 'seen: ' + commands.map((e) => e.command + ' => ' + e.output).join(' | ') }
    }] }\n`,
  )
  return project
}

function runWrapper(project, payload) {
  const res = spawnSync(process.execPath, [WRAPPER], {
    cwd: project,
    input: JSON.stringify({
      session_id: 'session-1',
      cwd: project,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m x' },
      ...payload,
    }),
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, res.stderr)
  return JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason
}

test('end to end: Probity rules see the sub-agent history through the wrapper', (t) => {
  const { dir, parent } = session(t)
  const project = historyProject(dir)
  const fromParent = runWrapper(project, { transcript_path: parent })
  assert.match(fromParent, /echo parent-run/)
  const fromAgent = runWrapper(project, { transcript_path: parent, agent_id: 'a1b2' })
  assert.match(fromAgent, /gradlew :sdk:anonyome:jvmTest => .*rejects expired tokens\[jvm\] FAILED/)
  assert.doesNotMatch(fromAgent, /parent-run/)
})

// Issue #54: Probity refuses a transcript over 100 MiB, and every
// history-based rule then fails closed with "rule error: ... exceeds
// 104857600 bytes" until the session is restarted. The wrapper hands
// Probity the most recent part of an oversized transcript instead.

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'probity-tail-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('transcriptTail leaves a transcript at or under the limit alone', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 's.jsonl')
  writeFileSync(path, 'a'.repeat(99) + '\n')
  assert.equal(transcriptTail(path, { maxBytes: 100, tailBytes: 40 }), null)
})

test('transcriptTail copies the newest whole lines of an oversized transcript to a private file', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 's.jsonl')
  const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({ n: i }))
  writeFileSync(path, lines.join('\n') + '\n')
  const tail = transcriptTail(path, { maxBytes: 50, tailBytes: 40 })
  t.after(() => tail && rmSync(dirname(tail), { recursive: true, force: true }))
  assert.ok(tail, 'expected a tail file')
  assert.ok(tail.endsWith('.jsonl'))
  const kept = readFileSync(tail, 'utf8')
  assert.ok(kept.length <= 40, `tail is ${kept.length} bytes`)
  assert.ok(kept.endsWith(lines.at(-1) + '\n'), 'keeps the newest line')
  for (const line of kept.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line), `partial line kept: ${line}`)
  assert.equal(statSync(tail).mode & 0o777, 0o600)
})

test('transcriptTail leaves a symlinked transcript for Probity to refuse', (t) => {
  const dir = tempDir(t)
  const real = join(dir, 'real.jsonl')
  writeFileSync(real, 'x'.repeat(200) + '\n')
  const link = join(dir, 'link.jsonl')
  symlinkSync(real, link)
  assert.equal(transcriptTail(link, { maxBytes: 100, tailBytes: 40 }), null)
})

test('preparePayload points an oversized transcript at its tail, and cleanup removes it', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 's.jsonl')
  writeFileSync(path, bashCall('toolu_old', 'echo old', 'old') + '\n' + bashCall('toolu_new', 'echo new', 'new') + '\n')
  const { input, cleanup } = preparePayload(JSON.stringify({ transcript_path: path }), { maxBytes: 100, tailBytes: 400 })
  const tail = JSON.parse(input).transcript_path
  assert.notEqual(tail, path)
  assert.match(readFileSync(tail, 'utf8'), /echo new/)
  cleanup()
  assert.equal(existsSync(tail), false)
})

test('end to end: an over-limit transcript still yields the recent history, not a rule error', (t) => {
  const { dir, parent } = session(t)
  const project = historyProject(dir)
  // Push the parent transcript past Probity's cap with blank lines (which
  // Probity skips), then record the run a commit gate would look for.
  appendFileSync(parent, Buffer.alloc(PROBITY_MAX_TRANSCRIPT_BYTES + 1024, '\n'))
  appendFileSync(parent, bashCall('toolu_build', './gradlew build', 'BUILD SUCCESSFUL in 9s') + '\n')
  const reason = runWrapper(project, { transcript_path: parent })
  assert.doesNotMatch(reason, /rule error|exceeds/)
  assert.match(reason, /gradlew build => BUILD SUCCESSFUL/)
})
