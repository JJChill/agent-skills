/**
 * Probity config template — Kotlin Multiplatform preset.
 *
 * Same enforcement as probity.config.kotlin.ts, recalibrated for a
 * KMP codebase with ports-and-adapters codified per feature module:
 * source sets (`commonMain`/`androidMain`/`desktopMain`/`iosMain`,
 * tests in `commonTest`/`androidHostTest`/…), core vs adapter split
 * by package (`domain`/`port`/`usecase`/`presentation` vs
 * `adapter`/`di`/`ui`), kotlin.test + hand-written fakes with NO
 * mocking library, Koin at the composition root only, and
 * acceptance tests driven through a Robot DSL at the ViewModel
 * boundary with Markdown Given/When/Then specs in docs/specs/.
 * Adjust globs and package names to your layout.
 *
 * Probity still runs on Node: `npm install -D @nizos/probity`
 * (plus optionally @ast-grep/napi @ast-grep/lang-kotlin for the TDD
 * fast-path) next to gradlew.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  defineConfig,
  enforceTdd,
  forbidContentPattern,
  type RuleEntry,
} from '@nizos/probity'

import {
  enforceAcceptanceLanguage,
  withAcceptanceLanguageFastPath,
} from './rules/acceptance-language.js'
import {
  enforceSpecTestParity,
  requireSpecBackedAcceptanceTest,
  surfaceScenarioLinkBreakage,
  type DriverScope,
} from './rules/spec-test-parity.js'
import { surfaceGlossaryTermBreakage } from './rules/ubiquitous-language.js'
import {
  enforceProbeReversion,
  forbidNewAmbientEffects,
  GRADLE_TEST_COMMAND,
  KOTLIN_BOUNDARY_ADDENDUM,
  KOTLIN_INFRASTRUCTURE_IMPORTS,
  MOCKING_LIBRARY_IMPORTS,
  requireGreenTestRun,
  withKotlinFastPath,
  withMutationProbe,
  withTelemetryFastPath,
} from './rules/kotlin.js'
import {
  enforceAdapterObservability,
  enforcePortsBoundary,
} from './rules/ports-and-adapters.js'

// This config sits at the project root, so its directory is the repo
// root — spec/test scanning for the traceability rules anchors here.
const ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * The rule entries, as a factory over the project root. Probity only
 * reads the default export below; the factory exists so tooling can
 * instantiate the exact same blocks against a different root — the
 * workflow eval runs them in a temp directory, and
 * `scripts/scope-report.ts` resolves their `files` scopes against the
 * real tree. Keeping the entries in one place is what lets the eval's
 * scoping stay derived from this config instead of hand-mirrored.
 *
 * Relative globs (`docs/...`) are NOT anchored here: Probity's
 * `loadConfig` anchors them against this file's directory at load
 * time, and the tooling replicates that via `rules/scoping.ts`.
 *
 * `parity` optionally switches on the per-scenario driver mapping
 * (`driverScopes`/`defaultScopes` on the commit-time parity gate) —
 * projects normally enable it by uncommenting the block in the
 * `enforceSpecTestParity` call below; the parameter exists so the
 * workflow eval can exercise the scope checks without changing the
 * template's default-off posture.
 */
export function kmpRuleEntries(
  root: string,
  parity?: { driverScopes?: DriverScope[]; defaultScopes?: string[] },
): RuleEntry[] {
  // Ubiquitous-language glossary (copy GLOSSARY.template.md here).
  // The glossary-aware rules degrade gracefully while the file
  // doesn't exist yet — wiring it up front costs nothing.
  const glossary = join(root, 'docs/GLOSSARY.md')

  // Core purity scope — the inside of the hexagon: domain, ports,
  // use cases, and MVI presentation in commonMain. Adapter, DI, and
  // Compose ui packages import vendors by design — excluded.
  const CORE_GLOBS = [
    '**/src/commonMain/**/domain/**',
    '**/src/commonMain/**/port/**',
    '**/src/commonMain/**/usecase/**',
    '**/src/commonMain/**/presentation/**',
  ]

  // Rule ordering principle: Probity stops at the first violation, so
  // every deterministic screen (pattern match, free, instant) is
  // listed before any AI-validated rule (a model call per matching
  // write). A write with a vendor import in core code must be
  // rejected by the free import screen, not after a TDD model call.

  return [
    // ── Deterministic wall ───────────────────────────────────────────

    // Core import/effect screens. The import screen also catches Koin
    // here: DI stays at the composition root, never in domain code.
    {
      files: CORE_GLOBS,
      rules: [
        forbidContentPattern({
          match: KOTLIN_INFRASTRUCTURE_IMPORTS,
          reason:
            'Core code imports an infrastructure/vendor package (this ' +
            'screen includes Koin — DI belongs at the composition ' +
            'root). The Dependency Rule: core imports nothing from ' +
            'frameworks, vendors, or OS I/O — define a port and reach ' +
            'the dependency through an adapter (see the ' +
            'ports-and-adapters skill).',
        }),
        forbidNewAmbientEffects({
          seamHint:
            'This codebase injects function-typed providers (e.g. ' +
            'nowEpochMillis: () -> Long) with real defaults supplied ' +
            'only in platform adapters or DI modules',
        }),
      ],
    },

    // No mocking library at all: this convention is hand-written
    // fakes substituted at ports (shared via testfixtures modules).
    {
      files: ['**/src/*Test/kotlin/**', '**/src/test/kotlin/**'],
      rules: [
        forbidContentPattern({
          match: MOCKING_LIBRARY_IMPORTS,
          reason:
            'This codebase uses no mocking library: substitute a ' +
            'hand-written fake at the port (see the shared test ' +
            'fixtures), never mock an SDK or framework type. Ports ' +
            'are the only test seam.',
        }),
      ],
    },

    // Spec↔test traceability. Editing a spec must not silently break
    // the tests that claim its scenarios: removing or renaming a
    // `## Scenario:` heading still covered by a test blocks with the
    // list of affected tests, so the rename updates its Covers: tags
    // in the same change.
    {
      files: ['docs/specs/**/*.feature.md'],
      rules: [surfaceScenarioLinkBreakage({ testRoots: [root] })],
    },

    // Spec-first, at write time: adding a new acceptance test case
    // requires a new Covers: tag resolving to a scenario that already
    // exists in docs/specs — the feature file is written before the
    // test that claims it. Scoped to the test-case layer only
    // (*Spec.kt); drivers/DSL/scenario bodies add no @Test functions.
    {
      files: ['**/acceptance/**/*Spec.kt', '**/acceptance/**/*Test.kt'],
      rules: [
        requireSpecBackedAcceptanceTest({ specsDir: join(root, 'docs/specs') }),
      ],
    },

    // Ubiquitous-language drift: renaming or removing a glossary term
    // that specs, tests, or code still use blocks the glossary edit
    // with the list of users.
    {
      files: ['docs/GLOSSARY.md'],
      rules: [surfaceGlossaryTermBreakage({ searchRoots: [root] })],
    },

    // ── AI-validated judgment layer ──────────────────────────────────

    // Inner loop: test-driven-development. `src/*Main` / `src/*Test`
    // cover every KMP source set (commonMain, androidMain, commonTest,
    // androidHostTest, …); main/test cover classic Android app modules
    // alongside them. The Kotlin fast-path keeps the most common write
    // (a single new @Test) deterministic. The mutation-probe wrapper
    // lets a write marked `// probity: mutation-probe` (a deliberate
    // break proving a retrofitted test bites) through without a
    // red-before-green demand — enforceProbeReversion below blocks
    // commits until the probe is reverted.
    {
      files: [
        '**/src/*Main/kotlin/**',
        '**/src/*Test/kotlin/**',
        '**/src/main/kotlin/**',
        '**/src/test/kotlin/**',
      ],
      // Telemetry-only additions (a complete logger.event/breadcrumb
      // line) pass deterministically — instrumentation demanded by the
      // adapter-observability rule must not be judged as unasserted
      // behavior by the TDD gate.
      rules: [
        withMutationProbe(
          withTelemetryFastPath(withKotlinFastPath(enforceTdd())),
        ),
      ],
    },

    // Boundaries: ports-and-adapters. The Dependency Rule judgments
    // the import screen can't make — thin adapters, vendor types in
    // port signatures, glossary-conflicting names.
    {
      files: CORE_GLOBS,
      rules: [
        enforcePortsBoundary({
          instructions: (defaults) => defaults + KOTLIN_BOUNDARY_ADDENDUM,
          glossaryPath: glossary,
        }),
      ],
    },

    // Adapters must be thin, but not blind: a new adapter path doing
    // external I/O carries boundary observability (structured event,
    // port tap, or span). Delta-based — legacy uninstrumented paths
    // migrate incrementally.
    {
      files: ['**/src/*Main/kotlin/**/adapter/**'],
      rules: [
        withTelemetryFastPath(
          enforceAdapterObservability({
            conventionHint:
              'This codebase uses structured Logger.event(tag, event, ' +
              'level, fields) from :foundation (one greppable line: ' +
              'event=<name> k=v), and/or a recording port-tap decorator ' +
              'wired at the Koin composition root.',
          }),
        ),
      ],
    },

    // Outer loop: acceptance-testing. The Language Test on the spec
    // layer: Markdown Given/When/Then specs and the acceptance test
    // cases. Robot/DSL/driver classes are layers 2-3 (they know about
    // UiState and MVI intents) — excluded, whichever of the two
    // layouts a feature uses (merged *Robot.kt, or split *Dsl.kt +
    // *Driver.kt per the four-layer model). Shared scenario-body
    // files (*Scenarios.kt — the bodies both drivers run) are layer 1
    // and stay INCLUDED by design: they must read as pure domain
    // language.
    {
      files: [
        'docs/specs/**/*.feature.md',
        '**/acceptance/**',
        '!**/*Robot.kt',
        '!**/*Dsl.kt',
        '!**/*Driver.kt',
      ],
      // requireGlossaryEntry: true is the strict "glossary
      // conversation happens first" mode — turn it on once the
      // glossary has real coverage, not on day one. The fast-path
      // wrapper keeps a single-@Test write that only reuses existing
      // DSL vocabulary free of AI calls (Markdown specs always go to
      // the validator).
      rules: [
        withAcceptanceLanguageFastPath(
          enforceAcceptanceLanguage({ glossaryPath: glossary }),
        ),
      ],
    },

    // ── Ship gates ───────────────────────────────────────────────────
    // Definition of done, made mechanical: every non-wip scenario in
    // docs/specs is claimed by an acceptance test (Covers: tag), and
    // every tag resolves to a real scenario. Mark in-progress specs
    // `## Scenario (wip):`. CI mirror for human commits:
    // scripts/spec-parity.mjs.
    //
    // Brownfield adoption: a spec suite that predates the gate would
    // block every commit. Generate a baseline once —
    //   node scripts/spec-parity.mjs --specs docs/specs \
    //     --baseline docs/specs/.parity-baseline --write-baseline
    // — and commit it: baselined scenarios are exempt while new ones
    // are enforced from day one; burn the file down by deleting lines
    // as coverage lands. No baseline file → full enforcement.
    //
    // Per-scenario driver mapping (optional): declare named driver
    // scopes and tag scenarios that need more than the default suite —
    // `## Scenario [system]: …` then requires a covering test whose
    // path matches that scope. Tags are floors, not ceilings; with
    // shared scenario bodies (*Scenarios.kt) the extra covering test
    // is a thin spec class calling the existing body. CALIBRATE THE
    // PATTERNS TO YOUR LAYOUT before uncommenting — a pattern matching
    // zero files makes every tagged scenario fail, loudly.
    enforceSpecTestParity({
      specsDir: join(root, 'docs/specs'),
      testRoots: [root],
      baselinePath: join(root, 'docs/specs/.parity-baseline'),
      // driverScopes: [
      //   { name: 'view-model', filePattern: /[/\\]acceptance[/\\]viewmodel[/\\]/ },
      //   { name: 'system', filePattern: /[/\\]acceptance[/\\]ui[/\\]/ },
      // ],
      // defaultScopes: ['view-model'],
      ...parity,
    }),

    // The commit half of the mutation-probe round-trip: no commit
    // while a `probity: mutation-probe` marker is still on disk —
    // reverting the mutation removes the marker with it.
    enforceProbeReversion({ roots: [root] }),

    // Matches testAndroidHostTest, :feature:x:testAndroidHostTest,
    // :desktop:jvmTest, allTests, :app:testDevDebugUnitTest. Stricter
    // than Probity's requireCommand: the recorded run's output must
    // actually be green, not merely exist.
    requireGreenTestRun({ command: GRADLE_TEST_COMMAND }),
  ]
}

export default defineConfig({ rules: kmpRuleEntries(ROOT) })
