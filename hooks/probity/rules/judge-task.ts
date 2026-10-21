import { AsyncLocalStorage } from 'node:async_hooks'

import type { Rule, RuleEntry } from '@nizos/probity'

/**
 * Which judging task a judge call is for.
 *
 * Why: a judge (`ctx.agent`) receives only a prompt, never the rule that
 * asked, so `shadowJudge` could compare a candidate judge only across all
 * tasks at once. Whether a cheaper judge is good enough differs by task:
 * a vocabulary check is not the TDD gate. The presets run every rule
 * under its task with {@link withJudgeTasks}, and a judge reads the
 * current one with {@link judgeTask}. A rule that asks the judge a
 * second, different question labels that call with {@link withJudgeTask}.
 */

const current = new AsyncLocalStorage<string>()

/** The judging task of the rule running now, if any. */
export function judgeTask(): string | undefined {
  return current.getStore()
}

/** Runs `body` labelled with `task`, overriding any label around it. */
export function withJudgeTask<T>(task: string, body: () => T): T {
  return current.run(task, body)
}

/**
 * The task a rule name stands for: the innermost name of a wrapper
 * chain, so `characterizationTest(mutationProbe(enforceTdd))` is
 * `enforceTdd`.
 */
export function taskOf(ruleName: string): string {
  return ruleName.match(/(\w+)\)*$/)?.[1] ?? '(unnamed)'
}

function labelled(rule: Rule): Rule {
  const task = taskOf(rule.name)
  const wrapped: Rule = (action, ctx) => current.run(task, () => rule(action, ctx))
  // Probity names a rule in its trace and deny text by `name`.
  Object.defineProperty(wrapped, 'name', { value: rule.name })
  return wrapped
}

/** `entries` with every rule, flat or in a block, run under its judging task. */
export function withJudgeTasks(entries: readonly RuleEntry[]): RuleEntry[] {
  return entries.map((entry) =>
    typeof entry === 'function' ? labelled(entry) : { ...entry, rules: entry.rules.map(labelled) },
  )
}
