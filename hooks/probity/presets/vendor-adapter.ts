/**
 * The forwarding-only block (issue #102), built once for every preset:
 * vendor adapters whose success path can't be tested offline leave the
 * TDD block and are held to `enforceForwardingOnlyAdapter` instead,
 * wrapped in the same failure diagnostics and contradiction retry as
 * the presets' other judges. Presets list it before their TDD block.
 */
import type { RuleEntry } from '@nizos/probity'

import { withContradictionRetry, withJudgeFailureDiagnostics } from '../rules/gates.js'
import { enforceForwardingOnlyAdapter } from '../rules/ports-and-adapters.js'

/** The block for `globs`, or undefined when no include glob is given. */
export function vendorAdapterBlock(globs: readonly string[] = []): RuleEntry | undefined {
  if (!globs.some((glob) => !glob.startsWith('!'))) return undefined
  const [first, ...rest] = globs
  return {
    files: [first!, ...rest],
    rules: [withJudgeFailureDiagnostics(withContradictionRetry(enforceForwardingOnlyAdapter()))],
  }
}

/** `!`-negations of `globs`' includes, for the TDD block to leave them out. */
export function vendorAdapterExclusions(globs: readonly string[] = []): string[] {
  return globs.filter((glob) => !glob.startsWith('!')).map((glob) => `!${glob}`)
}
