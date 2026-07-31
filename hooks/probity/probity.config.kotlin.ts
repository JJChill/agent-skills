/**
 * Probity config template — Kotlin/JVM/Android preset.
 *
 * Same enforcement as probity.config.ts (see hooks/PROBITY.md) with
 * the deterministic layer swapped to Kotlin-shaped rules from
 * ./rules/kotlin.ts. Calibrated against a multi-module Android
 * codebase (Gradle per project, `<module>-core` / `<module>-ui`
 * split, Mockito-kotlin + JUnit 4, AWS/Amplify/Apollo/OkHttp/
 * Retrofit/Room vendor stack) — adjust the globs and package names
 * to yours.
 *
 * Note Probity itself still runs on Node: the consuming Kotlin
 * project needs `npm install -D @nizos/probity` (a one-dependency
 * package.json next to gradlew is fine).
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, enforceTdd, forbidContentPattern } from '@nizos/probity'

import {
  enforceAcceptanceLanguage,
  withAcceptanceLanguageFastPath,
} from './rules/acceptance-language.js'
import { surfaceGlossaryTermBreakage } from './rules/ubiquitous-language.js'
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
} from './rules/kotlin.js'
import {
  enforceAdapterObservability,
  enforcePortsBoundary,
} from './rules/ports-and-adapters.js'
import { requireSpecBackedAcceptanceTest } from './rules/spec-test-parity.js'

// Ubiquitous-language glossary (copy GLOSSARY.template.md here). The
// glossary-aware rules degrade gracefully while it doesn't exist yet.
const ROOT = dirname(fileURLToPath(import.meta.url))
const GLOSSARY = join(ROOT, 'docs/GLOSSARY.md')

// Core purity scope. Point these at your core modules (e.g. the
// `*-core` modules of a core/ui split); DI wiring and adapter
// packages import vendors by design — exclude them.
const CORE_GLOBS = [
  '**/*-core/src/main/**',
  '!**/*-core/src/main/**/di/**',
  '!**/*-core/src/main/**/data/**',
]

// Rule ordering principle: Probity stops at the first violation, so
// every deterministic screen (pattern match, free, instant) is listed
// before any AI-validated rule (a model call per matching write). A
// write with a vendor import in core code must be rejected by the
// free import screen, not after a TDD model call.

export default defineConfig({
  rules: [
    // ── Deterministic wall ───────────────────────────────────────────

    // Core import/effect screens.
    {
      files: CORE_GLOBS,
      rules: [
        forbidContentPattern({
          match: KOTLIN_INFRASTRUCTURE_IMPORTS,
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
            'This codebase has a TimeProvider port (sudocommons-core) — inject it rather than reading the OS clock',
        }),
      ],
    },

    // Ports are the only test seam: no new static/object/constructor
    // mocking anywhere in the suite.
    {
      files: ['**/src/test/**', '**/src/androidTest/**', '**/src/sharedTest/**'],
      rules: [forbidStaticMocks()],
    },

    // Ubiquitous-language drift: renaming or removing a glossary term
    // that specs, tests, or code still use blocks the glossary edit
    // with the list of users.
    {
      files: ['docs/GLOSSARY.md'],
      rules: [surfaceGlossaryTermBreakage({ searchRoots: [ROOT] })],
    },

    // Spec-first, at write time: adding a new acceptance test case
    // requires a new Covers: tag resolving to a `## Scenario:` that
    // already exists in docs/specs — the feature file is written
    // before the test that claims it. Deterministic; the pattern also
    // matches Swift XCTest (`func test…`), so an XCUITest acceptance
    // glob works here unchanged.
    {
      files: ['**/acceptance/**/*Spec.kt', '**/acceptance/**/*Test.kt'],
      rules: [
        requireSpecBackedAcceptanceTest({ specsDir: join(ROOT, 'docs/specs') }),
      ],
    },

    // ── AI-validated judgment layer ──────────────────────────────────

    // Inner loop: test-driven-development. Android source sets
    // commonly keep .kt under src/main/java, so match both. Probity
    // has no built-in Kotlin fast-path; withKotlinFastPath supplies
    // one — a write adding exactly one @Test function passes without
    // an AI call. It needs the optional packages
    // (`npm install -D @ast-grep/napi @ast-grep/lang-kotlin`) and
    // falls through to plain enforceTdd when they're absent.
    {
      files: [
        '**/src/main/java/**',
        '**/src/main/kotlin/**',
        '**/src/test/**',
        '**/src/sharedTest/**',
      ],
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
      files: CORE_GLOBS,
      rules: [
        enforcePortsBoundary({
          instructions: (defaults) => defaults + KOTLIN_BOUNDARY_ADDENDUM,
          glossaryPath: GLOSSARY,
        }),
      ],
    },

    // Adapters must be thin, but not blind: a new adapter path doing
    // external I/O carries boundary observability (structured event,
    // port tap, or span). Point the globs at your adapter/data
    // packages. Delta-based — legacy paths migrate incrementally.
    {
      files: [
        '**/src/main/**/adapter/**',
        '**/src/main/**/adapters/**',
        '**/src/main/**/data/**',
      ],
      rules: [withTelemetryFastPath(enforceAdapterObservability())],
    },

    // Outer loop: acceptance-testing. The Language Test on the spec
    // layer only. Point at wherever your executable specifications
    // live (e.g. an acceptance package under androidTest, or Gherkin
    // features); protocol drivers and test infrastructure must NOT
    // match.
    {
      files: ['**/acceptance/**/*Spec.kt', '**/acceptance/**/*Test.kt', '**/*.feature'],
      rules: [
        withAcceptanceLanguageFastPath(
          enforceAcceptanceLanguage({ glossaryPath: GLOSSARY }),
        ),
      ],
    },

    // ── Ship gates ───────────────────────────────────────────────────

    // The commit half of the mutation-probe round-trip: no commit
    // while a `probity: mutation-probe` marker is still on disk —
    // reverting the mutation removes the marker with it.
    enforceProbeReversion({ roots: [ROOT] }),

    // No commit on an unverified tree. GRADLE_TEST_COMMAND matches
    // plain and flavored test tasks (`./gradlew test`,
    // `./gradlew :app:testDevDebugUnitTest`); tighten it to your
    // module's real task if you want the gate strict about which
    // suite counts. Stricter than Probity's requireCommand: the
    // recorded run's output must actually be green, not merely exist.
    requireGreenTestRun({ command: GRADLE_TEST_COMMAND }),
  ],
})
