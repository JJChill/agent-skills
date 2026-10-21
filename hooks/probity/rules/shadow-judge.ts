import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Agent, Verdict } from '@nizos/probity'

import { isJudgeUnavailable } from './gates.js'
import type { NamedJudge } from './kiro-judge.js'

// Probity doesn't export its telemetry type; derive it from the verdict.
type AgentTelemetry = NonNullable<Verdict['meta']>

/**
 * A judge that measures other judges on a project's real traffic.
 *
 * Why: whether a cheaper model (or another judge) is good enough depends
 * on the prompts a project's rules actually send, and Probity's
 * `--debug` trace records verdicts but not prompts, so they cannot be
 * replayed afterwards. `shadowJudge` asks the primary judge and every
 * candidate the same prompt in parallel, always returns the primary's
 * verdict, and appends the prompt and all verdicts to a JSONL log that
 * `probity-shadow-report` summarizes:
 *
 *   export default defineConfig({
 *     rules: kmpRuleEntries(root),
 *     ai: shadowJudge(claudeJudge(), [claudeJudge({ model: 'claude-haiku-5-5' })], {
 *       log: '.probity/shadow.jsonl',
 *     }),
 *   })
 *
 * Enforcement is unchanged: a candidate that fails, hangs or cannot be
 * logged never alters or blocks the verdict. Each candidate adds its own
 * spend, and a write waits for the slowest candidate up to
 * `candidateTimeoutMs`.
 */

export type ShadowJudgeOptions = {
  /** JSONL file each verdict is appended to (created 0600, directories as needed). */
  log: string
  /** Stop waiting for a candidate after this long from the start of the verdict. Default 60,000 ms. */
  candidateTimeoutMs?: number
  /**
   * Log the full prompt, so the log can be replayed on other models.
   * Default true. Prompts contain the code being judged; with false only
   * its SHA-256 is kept.
   */
  includePrompt?: boolean
}

type LoggedVerdict = {
  name: string
  kind?: Verdict['kind']
  reason?: string
  meta?: AgentTelemetry
  /** The candidate threw instead of answering. */
  error?: string
  /** The candidate had not answered within `candidateTimeoutMs`. */
  timedOut?: boolean
  durationMs: number
}

export type ShadowLogEntry = {
  at: string
  promptSha256: string
  prompt?: string
  primary: LoggedVerdict & { kind: Verdict['kind']; reason: string }
  candidates: LoggedVerdict[]
}

const DEFAULT_CANDIDATE_TIMEOUT_MS = 60_000

function judgeName(judge: Agent, fallback: string): string {
  return (judge as NamedJudge).name ?? fallback
}

function logged(name: string, verdict: Verdict, durationMs: number): LoggedVerdict {
  return { name, kind: verdict.kind, reason: verdict.reason, ...(verdict.meta && { meta: verdict.meta }), durationMs }
}

async function askCandidate(candidate: Agent, name: string, prompt: string, started: number, timeoutMs: number): Promise<LoggedVerdict> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    // Not unref'd: while the hook waits on a hung candidate, this timer is
    // what keeps the process alive to return the verdict.
    timer = setTimeout(() => resolve('timeout'), Math.max(0, started + timeoutMs - Date.now()))
  })
  try {
    const answer = await Promise.race([candidate.reason(prompt), timeout])
    const durationMs = Date.now() - started
    return answer === 'timeout' ? { name, timedOut: true, durationMs } : logged(name, answer, durationMs)
  } catch (error) {
    return { name, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

export function shadowJudge(primary: Agent, candidates: readonly Agent[], options: ShadowJudgeOptions): NamedJudge {
  const primaryName = judgeName(primary, 'primary')
  return {
    ...((primary as NamedJudge).name !== undefined && { name: primaryName }),
    reason: async (prompt) => {
      const started = Date.now()
      const timeoutMs = options.candidateTimeoutMs ?? DEFAULT_CANDIDATE_TIMEOUT_MS
      const shadows = candidates.map((candidate, i) =>
        askCandidate(candidate, judgeName(candidate, `candidate-${i + 1}`), prompt, started, timeoutMs),
      )
      const verdict = await primary.reason(prompt)
      const primaryMs = Date.now() - started
      const entry: ShadowLogEntry = {
        at: new Date(started).toISOString(),
        promptSha256: createHash('sha256').update(prompt).digest('hex'),
        ...(options.includePrompt !== false && { prompt }),
        primary: { ...logged(primaryName, verdict, primaryMs), kind: verdict.kind, reason: verdict.reason },
        candidates: await Promise.all(shadows),
      }
      try {
        mkdirSync(dirname(options.log), { recursive: true })
        appendFileSync(options.log, JSON.stringify(entry) + '\n', { mode: 0o600 })
      } catch {
        // Measuring must never change enforcement.
      }
      return verdict
    },
  }
}

export type ShadowDisagreement = { at: string; promptSha256: string; primaryReason: string; candidateReason: string }

export type ShadowSummary = {
  candidate: string
  /** Verdicts where both judges answered. */
  compared: number
  agreed: number
  /** The candidate passed what the primary denied: enforcement it would have lost. */
  leaks: ShadowDisagreement[]
  /** The candidate denied what the primary passed: interruptions it would have added. */
  friction: ShadowDisagreement[]
  /** The candidate errored, timed out, or reported itself unavailable. */
  unavailable: number
  /** The primary was unavailable, so there was nothing to compare against. */
  skipped: number
  /** Tokens per model, the judge's own background calls included. */
  tokens: TokensByModel
  primaryTokens: TokensByModel
  medianMs: number | null
  primaryMedianMs: number | null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export type TokensByModel = Record<string, { input: number; output: number }>

/** Adds the per-model usage rows of a verdict's `meta.models` to `into`. */
function addTokens(into: TokensByModel, meta: AgentTelemetry | undefined): void {
  const rows = Array.isArray(meta?.models) ? meta.models : []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const usage = row as Record<string, unknown>
    if (typeof usage.model !== 'string') continue
    const total = (into[usage.model] ??= { input: 0, output: 0 })
    if (typeof usage.inputTokens === 'number') total.input += usage.inputTokens
    if (typeof usage.outputTokens === 'number') total.output += usage.outputTokens
  }
}

/** Per-candidate agreement with the primary judge over a shadow log. */
export function summarizeShadowLog(entries: readonly ShadowLogEntry[]): ShadowSummary[] {
  const rows = new Map<string, ShadowSummary & { durations: number[]; primaryDurations: number[] }>()
  for (const entry of entries) {
    const primaryDown = isJudgeUnavailable(entry.primary.reason)
    for (const candidate of entry.candidates) {
      let row = rows.get(candidate.name)
      if (!row) {
        row = {
          candidate: candidate.name,
          compared: 0,
          agreed: 0,
          leaks: [],
          friction: [],
          unavailable: 0,
          skipped: 0,
          tokens: {},
          primaryTokens: {},
          medianMs: null,
          primaryMedianMs: null,
          durations: [],
          primaryDurations: [],
        }
        rows.set(candidate.name, row)
      }
      addTokens(row.tokens, candidate.meta)
      addTokens(row.primaryTokens, entry.primary.meta)
      row.durations.push(candidate.durationMs)
      row.primaryDurations.push(entry.primary.durationMs)
      if (primaryDown) {
        row.skipped++
        continue
      }
      if (candidate.error !== undefined || candidate.timedOut || !candidate.kind || isJudgeUnavailable(candidate.reason ?? '')) {
        row.unavailable++
        continue
      }
      row.compared++
      if (candidate.kind === entry.primary.kind) {
        row.agreed++
        continue
      }
      const disagreement = {
        at: entry.at,
        promptSha256: entry.promptSha256,
        primaryReason: entry.primary.reason,
        candidateReason: candidate.reason ?? '',
      }
      if (candidate.kind === 'pass') row.leaks.push(disagreement)
      else row.friction.push(disagreement)
    }
  }
  return [...rows.values()].map(({ durations, primaryDurations, ...row }) => ({
    ...row,
    medianMs: median(durations),
    primaryMedianMs: median(primaryDurations),
  }))
}
