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
 *   - glossaryPath          — absolute path to a ubiquitous-language glossary
 *   - commitCommand / commitSuccessPattern / commitFailurePattern
 *                           — your real test command and its output shapes
 * See presets/js.ts (`JsPresetOptions`) for the full list and every
 * option's current default.
 *
 * Brownfield? The mutation-probe and characterization round-trips
 * (`withMutationProbe`/`enforceProbeReversion`,
 * `withCharacterizationTest`/`enforceCharacterizationResolution`,
 * re-exported from `@jjchill/probity-rules/rules/kotlin` despite the
 * filename — language-neutral) sanction retrofitting tests onto
 * pre-existing behavior, which the plain TDD gate otherwise blocks (a
 * test for existing behavior is born green). Wire them when you start
 * backfilling coverage; see hooks/PROBITY.md.
 */
import { defineConfig } from '@nizos/probity'

import { jsRuleEntries } from '@jjchill/probity-rules/presets/js'

export default defineConfig({
  rules: jsRuleEntries({
    // glossaryPath: fileURLToPath(new URL('./docs/GLOSSARY.md', import.meta.url)),
  }),
})
