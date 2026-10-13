/**
 * The fixed-wait screen (issue #119), built once for the Kotlin, KMP
 * and JS presets: no new sleeps anywhere in the acceptance suite,
 * DSL and drivers included. Presets spread it in among their other
 * deterministic screens, ahead of the judged rules.
 */
import type { RuleEntry } from '@nizos/probity'

import { forbidNewFixedWaits, type NamedPattern } from '../rules/gates.js'

/** The block for `globs` (default `['**\/acceptance/**']`), or none
 *  when no include glob is given — `[]` turns the screen off. */
export function fixedWaitBlock(
  globs: readonly string[] = ['**/acceptance/**'],
  patterns: NamedPattern[],
): RuleEntry[] {
  if (!globs.some((glob) => !glob.startsWith('!'))) return []
  const [first, ...rest] = globs
  return [{ files: [first!, ...rest], rules: [forbidNewFixedWaits({ patterns })] }]
}
