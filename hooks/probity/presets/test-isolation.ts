/**
 * The DSL isolation block (issue #119), built once for every preset and
 * opt-in: given `dslIsolationGlobs`, writes to the acceptance DSL are
 * judged by `enforceTestIsolation`, wrapped in the same failure
 * diagnostics and contradiction retry as the presets' other judges.
 */
import type { RuleEntry } from '@nizos/probity'

import { enforceTestIsolation } from '../rules/acceptance-language.js'
import { withContradictionRetry, withJudgeFailureDiagnostics } from '../rules/gates.js'

/** The block for `globs`, or none when no include glob is given. */
export function testIsolationBlock(globs: readonly string[] = []): RuleEntry[] {
  if (!globs.some((glob) => !glob.startsWith('!'))) return []
  const [first, ...rest] = globs
  return [
    {
      files: [first!, ...rest],
      rules: [withJudgeFailureDiagnostics(withContradictionRetry(enforceTestIsolation()))],
    },
  ]
}
