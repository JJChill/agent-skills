# probity enforcement templates

Opt-in hard enforcement for three of this catalog's disciplines — [`test-driven-development`](../skills/test-driven-development/SKILL.md), [`ports-and-adapters`](../skills/ports-and-adapters/SKILL.md), and [`acceptance-testing`](../skills/acceptance-testing/SKILL.md) — via [Probity](https://github.com/nizos/probity), a PreToolUse rule engine for coding agents.

## Why

The skills in this catalog are prose: the agent reads the rules and follows them. That works until it doesn't — the Common Rationalizations tables exist precisely because prose gets rationalized away under pressure. Probity closes that gap: it intercepts every `Write`/`Edit`/`Bash` call *before it executes*, validates it against configured rules, and blocks violations with a corrective message the agent self-corrects from. The skills keep teaching the *why and how*; Probity enforces the *that*, per tool call.

The two layers are complementary by design: when Probity blocks an action, its reason lands on an agent that has the corresponding skill in context, so the recovery is informed rather than blind.

## What's in the template

[`probity/probity.config.ts`](probity/probity.config.ts) plus two custom rule modules under [`probity/rules/`](probity/rules/):

| Rule | Skill it enforces | Mechanism |
|---|---|---|
| `enforceTdd()` (Probity built-in) | test-driven-development | AI-validated: every production write must address an observed failing test, minimally; refactor debts block the next red |
| `forbidContentPattern(KNOWN_INFRASTRUCTURE_IMPORTS)` | ports-and-adapters | Deterministic: known framework/vendor/OS-I/O imports never enter core code — caught free, before any AI call |
| `enforcePortsBoundary()` (custom) | ports-and-adapters | AI-validated: the Dependency Rule, thin adapters (no business conditionals), vendor types kept out of port signatures |
| `enforceAdapterObservability()` (custom) | ports-and-adapters + observability-and-instrumentation | AI-validated, scoped to adapter paths: a NEW adapter path doing external I/O must carry boundary observability — a structured event, a port-tap/recording decorator, or a span. Thin, not blind. Delta-based; pure mappers, wiring, and tests pass; takes a `conventionHint` naming your telemetry convention. Guarantees telemetry *presence*, never field safety (sensitive-field discipline stays with review). Note it runs after the TDD gate (first violation wins), so on brand-new behaviour TDD answers first — a second-pass gate; its deny text tells the agent to assert the event in the failing test so both gates ask for the same thing, and `withTelemetryFastPath` makes telemetry-only additions free on both sides |
| `forbidInternalModuleMocks()` (custom) | ports-and-adapters | Deterministic: blocks newly introduced `jest.mock()` / `vi.mock()` of the team's own modules — "Ports Are the Only Test Seam". Pre-existing mocks don't re-trigger, so suites migrate incrementally |
| `enforceAcceptanceLanguage()` (custom) | acceptance-testing (+ ubiquitous-language) | AI-validated: the Language Test on spec-layer files — no UI/protocol/persistence mechanics, single outcome per spec, glossary terms verbatim when `glossaryPath` is set. One standard across artifacts: wording that violates in a test step ("the backend rejects creation") violates in the Markdown scenario too — the spec is judged as the source tests transcribe |
| `requireSpecBackedAcceptanceTest()` (custom, Kotlin & Swift presets) | acceptance-testing + specification-by-example | Deterministic, write-time: a write adding a new acceptance test case must also add a `Covers:` tag resolving to a scenario that already exists in `docs/specs` — the feature file is written before the test that claims it. Closes the tagless-suite gap the commit-time parity gate can't see |
| `requireGreenTestRun()` (custom, Kotlin & Swift presets) | test-driven-development / `/build` / `/ship` | Deterministic: `git commit` is blocked unless the test suite ran after the last write **and its recorded output was green** — Probity's `requireCommand` checks only that a run was recorded, and would pass a transcript whose latest run failed. Same inherent limit: runs outside the session transcript (another terminal, CI) are invisible |
| `withMutationProbe()` + `enforceProbeReversion()` (custom, Kotlin & Swift presets) | acceptance-testing (mutation checks) | Deterministic pair: a production write marked `// probity: mutation-probe` (a deliberate break proving a retrofitted test bites) bypasses the TDD gate, and `git commit` is blocked while any probe marker is still on disk — an enforced mark → red → revert → commit round-trip instead of an override |
| `enforceControlledPreconditions()` (custom) | acceptance-testing (controlled preconditions) | AI-validated, scoped to the driver and test-control layers (the opposite scoping from `enforceAcceptanceLanguage`): a driver method named for a precondition must establish it (fixture key, launch environment, programmed fake), and control wiring is never deleted just because the scenario passes without it — see "Brownfield seam gaps" below |
| `withInverseScenarioGuidance()` (custom) | test-driven-development × acceptance-testing | Deterministic wrapper over the TDD gate: verdicts unchanged, but a violation on the test-control layer (acceptance composition root, fixtures) gains the guidance that applies — the inverse-scenario escape route on missing-red/content-removing denials (so "observe a red first" never reads as "delete the control"), or an atomic-fixture hint on undefined-symbol denials (a fake + its fixture key + its enum value are one unit, landed piecewise). Other denials pass through untouched |
| `withCharacterizationTest()` + `enforceCharacterizationResolution()` (custom) | test-driven-development × acceptance-testing (characterization coverage) | Deterministic pair sanctioning the FIRST test for pre-existing behavior (born green — no red can precede it): a test-layer write marked `// probity: characterization` bypasses the TDD gate; the marker only comes off through a proof-checked removal (the transcript must record that test failing under a mutation probe), and `git commit` is blocked while any marker is on disk — an enforced write → probe → red → revert → prove → commit round-trip |

## Language presets

The config above is tuned for a JS/TS project. Probity's engine and the AI-validated rules are language-agnostic (they judge writes, not test runners), but the deterministic screens are ecosystem-specific, so per-language presets swap that layer:

- **Kotlin / JVM / Android** — [`probity/probity.config.kotlin.ts`](probity/probity.config.kotlin.ts) + [`probity/rules/kotlin.ts`](probity/rules/kotlin.ts). Replaces the ESM import screen with a Kotlin `import` screen (AWS, Amplify, Apollo, Firebase, OkHttp, Retrofit, Room, JDBC, Ktor, Spring, …); replaces the jest/vi mock blocker with `forbidStaticMocks()` (Mockito `mockStatic`, MockK's `mockkStatic`/`mockkObject`/`mockkConstructor`, PowerMock — the JVM's monkey-patching equivalents, which are always seam violations; plain `mock<T>()` is left to the AI rule since only it can tell a port from an internal class); adds `forbidNewAmbientEffects()` blocking net-new `Instant.now()` / `System.currentTimeMillis()` / `Date()` / `UUID.randomUUID()` / `Random()` / `System.getenv` in core code, with a `seamHint` pointing the agent at your canonical port; extends `enforcePortsBoundary` with a Kotlin/Android addendum (DI modules are composition roots, Robolectric-in-core-tests is a smell); and gates commits on Gradle test tasks, flavored ones included.

  Two config variants ship for Kotlin, differing in layout and test-double policy: [`probity.config.kotlin.ts`](probity/probity.config.kotlin.ts) targets a classic JVM/Android multi-module codebase (`src/main/java|kotlin`, `*-core`/`*-ui` module split, a mocking library present but its monkey-patching APIs blocked); [`probity.config.kmp.ts`](probity/probity.config.kmp.ts) targets Kotlin Multiplatform with per-feature hexagonal packages (KMP source-set globs like `src/*Main/kotlin`, core purity scoped to `domain`/`port`/`usecase`/`presentation` packages with Koin included in the core import screen, a no-mocking-library-at-all rule for fakes-only conventions via `MOCKING_LIBRARY_IMPORTS`, and acceptance-language checks covering Markdown `*.feature.md` specs while excluding Robot DSL classes). The boundary-rule addendum also teaches the validator KMP idioms: `expect`/`actual` platform source sets are adapters, and a function-typed constructor parameter (`nowEpochMillis: () -> Long`) is a valid port — unless its default calls the real OS inside common code.

  Two Kotlin-specific notes. First, Probity's built-in single-new-test fast-path doesn't cover Kotlin, so the preset ships `withKotlinFastPath(enforceTdd())`: a `.kt`/`.kts` write adding exactly one `@Test` function passes deterministically (via ast-grep and the `tree-sitter-kotlin` grammar) instead of costing an AI call — the most common write in a TDD loop. It needs two optional packages (`npm install -D @ast-grep/napi @ast-grep/lang-kotlin`) and transparently falls through to plain `enforceTdd` when they're missing; like Probity's own fast-path, it trades away the refactor-readiness check on those writes. Second, the Kotlin deterministic rules are **delta-based** (they block only occurrences a write *introduces*), so a brownfield codebase with hundreds of existing direct clock calls migrates incrementally instead of having those files frozen.

- **Swift / iOS** — [`probity/probity.config.swift.ts`](probity/probity.config.swift.ts) + [`probity/rules/swift.ts`](probity/rules/swift.ts). Most of the stack is reused verbatim because it is language-neutral: the spec-traceability rules already match Swift's `func test…` declarations, the language/glossary rules judge content, and the generic gates (`requireGreenTestRun`, the mutation-probe pair, `withTelemetryFastPath`) take patterns as options. The Swift module supplies only what is Xcode-specific: a fixed-sleep screen for the acceptance suite (`sleep`/`usleep`/`Thread.sleep`/`Task.sleep` — the top XCUITest flakiness source), an XCUITest-mechanics containment screen (`XCUIApplication`/`XCUIElement` allowed only in `AcceptanceTests/Drivers/`), and xcodebuild patterns for the commit gate (`xcodebuild … test` invocations judged green by the `** TEST SUCCEEDED **` banner or an `xcresulttool` summary reporting `"result": "Passed"`). One layout note: the parity scanners' default test-file pattern expects a lowercase `acceptance/` path segment; iOS suites conventionally live in `AcceptanceTests/`, so the preset overrides `testFilePattern` everywhere — keep that override if you rename the directory. Calibrated against a production CocoaPods + SwiftPM app with an XCUITest target plus an app-hosted component-test target sharing one scenario layer. The Swift preset also wires the brownfield seam-gap rules (see below): `enforceControlledPreconditions()` on `AcceptanceTests/Drivers/**` and the acceptance composition root, `withInverseScenarioGuidance()` around the TDD gate for writes to that root, and the characterization round-trip (`withCharacterizationTest()` on the acceptance suite plus the `enforceCharacterizationResolution()` commit gate).

## Spec↔test traceability (KMP preset)

The KMP preset also enforces the `acceptance-testing` skill's definition of done mechanically: every scenario in a Markdown spec is claimed by an acceptance test, and every claim resolves to a real scenario. The link is declared, not inferred — a test carries a tag (comment or annotation argument):

```kotlin
// Covers: messaging.feature.md :: Scenario: Message is delivered to a contact
```

Three deterministic rules in [`probity/rules/spec-test-parity.ts`](probity/rules/spec-test-parity.ts) hold the invariant from both ends — and enforce the *ordering*:

- **`requireSpecBackedAcceptanceTest({ specsDir })`** fires at write time on the acceptance test-case layer: a write that adds a new test case (`@Test`, or Swift's `func test…`) must also add a `Covers:` tag resolving to a `## Scenario:` heading that **already exists** in `specsDir`. This is spec-first made mechanical — an agent cannot author acceptance tests without writing the feature file first, and the deny message says exactly what to create and where. Delta-based: edits inside existing brownfield test files pass untouched, and `(wip)`/`(planned)` scenarios count as existing (they're exactly what outside-in work drives against). Without this rule, a tagless acceptance suite is invisible to the commit gate below — the gap we hit on a real iOS trial, where an agent produced a whole suite with no feature file and nothing objected.

- **`enforceSpecTestParity()`** gates `git commit`: it scans `docs/specs/*.feature.md` for `## Scenario:` headings and the acceptance dirs for `Covers:` tags, and blocks with a two-sided report — scenarios no test claims, and tags pointing at scenarios that no longer exist. Parity requires the *link*, not a passing run (the claiming test may still be red or quarantined); scenarios still being driven outside-in are exempted with `## Scenario (wip):`.

  **Brownfield adoption:** a spec suite that predates the gate would block every commit (a real KMP app we trialed this on had 454 scenarios and zero tags). The rule takes a `baselinePath`: generate the baseline once — `node scripts/spec-parity.mjs --specs docs/specs --baseline docs/specs/.parity-baseline --write-baseline` — and commit it. Baselined scenarios are exempt from the orphan check while every new scenario is enforced from day one; burn the file down by deleting lines as coverage lands. A missing baseline file means full enforcement (the greenfield default), and dangling `Covers:` tags are never baselined — they are actively wrong, not legacy.

  **Per-scenario driver mapping:** the rule optionally checks coverage per *(scenario, driver scope)*, not just per scenario. Declare named scopes (`driverScopes: [{ name: 'system', filePattern: /AcceptanceTests[/\\]Specs[/\\]/ }, …]`) mapping each scope to its test files, and tag scenarios that need more than the default suite — `## Scenario [system]: …` (composes with wip as `## Scenario (wip) [system]:`). A tagged scenario must be covered by a test matching that scope's pattern, on top of the base check; `defaultScopes` names scopes every scenario must satisfy even untagged (the project's standard driver set). Tags are floors, never ceilings — extra coverage in other scopes is always fine — and a tag naming an undeclared scope blocks (misspelling protection). Tags never change scenario keys, so existing `Covers:` tags and baselines are unaffected; baselined and wip scenarios are exempt from scope checks too. The rationale and the tag convention live in the `acceptance-testing` skill's Layer 3 section.

  **The baseline is where dead coverage hides.** While it exists, the parity gate is advisory for everything in it — and mutation checks are the mechanism that surfaces the cost: a mutation probe that stays green under every suite usually means the behavior's scenario is sitting in the baseline, untested. Treat every green probe as a burn-down prompt (write the claiming test, delete the baseline line), not as a reason to pick a different probe.
- **`surfaceScenarioLinkBreakage()`** fires on `*.feature.md` writes: removing or renaming a scenario heading that tests still claim blocks immediately, listing the affected tests — so a rename updates its `Covers:` tags in the same change instead of rotting until commit time.

Because scenario titles are link keys, renames must touch the claiming tests — that's the point, and the breakage rule turns it into a guided step. Hooks only run in agent sessions, so [`probity/scripts/spec-parity.mjs`](probity/scripts/spec-parity.mjs) ships the same check as a zero-dependency CLI for CI and human commits: `node spec-parity.mjs --specs docs/specs` (exit 1 on breakage); driver scopes mirror as `--scope system=<path regex>` (repeatable) and `--default-scopes a,b`.

## Brownfield seam gaps: preconditions are controlled, not observed

A failure mode from a real iOS trial, worth designing against. The scenario was "new user whose sign-in fails is told, and offered support." In the simulator the real sign-in path genuinely fails (no reachable backend), so the test went green **without** the control fixture the agent had written — and the TDD gate, correctly demanding a red before fixture code, appeared to "refuse" the fixture. The agent resolved the tension in the wrong direction: it deleted the fixture and let the environment own the scenario's Given. Two real costs follow: the test can't distinguish the failure it asked for from the failure the machine produced (on a connected machine the precondition silently inverts), and the *success* path becomes unspecifiable — nothing can make sign-in succeed until the port is controlled.

The principle (now in the `acceptance-testing` skill's Test Isolation section): **every Given is established by the test — fixture, programmed stub, substituted port — never inherited from the environment.** And the escape route when a control fixture can't get a red: the legitimate red is the **inverse scenario** on the same port ("a new user who signs in successfully is taken into the app"), which genuinely fails until the port is controllable; its red drives the fixture, and the original scenario then adopts the explicit fixture as a refactor under green.

Three pieces enforce this mechanically:

- **`enforceControlledPreconditions()`** ([`probity/rules/acceptance-language.ts`](probity/rules/acceptance-language.ts)) — AI-validated, scoped to protocol drivers and the acceptance composition root. Blocks the *no-op precondition driver* (a method named "…WhoseSignInWillFail" whose body only navigates and asserts, setting no fixture/stub/launch state — especially with a comment admitting the environment covers it) and blocks deleting control wiring on the grounds that the scenario is green without it, naming the inverse-scenario route in the deny text. Scope it to the layers `enforceAcceptanceLanguage` excludes (e.g. `AcceptanceTests/Drivers/**` plus the acceptance assembly).
- **`withInverseScenarioGuidance()`** ([`probity/rules/kotlin.ts`](probity/rules/kotlin.ts)) — wraps the TDD gate; on test-control paths its deny text gains the escape route, because the deny message is what the agent actually reads at the decision point.
- **The characterization round-trip** — the sibling trap, hit on the same trial: the behavior already exists in production, so its *first* test is born green and no red keyed to it can ever be observed — and a mutation probe can't help yet, because a probe only fails tests that already exist. An unwrapped TDD gate correctly denies the test write, leaving only an override or an unspecified behavior. `withCharacterizationTest()` + `enforceCharacterizationResolution()` ([`probity/rules/kotlin.ts`](probity/rules/kotlin.ts)) sanction it as an enforced round-trip instead: the test lands carrying `// probity: characterization` (test-layer paths only — production writes can't borrow the marker); the marker's removal is blocked until the session transcript records that test failing under a mutation probe (the acceptance-testing skill's mutation-check for retrofitted specs, made mechanical); and commits are blocked while any marker remains. The green is earned, not exempted.
- **Verdict-before-reasoning (a validator bug class, not a brownfield trap).** The same trial surfaced a denial whose reason text literally concluded "…Re-evaluating: this is minimal green for the observed failing test. Passing." — returned as a violation. Root cause: the validator response shape put `kind` before `reason`, and an autoregressive model emits fields in order — it must commit to the verdict before writing its analysis, so a mind changed mid-`reason` can't revise the already-emitted `kind`. The custom rules in this repo now use a reason-first shape (`{"reason":…,"kind":…}` — conclude, then label). Probity's built-in `enforceTdd` ships the kind-first shape and its response format is not configurable; until upstream fixes it, patch the installed package (the calibration projects carry a `patch-package` patch reordering the fields).
- **The stop-and-ask protocol** — when a scenario cannot be honestly driven at all because the seam itself is missing (no port to substitute, no composition root to substitute it in), the sanctioned move is to mark it `## Scenario (wip):` (which the parity gate already exempts) and surface the seam gap to the user as a design decision. Silently reshaping the scenario, weakening its Given, or letting the environment stand in is never the agent's call to make unilaterally.

## Ubiquitous language

The glossary (`docs/GLOSSARY.md`, format in [`probity/GLOSSARY.template.md`](probity/GLOSSARY.template.md): one term per `##` heading, one term per concept) is wired into both Kotlin config templates and enforced from three directions:

- **Usage in specs** — `enforceAcceptanceLanguage({ glossaryPath })`: spec content naming a recorded concept with a synonym or conflicting term is blocked. Optional strict mode `requireGlossaryEntry: true` enforces "the glossary conversation happens first": a domain concept with *no* entry blocks until the glossary gets one — turn it on once the glossary has real coverage, not day one.
- **Usage in code** — `enforcePortsBoundary({ glossaryPath })`: the boundary validator gets the glossary, so ports and domain types naming a recorded concept with a conflicting term are violations (`ShipmentStore` when the glossary says Parcel).
- **Drift** — `surfaceGlossaryTermBreakage()` on glossary writes: removing or renaming a term that specs, tests, or code still use blocks the edit with the list of users. Multi-word terms are matched as identifiers too (`Delivery Window` → `DeliveryWindow`/`deliveryWindow`/`delivery_window`). Retiring a term nothing uses passes silently.

All three degrade gracefully while `docs/GLOSSARY.md` doesn't exist, so the wiring costs nothing before the glossary conversation starts.

## Setup

Probity lives in the **consuming project** (the codebase you're building), not in this repo.

1. In your project:

   ```bash
   npm install -D @nizos/probity
   ```

2. Copy the templates to your project root:

   ```bash
   cp <agent-skills>/hooks/probity/probity.config.ts .
   cp -r <agent-skills>/hooks/probity/rules ./rules
   cp -r <agent-skills>/hooks/probity/scripts ./scripts
   ```

3. **Edit the globs.** The template assumes a `src/core` + `src/adapters` layout; point the core-purity block at your actual core/domain code, the spec block at your actual spec layer, and the commit gate at your real test command. Wrong scoping is the main failure mode, in both directions: `enforcePortsBoundary` on adapter files or `enforceAcceptanceLanguage` on protocol drivers will block work those files are supposed to do (both rules instruct the validator to pass on clearly mis-scoped files, but don't rely on that), while a glob slightly too narrow for your layout fails silently — the rule simply never fires.

4. **Check the scoping** before the first agent session finds out the hard way:

   ```bash
   npx tsx scripts/scope-report.ts --config probity.config.ts
   ```

   The report resolves every `{ files, rules }` block against your real tree with Probity's own glob semantics and prints what each block claims, flagging dead scopes (globs matching zero files — the silent failure), core-purity rules claiming adapter/DI/UI-looking paths, and the acceptance-language rule claiming Robot/driver files. Re-run it (or wire `--strict` into CI) whenever the layout or the globs change.

5. Wire the hook. Easiest is the plugin:

   ```
   /plugin marketplace add nizos/probity
   /plugin install probity@probity
   ```

   Or manually in `.claude/settings.json`:

   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash|Write|Edit|NotebookEdit",
           "hooks": [
             { "type": "command", "command": "cd \"$CLAUDE_PROJECT_DIR\" && ./node_modules/.bin/probity --agent claude-code" }
           ]
         }
       ]
     }
   }
   ```

   Anchor the hook with `cd "$CLAUDE_PROJECT_DIR" &&`, never a bare relative `./node_modules/...`: hooks are not guaranteed to run with the repo root as their working directory (a session launched from a parent directory, a worktree, a `cd` elsewhere). A bare relative path then fails to resolve and the hook errors **non-blocking** — every rule silently stops enforcing while work continues. The `cd` also matters beyond binary resolution: Probity discovers `probity.config.ts` by searching upward from the working directory, so a hook run from the wrong cwd finds no config even with an absolute bin path. Prefer the direct bin path over `npx @nizos/probity`: the hook runs on **every** matched tool call, and npx's resolution overhead is ~0.6-1.6s per call vs ~0.2s for the bin (measured on a warm cache). A truly resident validator process would cut the remaining startup too, but that's engine work — worth an upstream issue, not something the templates can provide.

## Mental model

Deterministic rules are the cheap outer wall (pattern matches, no latency); AI-validated rules are the judgment layer behind it. **Rule order enforces that economics:** Probity stops at the first violation, so both Kotlin configs list every deterministic screen before any AI rule — a vendor import in core code is rejected free by the import screen, never after a TDD model call. Preserve that ordering when editing the configs; the workflow eval asserts it (deterministically-blocked steps must consult no AI validator). Each AI rule sends the validator a distilled version of the corresponding SKILL.md's rules plus the current file and the pending write, and gets back a pass/violation verdict. The prompts follow Probity's own `enforceTdd` conventions: judge the *change* rather than the whole file, never punish transient in-progress states, and treat an explicit user instruction to let a change through as authoritative — it's a guardrail, not a jail.

Customize the AI rules without forking them via `instructions: (defaults) => defaults + '...'` — e.g. name your project's core and adapter directories so `enforcePortsBoundary` infers file roles precisely.

## Evaluating the workflow

[`probity/evals/workflow-eval.ts`](probity/evals/workflow-eval.ts) evaluates the full enforcement stack as a **scripted episode**: a made-up feature (parcel tracking) is driven through the entire outside-in loop — glossary write, spec write, glossary-conflicting spec (blocked), UI-leaking spec (blocked), tagless acceptance test and a tag citing a nonexistent scenario (both blocked — spec-first at write time), acceptance test with Covers tag (fast-path verified), premature production code (blocked), red run, minimal implementation, vendor import in domain code (blocked), direct clock read (blocked), mocking-library import (blocked), commit before tests (blocked), commit on green (allowed), covered-scenario rename (blocked), wip promotion without a test (parity-blocked at commit, then baselined and allowed — the incremental-adoption path), used-term glossary rename (blocked), a backend-naming spec scenario (blocked — one language standard for specs and tests), a mutation-probe round-trip (probe allowed with no TDD call, commit blocked while the probe is on disk, allowed after reversion), unused-term retirement (allowed), a driver-scope round-trip (a `[system]`-tagged scenario: misspelled tag commit-blocked, tag without system-suite coverage commit-blocked, allowed once a thin system-driver test claims the scenario) — 48 steps, each asserting the expected decision and firing rule. Deterministically-blocked steps also assert that no AI validator was consulted, pinning the deterministic-before-AI rule order. Correctly blocked actions are not materialized, exactly as a real hook prevents them, so the episode's file state stays honest.

Scoping is part of what the episode exercises: the eval runs the rule entries exported by `probity.config.kmp.ts` itself (via its `kmpRuleEntries` factory), resolving each block's `files` globs with [`probity/rules/scoping.ts`](probity/rules/scoping.ts) — a pinned replica of Probity's picomatch matcher and glob anchoring. Four of the 48 steps are deliberately **out-of-scope** writes carrying content the core rules would block — a Room adapter with a vendor import and a real clock read, a Koin DI module, a mechanics-laden `TrackingRobot.kt` and its split-layout `TrackingViewModelDriver.kt` twin (the four-layer model's `*Dsl.kt`/`*Driver.kt` files are excluded alongside `*Robot.kt`) — and assert not just `allow` but that no AI validator was even consulted (`expectAiSilent`), so an eroded exclusion or over-broadened core glob in the template fails the eval instead of shipping.

Two modes:

- `npx tsx workflow-eval.ts` — scripted AI verdicts. CI-safe and deterministic: exercises the wiring, rule ordering, and every deterministic rule exactly; the AI rules' *invocation* is verified while their verdicts are assumed.
- `npx tsx workflow-eval.ts --live` — real verdicts via the `claude` CLI. Additionally evaluates the AI rules' prompt quality: does `enforceTdd` actually block the premature write and pass the post-red minimal one, does the Language Test catch the click-the-button scenario. Live mode asserts outcomes only (a write violating several rules may block on whichever rule runs first, as in a real session) and costs ~a dozen model calls.

What the harness does not cover: Probity's own engine — hook payload parsing and transcript adapters — and any drift between `rules/scoping.ts` and the engine's matcher across Probity upgrades (the replica exists because Probity doesn't export its matcher; it is pinned to a version and documents what to diff on upgrade). A mis-scoped glob in **your** edited config is the scope report's job (Setup step 4), not the eval's: run `scripts/scope-report.ts` against your real tree at setup and whenever the layout changes.

## Costs and caveats

- **AI rules cost a model call per matching write.** Scope tightly. `enforceTdd({ fastPath: true })` skips the AI when a write adds exactly one test (at the price of skipping refactor enforcement). Fast-paths must cover **every** rule scoped to a file or they buy nothing: a single-`@Test` write under `acceptance/**` fast-paths the TDD rule *and* — via `withAcceptanceLanguageFastPath` — the Language Test, provided the new test only reuses vocabulary already declared in the suite's DSL files and contains no mechanism words; anything novel falls through to the validator.
- **Agent support:** Probity supports Claude Code, GitHub Copilot CLI, and Codex. The skills in this catalog work in eight-plus tools; treat this as an optional hardening layer, not a dependency.
- **npm required** in the consuming project. The rules themselves are language-agnostic (they judge writes, not test runners), but `forbidInternalModuleMocks` recognizes jest/vitest specifically — extend `MODULE_MOCK_PATTERN` for other ecosystems.
- **Fail-closed:** if a rule throws or the AI validator is unavailable, Probity blocks. The custom rules return an explicit violation naming the misconfiguration when no AI agent is wired.
- **AI verdicts have variance.** The validator sees the pending file and the session transcript — not the definitions of types the file references — so it can occasionally deny on a wrong guess about a referenced type, and an identical re-replay may pass. Treat a surprising deny as worth one re-read of its reason before adapting; giving validators referenced-file access is an upstream improvement worth pursuing.
- **Override is in-session:** the agent can ask the user to wave a blocked change through, and the validator honors that on the next attempt. Softer than it sounds; it means disagreements surface to you instead of being silently forced either way.
- **These gates deter rationalization, not deliberate deception.** An adversarial replay trial (real iOS project, 20 fabricated events) confirmed the honest paths and also the limits: the green-run gate matches *recorded output*, so an echoed success banner or a re-read of a stale `.xcresult` satisfies it, and its "writes since the last run" index only advances on Write/Edit tool events — a file changed via shell redirection (`cat > file <<EOF`) is invisible. Treat the gates as guardrails for an agent trying to cut corners under pressure, and keep CI as the arbiter of record. Anchoring the gate to result-bundle freshness (compare the `.xcresult` timestamp against source mtimes) is the known upstream improvement.
- **Audit the write-rule globs against your real tree** (`scripts/scope-report.ts`). A write that no rule matches is a silent free pass, and layout surprises are common — the iOS trial found the app's `AppDelegate.swift` sitting *beside* `App/Sources/`, outside every glob, and an acceptance suite created in a new directory would be equally invisible. Scope rules to the *directory* that owns a layer, not to filename suffixes (`AcceptanceTests/**`, not `**/*Tests.swift` — a creative filename dodges a suffix; a test-method pattern inside the rule doesn't care what the file is called).
- **Division of labor, observed live:** the deterministic screens are trivially evaded by construction (`"XCUI" + "Application"` slips a regex), but in the same trial the AI TDD validator caught exactly that obfuscation, with an accurate explanation — while also being the layer that costs seconds and can't see files the globs exclude. Regexes are the cheap wall, AI is the judgment backstop, and neither substitutes for correct scoping.
