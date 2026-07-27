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
 */
import {
  defineConfig,
  enforceTdd,
  forbidContentPattern,
  requireCommand,
} from '@nizos/probity'

import { enforceAcceptanceLanguage } from './rules/acceptance-language.js'
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
    // ── Inner loop: test-driven-development ─────────────────────────
    // Red → Green → Refactor on all production and test code. This is
    // the expensive rule (AI call per matching write) — scope it to
    // the code you actually TDD.
    {
      files: ['src/**', 'test/**', 'tests/**'],
      rules: [enforceTdd()],
    },

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
    // No commit on an unverified tree: the full suite must have run
    // after the last write. Mirrors the /build and /ship commands'
    // prose gate. Match your real test command.
    requireCommand({
      before: { kind: 'command', match: /git commit/ },
      command: /npm (run )?test|vitest|jest|pytest/,
      after: { kind: 'write' },
      reason:
        'Run the test suite after the last change before committing ' +
        '(see test-driven-development: commit only on green).',
    }),
  ],
})
