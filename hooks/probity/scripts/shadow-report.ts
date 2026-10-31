#!/usr/bin/env node
/**
 * Summarizes a `shadowJudge` log: for each candidate judge, how often it
 * agreed with the primary, and where it did not.
 *
 *   npx probity-shadow-report .probity/shadow.jsonl [--show leaks|friction|all]
 *
 * A leak is a write the candidate would have let through that the
 * primary denied; friction is a write it would have denied that the
 * primary passed. Each rate comes with its 95% upper bound, so a small
 * sample cannot pass for a good result, and a table splits every
 * candidate by judging task (the rule that asked). The primary is not
 * ground truth, so read the leaks before trusting a cheaper judge:
 * `--show leaks` prints each one's task, reasons and prompt hash, which
 * finds the full prompt in the log.
 */
import { closeSync, createReadStream, openSync } from 'node:fs'
import { createInterface } from 'node:readline'

import { summarizeShadowLog, type ShadowDisagreement, type ShadowLogEntry, type ShadowSummary, type TokensByModel } from '../rules/shadow-judge.js'

const USAGE = 'usage: probity-shadow-report <shadow.jsonl> [--show leaks|friction|all]'
const REASON_EXCERPT = 300

function fail(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`)
  process.exit(1)
}

function seconds(ms: number | null): string {
  return ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`
}

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > REASON_EXCERPT ? `${line.slice(0, REASON_EXCERPT)}…` : line
}

function tokenLines(title: string, tokens: TokensByModel): string[] {
  const models = Object.entries(tokens)
  if (models.length === 0) return [`  ${title}: none recorded`]
  const count = (n: number) => n.toLocaleString('en-US')
  return [`  ${title}:`, ...models.map(([model, t]) => `    ${model}: in ${count(t.input)}, out ${count(t.output)}`)]
}

function percent(value: number | null): string {
  return value === null ? '-' : `${(value * 100).toFixed(1)}%`
}

/** `k of n <what> (rate, up to bound at 95%)`. */
function rated(k: number, n: number, what: string, upper: number | null): string {
  return n === 0 ? `${k} of 0 ${what}` : `${k} of ${n} ${what} (${percent(k / n)}, up to ${percent(upper)} at 95%)`
}

/** `k/n (≤bound)` for the per-task table. */
function cell(k: number, n: number, upper: number | null): string {
  return n === 0 ? '-' : `${k}/${n} (≤${percent(upper)})`
}

function taskTable(rows: ShadowSummary[]): string[] {
  const width = Math.max(4, ...rows.map((row) => row.task!.length))
  const lines = [`  by task:`, `    ${'task'.padEnd(width)}  verdicts  agreed  leaks (≤95%)         friction (≤95%)`]
  for (const row of rows) {
    const verdicts = row.compared + row.unavailable + row.skipped
    const agreed = row.compared ? percent(row.agreed / row.compared) : '-'
    lines.push(
      `    ${row.task!.padEnd(width)}  ${String(verdicts).padStart(8)}  ${agreed.padStart(6)}  ` +
        `${cell(row.leaks.length, row.primaryDenials, row.leakRateUpper).padEnd(20)} ` +
        cell(row.friction.length, row.primaryPasses, row.frictionRateUpper),
    )
  }
  return lines
}

function listed(title: string, items: ShadowDisagreement[]): string[] {
  const lines = [`  ${title}:`]
  for (const item of items) {
    lines.push(`    ${item.at}  ${item.promptSha256}${item.task ? `  ${item.task}` : ''}`)
    lines.push(`      primary: ${excerpt(item.primaryReason)}`)
    lines.push(`      candidate: ${excerpt(item.candidateReason)}`)
  }
  return lines
}

const args = process.argv.slice(2)
const showAt = args.indexOf('--show')
const show = showAt === -1 ? undefined : args[showAt + 1]
if (show !== undefined && !['leaks', 'friction', 'all'].includes(show)) fail(`--show takes leaks, friction or all, not ${show}`)
const path = args.find((arg, i) => !arg.startsWith('--') && (showAt === -1 || i !== showAt + 1))
if (!path) fail('no shadow log given')

try {
  closeSync(openSync(path, 'r'))
} catch (error) {
  fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
}

// Line by line, without the prompts: a log that keeps every prompt grows
// ~80 KB per verdict, past what one string or the heap can hold (#164).
const entries: ShadowLogEntry[] = []
let unreadable = 0
for await (const line of createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })) {
  if (!line.trim()) continue
  try {
    const entry = JSON.parse(line) as ShadowLogEntry
    delete entry.prompt
    if (entry?.primary && Array.isArray(entry.candidates)) entries.push(entry)
    else unreadable++
  } catch {
    unreadable++
  }
}

const out: string[] = []
const span = entries.length ? `, ${entries[0]!.at} to ${entries.at(-1)!.at}` : ''
out.push(`Shadow log ${path}: ${entries.length} verdicts${span}`)
if (unreadable) out.push(`${unreadable} unreadable line${unreadable === 1 ? '' : 's'} skipped`)
const unlabelled = entries.filter((entry) => !entry.task).length
if (unlabelled) {
  out.push(
    `${unlabelled} of ${entries.length} verdicts (${percent(unlabelled / entries.length)}) have no judging task, ` +
      'so the by-task table cannot place them. Rules added outside a preset need probityConfig() in place of ' +
      'defineConfig(), or withJudgeTasks([...]) around them; verdicts logged before 0.4.50 have none.',
  )
}
const rows = summarizeShadowLog(entries)
for (const row of rows.filter((candidate) => candidate.task === undefined)) {
  const rate = row.compared ? ` (${percent(row.agreed / row.compared)})` : ''
  out.push('', `${row.candidate}, all tasks`)
  out.push(`  agreed ${row.agreed} of ${row.compared}${rate}`)
  out.push(`  leaks ${rated(row.leaks.length, row.primaryDenials, 'primary denials', row.leakRateUpper)}`)
  out.push(`  friction ${rated(row.friction.length, row.primaryPasses, 'primary passes', row.frictionRateUpper)}`)
  out.push(`  unavailable ${row.unavailable}, skipped ${row.skipped} (primary unavailable)`)
  out.push(`  median ${seconds(row.medianMs)} (primary ${seconds(row.primaryMedianMs)})`)
  out.push(...tokenLines('tokens', row.tokens), ...tokenLines('primary tokens', row.primaryTokens))
  out.push(...taskTable(rows.filter((task) => task.candidate === row.candidate && task.task !== undefined)))
  if ((show === 'leaks' || show === 'all') && row.leaks.length) out.push(...listed('leaks', row.leaks))
  if ((show === 'friction' || show === 'all') && row.friction.length) out.push(...listed('friction', row.friction))
}
process.stdout.write(out.join('\n') + '\n')
