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
 *
 * Install:
 *
 *   npm install -D @nizos/probity @jjchill/probity-rules
 *
 * Probity still runs on Node: `npm install -D @nizos/probity`
 * (plus optionally @ast-grep/napi @ast-grep/lang-kotlin for the TDD
 * fast-path) next to gradlew.
 *
 * EDIT: the rule entries live in `presets/kmp.ts` (`kmpRuleEntries`).
 * The globs inside it (core/domain packages, source sets, adapter
 * packages) are calibrated to the reference codebase above — audit
 * them against your tree with `npx probity-scope-report` and adjust
 * to your layout. The optional `parity` second argument turns on the
 * per-scenario driver mapping; see the commented example in
 * presets/kmp.ts.
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from '@nizos/probity'

import { kmpRuleEntries } from '@jjchill/probity-rules/presets/kmp'

const ROOT = dirname(fileURLToPath(import.meta.url))

export default defineConfig({ rules: kmpRuleEntries(ROOT) })
