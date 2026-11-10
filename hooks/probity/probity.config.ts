/**
 * Probity config template for agent-skills projects — plain JS/TS
 * preset.
 *
 * Copy this file to your project root as `probity.config.ts`, install
 * the rules package and Probity itself:
 *
 *   npm install -D @nizos/probity @jjchill/probity-rules
 *
 * then wire the hook (see hooks/PROBITY.md).
 *
 * EDIT THESE OPTIONS to your layout — the defaults below describe a
 * common src/core + src/adapters project and WILL need adjusting:
 *   - coreGlobs             — where your core/domain code lives
 *   - infrastructureImports — your stack's known vendor/framework imports
 *   - specGlobs             — where your acceptance specs live
 *   - drivingAdapterGlobs   — your UI components / route handlers, held
 *                             thin (an AI call per write; [] = off)
 *   - domainDiscriminants   — fields whose literal comparison in UI code
 *                             is a domain decision, e.g. ['role'] (off
 *                             until set; blocks free, before the AI call)
 *   - specsDir              — turns on spec-first (see the block below)
 *   - glossaryPath          — absolute path to a ubiquitous-language glossary
 *   - commitCommand / commitSuccessPattern / commitFailurePattern
 *                           — your real test command and its output shapes
 * See presets/js.ts (`JsPresetOptions`) for the full list and every
 * option's current default.
 *
 * What this preset enforces as shipped: the TDD gate on src/ and tests,
 * core purity (vendor imports, clock/random/env reads, the boundary
 * judge) on src/core and src/domain, no mocking of your own modules, the
 * Language Test on spec files, thin driving adapters, no fixed waits in
 * acceptance code, and a green test run before every commit.
 * What it does NOT enforce until you opt in: spec-first (an acceptance
 * test must cite an existing scenario; spec edits can't orphan a test;
 * commits need spec↔test parity) — set `specsDir` below; glossary
 * drift — set `glossaryPath`. The mutation-probe and characterization
 * round-trips are not wired in this preset at all (see Brownfield).
 *
 * Brownfield? The mutation-probe and characterization round-trips
 * (`withMutationProbe`/`enforceProbeReversion`,
 * `withCharacterizationTest`/`enforceCharacterizationResolution`,
 * language-neutral, from `@jjchill/probity-rules` or
 * `@jjchill/probity-rules/rules/round-trips`) sanction retrofitting tests onto
 * pre-existing behavior, which the plain TDD gate otherwise blocks (a
 * test for existing behavior is born green). Wire them when you start
 * backfilling coverage; see hooks/PROBITY.md.
 */
import { fileURLToPath } from 'node:url'

import { claudeJudge, probityConfig } from '@jjchill/probity-rules'
import { jsRuleEntries } from '@jjchill/probity-rules/presets/js'

// probityConfig is defineConfig plus a judging-task label on every rule,
// rules you add here included (hooks/PROBITY.md, "Choosing the AI judge").
export default probityConfig({
  rules: jsRuleEntries({
    // ── Spec-first: OFF until specsDir is set ─────────────────────────
    // Uncomment this one line to turn it on. Specs are Markdown files in
    // specs/ (`<name>.feature.md`, `## Scenario: <title>` headings);
    // acceptance tests are acceptance/**/*.test.* (acceptanceTestGlobs).
    // Then:
    //   - a new test case in an acceptance test needs a
    //     `// Covers: <name>.feature.md :: Scenario: <title>` tag naming a
    //     scenario that already exists (the spec is written first);
    //   - renaming or removing a scenario a test covers is blocked until
    //     the test's tag is updated in the same change;
    //   - a commit is blocked while a non-wip scenario has no covering
    //     test (mark unfinished ones `## Scenario (wip):`).
    // Existing specs with gaps? Baseline them once and point
    // parityBaselinePath at the file:
    //   npx probity-spec-parity --specs specs --baseline specs/.parity-baseline --write-baseline
    // specsDir: fileURLToPath(new URL('./specs', import.meta.url)),
    // parityBaselinePath: fileURLToPath(new URL('./specs/.parity-baseline', import.meta.url)),
    // glossaryPath: fileURLToPath(new URL('./docs/GLOSSARY.md', import.meta.url)),
    // domainDiscriminants: ['role'],
    // coreExportsInJudge: true,
  }),
  // The installed Claude Code judges, not the copy bundled with Probity's
  // Agent SDK, on the model the judge's rules were measured on: unpinned,
  // it runs on whatever the CLI defaults to, and Sonnet let about a
  // quarter of Opus's TDD denials through (hooks/PROBITY.md, "Choosing
  // the AI judge"). Change the model only after measuring it there.
  ai: claudeJudge({ model: 'claude-opus-5-5' }),
})
