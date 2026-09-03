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
import { enforceTdd, forbidContentPattern, type RuleEntry } from '@nizos/probity'

import { enforceAcceptanceLanguage } from '../rules/acceptance-language.js'
import {
  forbidNewAmbientEffects,
  JS_AMBIENT_EFFECT_PATTERNS,
  requireGreenTestRun,
} from '../rules/gates.js'
import {
  enforcePortsBoundary,
  forbidInternalModuleMocks,
} from '../rules/ports-and-adapters.js'
import type { Globs } from '../rules/scoping.js'

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

  return [
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

    // ── Inner loop: test-driven-development ─────────────────────────
    // Red → Green → Refactor on all production and test code. This is
    // the expensive rule (AI call per matching write) — scope it to
    // the code you actually TDD. Listed AFTER the deterministic
    // screens above: Probity stops at the first violation, so a
    // vendor import in core code is rejected free by the import
    // screen, never after a model call.
    {
      files: tddGlobs,
      rules: [enforceTdd()],
    },

    // ── Outer loop: acceptance-testing ──────────────────────────────
    // The Language Test on the spec layer only. Do NOT widen this to
    // DSL or protocol-driver files — those layers are supposed to
    // contain the mechanics this rule blocks. To hold specs to your
    // glossary (ubiquitous-language skill), pass glossaryPath as an
    // absolute path, e.g.:
    //   enforceAcceptanceLanguage({
    //     glossaryPath: fileURLToPath(new URL('./docs/GLOSSARY.md', import.meta.url)),
    //   })
    {
      files: specGlobs,
      rules: [enforceAcceptanceLanguage({ glossaryPath: options.glossaryPath })],
    },

    // ── Ship gate ────────────────────────────────────────────────────
    // No commit on an unverified tree — and the recorded run must be
    // GREEN. Probity's built-in requireCommand only checks that a test
    // command ran after the last write; a run whose output was all
    // failures would still unlock the commit. Match your real test
    // command and your runner's summary lines (defaults below cover
    // vitest and jest).
    requireGreenTestRun({
      command: options.commitCommand ?? /npm (run )?test|vitest|jest/,
      successPattern:
        options.commitSuccessPattern ?? /Test Files\s+\d+ passed|Tests:\s+.*\b\d+ passed/,
      failurePattern: options.commitFailurePattern ?? /\d+ failed|FAIL\s/,
    }),
  ]
}
