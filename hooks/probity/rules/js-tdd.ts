import { enforceTdd, type Rule } from '@nizos/probity'

import { withJudgeFailureDiagnostics, withContradictionRetry } from './gates.js'

/**
 * Appended to Probity's default TDD rules for JS/TS. The defaults say
 * both "adding a test is the red step" and "judge a new red at the
 * green->red boundary too" (the refactor check), and the judge has
 * read the second as a demand that the new test was already observed
 * failing (#73; the Kotlin judge did the same in #43).
 */
export const JS_TDD_ADDENDUM = `## Adding a red test

- Adding a failing test is the red step itself. A test-file write that adds one new test (with any imports, fixtures, or helpers it needs) passes without any prior run of that test: a test cannot have failed before it exists. "Must be observed failing for the right reason" applies only to the production write that follows it, never to the test write. This holds whether the asserted behavior is missing entirely or exists but is wrong, including behavior the previous cycle just implemented.
- At a test write, the only green->red question is whether the prior green left an unmistakable refactor unmade. A passing prior run is the expected state before a new test is added, never a reason to block it. Do not block a test write because the new test has not been observed failing, because the last run was for a previous test, or because the test contradicts what production code does now.
- The other rules still hold: a write adding more than one new test is a violation (restructuring existing tests is not adding), and so is a production write with no observed failing test for it. Observed failing means a test run, after the test was written, whose output shows that test failing. A test written in the session with no run after it has not been observed failing, and an earlier failing run of a different test does not count.`

/**
 * Probity's `enforceTdd()` with {@link JS_TDD_ADDENDUM} appended, wrapped
 * as the JS preset wires it: a self-contradicting deny is retried, and a
 * judge that returns no verdict (spend limit, auth failure) is reported
 * as an infrastructure failure rather than a TDD rejection. Use this in
 * place of `withJudgeFailureDiagnostics(withContradictionRetry(enforceTdd()))`.
 */
export function enforceJsTdd(): Rule {
  return withJudgeFailureDiagnostics(
    withContradictionRetry(
      enforceTdd({ instructions: (defaults) => `${defaults}\n\n${JS_TDD_ADDENDUM}` }),
    ),
  )
}
