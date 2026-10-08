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
 * And it runs Probity in the right tree (issue #66). The hook `cd`s to
 * $CLAUDE_PROJECT_DIR, which still names the main checkout after a
 * session moves into a worktree (EnterWorktree, or an `isolation:
 * "worktree"` sub-agent). Probity finds its config by searching upward
 * from its working directory, so every rule judged the main checkout's
 * specs and files. When the edited file (or, for a command, the
 * session's cwd) is inside a git worktree nested in the project that
 * has its own probity.config.*, the wrapper starts Probity there. That
 * config's imports still resolve from the project's node_modules, one
 * directory level up the tree.
 *
 * The same goes for a worktree beside the project (`git worktree add
 * ../<name>`, issue #90), found through `git worktree list`. Its config
 * can't reach the project's node_modules by walking upward, so the
 * wrapper adds that directory to NODE_PATH, which Node consults only
 * after the worktree's own node_modules. When the packages resolve
 * nowhere, Probity's deny says to run `npm ci` in that tree.
 *
 * Finally, it keeps a broken config fixable (issue #81). Probity loads
 * probity.config.* on every call and blocks everything when that load
 * throws, including the edit that would fix it. So for an Edit or Write
 * to the config Probity would load, the wrapper loads the after-state
 * first (in a scratch copy beside the config) and blocks an edit that
 * would leave it unloadable. And if the config already fails to load,
 * edits to it pass through to the normal permission flow while every
 * other call stays blocked, with a deny that says how to recover.
 *
 * Use it in place of the probity bin in `.claude/settings.json`:
 *
 *   "command": "cd \"$CLAUDE_PROJECT_DIR\" && ./node_modules/.bin/probity-claude"
 *
 * Extra arguments are forwarded; `--agent claude-code` is added unless
 * one is given. Zero dependencies; Probity is resolved from the working
 * directory's node_modules, exactly as the direct bin would be.
 */
import { execFileSync, spawn } from 'node:child_process'
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
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

const CONFIG_NAMES = ['ts', 'mts', 'js', 'mjs'].map((ext) => `probity.config.${ext}`)

function canonical(path) {
  // Resolve symlinks on the longest existing prefix (a file being
  // created does not exist yet), so paths compare like the project dir.
  let head = resolve(path)
  const tail = []
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(basename(head))
    head = dirname(head)
  }
  try {
    head = realpathSync(head)
  } catch {
    // keep the resolved path
  }
  return join(head, ...tail)
}

function isBelow(parent, child) {
  const path = relative(parent, child)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

// The directory a command explicitly acts in: `git -C <dir>`, else a
// leading `cd <dir> &&`; null when it names none. Mirrors the commit
// gates' commitDirectory (rules/commit-target.ts), so a worktree session
// that commits in the main checkout is judged there.
function commandDirectory(command) {
  const unquote = (value) => value.replace(/^(['"])(.*)\1$/, '$2')
  const gitDashC = command.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/)
  const cd = command.match(/^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)/)
  const target = gitDashC?.[1] ?? cd?.[1]
  return target ? unquote(target) : null
}

/** The roots of every worktree of the repository at `dir`, or [] when git can't say. */
function worktreeRoots(dir) {
  try {
    const listing = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return listing
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => canonical(line.slice('worktree '.length)))
  } catch {
    return []
  }
}

/**
 * The git worktree to run Probity in for this payload, or null to stay
 * in `projectDir`: the nearest directory holding `.git` above the edited
 * file (for a command, the session's cwd), when it lies below
 * `projectDir` and has its own Probity config. Outside `projectDir`, the
 * worktree of the project's repository that holds that path (a sibling
 * made with `git worktree add ../<name>`), when it has its own config. A
 * command's directory is its `git -C <dir>` or leading `cd <dir> &&`,
 * else the session's cwd.
 */
export function probityDirectory(payload, projectDir) {
  const input = payload?.tool_input ?? {}
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : null
  const file = [input.file_path, input.notebook_path].find((value) => typeof value === 'string')
  const base = cwd ?? projectDir
  let start
  if (file) start = dirname(isAbsolute(file) ? file : resolve(base, file))
  else if (typeof input.command === 'string') start = resolve(base, commandDirectory(input.command) ?? '.')
  else if (cwd) start = cwd
  else return null
  const project = canonical(projectDir)
  const hasConfig = (dir) => CONFIG_NAMES.some((name) => existsSync(join(dir, name)))
  const target = canonical(start)
  for (let dir = target; isBelow(project, dir); dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return hasConfig(dir) ? dir : null
  }
  if (target === project || isBelow(project, target)) return null
  const sibling = worktreeRoots(project)
    .filter((root) => root !== project && (root === target || isBelow(root, target)))
    .sort((a, b) => b.length - a.length)[0]
  return sibling && hasConfig(sibling) ? sibling : null
}

/**
 * `env` with `projectDir`'s node_modules appended to NODE_PATH, so a
 * config in a worktree without its own packages loads the project's.
 * Node consults NODE_PATH only after the node_modules directories above
 * the importing file, so a worktree's own install still wins.
 */
export function withPackageFallback(env, projectDir) {
  const fallback = join(projectDir, 'node_modules')
  const paths = (env.NODE_PATH ?? '').split(delimiter).filter(Boolean)
  return paths.includes(fallback) ? env : { ...env, NODE_PATH: [...paths, fallback].join(delimiter) }
}

const MISSING_PACKAGE = /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/

const INSTALL_COMMAND =
  /^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:npm\s+(?:ci|install|i)|pnpm\s+(?:install|i)|yarn(?:\s+install)?|bun\s+install)(?:\s+-[\w-]+(?:=\S+)?)*\s*$/

/**
 * Whether `command` only installs packages, with nothing chained to it.
 * When a config's packages resolve nowhere, every call is denied but
 * this one, so the session can install them. Mirrors the Kiro shim's
 * `install` check (kiro/probity-kiro-translate.py).
 */
export function isInstallCommand(command) {
  return typeof command === 'string' && INSTALL_COMMAND.test(command)
}

/** `args` with a relative `--debug <path>` anchored to `projectDir`, so the log stays put when Probity runs elsewhere. */
export function debugArgs(args, projectDir) {
  return args.map((arg, i) =>
    args[i - 1] === '--debug' && !isAbsolute(arg) ? join(projectDir, arg) : arg,
  )
}

/**
 * The config Probity will load when run in `dir` with `args`: its
 * `--config` (resolved against `dir`, as Probity does), else the
 * nearest probity.config.* searching upward. Null when there is none.
 */
export function activeConfig(dir, args = []) {
  const flag = args.indexOf('--config')
  if (flag !== -1 && typeof args[flag + 1] === 'string') return resolve(dir, args[flag + 1])
  for (let current = resolve(dir); ; current = dirname(current)) {
    const name = CONFIG_NAMES.find((candidate) => existsSync(join(current, candidate)))
    if (name) return join(current, name)
    if (dirname(current) === current) return null
  }
}

/** Whether the payload is an Edit or Write of `config`. */
export function targetsConfig(payload, config) {
  if (!config || !['Edit', 'Write'].includes(payload?.tool_name)) return false
  const file = payload.tool_input?.file_path
  if (typeof file !== 'string') return false
  const base = typeof payload.cwd === 'string' ? payload.cwd : process.cwd()
  return canonical(isAbsolute(file) ? file : resolve(base, file)) === canonical(config)
}

/**
 * The content an Edit or Write leaves `path` with, or null when Claude
 * Code would reject the call anyway (old_string missing, or ambiguous
 * without replace_all). Matches in LF space, like Probity's applyEdit.
 */
export function afterState(payload, path) {
  const input = payload?.tool_input ?? {}
  if (payload?.tool_name === 'Write') return typeof input.content === 'string' ? input.content : null
  if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return null
  let current
  try {
    current = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return null
  }
  const oldString = input.old_string.replace(/\r\n/g, '\n')
  const newString = input.new_string.replace(/\r\n/g, '\n')
  if (oldString === '' || !current.includes(oldString)) return null
  if (!input.replace_all && current.indexOf(oldString) !== current.lastIndexOf(oldString)) return null
  return input.replace_all
    ? current.replaceAll(oldString, () => newString)
    : current.replace(oldString, () => newString)
}

/**
 * Loads `config` with Probity's own loader and returns the error
 * message, or null when it loads. With `content`, loads that text
 * instead, from a scratch file beside the config so its relative and
 * node_modules imports resolve the same way; the scratch file's name
 * is not one Probity would ever pick up, and it is always removed.
 * Throws only when the check itself cannot run (no loader, no scratch).
 */
export async function configLoadError(probityRoot, config, content) {
  // loadConfig is not on the package's exports map; import it by path.
  const { loadConfig } = await import(pathToFileURL(join(probityRoot, 'dist', 'config.js')).href)
  let target = config
  if (content !== undefined) {
    target = join(dirname(config), `.probity-config-check-${process.pid}${extname(config)}`)
    writeFileSync(target, content)
  }
  try {
    await loadConfig(target)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    if (target !== config) rmSync(target, { force: true })
  }
}

/** A Claude Code PreToolUse deny with `reason`. */
function denyResponse(reason) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  })
}

/** The deny for an edit whose after-state would not load. */
export function brokenEditReason(config, error) {
  return (
    `Probity: this edit would leave ${basename(config)} unable to load (${error}), and a config ` +
    'that fails to load blocks every tool call, including the edit that would fix it. Make every ' +
    'intermediate state load (add an import before its first use), or rewrite the file in one Write.'
  )
}

/** `response` (Probity's stdout) with the self-repair hint appended to its deny reason. */
export function withLockoutHint(response, config) {
  let parsed
  try {
    parsed = JSON.parse(response)
  } catch {
    return response
  }
  const output = parsed?.hookSpecificOutput
  if (output?.permissionDecision !== 'deny') return response
  output.permissionDecisionReason +=
    `\n${config} failed to load, so Probity blocks every tool call until it does. ` +
    `Edit or Write ${config} to fix it: those calls are not blocked while it is broken.`
  return JSON.stringify(parsed)
}

/** `response` (Probity's stdout) with an install hint appended to a deny caused by a package that doesn't resolve. */
export function withInstallHint(response, dir) {
  let parsed
  try {
    parsed = JSON.parse(response)
  } catch {
    return response
  }
  const output = parsed?.hookSpecificOutput
  if (output?.permissionDecision !== 'deny' || !MISSING_PACKAGE.test(output.permissionDecisionReason)) return response
  output.permissionDecisionReason +=
    `\nProbity's config in ${dir} imports a package that isn't installed, so every tool call is ` +
    `blocked. Run npm ci in ${dir}.`
  return JSON.stringify(parsed)
}

function probityRoot() {
  // @nizos/probity doesn't export its package.json, so resolve the main
  // entry and walk up to the package root.
  const require = createRequire(join(process.cwd(), 'noop.js'))
  let dir = dirname(require.resolve('@nizos/probity'))
  while (dir !== dirname(dir)) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name === '@nizos/probity') {
        const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.probity
        return { root: dir, bin: join(dir, bin) }
      }
    }
    dir = dirname(dir)
  }
  throw new Error('package root not found')
}

async function main() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  const { input, cleanup } = preparePayload(raw)
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = null
  }
  const projectDir = process.cwd()
  const workDir = probityDirectory(payload, projectDir) ?? projectDir

  // In-process config checks load the worktree's config too.
  const env = withPackageFallback(process.env, projectDir)
  if (env !== process.env) {
    process.env.NODE_PATH = env.NODE_PATH
    Module._initPaths()
  }

  const args = debugArgs(process.argv.slice(2), projectDir)
  if (!args.includes('--agent')) args.unshift('--agent', 'claude-code')

  let probity
  try {
    probity = probityRoot()
  } catch (error) {
    console.error(`probity-claude: cannot find @nizos/probity from ${process.cwd()}: ${error.message}`)
    cleanup()
    process.exit(2)
  }

  // A crash here would exit non-zero, which Claude Code treats as
  // "proceed": when the check itself cannot run, leave it to Probity.
  const config = activeConfig(workDir, args)
  if (targetsConfig(payload, config)) {
    try {
      if (await configLoadError(probity.root, config)) {
        // Broken already: let the fix through to the normal permission flow.
        console.error(`probity-claude: ${config} fails to load; not blocking this edit to it`)
        cleanup()
        process.exit(0)
      }
      const after = afterState(payload, config)
      const error = after === null ? null : await configLoadError(probity.root, config, after)
      if (error) {
        process.stdout.write(denyResponse(brokenEditReason(config, error)))
        cleanup()
        process.exit(0)
      }
    } catch (error) {
      console.error(`probity-claude: cannot check the edit to ${config}: ${error.message}`)
    }
  }

  const child = spawn(process.execPath, [probity.bin, ...args], {
    cwd: workDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const out = []
  const err = []
  child.stdout.on('data', (chunk) => out.push(chunk))
  child.stderr.on('data', (chunk) => err.push(chunk))
  child.stdin.end(input)
  child.on('close', async (code, signal) => {
    cleanup()
    let stdout = Buffer.concat(out).toString('utf8')
    const stderr = Buffer.concat(err).toString('utf8')
    // Probity writes `Probity: <reason>` to stderr only when it fails
    // closed outside the rules; confirm it was the config before saying so.
    try {
      const hinted = withInstallHint(stdout, workDir)
      if (hinted !== stdout) stdout = isInstallCommand(payload?.tool_input?.command) ? '' : hinted
      else if (config && stderr.startsWith('Probity: ') && (await configLoadError(probity.root, config))) {
        stdout = withLockoutHint(stdout, config)
      }
    } catch {
      // Forward Probity's deny as it is.
    }
    process.stdout.write(stdout)
    process.stderr.write(stderr)
    process.exitCode = signal ? 1 : (code ?? 1)
  })
}

// Run only as a program (npm links bins through node_modules/.bin, so
// compare real paths), not when imported by tests.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main()
}
