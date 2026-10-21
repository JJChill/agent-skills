#!/usr/bin/env node
/**
 * Summarizes a `shadowJudge` log: for each candidate judge, how often it
 * agreed with the primary, and where it did not.
 *
 *   npx probity-shadow-report .probity/shadow.jsonl [--show leaks|friction|all]
 *
 * A leak is a write the candidate would have let through that the
 * primary denied; friction is a write it would have denied that the
 * primary passed. The primary is not ground truth, so read the leaks
 * before trusting a cheaper judge: `--show leaks` prints each one's
 * reasons and prompt hash, which finds the full prompt in the log.
 */
import { readFileSync } from 'node:fs'

import { summarizeShadowLog, type ShadowDisagreement, type ShadowLogEntry, type TokensByModel } from '../rules/shadow-judge.js'

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

function listed(title: string, items: ShadowDisagreement[]): string[] {
  const lines = [`  ${title}:`]
  for (const item of items) {
    lines.push(`    ${item.at}  ${item.promptSha256}`)
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

let content: string
try {
  content = readFileSync(path, 'utf8')
} catch (error) {
  fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
}

const entries: ShadowLogEntry[] = []
let unreadable = 0
for (const line of content.split('\n')) {
  if (!line.trim()) continue
  try {
    const entry = JSON.parse(line) as ShadowLogEntry
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
for (const row of summarizeShadowLog(entries)) {
  const rate = row.compared ? ` (${((row.agreed / row.compared) * 100).toFixed(1)}%)` : ''
  out.push('', row.candidate)
  out.push(`  agreed ${row.agreed} of ${row.compared}${rate}`)
  out.push(`  leaks ${row.leaks.length} (passed what the primary denied)`)
  out.push(`  friction ${row.friction.length} (denied what the primary passed)`)
  out.push(`  unavailable ${row.unavailable}, skipped ${row.skipped} (primary unavailable)`)
  out.push(`  median ${seconds(row.medianMs)} (primary ${seconds(row.primaryMedianMs)})`)
  out.push(...tokenLines('tokens', row.tokens), ...tokenLines('primary tokens', row.primaryTokens))
  if ((show === 'leaks' || show === 'all') && row.leaks.length) out.push(...listed('leaks', row.leaks))
  if ((show === 'friction' || show === 'all') && row.friction.length) out.push(...listed('friction', row.friction))
}
process.stdout.write(out.join('\n') + '\n')
