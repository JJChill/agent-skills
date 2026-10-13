/**
 * The scenario-fidelity block (issue #120), built once for the KMP,
 * Swift and JS presets: changed Covers-tagged tests are judged against
 * the scenarios they claim, on writes to acceptance tests and specs,
 * wrapped in the same failure diagnostics and contradiction retry as
 * the presets' other judges.
 */
import type { RuleEntry } from '@nizos/probity'

import { withContradictionRetry, withJudgeFailureDiagnostics } from '../rules/gates.js'
import { enforceScenarioFidelity } from '../rules/scenario-fidelity.js'

/** The block, or none when `enabled` is false or no glob is given. */
export function scenarioFidelityBlock(
  enabled: boolean | undefined,
  globs: readonly string[],
  options: Parameters<typeof enforceScenarioFidelity>[0],
): RuleEntry[] {
  if (enabled === false || !globs.some((glob) => !glob.startsWith('!'))) return []
  const [first, ...rest] = globs
  return [
    {
      files: [first!, ...rest],
      rules: [withJudgeFailureDiagnostics(withContradictionRetry(enforceScenarioFidelity(options)))],
    },
  ]
}
