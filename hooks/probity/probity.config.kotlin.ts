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

import { defineConfig, enforceTdd, forbidContentPattern, requireCommand } from '@nizos/probity'

import { enforceAcceptanceLanguage } from './rules/acceptance-language.js'
import { surfaceGlossaryTermBreakage } from './rules/ubiquitous-language.js'
import {
  forbidNewAmbientEffects,
  forbidStaticMocks,
  GRADLE_TEST_COMMAND,
  KOTLIN_BOUNDARY_ADDENDUM,
  KOTLIN_INFRASTRUCTURE_IMPORTS,
  withKotlinFastPath,
} from './rules/kotlin.js'
import { enforcePortsBoundary } from './rules/ports-and-adapters.js'

// Ubiquitous-language glossary (copy GLOSSARY.template.md here). The
// glossary-aware rules degrade gracefully while it doesn't exist yet.
const ROOT = dirname(fileURLToPath(import.meta.url))
const GLOSSARY = join(ROOT, 'docs/GLOSSARY.md')

export default defineConfig({
  rules: [
    // ── Inner loop: test-driven-development ─────────────────────────
    // Android source sets commonly keep .kt under src/main/java, so
    // match both. Probity has no built-in Kotlin fast-path;
    // withKotlinFastPath supplies one — a write adding exactly one
    // @Test function passes without an AI call. It needs the optional
    // packages (`npm install -D @ast-grep/napi @ast-grep/lang-kotlin`)
    // and falls through to plain enforceTdd when they're absent.
    {
      files: [
        '**/src/main/java/**',
        '**/src/main/kotlin/**',
        '**/src/test/**',
        '**/src/sharedTest/**',
      ],
      rules: [withKotlinFastPath(enforceTdd())],
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
          glossaryPath: GLOSSARY,
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
      rules: [enforceAcceptanceLanguage({ glossaryPath: GLOSSARY })],
    },

    // Ubiquitous-language drift: renaming or removing a glossary term
    // that specs, tests, or code still use blocks the glossary edit
    // with the list of users.
    {
      files: ['docs/GLOSSARY.md'],
      rules: [surfaceGlossaryTermBreakage({ searchRoots: [ROOT] })],
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
