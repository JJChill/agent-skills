/**
 * Probity config template for agent-skills projects.
 *
 * Turns three of this catalog's prose disciplines into hard PreToolUse
 * gates via https://github.com/nizos/probity :
 *
 *   test-driven-development  → enforceTdd (built-in)
 *   ports-and-adapters       → enforcePortsBoundary + forbidInternalModuleMocks
 *                              + a deterministic import screen
 *   acceptance-testing       → enforceAcceptanceLanguage
 *
 * Copy this file to your project root as `probity.config.ts` along
 * with the `rules/` directory next to it, install probity
 * (`npm install -D @nizos/probity`), wire the hook (see
 * hooks/PROBITY.md), then adjust every glob below to your layout —
 * the globs here describe a common src/core + src/adapters layout and
 * WILL need editing.
 *
 * Brownfield? The mutation-probe and characterization round-trips
 * (`withMutationProbe`/`enforceProbeReversion`,
 * `withCharacterizationTest`/`enforceCharacterizationResolution` in
 * rules/kotlin.ts — language-neutral despite the filename, they take
 * marker/file patterns as options) sanction retrofitting tests onto
 * pre-existing behavior, which the plain TDD gate otherwise blocks
 * (a test for existing behavior is born green). Wire them when you
 * start backfilling coverage; see hooks/PROBITY.md.
 */
import {
  defineConfig,
  enforceTdd,
  forbidContentPattern,
} from '@nizos/probity'

import { enforceAcceptanceLanguage } from './rules/acceptance-language.js'
import {
  forbidNewAmbientEffects,
  JS_AMBIENT_EFFECT_PATTERNS,
  requireGreenTestRun,
} from './rules/gates.js'
import {
  enforcePortsBoundary,
  forbidInternalModuleMocks,
} from './rules/ports-and-adapters.js'

/**
 * Deterministic first line of defense for the Dependency Rule: known
 * framework/vendor/OS-I/O imports never belong in core code, so block
 * them without spending an AI call. Extend with your stack's usual
 * suspects; enforcePortsBoundary catches what this list misses.
 */
const KNOWN_INFRASTRUCTURE_IMPORTS =
  /from\s+['"](?:node:(?:fs|http|https|net|child_process|process)|fs|http|https|express|fastify|@nestjs\/[^'"]+|next\/[^'"]+|pg|mysql2?|mongodb|mongoose|redis|ioredis|@prisma\/client|typeorm|knex|axios|node-fetch|got|undici|stripe|@aws-sdk\/[^'"]+|aws-sdk|firebase-admin)['"]/

export default defineConfig({
  rules: [
    // ── Boundaries: ports-and-adapters ──────────────────────────────
    // Core purity. Point these globs at your core/domain/use-case
    // code only — adapters and composition roots import vendors by
    // design and must NOT match here.
    {
      files: ['src/core/**', 'src/domain/**'],
      rules: [
        forbidContentPattern({
          match: KNOWN_INFRASTRUCTURE_IMPORTS,
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
        }),
        enforcePortsBoundary(),
      ],
    },

    // Ports are the only test seam: no jest.mock()/vi.mock() of our
    // own modules anywhere in the suite. Deterministic — free to run
    // broadly.
    {
      files: ['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**'],
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
      files: ['src/**', 'test/**', 'tests/**'],
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
      files: ['specs/**', 'acceptance/**', '**/*.feature'],
      rules: [enforceAcceptanceLanguage()],
    },

    // ── Ship gate ────────────────────────────────────────────────────
    // No commit on an unverified tree — and the recorded run must be
    // GREEN. Probity's built-in requireCommand only checks that a test
    // command ran after the last write; a run whose output was all
    // failures would still unlock the commit. Match your real test
    // command and your runner's summary lines (defaults below cover
    // vitest and jest).
    requireGreenTestRun({
      command: /npm (run )?test|vitest|jest/,
      successPattern: /Test Files\s+\d+ passed|Tests:\s+.*\b\d+ passed/,
      failurePattern: /\d+ failed|FAIL\s/,
    }),
  ],
})
