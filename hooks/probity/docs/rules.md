# Rule catalogue

Every rule the presets wire, the skill it enforces, and how. The rules ship in the [`@jjchill/probity-rules`](https://www.npmjs.com/package/@jjchill/probity-rules) package: presets under [`presets/`](../presets/), rule modules under [`rules/`](../rules/). Language-neutral gates live in [`rules/gates.ts`](../rules/gates.ts) and take every language-shaped decision (test-command shape, ambient-call shape) as a pattern option; the Kotlin preset re-exports them with JVM/Gradle defaults.

Back to the [overview](../../PROBITY.md).

| Rule | Skill it enforces | Kind |
|---|---|---|
| [`enforceTdd()`](#enforcetdd) | test-driven-development | AI |
| [`forbidContentPattern(KNOWN_INFRASTRUCTURE_IMPORTS)`](#forbidcontentpatternknown_infrastructure_imports) | ports-and-adapters | Deterministic |
| [`enforcePortsBoundary()`](#enforceportsboundary) | ports-and-adapters | AI |
| [`enforceAdapterObservability()`](#enforceadapterobservability) | ports-and-adapters, observability-and-instrumentation | AI |
| [`enforceThinDrivingAdapter()` + `forbidNewDomainDiscriminantChecks()`](#enforcethindrivingadapter--forbidnewdomaindiscriminantchecks) | ports-and-adapters, frontend-ui-engineering | AI + deterministic screen |
| [`forbidInternalModuleMocks()`](#forbidinternalmodulemocks) | ports-and-adapters | Deterministic |
| [`enforceLayeredImports()`](#enforcelayeredimports) | ports-and-adapters, frontend-ui-engineering | Deterministic, opt-in |
| [`enforceAcceptanceLanguage()`](#enforceacceptancelanguage) | acceptance-testing, ubiquitous-language | AI |
| [`requireSpecBackedAcceptanceTest()`](#requirespecbackedacceptancetest) | acceptance-testing, specification-by-example | Deterministic |
| [`requireGreenTestRun()`](#requiregreentestrun) | test-driven-development, `/build`, `/ship` | Deterministic |
| [`forbidNewAmbientEffects()`](#forbidnewambienteffects) | ports-and-adapters | Deterministic |
| [`surfaceRemovedStringUsage()`](#surfaceremovedstringusage) | frontend-ui-engineering, acceptance-testing | Deterministic |
| [`withMutationProbe()` + `enforceProbeReversion()`](#withmutationprobe--enforceprobereversion) | acceptance-testing (mutation checks) | Deterministic |
| [`enforceControlledPreconditions()`](#enforcecontrolledpreconditions) | acceptance-testing (controlled preconditions) | AI |
| [`withInverseScenarioGuidance()`](#withinversescenarioguidance) | test-driven-development, acceptance-testing | Deterministic wrapper |
| [`withCharacterizationTest()` + `enforceCharacterizationResolution()`](#withcharacterizationtest--enforcecharacterizationresolution) | test-driven-development, acceptance-testing | Deterministic |
| [`withJudgeFailureDiagnostics()`](#withjudgefailurediagnostics) | test-driven-development | Deterministic wrapper |

Rules documented with their options elsewhere: the [spec↔test traceability](options.md#spectest-traceability) rules, [review record and routing](options.md#review-record-requirereviewrecord), the [shell-write screen](options.md#shell-writes-to-scoped-files-shellwritescreen), and the [forwarding-only adapter](options.md#vendor-adapters-only-a-live-session-can-exercise-vendoradapterglobs) judge.

## `enforceTdd()`

Probity's built-in; `enforceJsTdd()` in the JS preset, `enforceKotlinTdd()` in the Kotlin presets.

- **AI-validated:** every production write must address an observed failing test, minimally.
- Refactor debts block the next red.
- The Kotlin specifics (fast path, extraction under green, `TODO()` reds) are in the [Kotlin presets page](presets/kotlin.md#the-kotlin-tdd-gate).

## `forbidContentPattern(KNOWN_INFRASTRUCTURE_IMPORTS)`

Deterministic: known framework, vendor and OS-I/O imports never enter core code. Caught free, before any AI call.

## `enforcePortsBoundary()`

AI-validated: the Dependency Rule, thin adapters (no business conditionals), and vendor types kept out of port signatures.

## `enforceAdapterObservability()`

AI-validated, scoped to adapter paths: a new adapter path doing external I/O must carry boundary observability, either a structured event, a port-tap or recording decorator, or a span. Thin, not blind.

- **Delta-based.** Pure mappers, wiring and tests pass.
- **`conventionHint`** names your telemetry convention.
- **Presence only.** It guarantees telemetry is there, never that its fields are safe; sensitive-field discipline stays with review.
- **Order.** It runs after the TDD gate (the first violation wins), so on brand-new behaviour TDD answers first. Its deny text tells the agent to assert the event in the failing test, so both gates ask for the same thing.
- **`withTelemetryFastPath`** makes telemetry-only additions free on both sides: a write whose whole delta is complete single-line telemetry calls passes without a judge.

## `enforceThinDrivingAdapter()` + `forbidNewDomainDiscriminantChecks()`

JS, Kotlin, KMP and Swift presets. The opposite direction from the core-purity rules: business logic must not leak *out* of the core into driving adapters (UI components, pages, route handlers).

- **Blocks** a write that adds a decision in domain terms, coordinates more than one port or use-case call, re-implements a rule the core exports, or files a framework-free use case under a UI path. The deny names the extraction target (a domain function or a use case).
- **Passes** rendering, display formatting, local view state, one call per user intent, and display conditions over the rows already shown (empty, single item, first or last row) unless they repeat a rule the core enforces.
- **Delta-based.** It runs before the TDD gate, which can't catch these: a component test makes the logic "tested".
- **Scope.** The JS preset wires it by default through `drivingAdapterGlobs` (`src/ui/**`, `src/components/**`, `src/**/*.tsx`, minus tests and stories; `[]` switches it off). The Kotlin, KMP and Swift presets wire it only when `drivingAdapterGlobs` is set; see [Driving adapters by project layout](options.md#driving-adapters-by-project-layout-drivingadapterglobs).
- **`coreExportsInJudge: true`** gives the judge the export names under `coreGlobs`, so copies of existing rules are named. `coreApiPaths` reads binary-compatibility-validator dumps (Kotlin) or `.swiftinterface` files (Swift) for a repo with no core source.
- **The deterministic screen** is opt-in through `domainDiscriminants` (e.g. `['role', 'plan']`): net-new literal comparisons on those fields block free, before the AI call. There's no default list, because `status === 'loading'` is ordinary view state. In Kotlin the screen also matches enum entries, `when (x.role)` subjects and `is` checks; in Swift, enum cases, `switch` subjects and `if case`.
- The Kotlin judge gets an addendum for CLI commands and Compose screens.

## `forbidInternalModuleMocks()`

Deterministic: blocks newly introduced `jest.mock()` / `vi.mock()` of the team's own modules ("Ports Are the Only Test Seam"). Existing mocks don't re-trigger, so suites migrate incrementally. The Kotlin presets use `forbidStaticMocks()` instead; see the [Kotlin presets page](presets/kotlin.md).

## `enforceLayeredImports()`

Deterministic, delta-based, opt-in: an ordered set of layers (atomic design levels, presentation over data), lowest first. Blocks a write that adds a reference to a layer above, or to a sibling at the same rank. Configuration is in [Layered imports](options.md#layered-imports-enforcelayeredimports).

## `enforceAcceptanceLanguage()`

AI-validated: the Language Test on spec-layer files.

- No UI, protocol or persistence mechanics, and a single outcome per spec.
- Glossary terms verbatim when `glossaryPath` is set; see [Ubiquitous language](options.md#ubiquitous-language).
- **One standard across artifacts.** Wording that violates in a test step ("the backend rejects creation") violates in the Markdown scenario too: the spec is judged as the source tests transcribe.
- **Settled wording.** With `specsDir` (wired by every preset), the judge is shown which of the write's new steps other specifications already use word for word, and doesn't block on them, so a step gets the same verdict in every feature file.
- **Glossary size.** The glossary is included up to 32,000 characters (`maxGlossaryChars`); beyond that the judge is told the rest isn't shown.

## `requireSpecBackedAcceptanceTest()`

Deterministic, write-time: a write adding a new acceptance test case must also add a `Covers:` tag naming a scenario that already exists in the specs directory. The feature file is written before the test that claims it. This closes the tagless-suite gap the commit-time parity gate can't see. Details in [Spec↔test traceability](options.md#spectest-traceability).

## `requireGreenTestRun()`

All presets (`gates.ts`). Deterministic: `git commit` is blocked unless the test suite ran after the last write **and its recorded output was green**. Probity's `requireCommand` checks only that a run was recorded, and would pass a transcript whose latest run failed.

- **Options.** A command regex plus success and failure patterns. Two additive hooks, unused by default: `commandPredicate` narrows which regex-matched commands count, and `extraSuccessPredicate`/`extraFailurePredicate` add command-aware signals beside the text patterns.
- **JS/TS.** The default command counts a run only when one of its top-level commands starts the suite: `npm`/`pnpm`/`yarn`/`bun` `test` or `run test[:…]`, or `vitest`/`jest`, directly or through `npx` (the exported `isJsTestInvocation`). So `echo vitest`, or an issue body that mentions jest, isn't a run. A custom `commitCommand` is used as given, so anchor it.
- **Kotlin (Gradle).** Applied only when the caller passes the exported `GRADLE_TEST_COMMAND` unchanged.
  - Accepted tasks: `test` (flavored or module-qualified `test…Test`), `allTests`, `jvmTest`, `build` and `check`, recognised inside piped or compound strings.
  - Rejected: `--dry-run`, `-x`/`--exclude-task`, flag or redirect-value spoofing, and lookalike tasks that run nothing.
  - Green means Gradle's `BUILD SUCCESSFUL` banner, or under Kiro, when the last simple command is itself a Gradle verification run, a structured `exit_status` of zero.
  - Any other regex, or Swift's `xcodebuild` command, gets none of this.
- **Deny text.**
  - A run with no failure but no summary line (output cut by `| grep`, `| head`, `| tail`) gets its own deny naming the summary pattern.
  - A red-run deny ends with `Judged run:` and the command it judged, so a surprising deny shows which invocation was taken as the last run.
  - `options.reason` is appended on either path.
- **`enforceForPaths`** scopes the demand to commits touching matching files.
- **Worktrees.** With several worktrees of one repository in a session, the gate judges only the commit's own worktree: a write under another worktree, and a run starting with `cd <absolute path>` into one, are left out. A run with no leading `cd`, or a relative one, counts for every worktree, since the transcript doesn't record where it ran.
- **Limits.**
  - Runs outside the session transcript (another terminal, CI) are invisible.
  - "Writes since the last run" counts only write-tool events. A file changed by a shell command after a green run (`cat > file <<EOF`) doesn't reset it, so the commit goes through. The shell-write screen denies such commands only for files a rule scopes, and only when it can parse them.
  - The gate matches recorded output, so an echoed success banner or a re-read of a stale `.xcresult` satisfies it. Anchoring it to result-bundle freshness (the `.xcresult` timestamp against source mtimes) is the known upstream improvement.

## `forbidNewAmbientEffects()`

All presets (`gates.ts`). Deterministic, delta-based: net-new direct clock, randomness and environment reads in core code are blocked. `JS_AMBIENT_EFFECT_PATTERNS` covers `Date.now()`, argument-less `new Date()`, `Math.random()`, `randomUUID()` and `process.env`; the Kotlin re-export covers the JVM equivalents. Clock, randomness and configuration are ports, and `seamHint` names your canonical one. Existing call sites don't block; only what a write introduces.

## `surfaceRemovedStringUsage()`

`gates.ts`. Deterministic, delta-based: a UI-code write that removes a string literal still referenced verbatim by E2E or smoke specs (which select by visible text or accessible name, and usually don't run in the quick local loop) is blocked with the list of dependent spec files. "Renamed a button, broke the deploy gate" is caught at write time instead of in CI.

## `withMutationProbe()` + `enforceProbeReversion()`

[`round-trips.ts`](../rules/round-trips.ts); wired in the Kotlin, KMP and Swift presets. A deterministic pair:

- A production write marked `// probity: mutation-probe` (a deliberate break proving a retrofitted test bites) bypasses the TDD gate.
- `git commit` is blocked while any probe marker is still on disk.

The result is an enforced mark → red → revert → commit round-trip instead of an override. The marker works on any file the TDD block covers, including a test-support stub or fake in a `src/main` source set (judged as production code). An unmarked write denied for lacking a red gets a deny-text note naming the marker.

## `enforceControlledPreconditions()`

AI-validated, scoped to the driver and test-control layers (the opposite scoping from `enforceAcceptanceLanguage`). A driver method named for a precondition must establish it (a fixture key, launch environment, or programmed fake), and control wiring is never deleted just because the scenario passes without it. See [Brownfield seam gaps](#brownfield-seam-gaps-preconditions-are-controlled-not-observed).

## `withInverseScenarioGuidance()`

[`round-trips.ts`](../rules/round-trips.ts). A deterministic wrapper over the TDD gate. Verdicts are unchanged, but a violation on the test-control layer (acceptance composition root, fixtures) gains the guidance that applies:

- the inverse-scenario escape route on missing-red or content-removing denials, so "observe a red first" never reads as "delete the control";
- an atomic-fixture hint on undefined-symbol denials: a fake, its fixture key and its enum value are one unit, landed piecewise.

Other denials pass through untouched.

## `withCharacterizationTest()` + `enforceCharacterizationResolution()`

[`round-trips.ts`](../rules/round-trips.ts); wired in the Kotlin, KMP and Swift presets. A deterministic pair sanctioning the *first* test for existing behaviour, which is born green, so no red can precede it:

1. A test-layer write marked `// probity: characterization` bypasses the TDD gate. Production writes can't borrow the marker.
2. The marker comes off only through a proof-checked removal: the transcript must record that test failing under a mutation probe.
3. `git commit` is blocked while any marker is on disk.

That makes an enforced write → probe → red → revert → prove → commit round-trip.

- An unmarked test-layer write denied for lacking a red gets a deny-text note naming the marker. An agent pinning existing behaviour (say, a branch a mutation review found untested) finds the sanctioned route instead of breaking production to manufacture a red.
- A test-layer write denied as retrofitting a red test to the code gets a restart-the-cycle note instead: revert the production change and the test, rewrite the test with the corrected expectation, watch it fail, and reapply. Neither marker is offered.

## `withJudgeFailureDiagnostics()`

`gates.ts`; wraps the TDD judge in every preset. When the judge returns no verdict (a spend-limit or auth notice, empty or non-JSON output), the write stays blocked, but the deny text says it was *not* judged, names the judge, says whether the provider reported itself unavailable, and lists the writes that never call the judge. Probity's raw `could not parse verdict from validator output: …` reads like a policy rejection and sends agents into futile rewording. Genuine verdicts pass through untouched.

## Brownfield seam gaps: preconditions are controlled, not observed

A failure mode from a real iOS trial, worth designing against. The scenario was "new user whose sign-in fails is told, and offered support." In the simulator the real sign-in path genuinely fails (no reachable backend), so the test went green **without** the control fixture the agent had written, and the TDD gate, correctly demanding a red before fixture code, appeared to "refuse" the fixture. The agent resolved the tension the wrong way: it deleted the fixture and let the environment own the scenario's Given. Two costs follow:

- The test can't tell the failure it asked for from the failure the machine produced. On a connected machine the precondition silently inverts.
- The *success* path becomes unspecifiable: nothing can make sign-in succeed until the port is controlled.

The principle, in the `acceptance-testing` skill's Test Isolation section: **every Given is established by the test (fixture, programmed stub, substituted port), never inherited from the environment.** When a control fixture can't get a red, the legitimate red is the **inverse scenario** on the same port ("a new user who signs in successfully is taken into the app"). It genuinely fails until the port is controllable; its red drives the fixture, and the original scenario then adopts the explicit fixture as a refactor under green.

Pieces that enforce this:

- **[`enforceControlledPreconditions()`](../rules/acceptance-language.ts)**, AI-validated, scoped to protocol drivers and the acceptance composition root. It blocks the *no-op precondition driver* (a method named "…WhoseSignInWillFail" whose body only navigates and asserts, setting no fixture, stub or launch state, especially with a comment admitting the environment covers it). It also blocks deleting control wiring because the scenario is green without it, naming the inverse-scenario route. Scope it to the layers `enforceAcceptanceLanguage` excludes (e.g. `AcceptanceTests/Drivers/**` plus the acceptance assembly).
- **[`withInverseScenarioGuidance()`](#withinversescenarioguidance)** wraps the TDD gate; on test-control paths its deny text gains the escape route, because the deny message is what the agent reads at the decision point.
- **The [characterization round-trip](#withcharacterizationtest--enforcecharacterizationresolution)** handles the sibling trap from the same trial: the behaviour already exists, so its first test is born green, and a mutation probe can't help yet because a probe only fails tests that already exist.
- **Reason before verdict.** The same trial surfaced a denial whose reason concluded "…Re-evaluating: this is minimal green for the observed failing test. Passing." but came back as a violation. The response shape put `kind` before `reason`, and a model emits fields in order, so it commits to the verdict before its analysis. This package's own rules ask for `{"reason":…,"kind":…}` (conclude, then label). Probity's built-in `enforceTdd` still asks for the verdict first and its format isn't configurable. Until upstream changes that, patch the installed package (the calibration projects carry a `patch-package` patch reordering the fields).
- **Stop and ask.** When a scenario can't be honestly driven at all because the seam itself is missing (no port to substitute, no composition root to substitute it in), mark it `## Scenario (wip):`, which the parity gate exempts, or, with a shared spec repository, add a wip-file line naming the missing seam. Then surface the seam gap to the user as a design decision. Reshaping the scenario, weakening its Given, or letting the environment stand in is never the agent's call alone.
