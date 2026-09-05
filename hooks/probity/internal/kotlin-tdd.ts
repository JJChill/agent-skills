import { enforceTdd, type Rule } from '@nizos/probity'

const KOTLIN_TDD_ADDENDUM = `## Kotlin/JVM TDD clarification

- Kotlin-specific exception to the generic placeholder guidance: when a targeted, relevant Kotlin test executes a \`TODO()\` placeholder and reports \`kotlin.NotImplementedError\`, that runtime failure is a clean red. Do not require a second run that reaches an assertion before replacing the placeholder. The implementation remains bounded by the assertions present in the relevant test source visible in the recent session.
- A compile, unresolved-import, or signature failure is not a clean red. It authorizes only placeholder, signature, or scaffolding work needed to make the test runnable; it does not authorize implementing the asserted behavior.
- One observed failing test may require one cohesive green write across multiple methods or branches when every changed method and branch is required by assertions present in that same relevant test source. No artificial test rerun is required between parts of that one atomic write. If the relevant assertions are not visible in the recent session, the red authorizes placeholder or scaffolding work only; do not infer that it authorizes production behavior.
- Git staging and git-index state are irrelevant. Judge only the recent session evidence, current file content, and pending action; do not require a test or production file to be staged.`

/**
 * Kotlin sessions commonly include Gradle output plus several source reads between
 * red and green. Twenty events preserves that nearby red; clipping each event at
 * 6,000 characters keeps the additional context bounded.
 */
export function enforceKotlinTdd(): Rule {
  return enforceTdd({
    instructions: (defaults) => `${defaults}\n\n${KOTLIN_TDD_ADDENDUM}`,
    maxEvents: 20,
    maxContentChars: 6_000,
  })
}
