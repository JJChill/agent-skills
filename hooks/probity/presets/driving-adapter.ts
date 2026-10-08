/**
 * The thin-driving-adapter block (issues #72, #76), built once for
 * every preset: the free discriminant screen when discriminants are
 * configured, then the AI judge, wrapped in the same failure
 * diagnostics and contradiction retry as the presets' TDD judges.
 * Presets list it before their TDD block, so a denial costs one AI
 * call, not two.
 */
import type { RuleEntry } from '@nizos/probity'

import type { NamedPattern } from '../rules/gates.js'
import { withContradictionRetry, withJudgeFailureDiagnostics } from '../rules/gates.js'
import {
  enforceThinDrivingAdapter,
  forbidNewDomainDiscriminantChecks,
  type ApiDumpFormat,
  type ExportLanguage,
} from '../rules/ports-and-adapters.js'

export type DrivingAdapterBlockOptions = {
  /** Driving-adapter files. No include glob → no block. */
  globs: readonly string[]
  /** Core scope, excluded: core code is never a driving adapter. */
  coreGlobs: readonly string[]
  /** Leave `coreGlobs` out of the block (default). A preset whose core
   *  scope contains its views (Swift's module folders) passes false and
   *  takes the views out of its core block instead. */
  excludeCore?: boolean
  /** Fields whose literal comparison is a domain decision. */
  domainDiscriminants?: readonly string[]
  /** Appended to the discriminant screen's deny. */
  domainHint?: string
  /** Builds the discriminant patterns (default: JS/TS literals). */
  patternsFor?: (discriminants: readonly string[]) => NamedPattern[]
  /** Give the judge the export names of `coreGlobs` sources. */
  coreExports?: { root?: string; language?: ExportLanguage; maxChars?: number }
  /** Give the judge the public API read from published dumps. */
  publishedApi?: { paths: readonly string[]; format: ApiDumpFormat; root?: string }
  /** Extends or replaces the judge's rules text. */
  instructions?: string | ((defaults: string) => string)
}

export function drivingAdapterBlock(options: DrivingAdapterBlockOptions): RuleEntry | undefined {
  if (!options.globs.some((glob) => !glob.startsWith('!'))) return undefined
  const coreExclusions =
    options.excludeCore === false
      ? []
      : options.coreGlobs.filter((glob) => !glob.startsWith('!')).map((glob) => `!${glob}`)
  const [first, ...rest] = [...options.globs, ...coreExclusions]
  return {
    files: [first!, ...rest],
    rules: [
      ...(options.domainDiscriminants?.length
        ? [
            forbidNewDomainDiscriminantChecks({
              discriminants: options.domainDiscriminants,
              domainHint: options.domainHint,
              patternsFor: options.patternsFor,
            }),
          ]
        : []),
      withJudgeFailureDiagnostics(
        withContradictionRetry(
          enforceThinDrivingAdapter({
            coreExports: options.coreExports && {
              globs: options.coreGlobs,
              ...options.coreExports,
            },
            publishedApi: options.publishedApi,
            instructions: options.instructions,
          }),
        ),
      ),
    ],
  }
}
