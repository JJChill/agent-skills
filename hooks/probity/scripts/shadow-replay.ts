#!/usr/bin/env node
/**
 * Replays recorded whole-file prompts (issue #174): asks a judge each
 * prompt that compaction replaced with a diff, and reports how often it
 * agrees with the verdict the compacted prompt got, as
 * `probity-shadow-report` does for a live shadow.
 *
 *   npx probity-shadow-replay .probity/whole-prompts.jsonl [--judge claude|kiro] [--model ID]
 *     [--limit N] [--concurrency N] [--show leaks|friction|all]
 *
 * Record with the presets' `compactJudgeFiles: { record: { log, sample } }`.
 * A leak is a verdict the whole-file judge passes that the compacted one
 * denied; friction the reverse. Each replayed prompt is one judge call,
 * on your account: `--limit` caps the spend. The prompts hold code and
 * session context, so keep the log local.
 */
import { closeSync, createReadStream, openSync } from 'node:fs'
import { createInterface } from 'node:readline'

import { claudeJudge, kiroJudge } from '../rules/kiro-judge.js'
import { replayWholePrompts } from '../rules/whole-prompt-record.js'
import { shadowReportLines } from './shadow-format.js'

const USAGE =
  'usage: probity-shadow-replay <whole-prompts.jsonl> [--judge claude|kiro] [--model ID] [--limit N] ' +
  '[--concurrency N] [--show leaks|friction|all]'

function fail(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
const VALUED = new Set(['--judge', '--model', '--limit', '--concurrency', '--show'])
const option = (name: string) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const path = args.find((arg, i) => !arg.startsWith('--') && !VALUED.has(args[i - 1] ?? ''))
const judgeKind = option('--judge') ?? 'claude'
if (!['claude', 'kiro'].includes(judgeKind)) fail(`--judge takes claude or kiro, not ${judgeKind}`)
const show = option('--show')
if (show !== undefined && !['leaks', 'friction', 'all'].includes(show)) fail(`--show takes leaks, friction or all, not ${show}`)
const count = (name: string) => {
  const value = option(name)
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) fail(`${name} takes a whole number from 1, not ${value}`)
  return n
}
const limit = count('--limit')
const concurrency = count('--concurrency') ?? 4
if (!path) fail('no record log given')

try {
  closeSync(openSync(path, 'r'))
} catch (error) {
  fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
}

const model = option('--model')
const judge = judgeKind === 'kiro' ? kiroJudge(model ? { model } : {}) : claudeJudge(model ? { model } : {})
const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
const { entries, unreadable } = await replayWholePrompts(lines, judge, { limit, concurrency })
const heading = `Replay of ${path} (whole-file prompts; primary verdicts were on compacted prompts)`
process.stdout.write(shadowReportLines(entries, { heading, unreadable, show }).join('\n') + '\n')
