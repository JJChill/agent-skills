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
import { defineConfig, enforceTdd, forbidContentPattern, requireCommand } from '@nizos/probity'

import { enforceAcceptanceLanguage } from './rules/acceptance-language.js'
import {
  forbidNewAmbientEffects,
  GRADLE_TEST_COMMAND,
  KOTLIN_BOUNDARY_ADDENDUM,
  KOTLIN_INFRASTRUCTURE_IMPORTS,
  MOCKING_LIBRARY_IMPORTS,
  withKotlinFastPath,
} from './rules/kotlin.js'
import { enforcePortsBoundary } from './rules/ports-and-adapters.js'

export default defineConfig({
  rules: [
    // ── Inner loop: test-driven-development ─────────────────────────
    // `src/*Main` / `src/*Test` cover every KMP source set
    // (commonMain, androidMain, commonTest, androidHostTest, …);
    // main/test cover classic Android app modules alongside them.
    {
      files: [
        '**/src/*Main/kotlin/**',
        '**/src/*Test/kotlin/**',
        '**/src/main/kotlin/**',
        '**/src/test/kotlin/**',
      ],
      rules: [withKotlinFastPath(enforceTdd())],
    },

    // ── Boundaries: ports-and-adapters ──────────────────────────────
    // Core purity for the inside of the hexagon: domain, ports,
    // use cases, and MVI presentation in commonMain. Adapter, DI,
    // and Compose ui packages import vendors by design — excluded.
    // The import screen also catches Koin here: DI stays at the
    // composition root, never in domain code.
    {
      files: [
        '**/src/commonMain/**/domain/**',
        '**/src/commonMain/**/port/**',
        '**/src/commonMain/**/usecase/**',
        '**/src/commonMain/**/presentation/**',
      ],
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
        enforcePortsBoundary({
          instructions: (defaults) => defaults + KOTLIN_BOUNDARY_ADDENDUM,
        }),
      ],
    },

    // No mocking library at all: this convention is hand-written
    // fakes substituted at ports (shared via testfixtures modules).
    // Deterministic — free to run broadly.
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

    // ── Outer loop: acceptance-testing ──────────────────────────────
    // The Language Test on the spec layer: Markdown Given/When/Then
    // specs and the acceptance test cases. Robot DSL classes are
    // layer 2 (they know about UiState and MVI intents) — excluded.
    {
      files: [
        'docs/specs/**/*.feature.md',
        '**/acceptance/**',
        '!**/*Robot.kt',
      ],
      rules: [enforceAcceptanceLanguage()],
    },

    // ── Ship gate ────────────────────────────────────────────────────
    // Matches testAndroidHostTest, :feature:x:testAndroidHostTest,
    // :desktop:jvmTest, allTests, :app:testDevDebugUnitTest.
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
