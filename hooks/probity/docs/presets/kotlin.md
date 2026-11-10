# Kotlin and KMP presets

Two Kotlin presets ship, differing in layout and test-double policy:

| Preset | Template | Factory | Calibrated for |
|---|---|---|---|
| Kotlin / JVM / Android | [`probity.config.kotlin.ts`](../../probity.config.kotlin.ts) | `kotlinRuleEntries(root, options?)` ([`presets/kotlin.ts`](../../presets/kotlin.ts)) | A classic multi-module Gradle codebase: `src/main/java\|kotlin`, a `*-core`/`*-ui` module split, a mocking library present but its monkey-patching APIs blocked |
| Kotlin Multiplatform | [`probity.config.kmp.ts`](../../probity.config.kmp.ts) | `kmpRuleEntries(root, options?)` ([`presets/kmp.ts`](../../presets/kmp.ts)) | Per-feature hexagonal packages, KMP source sets (`src/*Main/kotlin`), fakes only, Markdown specs in `docs/specs/` |

The Kotlin-specific rules are in [`rules/kotlin.ts`](../../rules/kotlin.ts).

Back to the [overview](../../../PROBITY.md). Other presets: [JS/TS](js.md), [Swift](swift.md).

## What the Kotlin layer replaces

Probity's engine and the AI-validated rules are language-agnostic: they judge writes, not test runners. The deterministic screens are ecosystem-specific, so this preset swaps that layer.

- **Imports.** A Kotlin `import` screen replaces the ESM one: AWS, Amplify, Apollo, Firebase, OkHttp, Retrofit, Room, JDBC, Ktor, Spring and more (`KOTLIN_INFRASTRUCTURE_IMPORTS`). The KMP preset includes Koin in it.
- **Mocks.** `forbidStaticMocks()` replaces the jest/vi mock blocker. It blocks Mockito `mockStatic`, MockK's `mockkStatic`/`mockkObject`/`mockkConstructor` and PowerMock, the JVM's monkey-patching equivalents, which are always seam violations.
  - Plain `mock<T>()` is left to the AI rule, since only it can tell a port from an internal class.
  - The KMP preset goes further, with no mocking library at all (`MOCKING_LIBRARY_IMPORTS`) for fakes-only conventions.
- **Ambient effects.** `forbidNewAmbientEffects()` blocks net-new `Instant.now()`, `System.currentTimeMillis()`, `Date()`, `UUID.randomUUID()`, `Random()` and `System.getenv` in core code. `seamHint` points the agent at your canonical port.
- **Boundary judge.** `enforcePortsBoundary` gets a Kotlin/Android addendum (`KOTLIN_BOUNDARY_ADDENDUM`): DI modules are composition roots, and Robolectric in core tests is a smell. The KMP idioms it knows:
  - `expect`/`actual` platform source sets are adapters;
  - a function-typed constructor parameter (`nowEpochMillis: () -> Long`) is a valid port, unless its default calls the real OS inside common code.
- **Commit gate.** Commits are gated on Gradle verification tasks; see [`requireGreenTestRun()`](../rules.md#requiregreentestrun) for the accepted tasks, spoofing rejections and the Kiro exit-status allowance.
- **Core scope (KMP).** Core purity covers the `domain`, `port`, `usecase` and `presentation` packages.
- **Acceptance language (KMP).** The checks cover Markdown `*.feature.md` specs, and leave out Robot, DSL and driver classes (`*Robot.kt`, `*Dsl.kt`, `*Driver.kt`).
- **Delta-based.** The Kotlin deterministic rules block only occurrences a write *introduces*, so a brownfield codebase with hundreds of existing direct clock calls migrates incrementally instead of having those files frozen.

Both presets also wire the language-neutral layers:
- [spec↔test traceability](../options.md#spectest-traceability): the full set in the KMP preset; only the write-time `Covers:` gate (`requireSpecBackedAcceptanceTest`) in the classic Kotlin preset;
- the [glossary](../options.md#ubiquitous-language), [fixed-wait screening](../options.md#no-fixed-waits-in-acceptance-code-fixedwaitglobs) and the [shell-write screen](../options.md#shell-writes-to-scoped-files-shellwritescreen);
- the [mutation-probe](../rules.md#withmutationprobe--enforceprobereversion) and [characterization](../rules.md#withcharacterizationtest--enforcecharacterizationresolution) round-trips around the TDD gate.

## The Kotlin TDD gate

The preset ships `withKotlinFastPath(enforceKotlinTdd())`, because Probity's built-in single-new-test fast path doesn't cover Kotlin.

**The deterministic fast path.** A write under a classic or KMP Kotlin test source set that adds exactly one runnable, structurally annotated `@Test` function passes without an AI call. It parses with ast-grep and the `tree-sitter-kotlin` grammar.

- **Existing files.** An existing file must keep every prior source byte and test function, and make one contiguous insertion containing only the test (plus comments and whitespace), or a separate test class with no other functions.
- **New files.** A brand-new file may also include imports and property fixtures.
- **Parser packages.** They ship as exact-version optional dependencies and install automatically on supported platforms; `npm install --omit=optional` disables the path. When parser support is missing or fails, the write goes to the AI judge with an explicit diagnostic.
- **Always judged instead:**
  - test deletion, disabling or weakening, and newly introduced disable controls;
  - changes to existing test-container headers;
  - declarations that shadow identifiers existing tests use;
  - writes adding several tests;
  - all production-source paths.
- **Trade-off.** Like Probity's built-in fast paths, a deterministic pass skips the AI judge's green→red refactor-readiness check for that write.

**The judge's window.** The delegated judge keeps 20 recent events, each clipped at 6,000 characters, so nearby Gradle reds survive normal source inspection while prompt growth stays bounded.

**Extraction under green.** Because of that clip, the judge can't see most of a large file the session read, so the preset also wraps it in `withExtractionUnderGreen`. When a write creates a new production file and the latest Gradle build or test run was green, a separate judge gets the full on-disk content of the production files the session read or edited.

- **Passes** if every behaviour in the write is already there: an extract-and-move refactor, including an interface plus its implementation, with the original still in place.
- **Blocks by name** a move with new behaviour added, since under green no failing test justifies it.
- **An unsure answer** falls through to the TDD judge.

**What counts as red.**

- **`TODO()` reds.** A targeted relevant test executing `TODO()` or `kotlin.NotImplementedError` is a clean red without a second assertion-failure run. This is an explicit Kotlin exception to the generic placeholder guidance. Implementation stays bounded by assertions in the relevant test source visible in recent history.
- **Compile, import and signature failures** authorize scaffolding only.
- **One cohesive green write** may span all the methods or branches those visible assertions require, without artificial reruns in between.
- **Git staging and index state** are ignored.

## KMP options

`kmpRuleEntries(root, options?)` takes `KmpPresetOptions`, a superset of the factory's original `{ driverScopes, defaultScopes }` shape, so callers passing that shape keep working. Every path in the preset is an option, each defaulting to the reference layout:

| Option | Default |
|---|---|
| `specsDir` | `docs/specs` |
| `specGlobs` | `docs/specs/**/*.feature.md` |
| `glossaryPath` | `docs/GLOSSARY.md` |
| `coreGlobs` | the `domain`, `port`, `usecase`, `presentation` packages under `src/commonMain` |
| `acceptanceTestGlobs` | `**/acceptance/**/*Spec.kt`, `**/acceptance/**/*Test.kt` |
| `testRoots`, `testFilePattern`, `testDeclarationPattern`, `baselinePath` | the reference layout's |
| `driverScopes`, `defaultScopes` | none |

`kotlinRuleEntries`'s `KotlinPresetOptions` follows the same style. Both presets also take `harnessGlobs`, `vendorAdapterGlobs`, `drivingAdapterGlobs` and the other options in the [options reference](../options.md). The full list, with every default, is at the top of each preset module.
