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
import { defineConfig, enforceTdd, forbidContentPattern, requireCommand } from '@nizos/probity'

import { enforceAcceptanceLanguage } from './rules/acceptance-language.js'
import {
  forbidNewAmbientEffects,
  forbidStaticMocks,
  GRADLE_TEST_COMMAND,
  KOTLIN_BOUNDARY_ADDENDUM,
  KOTLIN_INFRASTRUCTURE_IMPORTS,
} from './rules/kotlin.js'
import { enforcePortsBoundary } from './rules/ports-and-adapters.js'

export default defineConfig({
  rules: [
    // ── Inner loop: test-driven-development ─────────────────────────
    // Android source sets commonly keep .kt under src/main/java, so
    // match both. No deterministic fast-path exists for Kotlin —
    // every matching write costs an AI call; scope accordingly.
    {
      files: [
        '**/src/main/java/**',
        '**/src/main/kotlin/**',
        '**/src/test/**',
        '**/src/sharedTest/**',
      ],
      rules: [enforceTdd()],
    },

    // ── Boundaries: ports-and-adapters ──────────────────────────────
    // Core purity. Point these at your core modules (e.g. the
    // `*-core` modules of a core/ui split); DI wiring and adapter
    // packages import vendors by design — exclude them.
    {
      files: [
        '**/*-core/src/main/**',
        '!**/*-core/src/main/**/di/**',
        '!**/*-core/src/main/**/data/**',
      ],
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
        enforcePortsBoundary({
          instructions: (defaults) => defaults + KOTLIN_BOUNDARY_ADDENDUM,
        }),
      ],
    },

    // Ports are the only test seam: no new static/object/constructor
    // mocking anywhere in the suite. Deterministic — free to run
    // broadly.
    {
      files: ['**/src/test/**', '**/src/androidTest/**', '**/src/sharedTest/**'],
      rules: [forbidStaticMocks()],
    },

    // ── Outer loop: acceptance-testing ──────────────────────────────
    // The Language Test on the spec layer only. Point at wherever
    // your executable specifications live (e.g. an acceptance package
    // under androidTest, or Gherkin features); protocol drivers and
    // test infrastructure must NOT match.
    {
      files: ['**/acceptance/**/*Spec.kt', '**/acceptance/**/*Test.kt', '**/*.feature'],
      rules: [enforceAcceptanceLanguage()],
    },

    // ── Ship gate ────────────────────────────────────────────────────
    // No commit on an unverified tree. GRADLE_TEST_COMMAND matches
    // plain and flavored test tasks (`./gradlew test`,
    // `./gradlew :app:testDevDebugUnitTest`); tighten it to your
    // module's real task if you want the gate strict about which
    // suite counts.
    requireCommand({
      before: { kind: 'command', match: /git commit/ },
      command: GRADLE_TEST_COMMAND,
      after: { kind: 'write' },
      reason:
        'Run the Gradle test suite after the last change before ' +
        'committing (see test-driven-development: commit only on green).',
    }),
  ],
})
