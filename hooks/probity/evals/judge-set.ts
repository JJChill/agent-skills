/**
 * Builds the labelled judge set from evals/judge-cases.ts.
 *
 * Each case is run through its preset's real rules, in a scratch
 * project, with a judge that records the prompt instead of answering.
 * So the set always holds the prompts today's rules send, not a frozen
 * copy that drifts from them.
 *
 *   npx tsx evals/judge-set.ts                 # check only, no model calls (CI)
 *   npx tsx evals/judge-set.ts --out set.jsonl # also write the set
 *
 * Check mode fails when a case no longer reaches the judge it is
 * labelled for (a deterministic rule or a fast path now decides it,
 * or the task was renamed): fix or drop the case, don't let it rot.
 *
 * The written set is a `probity-shadow-replay` log whose recorded
 * verdicts are the labels, so replaying it reports leaks (the judge
 * passed a write labelled `violation`) and friction (it denied one
 * labelled `pass`), per judging task:
 *
 *   npx tsx scripts/shadow-replay.ts set.jsonl --judge claude --model claude-opus-5-5
 *
 * `npm run eval:judge -- --judge … --model …` does both. Each case is
 * one judge call per `--repeat`, on your account.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Action, Agent, RuleContext, RuleEntry } from '@nizos/probity'

import { jsRuleEntries } from '../presets/js.js'
import { kmpRuleEntries } from '../presets/kmp.js'
import { judgeTask, withJudgeTasks } from '../rules/judge-task.js'
import { actionMatchesFilesScope, anchorEntries, isRuleBlock } from '../rules/scoping.js'
import { sha256, type WholePromptRecord } from '../rules/whole-prompt-record.js'
import { JUDGE_CASES, type JudgeCase } from './judge-cases.js'

type SessionEvent = Awaited<ReturnType<NonNullable<RuleContext['history']>>>[number]
type RawSessionEvent = Awaited<ReturnType<NonNullable<RuleContext['rawHistory']>>>[number]

/** The name a labelled set gives its recorded verdicts; shadow-replay keys on it. */
export const EXPECTED = 'expected'

function entriesFor(testCase: JudgeCase, root: string): RuleEntry[] {
  const entries = testCase.preset === 'js' ? jsRuleEntries(testCase.options) : kmpRuleEntries(root, testCase.options)
  return anchorEntries(withJudgeTasks(entries), root)
}

function put(root: string, path: string, content: string): string {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

/** The prompts a case sends, by task, in the order the rules asked. */
export async function promptsFor(testCase: JudgeCase): Promise<{ task: string; prompt: string }[]> {
  const root = mkdtempSync(join(tmpdir(), 'probity-judge-set-'))
  try {
    for (const [path, content] of Object.entries(testCase.files ?? {})) put(root, path, content)
    const history: SessionEvent[] = []
    const rawHistory: RawSessionEvent[] = []
    for (const event of testCase.session ?? []) {
      const id = `t${rawHistory.length}`
      if ('user' in event) {
        history.push({ kind: 'prompt', text: event.user })
        rawHistory.push({ kind: 'prompt', text: event.user })
      } else if ('write' in event) {
        const full = put(root, event.write, event.content)
        history.push({ kind: 'write', path: full, content: event.content, output: 'ok' })
        rawHistory.push({ kind: 'action', tool: 'Write', input: { file_path: full, content: event.content }, output: 'ok', toolUseId: id })
      } else {
        history.push({ kind: 'command', command: event.run, output: event.output })
        rawHistory.push({ kind: 'action', tool: 'Bash', input: event.run, output: event.output, toolUseId: id })
      }
    }
    const asked: { task: string; prompt: string }[] = []
    // Answers pass, so every judged rule in the chain gets asked.
    const recorder: Agent = {
      reason: async (prompt) => {
        asked.push({ task: judgeTask() ?? '(unlabelled)', prompt: prompt.replaceAll(root, '/project') })
        return { kind: 'pass', reason: '' }
      },
    }
    const ctx: RuleContext = {
      agent: recorder,
      history: async () => [...history],
      rawHistory: async () => [...rawHistory],
      readFile: async (path) => {
        try {
          const { readFileSync } = await import('node:fs')
          return { kind: 'present', content: readFileSync(path, 'utf8') }
        } catch {
          return { kind: 'absent' }
        }
      },
    }
    const action: Action = { kind: 'write', path: join(root, testCase.write.path), content: testCase.write.content }
    for (const entry of entriesFor(testCase, root)) {
      const rules = !isRuleBlock(entry) ? [entry] : !entry.files || actionMatchesFilesScope(entry.files, action) ? entry.rules : []
      for (const rule of rules) {
        const result = await rule(action, ctx)
        if (result.kind === 'violation') {
          asked.push({ task: `(blocked by ${rule.name}: ${result.reason.split('\n')[0]})`, prompt: '' })
          return asked
        }
      }
    }
    return asked
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

export async function buildJudgeSet(cases: readonly JudgeCase[] = JUDGE_CASES): Promise<{ records: WholePromptRecord[]; problems: string[] }> {
  const records: WholePromptRecord[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const testCase of cases) {
    if (seen.has(testCase.id)) problems.push(`${testCase.id}: duplicate id`)
    seen.add(testCase.id)
    const asked = await promptsFor(testCase)
    const hit = asked.find((each) => each.task === testCase.task)
    if (!hit) {
      const got = asked.length ? asked.map((each) => each.task).join(', ') : 'no judge call'
      problems.push(`${testCase.id}: never reached the ${testCase.task} judge (got ${got})`)
      continue
    }
    records.push({
      at: testCase.id,
      task: testCase.task,
      promptSha256: sha256(hit.prompt),
      wholePrompt: hit.prompt,
      primary: { name: EXPECTED, kind: testCase.expect, reason: `${testCase.id} (${testCase.source})`, durationMs: 0 },
    })
  }
  return { records, problems }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outAt = process.argv.indexOf('--out')
  const out = outAt === -1 ? undefined : process.argv[outAt + 1]
  const { records, problems } = await buildJudgeSet()
  const byTask = new Map<string, { pass: number; violation: number }>()
  for (const record of records) {
    const row = byTask.get(record.task!) ?? { pass: 0, violation: 0 }
    row[record.primary.kind as 'pass' | 'violation']++
    byTask.set(record.task!, row)
  }
  console.log(`Judge set: ${records.length} of ${JUDGE_CASES.length} cases reach their judge`)
  for (const [task, row] of byTask) console.log(`  ${task}: ${row.pass} pass, ${row.violation} violation`)
  for (const problem of problems) console.log(`FAIL  ${problem}`)
  if (out) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
    console.log(`Wrote ${out}`)
  }
  process.exit(problems.length ? 1 : 0)
}
