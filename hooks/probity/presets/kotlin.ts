/**
 * Probity rule-entry factory — Kotlin/JVM/Android preset.
 *
 * Same enforcement as the JS preset (see hooks/PROBITY.md) with the
 * deterministic layer swapped to Kotlin-shaped rules from
 * '../rules/kotlin.js'. Calibrated against a multi-module Android
 * codebase (Gradle per project, `<module>-core` / `<module>-ui`
 * split, Mockito-kotlin + JUnit 4, AWS/Amplify/Apollo/OkHttp/
 * Retrofit/Room vendor stack) — every option below defaults to that
 * calibration; a consuming project overrides what its layout needs.
 *
 * Note Probity itself still runs on Node: the consuming Kotlin
 * project needs `npm install -D @nizos/probity` (a one-dependency
 * package.json next to gradlew is fine).
 */
import { join } from 'node:path'

import { enforceTdd, forbidContentPattern, type RuleEntry } from '@nizos/probity'

import {
  enforceAcceptanceLanguage,
  withAcceptanceLanguageFastPath,
} from '../rules/acceptance-language.js'
import {
  enforceProbeReversion,
  forbidNewAmbientEffects,
  forbidStaticMocks,
  GRADLE_TEST_COMMAND,
  KOTLIN_BOUNDARY_ADDENDUM,
  KOTLIN_INFRASTRUCTURE_IMPORTS,
  requireGreenTestRun,
  withKotlinFastPath,
  withMutationProbe,
  withTelemetryFastPath,
} from '../rules/kotlin.js'
import {
  enforceAdapterObservability,
  enforcePortsBoundary,
} from '../rules/ports-and-adapters.js'
import { requireSpecBackedAcceptanceTest } from '../rules/spec-test-parity.js'
import type { Globs } from '../rules/scoping.js'
import { surfaceGlossaryTermBreakage } from '../rules/ubiquitous-language.js'

export type KotlinPresetOptions = {
  /** Absolute path to the ubiquitous-language glossary. Defaults to
   *  `<root>/docs/GLOSSARY.md`; glossary-aware rules degrade
   *  gracefully while it doesn't exist yet. */
  glossaryPath?: string
  /** Core purity scope — point at your core modules (e.g. the
   *  `*-core` modules of a core/ui split); DI wiring and adapter
   *  packages import vendors by design and must be excluded. */
  coreGlobs?: Globs
  /** Deterministic infrastructure/vendor import screen for core code. */
  infrastructureImports?: RegExp
  /** Point at the project's canonical ambient-effect port(s). */
  seamHint?: string
  /** Test source sets where static/object/constructor mocking is
   *  forbidden — ports are the only test seam. */
  staticMockGlobs?: Globs
  /** Test-case files that must carry a spec-backed Covers: tag. */
  acceptanceTestGlobs?: Globs
  /** Files the Language Test applies to (acceptance test globs plus
   *  any Gherkin feature files). */
  acceptanceLanguageGlobs?: Globs
  /** Source sets the TDD gate applies to. */
  tddGlobs?: Globs
  /** Adapter/data packages that must carry boundary observability. */
  adapterGlobs?: Globs
  /** The real Gradle test task your commit gate should look for. */
  commitCommand?: RegExp
}

/**
 * Rule entries for a Kotlin/JVM/Android project, as a factory over the
 * project root. Rule ordering principle: Probity stops at the first
 * violation, so every deterministic screen (pattern match, free,
 * instant) is listed before any AI-validated rule (a model call per
 * matching write). A write with a vendor import in core code must be
 * rejected by the free import screen, not after a TDD model call.
 */
export function kotlinRuleEntries(root: string, options: KotlinPresetOptions = {}): RuleEntry[] {
  const glossary = options.glossaryPath ?? join(root, 'docs/GLOSSARY.md')

  const coreGlobs: Globs = options.coreGlobs ?? [
    '**/*-core/src/main/**',
    '!**/*-core/src/main/**/di/**',
    '!**/*-core/src/main/**/data/**',
  ]
  const staticMockGlobs: Globs = options.staticMockGlobs ?? [
    '**/src/test/**',
    '**/src/androidTest/**',
    '**/src/sharedTest/**',
  ]
  const acceptanceTestGlobs: Globs = options.acceptanceTestGlobs ?? [
    '**/acceptance/**/*Spec.kt',
    '**/acceptance/**/*Test.kt',
  ]
  const acceptanceLanguageGlobs: Globs = options.acceptanceLanguageGlobs ?? [
    ...acceptanceTestGlobs,
    '**/*.feature',
  ]
  const tddGlobs: Globs = options.tddGlobs ?? [
    '**/src/main/java/**',
    '**/src/main/kotlin/**',
    '**/src/test/**',
    '**/src/sharedTest/**',
  ]
  const adapterGlobs: Globs = options.adapterGlobs ?? [
    '**/src/main/**/adapter/**',
    '**/src/main/**/adapters/**',
    '**/src/main/**/data/**',
  ]

  return [
    // ── Deterministic wall ───────────────────────────────────────────

    // Core import/effect screens.
    {
      files: coreGlobs,
      rules: [
        forbidContentPattern({
          match: options.infrastructureImports ?? KOTLIN_INFRASTRUCTURE_IMPORTS,
          reason:
            'Core code imports an infrastructure package. The ' +
            'Dependency Rule: core imports nothing from frameworks, ' +
            'vendors, or OS I/O — define a port in the core and reach ' +
            'the dependency through an adapter (see the ' +
            'ports-and-adapters skill).',
        }),
        // Delta-based: only NEW ambient calls block, so the existing
        // Instant.now()/UUID.randomUUID() sites in a brownfield
        // codebase don't freeze their files. Point seamHint at your
        // canonical port(s).
        forbidNewAmbientEffects({
          seamHint:
            options.seamHint ??
            'This codebase has a TimeProvider port (sudocommons-core) — inject it rather than reading the OS clock',
        }),
      ],
    },

    // Ports are the only test seam: no new static/object/constructor
    // mocking anywhere in the suite.
    {
      files: staticMockGlobs,
      rules: [forbidStaticMocks()],
    },

    // Ubiquitous-language drift: renaming or removing a glossary term
    // that specs, tests, or code still use blocks the glossary edit
    // with the list of users.
    {
      files: ['docs/GLOSSARY.md'],
      rules: [surfaceGlossaryTermBreakage({ searchRoots: [root] })],
    },

    // Spec-first, at write time: adding a new acceptance test case
    // requires a new Covers: tag resolving to a `## Scenario:` that
    // already exists in docs/specs — the feature file is written
    // before the test that claims it. Deterministic; the pattern also
    // matches Swift XCTest (`func test…`), so an XCUITest acceptance
    // glob works here unchanged.
    {
      files: acceptanceTestGlobs,
      rules: [
        requireSpecBackedAcceptanceTest({ specsDir: join(root, 'docs/specs') }),
      ],
    },

    // ── AI-validated judgment layer ──────────────────────────────────

    // Inner loop: test-driven-development. Android source sets
    // commonly keep .kt under src/main/java, so match both. Probity
    // has no built-in Kotlin fast-path; withKotlinFastPath supplies
    // one — a test-source write adding exactly one @Test function
    // while preserving all prior source (additive test scaffolding is
    // allowed) passes without an AI call. Its parser ships as optional
    // dependencies; unavailable parser support delegates to
    // enforceTdd with an explicit diagnostic.
    {
      files: tddGlobs,
      // Telemetry-only additions pass deterministically — see the
      // KMP preset's note on the TDD/observability tension.
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
    // port tap, or span). Point the globs at your adapter/data
    // packages. Delta-based — legacy paths migrate incrementally.
    {
      files: adapterGlobs,
      rules: [withTelemetryFastPath(enforceAdapterObservability())],
    },

    // Outer loop: acceptance-testing. The Language Test on the spec
    // layer only. Point at wherever your executable specifications
    // live (e.g. an acceptance package under androidTest, or Gherkin
    // features); protocol drivers and test infrastructure must NOT
    // match.
    {
      files: acceptanceLanguageGlobs,
      rules: [
        withAcceptanceLanguageFastPath(
          enforceAcceptanceLanguage({ glossaryPath: glossary }),
        ),
      ],
    },

    // ── Ship gates ───────────────────────────────────────────────────

    // The commit half of the mutation-probe round-trip: no commit
    // while a `probity: mutation-probe` marker is still on disk —
    // reverting the mutation removes the marker with it.
    enforceProbeReversion({ roots: [root] }),

    // No commit on an unverified tree. The default accepts test/
    // test...Test, allTests, jvmTest, build, and check; a custom
    // commitCommand replaces that task policy. The latest matching run
    // must carry BUILD SUCCESSFUL or a trustworthy Kiro zero status.
    requireGreenTestRun({ command: options.commitCommand ?? GRADLE_TEST_COMMAND }),
  ]
}
