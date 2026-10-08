import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  error?: NodeJS.ErrnoException
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
      const result = await run(command, args, { cwd, input: prompt, timeoutMs })
      if (result.error) {
        const cause =
          result.error.code === 'ENOENT'
            ? `${command} was not found on PATH`
            : `${command} could not be started: ${result.error.message}`
        return unavailable(cause, meta())
      }
      if (result.timedOut) {
        return unavailable(`no answer within ${timeoutMs} ms${outputTail(result)}`, meta())
      }
      if (result.exitCode !== 0) {
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
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (result: KiroRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill('SIGTERM')
      setTimeout(() => kill('SIGKILL'), 2_000).unref()
      // Answer now: waiting for the pipes to close can take as long as
      // the run that just timed out.
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      finish({ exitCode: null, stdout, stderr, timedOut })
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish({ exitCode: null, stdout, stderr, timedOut, error }),
    )
    child.on('close', (code) => finish({ exitCode: code, stdout, stderr, timedOut }))
    // A judge that exits before reading all of stdin is reported by its
    // exit code, not by the broken pipe.
    child.stdin.on('error', () => {})
    child.stdin.end(input)
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

/**
 * Probity's default judge (the Claude Agent SDK on the user's Claude
 * login), for use inside {@link judgeChain}. Probity does not export
 * it, so it is loaded from the installed `@nizos/probity` on first
 * use. If that fails (a Probity release that moved it), the verdict
 * says "Claude judge unavailable", so a chain moves on.
 */
export function claudeJudge(): NamedJudge {
  let loading: Promise<Agent> | undefined
  return {
    name: 'claude',
    reason: async (prompt) => {
      let agent: Agent
      try {
        loading ??= loadClaudeCodeAgent()
        agent = await loading
      } catch (error) {
        return {
          kind: 'violation',
          reason: `Claude judge unavailable: cannot load Probity's Claude Code judge (${message(error)})`,
        }
      }
      return agent.reason(prompt)
    },
  }
}

async function loadClaudeCodeAgent(): Promise<Agent> {
  const index = createRequire(import.meta.url).resolve('@nizos/probity')
  const url = new URL('./vendors/claude-code/agent.js', pathToFileURL(index))
  const module = (await import(url.href)) as { claudeCode?: () => Agent }
  if (typeof module.claudeCode !== 'function') {
    throw new Error(`${url.pathname} has no claudeCode export`)
  }
  return module.claudeCode()
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
      const remembered = stateFile ? readUnavailable(stateFile) : {}
      for (const [index, judge] of judges.entries()) {
        const last = index === judges.length - 1
        const name = persisted(judge)
        const until = Math.max(unavailableUntil.get(index) ?? 0, name ? (remembered[name] ?? 0) : 0)
        if (!last && until > Date.now()) continue
        const verdict = await judge.reason(prompt)
        if (verdict.kind === 'pass' || !isJudgeUnavailable(verdict.reason)) {
          unavailableUntil.delete(index)
          if (name) writeUnavailable(stateFile!, name, undefined)
          return verdict
        }
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
