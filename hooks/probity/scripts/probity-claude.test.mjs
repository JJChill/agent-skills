// Issue #40: a sub-agent's PreToolUse payload carries the PARENT
// session's transcript_path plus an agent_id; the sub-agent's own tool
// calls live in <session>/subagents/agent-<id>.jsonl. probity-claude
// repoints transcript_path so history-based rules see the sub-agent's
// work.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { rewritePayload, subagentTranscript } from './probity-claude.mjs'

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
  assert.equal(rewritePayload(raw), raw)
  assert.equal(rewritePayload('not json'), 'not json')
})

test('end to end: Probity rules see the sub-agent history through the wrapper', (t) => {
  const { dir, parent } = session(t)
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
  const run = (payload) => {
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
  const fromParent = run({ transcript_path: parent })
  assert.match(fromParent, /echo parent-run/)
  const fromAgent = run({ transcript_path: parent, agent_id: 'a1b2' })
  assert.match(fromAgent, /gradlew :sdk:anonyome:jvmTest => .*rejects expired tokens\[jvm\] FAILED/)
  assert.doesNotMatch(fromAgent, /parent-run/)
})
