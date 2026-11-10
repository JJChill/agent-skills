import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Agent, Verdict } from '@nizos/probity'

import { isJudgeUnavailable } from './gates.js'

/**
 * AI judges other than Probity's default, and a chain that falls back
 * between them.
 *
 * Why: Probity's judged rules (enforceTdd and the rest) call
 * `ctx.agent.reason(prompt)`. Unless `probity.config.ts` sets `ai`,
 * that agent is the Claude Agent SDK on the user's Claude login. When
 * the login's spend limit is reached, every judged write fails closed.
 * `kiroJudge` runs the same prompt on kiro-cli instead; `judgeChain`
 * tries judges in order and moves on when one is unavailable, so a
 * committed config also works on a checkout without kiro-cli:
 *
 *   export default defineConfig({
 *     rules: kmpRuleEntries(root),
 *     ai: judgeChain([kiroJudge(), claudeJudge()]),
 *   })
 */

/** The judge-only Kiro agent `kiroJudge` runs by default. */
export const KIRO_JUDGE_AGENT = 'probity-judge'

// No tools, so the judge cannot read or write files, run commands, or
// trigger a preToolUse hook (Probity's own Kiro shim included). No
// hooks or resources, so a global default agent's userPromptSubmit
// hook never adds to the prompt. `--trust-tools=` alone is not enough:
// kiro_default still auto-allows reads under its working directory.
const KIRO_JUDGE_AGENT_CONFIG = `${JSON.stringify(
  {
    name: KIRO_JUDGE_AGENT,
    description:
      'Probity AI judge (written by @jjchill/probity-rules): answers one verdict prompt with JSON. No tools, hooks or resources.',
    prompt: 'You are a code-policy validator. Answer only from the prompt you are given.',
    tools: [],
    allowedTools: [],
    resources: [],
    hooks: {},
  },
  null,
  2,
)}\n`

/** What one kiro-cli run produced. `error` is set when it never started. */
export type KiroRunResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /**
   * kiro-cli printed a complete verdict and then went quiet without
   * exiting, so the run was stopped and the verdict taken (#200).
   */
  answered?: boolean
  error?: NodeJS.ErrnoException
}

/**
 * When the hook running Probity must finish, in epoch milliseconds. The
 * Kiro shim sets it on kiro-cli 3.x, which lets a call through once its
 * hook has run 60 s; `kiroJudge` keeps its run inside it (#200).
 */
export const HOOK_DEADLINE_ENV = 'PROBITY_HOOK_DEADLINE_MS'

/**
 * A file `kiroJudge` and `claudeJudge` note themselves in when asked, so
 * the Kiro shim can say which judge a timed-out call was waiting on.
 */
export const JUDGE_STATUS_ENV = 'PROBITY_JUDGE_STATUS'

function noteJudge(judge: string): void {
  const file = process.env[JUDGE_STATUS_ENV]
  if (!file) return
  try {
    writeFileSync(file, JSON.stringify({ judge, at: Date.now() }))
  } catch {
    // Only the timeout message loses detail.
  }
}

/** Runs kiro-cli; injectable so tests never start a real process. */
export type KiroRun = (
  command: string,
  args: string[],
  options: { cwd: string; input: string; timeoutMs: number },
) => Promise<KiroRunResult>

export type KiroJudgeOptions = {
  /** kiro-cli model id. Default `claude-opus-5.5`. */
  model?: string
  /**
   * kiro-cli effort level. Default `high`: on a replica of real
   * sessions, `medium` let a production write with no failing test
   * through 7 times in 25, against 0 in 15 at `high`.
   */
  effort?: string
  /**
   * Kiro agent to run. Default {@link KIRO_JUDGE_AGENT}, which
   * `kiroJudge` writes into its own working directory. Name another
   * agent only if it has no tools and no hooks.
   */
  agent?: string
  /** Kill the run and report the judge unavailable after this long. Default 60,000 ms. */
  timeoutMs?: number
  /**
   * Under a hook deadline (`PROBITY_HOOK_DEADLINE_MS`, set by the Kiro
   * shim on kiro-cli 3.x), the run also stops this long before the
   * deadline, so the next judge in a `judgeChain` still has time to
   * answer. Default 20,000 ms. Set 0 when `kiroJudge` is the only judge.
   */
  fallbackReserveMs?: number
  /** The kiro-cli executable. Default `kiro-cli`, found on PATH. */
  command?: string
  /**
   * Working directory for kiro-cli. Kiro stores a chat session per run
   * under its working directory, so the default is a directory of its
   * own (`<tmpdir>/probity-kiro-judge`), away from the project's
   * session list.
   */
  cwd?: string
  /** Replaces the process runner (tests). */
  run?: KiroRun
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_FALLBACK_RESERVE_MS = 20_000
// Less time than this left before the deadline is not worth a kiro-cli start.
const MIN_RUN_MS = 2_000
// How long kiro-cli may stay quiet after printing a complete verdict
// before the run is stopped and the verdict taken.
const ANSWER_SETTLE_MS = 1_000
const OUTPUT_LIMIT = 1_000_000
const OUTPUT_EXCERPT = 2_000

/**
 * A Probity AI judge (`Agent`) that answers on kiro-cli.
 *
 * Each verdict is one `kiro-cli chat --no-interactive` run, with the
 * prompt on stdin (judge prompts can exceed Linux's 128 KB limit on a
 * single argument) and a judge-only agent that has no tools or hooks.
 * The answer is parsed as strictly as Probity's own judge: a JSON
 * verdict, bare, fenced, or last in the output.
 *
 * It fails closed. When kiro-cli is missing, exits non-zero, times
 * out, or prints nothing, the verdict is a violation whose reason
 * starts "Kiro judge unavailable:", which `withJudgeFailureDiagnostics`
 * reports as an infrastructure failure and `judgeChain` treats as the
 * cue to try the next judge. An answer that is not a valid verdict is
 * reported the way Probity reports one ("could not parse verdict from
 * validator output: …"), so the presets ask once more.
 */
export function kiroJudge(options: KiroJudgeOptions = {}): NamedJudge {
  const model = options.model ?? 'claude-opus-5.5'
  const effort = options.effort ?? 'high'
  const agent = options.agent ?? KIRO_JUDGE_AGENT
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const reserveMs = options.fallbackReserveMs ?? DEFAULT_FALLBACK_RESERVE_MS
  const command = options.command ?? 'kiro-cli'
  const cwd = options.cwd ?? join(tmpdir(), 'probity-kiro-judge')
  const run = options.run ?? spawnKiro
  const args = [
    'chat',
    '--no-interactive',
    '--agent',
    agent,
    '--model',
    model,
    '--effort',
    effort,
    '--trust-tools=',
  ]
  return {
    name: 'kiro',
    reason: async (prompt) => {
      const started = Date.now()
      const meta = () => ({ judge: 'kiro', model, effort, durationMs: Date.now() - started })
      try {
        if (agent === KIRO_JUDGE_AGENT) writeJudgeAgent(cwd)
        else mkdirSync(cwd, { recursive: true })
      } catch (error) {
        return unavailable(`cannot prepare its working directory ${cwd}: ${message(error)}`, meta())
      }
      const deadline = Number(process.env[HOOK_DEADLINE_ENV])
      const budget = Number.isFinite(deadline) && deadline > 0 ? deadline - Date.now() - reserveMs : Infinity
      const limit = Math.min(timeoutMs, budget)
      const capped = budget < timeoutMs
      if (capped && limit < MIN_RUN_MS) {
        return unavailable(
          `no time left before the hook's deadline (${Math.max(0, Math.round(deadline - Date.now()))} ms left, ${reserveMs} ms of it kept for the next judge)`,
          meta(),
        )
      }
      noteJudge('kiro')
      const result = await run(command, args, { cwd, input: prompt, timeoutMs: limit })
      if (result.error) {
        const cause =
          result.error.code === 'ENOENT'
            ? `${command} was not found on PATH`
            : `${command} could not be started: ${result.error.message}`
        return unavailable(cause, meta())
      }
      if (result.timedOut) {
        const within = capped
          ? `${limit} ms, the time left before the hook's deadline less ${reserveMs} ms kept for the next judge`
          : `${limit} ms`
        return unavailable(`no answer within ${within}${outputTail(result)}`, meta())
      }
      if (result.exitCode !== 0 && !result.answered) {
        return unavailable(`${command} exited with code ${result.exitCode}${outputTail(result)}`, meta())
      }
      const text = stripAnsi(result.stdout).trim()
      if (!text) return unavailable(`${command} printed no answer${outputTail(result)}`, meta())
      return { ...parseVerdict(text), meta: meta() }
    },
  }
}

function writeJudgeAgent(cwd: string): void {
  const dir = join(cwd, '.kiro', 'agents')
  const file = join(dir, `${KIRO_JUDGE_AGENT}.json`)
  let current: string | undefined
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    current = undefined
  }
  if (current === KIRO_JUDGE_AGENT_CONFIG) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, KIRO_JUDGE_AGENT_CONFIG)
}

// kiro-cli runs in their own process groups. If the process running
// Probity is told to stop (the Kiro shim's deadline), they are killed
// too, rather than left to finish a verdict nobody will read (#200).
const liveRuns = new Set<ChildProcess>()

function killRun(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // Already gone.
  }
}

function onTerminate(): void {
  for (const child of liveRuns) killRun(child, 'SIGKILL')
  process.exit(143)
}

function track(child: ChildProcess): void {
  if (liveRuns.size === 0) process.on('SIGTERM', onTerminate)
  liveRuns.add(child)
}

function untrack(child: ChildProcess): void {
  if (!liveRuns.delete(child)) return
  if (liveRuns.size === 0) process.off('SIGTERM', onTerminate)
}

function isCompleteVerdict(stdout: string): boolean {
  const text = stripAnsi(stdout).trim()
  return text !== '' && !/^(could not parse verdict|validator returned unexpected shape)/.test(parseVerdict(text).reason)
}

const spawnKiro: KiroRun = (command, args, { cwd, input, timeoutMs }) =>
  new Promise((resolve) => {
    // Its own process group, so a timeout can stop kiro-cli and the
    // processes it starts, which otherwise hold the output pipes open.
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PROBITY_JUDGE: '1' },
      detached: process.platform !== 'win32',
    })
    track(child)
    let stdout = ''
    let stderr = ''
    let settled = false
    let settle: NodeJS.Timeout | undefined
    const finish = (result: KiroRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(settle)
      untrack(child)
      resolve(result)
    }
    // Stop the run and answer now: waiting for the pipes to close can
    // take as long as the run itself.
    const stop = (result: Omit<KiroRunResult, 'stdout' | 'stderr'>) => {
      killRun(child, 'SIGTERM')
      setTimeout(() => killRun(child, 'SIGKILL'), 2_000).unref()
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
      finish({ ...result, stdout, stderr })
    }
    const timer = setTimeout(() => stop({ exitCode: null, timedOut: true }), timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8')
      // kiro-cli can keep running for many seconds after it has answered
      // (#200), so a complete verdict followed by a quiet second is taken
      // without waiting for it to exit.
      clearTimeout(settle)
      if (isCompleteVerdict(stdout)) {
        settle = setTimeout(() => stop({ exitCode: null, timedOut: false, answered: true }), ANSWER_SETTLE_MS)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish({ exitCode: null, stdout, stderr, timedOut: false, error }),
    )
    child.on('close', (code) => finish({ exitCode: code, stdout, stderr, timedOut: false }))
    // A judge that exits before reading all of stdin is reported by its
    // exit code, not by the broken pipe.
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })

function unavailable(cause: string, meta: Verdict['meta']): Verdict {
  return { kind: 'violation', reason: `Kiro judge unavailable: ${cause}`, meta }
}

function outputTail(result: KiroRunResult): string {
  const text = [stripAnsi(result.stderr).trim(), stripAnsi(result.stdout).trim()]
    .filter(Boolean)
    .join('\n')
  if (!text) return ''
  return `. Output: ${text.length > OUTPUT_EXCERPT ? `…${text.slice(-OUTPUT_EXCERPT)}` : text}`
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Mirrors Probity's own verdict parsing (vendors/to-verdict.js), which
// is not exported: the whole text, then the text without a ```json
// fence, then the last JSON object embedded after prose.
function parseVerdict(text: string): Verdict {
  const parsed = safeParse(text) ?? safeParse(stripFence(text)) ?? lastEmbeddedObject(text)
  if (parsed === undefined) {
    return {
      kind: 'violation',
      reason: `could not parse verdict from validator output: ${text.slice(0, 4000)}`,
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'violation', reason: 'validator returned unexpected shape at <root>: expected object' }
  }
  const { kind, reason } = parsed as Record<string, unknown>
  if (kind !== 'pass' && kind !== 'violation') {
    return {
      kind: 'violation',
      reason: "validator returned unexpected shape at kind: expected 'pass' | 'violation'",
    }
  }
  if (typeof reason !== 'string') {
    return { kind: 'violation', reason: 'validator returned unexpected shape at reason: expected string' }
  }
  return { kind, reason }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function stripFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '')
    .trim()
}

function lastEmbeddedObject(text: string): unknown {
  for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    const end = balancedEnd(text, start)
    const parsed = end === undefined ? undefined : safeParse(text.slice(start, end + 1))
    if (parsed !== undefined) return parsed
    if (start === 0) break
  }
  return undefined
}

function balancedEnd(text: string, start: number): number | undefined {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return i
  }
  return undefined
}

/** The Claude Agent SDK's `query`, as Probity's Claude judge calls it. */
export type ClaudeQuery = (args: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<unknown>

export type ClaudeJudgeOptions = {
  /**
   * Claude model id the judge runs on, e.g. `claude-haiku-5-5`. Default:
   * none, so the Agent SDK picks, as with Probity's own judge.
   */
  model?: string
  /**
   * Which Claude Code binary runs the judge:
   * - default: the installed one ({@link installedClaude}), else the one
   *   bundled with Probity's Agent SDK;
   * - `'installed'`: the installed one, or "Claude judge unavailable" when
   *   there is none, so a chain moves on;
   * - `'bundled'`: the SDK's own, as Probity's judge runs it;
   * - a path: that binary.
   */
  executable?: 'installed' | 'bundled' | (string & {})
  /** Replaces the Agent SDK's `query` (tests). */
  query?: ClaudeQuery
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The Claude Code installed on this machine: the binary running the
 * current Claude Code session (`CLAUDE_CODE_EXECPATH`, which hooks
 * inherit), else the first `claude` on PATH. Null when there is none.
 */
export function installedClaude(): string | null {
  const session = process.env.CLAUDE_CODE_EXECPATH
  if (session && isExecutableFile(session)) return session
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude'
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && isExecutableFile(join(dir, name))) return join(dir, name)
  }
  return null
}

class NoInstalledClaude extends Error {}

/** The binary path for `executable`, undefined for the SDK's bundled one. */
function claudeExecutable(executable: ClaudeJudgeOptions['executable']): string | undefined {
  if (executable === 'bundled') return undefined
  if (executable !== undefined && executable !== 'installed') return executable
  const found = installedClaude()
  if (found) return found
  if (executable === 'installed') {
    throw new NoInstalledClaude('no installed claude found (CLAUDE_CODE_EXECPATH or claude on PATH)')
  }
  return undefined
}

/**
 * Probity's default judge (the Claude Agent SDK on the user's Claude
 * login), for use inside {@link judgeChain} or as `ai` on its own. Probity
 * does not export it, so it is loaded from the installed `@nizos/probity`
 * on first use. If that fails (a Probity release that moved it), the
 * verdict says "Claude judge unavailable", so a chain moves on.
 *
 * It runs the installed Claude Code when there is one (see `executable`),
 * so verdicts follow the user's own CLI rather than the SDK's bundled copy.
 *
 * With `model`, each verdict runs on that model, and Probity's own judge
 * settings (one turn, no tools, no thinking) are kept. The judge is then
 * named `claude:<model>`, so `judgeChain` skips it apart from the default.
 */
export function claudeJudge(options: ClaudeJudgeOptions = {}): NamedJudge {
  let loading: Promise<Agent> | undefined
  return {
    name: options.model ? `claude:${options.model}` : 'claude',
    reason: async (prompt) => {
      noteJudge(options.model ? `claude:${options.model}` : 'claude')
      let agent: Agent
      try {
        loading ??= loadClaudeCodeAgent(options)
        agent = await loading
      } catch (error) {
        loading = undefined
        return {
          kind: 'violation',
          reason: error instanceof NoInstalledClaude
            ? `Claude judge unavailable: ${error.message}`
            : `Claude judge unavailable: cannot load Probity's Claude Code judge (${message(error)})`,
        }
      }
      return agent.reason(prompt)
    },
  }
}

async function loadClaudeCodeAgent({ model, query, executable }: ClaudeJudgeOptions): Promise<Agent> {
  const binary = claudeExecutable(executable)
  const index = createRequire(import.meta.url).resolve('@nizos/probity')
  const url = new URL('./vendors/claude-code/agent.js', pathToFileURL(index))
  const module = (await import(url.href)) as { claudeCode?: (deps?: { queryFn?: ClaudeQuery }) => Agent }
  if (typeof module.claudeCode !== 'function') {
    throw new Error(`${url.pathname} has no claudeCode export`)
  }
  if (!model && !query && !binary) return module.claudeCode()
  // The SDK Probity itself depends on, resolved from Probity's install.
  const sdkQuery =
    query ??
    ((await import(pathToFileURL(createRequire(index).resolve('@anthropic-ai/claude-agent-sdk')).href)) as { query: ClaudeQuery }).query
  return module.claudeCode({
    queryFn: (args) =>
      sdkQuery({
        ...args,
        options: { ...args.options, ...(model && { model }), ...(binary && { pathToClaudeCodeExecutable: binary }) },
      }),
  })
}

/** A judge with a name `judgeChain` can remember it by across hook runs. */
export type NamedJudge = Agent & { name?: string }

export type JudgeChainOptions = {
  /**
   * After a judge is unavailable, skip it for this long. A hook run can
   * ask for up to four verdicts (contradiction retry, malformed-answer
   * retry, extraction check), and waiting for a dead judge each time
   * would overrun the hook timeout. Default 300,000 ms.
   */
  skipUnavailableMs?: number
  /**
   * Where a named judge's skip is kept, so it outlasts the hook run
   * (issue #87): Probity starts a new process per tool call, and a
   * hanging kiro-cli would otherwise cost every write the full
   * `timeoutMs`. Default `<tmpdir>/probity-kiro-judge/judge-chain.json`.
   * `false` keeps it in memory, for one hook run. Unnamed judges are
   * always kept in memory only.
   */
  stateFile?: string | false
}

type UnavailableUntil = Record<string, number>

function readUnavailable(file: string): UnavailableUntil {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as UnavailableUntil) : {}
  } catch {
    return {}
  }
}

/** Records or clears `name`; a state file that can't be written only loses the memory. */
function writeUnavailable(file: string, name: string, until: number | undefined): void {
  try {
    const state = readUnavailable(file)
    if (until === undefined) {
      if (!(name in state)) return
      delete state[name]
    } else {
      state[name] = until
    }
    mkdirSync(dirname(file), { recursive: true })
    const scratch = `${file}.${process.pid}`
    writeFileSync(scratch, JSON.stringify(state))
    renameSync(scratch, file)
  } catch {
    // Fall back to this run's memory.
  }
}

/**
 * A judge that asks each judge in turn and returns the first verdict
 * from a judge that was available. The order is the fallback order:
 * `judgeChain([kiroJudge(), claudeJudge()])` prefers Kiro,
 * `judgeChain([claudeJudge(), kiroJudge()])` prefers Claude.
 *
 * Only unavailability moves on (see `isJudgeUnavailable`): a judge
 * that could not start, timed out, answered nothing, or reported a
 * spend limit, quota, rate limit or authentication failure. A real
 * verdict, deny included, stands, and so does an answer that was not
 * valid JSON, which `withJudgeFailureDiagnostics` asks about again.
 * When every judge is unavailable, the verdict is the first judge's,
 * with each fallback's reason appended.
 */
export function judgeChain(judges: readonly NamedJudge[], options: JudgeChainOptions = {}): Agent {
  if (judges.length === 0) throw new Error('judgeChain needs at least one judge')
  const skipMs = options.skipUnavailableMs ?? 300_000
  const stateFile = options.stateFile === false ? undefined : (options.stateFile ?? join(tmpdir(), 'probity-kiro-judge', 'judge-chain.json'))
  const unavailableUntil = new Map<number, number>()
  const persisted = (judge: NamedJudge) => (stateFile && judge.name ? judge.name : undefined)
  return {
    reason: async (prompt) => {
      const failures: Verdict[] = []
      // Why each earlier judge didn't answer (issue #86), for the trace.
      const fallbackFrom: { judge: string; reason: string }[] = []
      const remembered = stateFile ? readUnavailable(stateFile) : {}
      for (const [index, judge] of judges.entries()) {
        const last = index === judges.length - 1
        const name = persisted(judge)
        const label = judge.name ?? `judge ${index + 1}`
        const until = Math.max(unavailableUntil.get(index) ?? 0, name ? (remembered[name] ?? 0) : 0)
        if (!last && until > Date.now()) {
          fallbackFrom.push({ judge: label, reason: 'skipped: unavailable earlier' })
          continue
        }
        const verdict = await judge.reason(prompt)
        if (verdict.kind === 'pass' || !isJudgeUnavailable(verdict.reason)) {
          unavailableUntil.delete(index)
          if (name) writeUnavailable(stateFile!, name, undefined)
          return fallbackFrom.length ? { ...verdict, meta: { ...verdict.meta, fallbackFrom } } : verdict
        }
        fallbackFrom.push({ judge: label, reason: verdict.reason })
        unavailableUntil.set(index, Date.now() + skipMs)
        if (name) writeUnavailable(stateFile!, name, Date.now() + skipMs)
        failures.push(verdict)
      }
      const [first, ...rest] = failures
      if (!first) return { kind: 'violation', reason: 'Kiro judge unavailable: no judge was asked' }
      return {
        ...first,
        reason: [first.reason, ...rest.map((f) => `Fallback judge: ${f.reason}`)].join('\n\n'),
      }
    },
  }
}
