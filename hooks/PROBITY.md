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
| `forbidInternalModuleMocks()` (custom) | ports-and-adapters | Deterministic: blocks newly introduced `jest.mock()` / `vi.mock()` of the team's own modules — "Ports Are the Only Test Seam". Pre-existing mocks don't re-trigger, so suites migrate incrementally |
| `enforceAcceptanceLanguage()` (custom) | acceptance-testing (+ ubiquitous-language) | AI-validated: the Language Test on spec-layer files — no UI/protocol/persistence mechanics, single outcome per spec, glossary terms verbatim when `glossaryPath` is set |
| `requireCommand(...)` (Probity built-in) | test-driven-development / `/build` / `/ship` | Deterministic: `git commit` is blocked unless the test suite ran after the last write |

## Language presets

The config above is tuned for a JS/TS project. Probity's engine and the AI-validated rules are language-agnostic (they judge writes, not test runners), but the deterministic screens are ecosystem-specific, so per-language presets swap that layer:

- **Kotlin / JVM / Android** — [`probity/probity.config.kotlin.ts`](probity/probity.config.kotlin.ts) + [`probity/rules/kotlin.ts`](probity/rules/kotlin.ts). Replaces the ESM import screen with a Kotlin `import` screen (AWS, Amplify, Apollo, Firebase, OkHttp, Retrofit, Room, JDBC, Ktor, Spring, …); replaces the jest/vi mock blocker with `forbidStaticMocks()` (Mockito `mockStatic`, MockK's `mockkStatic`/`mockkObject`/`mockkConstructor`, PowerMock — the JVM's monkey-patching equivalents, which are always seam violations; plain `mock<T>()` is left to the AI rule since only it can tell a port from an internal class); adds `forbidNewAmbientEffects()` blocking net-new `Instant.now()` / `System.currentTimeMillis()` / `Date()` / `UUID.randomUUID()` / `Random()` / `System.getenv` in core code, with a `seamHint` pointing the agent at your canonical port; extends `enforcePortsBoundary` with a Kotlin/Android addendum (DI modules are composition roots, Robolectric-in-core-tests is a smell); and gates commits on Gradle test tasks, flavored ones included.

  Two config variants ship for Kotlin, differing in layout and test-double policy: [`probity.config.kotlin.ts`](probity/probity.config.kotlin.ts) targets a classic JVM/Android multi-module codebase (`src/main/java|kotlin`, `*-core`/`*-ui` module split, a mocking library present but its monkey-patching APIs blocked); [`probity.config.kmp.ts`](probity/probity.config.kmp.ts) targets Kotlin Multiplatform with per-feature hexagonal packages (KMP source-set globs like `src/*Main/kotlin`, core purity scoped to `domain`/`port`/`usecase`/`presentation` packages with Koin included in the core import screen, a no-mocking-library-at-all rule for fakes-only conventions via `MOCKING_LIBRARY_IMPORTS`, and acceptance-language checks covering Markdown `*.feature.md` specs while excluding Robot DSL classes). The boundary-rule addendum also teaches the validator KMP idioms: `expect`/`actual` platform source sets are adapters, and a function-typed constructor parameter (`nowEpochMillis: () -> Long`) is a valid port — unless its default calls the real OS inside common code.

  Two Kotlin-specific notes. First, Probity's built-in single-new-test fast-path doesn't cover Kotlin, so the preset ships `withKotlinFastPath(enforceTdd())`: a `.kt`/`.kts` write adding exactly one `@Test` function passes deterministically (via ast-grep and the `tree-sitter-kotlin` grammar) instead of costing an AI call — the most common write in a TDD loop. It needs two optional packages (`npm install -D @ast-grep/napi @ast-grep/lang-kotlin`) and transparently falls through to plain `enforceTdd` when they're missing; like Probity's own fast-path, it trades away the refactor-readiness check on those writes. Second, the Kotlin deterministic rules are **delta-based** (they block only occurrences a write *introduces*), so a brownfield codebase with hundreds of existing direct clock calls migrates incrementally instead of having those files frozen.

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
   ```

3. **Edit the globs.** The template assumes a `src/core` + `src/adapters` layout; point the core-purity block at your actual core/domain code, the spec block at your actual spec layer, and the commit gate at your real test command. Wrong scoping is the main failure mode: `enforcePortsBoundary` on adapter files or `enforceAcceptanceLanguage` on protocol drivers will block work those files are supposed to do (both rules instruct the validator to pass on clearly mis-scoped files, but don't rely on that).

4. Wire the hook. Easiest is the plugin:

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
             { "type": "command", "command": "npx @nizos/probity --agent claude-code" }
           ]
         }
       ]
     }
   }
   ```

## Mental model

Deterministic rules are the cheap outer wall (pattern matches, no latency); AI-validated rules are the judgment layer behind it. Each AI rule sends the validator a distilled version of the corresponding SKILL.md's rules plus the current file and the pending write, and gets back a pass/violation verdict. The prompts follow Probity's own `enforceTdd` conventions: judge the *change* rather than the whole file, never punish transient in-progress states, and treat an explicit user instruction to let a change through as authoritative — it's a guardrail, not a jail.

Customize the AI rules without forking them via `instructions: (defaults) => defaults + '...'` — e.g. name your project's core and adapter directories so `enforcePortsBoundary` infers file roles precisely.

## Costs and caveats

- **AI rules cost a model call per matching write.** Scope tightly. `enforceTdd({ fastPath: true })` skips the AI when a write adds exactly one test (at the price of skipping refactor enforcement).
- **Agent support:** Probity supports Claude Code, GitHub Copilot CLI, and Codex. The skills in this catalog work in eight-plus tools; treat this as an optional hardening layer, not a dependency.
- **npm required** in the consuming project. The rules themselves are language-agnostic (they judge writes, not test runners), but `forbidInternalModuleMocks` recognizes jest/vitest specifically — extend `MODULE_MOCK_PATTERN` for other ecosystems.
- **Fail-closed:** if a rule throws or the AI validator is unavailable, Probity blocks. The custom rules return an explicit violation naming the misconfiguration when no AI agent is wired.
- **Override is in-session:** the agent can ask the user to wave a blocked change through, and the validator honors that on the next attempt. Softer than it sounds; it means disagreements surface to you instead of being silently forced either way.
