#!/usr/bin/env node
/**
 * Claude Code hook entry point for Probity that sees sub-agent work.
 *
 * When a Claude Code sub-agent (the Agent/Task tool, including
 * `isolation: "worktree"` agents) calls a tool, the PreToolUse payload
 * carries the PARENT session's `transcript_path` plus an `agent_id`.
 * The sub-agent's own tool calls and their output are recorded only in
 * `<session>/subagents/agent-<agent_id>.jsonl` next to the parent
 * transcript. Probity reads `transcript_path`, so every history-based
 * rule judged a sub-agent's writes and commits against the parent's
 * history: the TDD judge never saw the sub-agent's red runs, and the
 * characterization marker could never be released (issue #40).
 *
 * This wrapper points `transcript_path` at the sub-agent's transcript
 * when the payload names an agent and that file exists, then runs the
 * project's Probity unchanged. Anything else passes through verbatim.
 *
 * Use it in place of the probity bin in `.claude/settings.json`:
 *
 *   "command": "cd \"$CLAUDE_PROJECT_DIR\" && ./node_modules/.bin/probity-claude"
 *
 * Extra arguments are forwarded; `--agent claude-code` is added unless
 * one is given. Zero dependencies; Probity is resolved from the working
 * directory's node_modules, exactly as the direct bin would be.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The sub-agent transcript for a payload, or null to keep the original. */
export function subagentTranscript(payload) {
  const { agent_id: agentId, transcript_path: transcript } = payload ?? {}
  if (typeof agentId !== 'string' || !/^[\w-]+$/.test(agentId)) return null
  if (typeof transcript !== 'string' || !transcript.endsWith('.jsonl')) return null
  const candidate = join(
    dirname(transcript),
    basename(transcript, '.jsonl'),
    'subagents',
    `agent-${agentId}.jsonl`,
  )
  return existsSync(candidate) ? candidate : null
}

/** The stdin to hand Probity: the payload with its transcript repointed. */
export function rewritePayload(raw) {
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return raw
  }
  const transcript = subagentTranscript(payload)
  return transcript ? JSON.stringify({ ...payload, transcript_path: transcript }) : raw
}

function probityBin() {
  // @nizos/probity doesn't export its package.json, so resolve the main
  // entry and walk up to the package root for the bin path.
  const require = createRequire(join(process.cwd(), 'noop.js'))
  let dir = dirname(require.resolve('@nizos/probity'))
  while (dir !== dirname(dir)) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name === '@nizos/probity') {
        const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.probity
        return join(dir, bin)
      }
    }
    dir = dirname(dir)
  }
  throw new Error('package root not found')
}

async function main() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const input = rewritePayload(Buffer.concat(chunks).toString('utf8'))

  const args = process.argv.slice(2)
  if (!args.includes('--agent')) args.unshift('--agent', 'claude-code')

  let bin
  try {
    bin = probityBin()
  } catch (error) {
    console.error(`probity-claude: cannot find @nizos/probity from ${process.cwd()}: ${error.message}`)
    process.exit(2)
  }
  const child = spawn(process.execPath, [bin, ...args], { stdio: ['pipe', 'inherit', 'inherit'] })
  child.stdin.end(input)
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
}

// Run only as a program (npm links bins through node_modules/.bin, so
// compare real paths), not when imported by tests.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main()
}
