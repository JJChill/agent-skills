import { defineConfig, type Config } from '@nizos/probity'

import { withJudgeTasks } from './judge-task.js'

/**
 * `defineConfig` for configs built on this package: the same config, with
 * every rule it lists run under its judging task (judge-task.ts).
 *
 * Why: the presets label their own rules, but a rule a project adds next
 * to them would reach the judge unlabelled, and `shadowJudge` would file
 * its verdicts under `(unlabelled)`. Labelling at the config covers every
 * rule the project lists, including ones added later:
 *
 *   export default probityConfig({
 *     rules: [...kotlinRuleEntries(ROOT), requireChangelogEntry],
 *     ai: claudeJudge(),
 *   })
 *
 * Rules the presets already labelled are left as they are.
 */
export function probityConfig(config: Config): Config {
  return defineConfig({ ...config, rules: withJudgeTasks(config.rules) })
}
