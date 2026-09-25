/**
 * Probity rule-entry factory — Kotlin Multiplatform preset.
 *
 * Same enforcement as the Kotlin preset, recalibrated for a KMP
 * codebase with ports-and-adapters codified per feature module:
 * source sets (`commonMain`/`androidMain`/`desktopMain`/`iosMain`,
 * tests in `commonTest`/`androidHostTest`/…), core vs adapter split
 * by package (`domain`/`port`/`usecase`/`presentation` vs
 * `adapter`/`di`/`ui`), kotlin.test + hand-written fakes with NO
 * mocking library, Koin at the composition root only, and
 * acceptance tests driven through a Robot DSL at the ViewModel
 * boundary with Markdown Given/When/Then specs in docs/specs/.
 * Adjust globs and package names to your layout.
 *
 * Probity still runs on Node: install `@nizos/probity` and this rule
 * package next to gradlew. The TDD fast-path parser ships as optional
 * dependencies of the rule package.
 */
import { join, relative, sep } from 'node:path'

import { forbidContentPattern, type RuleEntry } from '@nizos/probity'

import { enforceKotlinTdd } from '../internal/kotlin-tdd.js'

import type { Globs } from '../rules/scoping.js'

import {
  enforceAcceptanceLanguage,
  withAcceptanceLanguageFastPath,
} from '../rules/acceptance-language.js'
import { withExcludeGlobs } from '../rules/scoping.js'
import {
  enforceSpecTestParity,
  requireSpecBackedAcceptanceTest,
  surfaceScenarioLinkBreakage,
  type DriverScope,
} from '../rules/spec-test-parity.js'
import { surfaceGlossaryTermBreakage } from '../rules/ubiquitous-language.js'
import {
  enforceCharacterizationResolution,
  enforceProbeReversion,
  forbidNewAmbientEffects,
  GRADLE_TEST_COMMAND,
  KOTLIN_BOUNDARY_ADDENDUM,
  KOTLIN_INFRASTRUCTURE_IMPORTS,
  KOTLIN_TEST_SOURCE_PATTERN,
  MOCKING_LIBRARY_IMPORTS,
  requireGreenTestRun,
  withCharacterizationTest,
  withKotlinFastPath,
  withMutationProbe,
  withTelemetryFastPath,
} from '../rules/kotlin.js'
import {
  enforceAdapterObservability,
  enforcePortsBoundary,
} from '../rules/ports-and-adapters.js'

/**
 * Options for {@link kmpRuleEntries}. A superset of the factory's
 * original `{ driverScopes, defaultScopes }` second parameter, so
 * existing callers passing that shape unchanged keep working. Every
 * option defaults to the reference KMP layout's current hardcoded
 * value — a consuming project overrides only what its layout needs.
 */
export type KmpPresetOptions = {
  /** Absolute path to the specs directory. */
  specsDir?: string
  /** Spec files the traceability rules scan/scope to (Markdown
   *  `*.feature.md` by default; add `**\/*.feature` for Gherkin). */
  specGlobs?: Globs
  /** Absolute path to the ubiquitous-language glossary. */
  glossaryPath?: string
  /** Core purity scope — domain/port/usecase/presentation packages in
   *  commonMain. Adapter, DI, and Compose ui packages import vendors
   *  by design and must NOT match here. */
  coreGlobs?: Globs
  /** Test-case files that must carry a spec-backed Covers: tag. */
  acceptanceTestGlobs?: Globs
  /** Absolute paths to scan for acceptance tests (Covers: tags). */
  testRoots?: string[]
  /** Which files count as acceptance tests when scanning for Covers:
   *  tags (default: any file under an `acceptance/` directory). */
  testFilePattern?: RegExp
  /** What counts as a test-case declaration for the write-time gate
   *  (default: Kotlin/Java `@Test` or Swift `func test…`). */
  testDeclarationPattern?: RegExp
  /** Per-scenario driver mapping; see {@link DriverScope}. */
  driverScopes?: DriverScope[]
  /** Scope names every scenario must satisfy even untagged. */
  defaultScopes?: string[]
  /** Incremental-adoption baseline path for the commit-time parity gate. */
  baselinePath?: string
  /** Globs excluded (as `!`-negations) from every files-scoped block —
   *  spikes and build output by default. Pass `[]` to disable. */
  excludeGlobs?: string[]
}

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
 * `options.driverScopes`/`options.defaultScopes` optionally switch on
 * the per-scenario driver mapping on the commit-time parity gate —
 * projects normally enable it by uncommenting the block in the
 * `enforceSpecTestParity` call below; the workflow eval passes them
 * directly so it can exercise the scope checks without changing the
 * template's default-off posture.
 */
export function kmpRuleEntries(root: string, options: KmpPresetOptions = {}): RuleEntry[] {
  // Ubiquitous-language glossary (copy GLOSSARY.template.md here).
  // The glossary-aware rules degrade gracefully while the file
  // doesn't exist yet — wiring it up front costs nothing.
  const glossary = options.glossaryPath ?? join(root, 'docs/GLOSSARY.md')
  // The glossary-drift block's files scope must track a custom
  // glossaryPath, not just the default location.
  const glossaryGlob = relative(root, glossary).split(sep).join('/')

  const specsDir = options.specsDir ?? join(root, 'docs/specs')
  const specGlobs: Globs = options.specGlobs ?? ['docs/specs/**/*.feature.md']
  const acceptanceTestGlobs: Globs = options.acceptanceTestGlobs ?? [
    '**/acceptance/**/*Spec.kt',
    '**/acceptance/**/*Test.kt',
  ]
  const testRoots = options.testRoots ?? [root]
  const baselinePath = options.baselinePath ?? join(root, 'docs/specs/.parity-baseline')
  const excludeGlobs = options.excludeGlobs ?? ['spikes/**', '**/build/**']

  // Core purity scope — the inside of the hexagon: domain, ports,
  // use cases, and MVI presentation in commonMain. Adapter, DI, and
  // Compose ui packages import vendors by design — excluded.
  const coreGlobs: Globs = options.coreGlobs ?? [
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

  const entries: RuleEntry[] = [
    // ── Deterministic wall ───────────────────────────────────────────

    // Core import/effect screens. The import screen also catches Koin
    // here: DI stays at the composition root, never in domain code.
    {
      files: coreGlobs,
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
      files: specGlobs,
      rules: [
        surfaceScenarioLinkBreakage({ testRoots, testFilePattern: options.testFilePattern }),
      ],
    },

    // Spec-first, at write time: adding a new acceptance test case
    // requires a new Covers: tag resolving to a scenario that already
    // exists in specsDir — the feature file is written before the
    // test that claims it. Scoped to the test-case layer only
    // (*Spec.kt); drivers/DSL/scenario bodies add no @Test functions.
    {
      files: acceptanceTestGlobs,
      rules: [
        requireSpecBackedAcceptanceTest({
          specsDir,
          testDeclarationPattern: options.testDeclarationPattern,
        }),
      ],
    },

    // Ubiquitous-language drift: renaming or removing a glossary term
    // that specs, tests, or code still use blocks the glossary edit
    // with the list of users.
    {
      files: [glossaryGlob],
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
    // commits until the probe is reverted. The characterization
    // wrapper sanctions a test for behavior production already has
    // (born green, so no red can precede it): a test-source write
    // marked `// probity: characterization` passes, and
    // enforceCharacterizationResolution below blocks commits until the
    // marker comes off through a recorded red under a mutation probe.
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
        withCharacterizationTest(
          withMutationProbe(
            withTelemetryFastPath(withKotlinFastPath(enforceKotlinTdd())),
          ),
          { filePattern: KOTLIN_TEST_SOURCE_PATTERN },
        ),
      ],
    },

    // Boundaries: ports-and-adapters. The Dependency Rule judgments
    // the import screen can't make — thin adapters, vendor types in
    // port signatures, glossary-conflicting names.
    {
      files: coreGlobs,
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
      files: [...specGlobs, '**/acceptance/**', '!**/*Robot.kt', '!**/*Dsl.kt', '!**/*Driver.kt'],
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
    // specsDir is claimed by an acceptance test (Covers: tag), and
    // every tag resolves to a real scenario. Mark in-progress specs
    // `## Scenario (wip):`. CI mirror for human commits:
    // scripts/spec-parity.mjs.
    //
    // Brownfield adoption: a spec suite that predates the gate would
    // block every specs/acceptance commit. Generate a baseline once —
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
    // PATTERNS TO YOUR LAYOUT before setting `driverScopes` — a
    // pattern matching zero files makes every tagged scenario fail,
    // loudly. Example:
    //   driverScopes: [
    //     { name: 'view-model', filePattern: /[/\\]acceptance[/\\]viewmodel[/\\]/ },
    //     { name: 'system', filePattern: /[/\\]acceptance[/\\]ui[/\\]/ },
    //   ],
    //   defaultScopes: ['view-model'],
    enforceSpecTestParity({
      specsDir,
      testRoots,
      baselinePath,
      testFilePattern: options.testFilePattern,
      driverScopes: options.driverScopes,
      defaultScopes: options.defaultScopes,
    }),

    // The commit half of the mutation-probe round-trip: no commit
    // while a `probity: mutation-probe` marker is still on disk —
    // reverting the mutation removes the marker with it.
    enforceProbeReversion({ roots: [root] }),

    // The commit half of the characterization round-trip: no commit
    // while a `probity: characterization` marker is still on disk —
    // the marker only comes off once the transcript records the
    // marked test failing under a mutation probe.
    enforceCharacterizationResolution({ roots: [root] }),

    // Accepts test/test...Test, :desktop:jvmTest, allTests,
    // build, and check. The latest matching run must carry BUILD
    // SUCCESSFUL or a trustworthy Kiro zero status.
    requireGreenTestRun({ command: GRADLE_TEST_COMMAND }),
  ]

  return withExcludeGlobs(entries, excludeGlobs)
}
