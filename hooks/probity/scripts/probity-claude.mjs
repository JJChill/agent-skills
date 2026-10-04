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
 * It also keeps long sessions working (issue #54). Probity refuses to
 * read a transcript over 100 MiB, and every history-based rule then
 * fails closed until the session is restarted. When the transcript is
 * over that limit, the wrapper copies its most recent part (whole lines
 * only) to a private temp file, points `transcript_path` there, and
 * deletes the copy when Probity exits. The gates only need recent
 * events: the last test run, the red before a green.
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
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
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

/** Probity refuses transcripts larger than this (`DEFAULT_MAX_BYTES` in its read-jsonl). */
export const PROBITY_MAX_TRANSCRIPT_BYTES = 100 * 1024 * 1024

/**
 * How much of an oversized transcript Probity is given: the newest
 * events. Large enough for hundreds of tool calls with their output,
 * small enough to stay well under the limit as the session grows.
 */
export const TRANSCRIPT_TAIL_BYTES = 32 * 1024 * 1024

/**
 * A private copy of the newest whole lines of `path` when it is larger
 * than `maxBytes`, or null to keep the original. A symlink or anything
 * that is not a regular file is left for Probity, which refuses it.
 */
export function transcriptTail(
  path,
  { maxBytes = PROBITY_MAX_TRANSCRIPT_BYTES, tailBytes = TRANSCRIPT_TAIL_BYTES } = {},
) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size <= maxBytes) return null
  const length = Math.min(tailBytes, stat.size)
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, length, stat.size - length)
  } finally {
    closeSync(fd)
  }
  // The read almost always starts mid-line: drop that partial line.
  const start = buffer.indexOf(0x0a) + 1
  const dir = mkdtempSync(join(tmpdir(), 'probity-claude-'))
  const tail = join(dir, basename(path))
  writeFileSync(tail, buffer.subarray(start), { mode: 0o600 })
  return tail
}

/**
 * The stdin to hand Probity — the payload with its transcript repointed
 * at a sub-agent's transcript and/or at the tail of an oversized one —
 * plus a cleanup that deletes any temp copy. Unparseable input passes
 * through unchanged.
 */
export function preparePayload(raw, limits = {}) {
  const unchanged = { input: raw, cleanup: () => {} }
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return unchanged
  }
  const original = payload?.transcript_path
  const transcript = subagentTranscript(payload) ?? original
  if (typeof transcript !== 'string') return unchanged
  const tail = transcriptTail(transcript, limits)
  const chosen = tail ?? transcript
  if (chosen === original) return unchanged
  return {
    input: JSON.stringify({ ...payload, transcript_path: chosen }),
    cleanup: () => {
      if (tail) rmSync(dirname(tail), { recursive: true, force: true })
    },
  }
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
  const { input, cleanup } = preparePayload(Buffer.concat(chunks).toString('utf8'))

  const args = process.argv.slice(2)
  if (!args.includes('--agent')) args.unshift('--agent', 'claude-code')

  let bin
  try {
    bin = probityBin()
  } catch (error) {
    console.error(`probity-claude: cannot find @nizos/probity from ${process.cwd()}: ${error.message}`)
    cleanup()
    process.exit(2)
  }
  const child = spawn(process.execPath, [bin, ...args], { stdio: ['pipe', 'inherit', 'inherit'] })
  child.stdin.end(input)
  child.on('exit', (code, signal) => {
    cleanup()
    process.exit(signal ? 1 : (code ?? 1))
  })
}

// Run only as a program (npm links bins through node_modules/.bin, so
// compare real paths), not when imported by tests.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main()
}
