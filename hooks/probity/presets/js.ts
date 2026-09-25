/**
 * Probity rule-entry factory — plain JS/TS preset.
 *
 * Turns three of the agent-skills catalog's prose disciplines into
 * hard PreToolUse gates via https://github.com/nizos/probity :
 *
 *   test-driven-development  → enforceTdd (built-in)
 *   ports-and-adapters       → enforcePortsBoundary + forbidInternalModuleMocks
 *                              + a deterministic import screen
 *   acceptance-testing       → enforceAcceptanceLanguage
 *
 * `jsRuleEntries(options?)` reproduces exactly what the shipped
 * `probity.config.ts` template wires by default — every option below
 * defaults to that template's current value. A consuming project
 * copies the thin template (which calls this factory) and overrides
 * only the options its layout needs.
 */
import { basename } from 'node:path'

import { enforceTdd, forbidContentPattern, type RuleEntry } from '@nizos/probity'

import { enforceAcceptanceLanguage } from '../rules/acceptance-language.js'
import {
  forbidNewAmbientEffects,
  JS_AMBIENT_EFFECT_PATTERNS,
  requireGreenTestRun,
  withJudgeFailureDiagnostics,
} from '../rules/gates.js'
import {
  enforcePortsBoundary,
  forbidInternalModuleMocks,
} from '../rules/ports-and-adapters.js'
import type { Globs } from '../rules/scoping.js'
import { withExcludeGlobs } from '../rules/scoping.js'
import {
  enforceSpecTestParity,
  JS_TEST_DECLARATION,
  requireSpecBackedAcceptanceTest,
  surfaceScenarioLinkBreakage,
  type DriverScope,
} from '../rules/spec-test-parity.js'
import { surfaceGlossaryTermBreakage } from '../rules/ubiquitous-language.js'

/**
 * Deterministic first line of defense for the Dependency Rule: known
 * framework/vendor/OS-I/O imports never belong in core code, so block
 * them without spending an AI call. Extend with your stack's usual
 * suspects; enforcePortsBoundary catches what this list misses.
 */
export const KNOWN_INFRASTRUCTURE_IMPORTS =
  /from\s+['"](?:node:(?:fs|http|https|net|child_process|process)|fs|http|https|express|fastify|@nestjs\/[^'"]+|next\/[^'"]+|pg|mysql2?|mongodb|mongoose|redis|ioredis|@prisma\/client|typeorm|knex|axios|node-fetch|got|undici|stripe|@aws-sdk\/[^'"]+|aws-sdk|firebase-admin)['"]/

export type JsPresetOptions = {
  /** Core/domain globs — adapters and composition roots import
   *  vendors by design and must NOT match here. */
  coreGlobs?: Globs
  /** The deterministic infrastructure-import screen for core code. */
  infrastructureImports?: RegExp
  /** Point at your canonical ports once they exist, e.g. "inject the
   *  Clock port from src/ports/clock.ts". */
  seamHint?: string
  /** Files where internal-module mocking is forbidden (the only test
   *  seam is a port). */
  mockGlobs?: Globs
  /** Files the TDD gate (the expensive, AI-validated rule) applies
   *  to — scope this to the code you actually TDD. */
  tddGlobs?: Globs
  /** The spec/acceptance layer the Language Test applies to. Do NOT
   *  widen this to DSL or protocol-driver files. */
  specGlobs?: Globs
  /** Absolute path to a glossary (ubiquitous-language skill) to hold
   *  specs to. */
  glossaryPath?: string
  /** The real test command your commit gate should look for. */
  commitCommand?: RegExp
  /** Your runner's green summary line. */
  commitSuccessPattern?: RegExp
  /** Your runner's failure summary line. */
  commitFailurePattern?: RegExp
  /**
   * Absolute path to the specs directory (e.g. `docs/specs`). OFF by
   * default — no behavior change until set. Setting it switches on
   * spec-to-test traceability, the same set the KMP/Kotlin presets
   * wire: `requireSpecBackedAcceptanceTest` on `acceptanceTestGlobs`
   * (deterministic, write-time, ordered before every AI-validated
   * rule below), `surfaceScenarioLinkBreakage` on `specGlobs`, and
   * `enforceSpecTestParity` as a commit gate. `surfaceGlossaryTermBreakage`
   * on `glossaryPath` is added too, once that option is also set.
   */
  specsDir?: string
  /** Test-case files that must carry a spec-backed Covers: tag. */
  acceptanceTestGlobs?: Globs
  /** Absolute paths to scan for acceptance tests (Covers: tags);
   *  defaults to `[process.cwd()]` — Probity hook processes are
   *  anchored to the project root. */
  testRoots?: string[]
  /** Which files count as acceptance tests when scanning for Covers:
   *  tags (default: any file under an `acceptance/` directory). */
  testFilePattern?: RegExp
  /** What counts as a test-case declaration for the write-time gate
   *  (default: {@link JS_TEST_DECLARATION} — vitest/jest/mocha
   *  `it(`/`test(` and their `.only`/`.skip`/`.each(...)( `/
   *  `.concurrent` variants). */
  testDeclarationPattern?: RegExp
  /** Per-scenario driver mapping; see {@link DriverScope}. */
  driverScopes?: DriverScope[]
  /** Scope names every scenario must satisfy even untagged. */
  defaultScopes?: string[]
  /** Incremental-adoption baseline path for the commit-time parity gate. */
  parityBaselinePath?: string
  /** Globs excluded (as `!`-negations) from every files-scoped block —
   *  spikes and build output by default. Pass `[]` to disable. */
  excludeGlobs?: string[]
}

/**
 * Rule entries for a plain JS/TS project. Probity stops at the first
 * violation, so deterministic screens (pattern match, free, instant)
 * are ordered before AI-validated rules (a model call per matching
 * write): a vendor import in core code is rejected free by the
 * import screen, never after a TDD model call.
 */
export function jsRuleEntries(options: JsPresetOptions = {}): RuleEntry[] {
  const coreGlobs: Globs = options.coreGlobs ?? ['src/core/**', 'src/domain/**']
  const mockGlobs: Globs = options.mockGlobs ?? ['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**']
  const tddGlobs: Globs = options.tddGlobs ?? ['src/**', 'test/**', 'tests/**']
  const specGlobs: Globs = options.specGlobs ?? ['specs/**', 'acceptance/**', '**/*.feature']
  const excludeGlobs = options.excludeGlobs ?? ['spikes/**', '**/build/**']

  const entries: RuleEntry[] = [
    // ── Boundaries: ports-and-adapters ──────────────────────────────
    // Core purity. Point these globs at your core/domain/use-case
    // code only — adapters and composition roots import vendors by
    // design and must NOT match here.
    {
      files: coreGlobs,
      rules: [
        forbidContentPattern({
          match: options.infrastructureImports ?? KNOWN_INFRASTRUCTURE_IMPORTS,
          reason:
            'Core code imports an infrastructure module. The Dependency ' +
            'Rule: core imports nothing from adapters, frameworks, ' +
            'vendors, or OS I/O — define a port in the core and reach ' +
            'the dependency through an adapter (see the ' +
            'ports-and-adapters skill).',
        }),
        // Clock, randomness, and environment are ports too. Delta-based:
        // existing call sites don't block; net-new ones do. Point
        // seamHint at your canonical ports once they exist.
        forbidNewAmbientEffects({
          patterns: JS_AMBIENT_EFFECT_PATTERNS,
          seamHint: options.seamHint,
        }),
        enforcePortsBoundary(),
      ],
    },

    // Ports are the only test seam: no jest.mock()/vi.mock() of our
    // own modules anywhere in the suite. Deterministic — free to run
    // broadly.
    {
      files: mockGlobs,
      rules: [forbidInternalModuleMocks()],
    },
  ]

  // Spec-to-test traceability (issue #18): OFF by default, so a
  // project that hasn't opted in sees no behavior change. Setting
  // `specsDir` wires the same set the KMP preset wires — deterministic
  // rules, ordered before the AI-validated TDD/Language Test rules
  // below (Probity stops at the first violation, so a tagless
  // acceptance test is rejected free, never after a model call).
  if (options.specsDir) {
    const specsDir = options.specsDir
    const acceptanceTestGlobs: Globs = options.acceptanceTestGlobs ?? [
      'acceptance/**/*.test.*',
      'acceptance/**/*.spec.*',
    ]
    const testRoots = options.testRoots ?? [process.cwd()]

    // Spec↔test traceability. Editing a spec must not silently break
    // the tests that claim its scenarios: removing or renaming a
    // `## Scenario:` heading still covered by a test blocks with the
    // list of affected tests, so the rename updates its Covers: tags
    // in the same change.
    entries.push({
      files: specGlobs,
      rules: [
        surfaceScenarioLinkBreakage({ testRoots, testFilePattern: options.testFilePattern }),
      ],
    })

    // Spec-first, at write time: adding a new test case (it(/test(,
    // see JS_TEST_DECLARATION) requires a new Covers: tag resolving to
    // a scenario that already exists in specsDir — the feature file is
    // written before the test that claims it.
    entries.push({
      files: acceptanceTestGlobs,
      rules: [
        requireSpecBackedAcceptanceTest({
          specsDir,
          testDeclarationPattern: options.testDeclarationPattern ?? JS_TEST_DECLARATION,
        }),
      ],
    })

    if (options.glossaryPath) {
      // Ubiquitous-language drift: renaming or removing a glossary
      // term that specs, tests, or code still use blocks the glossary
      // edit with the list of users. The JS preset has no `root` to
      // anchor a relative glob against (unlike the KMP/Kotlin
      // presets), so this scopes by basename anywhere in the tree —
      // broader than an exact path, but safe regardless of where
      // `glossaryPath` (an absolute path) points.
      entries.push({
        files: [`**/${basename(options.glossaryPath)}`],
        rules: [surfaceGlossaryTermBreakage({ searchRoots: testRoots })],
      })
    }
  }

  // ── Inner loop: test-driven-development ─────────────────────────
  // Red → Green → Refactor on all production and test code. This is
  // the expensive rule (AI call per matching write) — scope it to
  // the code you actually TDD. Listed AFTER the deterministic
  // screens above: Probity stops at the first violation, so a
  // vendor import in core code is rejected free by the import
  // screen, never after a model call.
  entries.push({
    files: tddGlobs,
    rules: [withJudgeFailureDiagnostics(enforceTdd())],
  })

  // ── Outer loop: acceptance-testing ──────────────────────────────
  // The Language Test on the spec layer only. Do NOT widen this to
  // DSL or protocol-driver files — those layers are supposed to
  // contain the mechanics this rule blocks. To hold specs to your
  // glossary (ubiquitous-language skill), pass glossaryPath as an
  // absolute path, e.g.:
  //   enforceAcceptanceLanguage({
  //     glossaryPath: fileURLToPath(new URL('./docs/GLOSSARY.md', import.meta.url)),
  //   })
  entries.push({
    files: specGlobs,
    rules: [enforceAcceptanceLanguage({ glossaryPath: options.glossaryPath })],
  })

  if (options.specsDir) {
    // ── Ship gate: spec↔test parity ─────────────────────────────────
    // Definition of done, made mechanical: every non-wip scenario in
    // specsDir is claimed by an acceptance test (Covers: tag), and
    // every tag resolves to a real scenario. Mark in-progress specs
    // `## Scenario (wip):`.
    entries.push(
      enforceSpecTestParity({
        specsDir: options.specsDir,
        testRoots: options.testRoots ?? [process.cwd()],
        testFilePattern: options.testFilePattern,
        baselinePath: options.parityBaselinePath,
        driverScopes: options.driverScopes,
        defaultScopes: options.defaultScopes,
      }),
    )
  }

  // ── Ship gate: green tests ──────────────────────────────────────
  // No commit on an unverified tree — and the recorded run must be
  // GREEN. Probity's built-in requireCommand only checks that a test
  // command ran after the last write; a run whose output was all
  // failures would still unlock the commit. Match your real test
  // command and your runner's summary lines (defaults below cover
  // vitest and jest).
  entries.push(
    requireGreenTestRun({
      command: options.commitCommand ?? /npm (run )?test|vitest|jest/,
      successPattern:
        options.commitSuccessPattern ?? /Test Files\s+\d+ passed|Tests:\s+.*\b\d+ passed/,
      failurePattern: options.commitFailurePattern ?? /\d+ failed|FAIL\s/,
    }),
  )

  return withExcludeGlobs(entries, excludeGlobs)
}
