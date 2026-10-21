/**
 * Probity config template — Swift/iOS preset.
 *
 * Same enforcement stack as the Kotlin presets (see hooks/PROBITY.md),
 * recalibrated for a native iOS app: an Xcode workspace with the
 * acceptance suite in AcceptanceTests/ following the four-layer model
 * (Specs + Component test glue / Scenarios / DSL / Drivers), XCUITest
 * plus an app-hosted component-test target, MVVM view models over
 * use-case ports, and Markdown Given/When/Then specs in docs/specs/.
 * Calibrated against a production CocoaPods + SwiftPM app — adjust
 * globs and package names to your layout.
 *
 * Install:
 *
 *   npm install -D @nizos/probity @jjchill/probity-rules
 *
 * Probity runs on Node: `npm install -D @nizos/probity` (a
 * one-dependency package.json with `"type": "module"` next to the
 * xcworkspace is fine).
 *
 * EDIT: the rule entries live in `presets/swift.ts`
 * (`swiftRuleEntries`). The globs inside it (AcceptanceTests/ layers,
 * App/Sources packages) are calibrated to the reference app above —
 * audit them against your tree with `npx probity-scope-report` before
 * trusting the gate; the file's own comments flag which patterns need
 * per-project calibration (test command, driver scopes). The main code
 * globs are options: `tddGlobs`, `coreGlobs` (ports and core behavior)
 * and `adapterGlobs` (boundary observability) default to the reference
 * app's paths.
 *
 * SwiftUI views (opt-in, issue #77): set `drivingAdapterGlobs` to hold
 * views thin. Starting globs per layout, and the `domainDiscriminants`,
 * `coreExportsInJudge` and `coreApiPaths` options, are in
 * hooks/PROBITY.md, "Driving adapters by project layout".
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { claudeJudge, probityConfig } from '@jjchill/probity-rules'
import { swiftRuleEntries } from '@jjchill/probity-rules/presets/swift'

const ROOT = dirname(fileURLToPath(import.meta.url))

// probityConfig is defineConfig plus a judging-task label on every rule,
// rules you add here included (hooks/PROBITY.md, "Choosing the AI judge").
export default probityConfig({
  rules: swiftRuleEntries(ROOT, {
    // drivingAdapterGlobs: ['App/Sources/**/Views/**', 'App/Sources/**/*View.swift', '!**/*Tests.swift', '!**/Previews/**'],
    // domainDiscriminants: ['role'],
    // coreExportsInJudge: true,
  }),
  // The installed Claude Code judges, not the copy bundled with Probity's
  // Agent SDK (hooks/PROBITY.md, "Choosing the AI judge").
  ai: claudeJudge(),
})
