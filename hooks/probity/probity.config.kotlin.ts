/**
 * Probity config template — Kotlin/JVM/Android preset.
 *
 * Same enforcement as probity.config.ts (see hooks/PROBITY.md) with
 * the deterministic layer swapped to Kotlin-shaped rules. Calibrated
 * against a multi-module Android codebase (Gradle per project,
 * `<module>-core` / `<module>-ui` split, Mockito-kotlin + JUnit 4,
 * AWS/Amplify/Apollo/OkHttp/Retrofit/Room vendor stack) — adjust the
 * options below to your layout.
 *
 * Install:
 *
 *   npm install -D @nizos/probity @jjchill/probity-rules
 *
 * Note Probity itself still runs on Node: the consuming Kotlin
 * project needs a one-dependency package.json next to gradlew.
 *
 * EDIT THESE OPTIONS to your layout — see presets/kotlin.ts
 * (`KotlinPresetOptions`) for the full list and every option's
 * current default:
 *   - coreGlobs        — your core modules (e.g. `*-core` of a core/ui split)
 *   - staticMockGlobs   — your test source sets
 *   - acceptanceTestGlobs / acceptanceLanguageGlobs — your spec layer
 *   - seamHint          — your ambient-effect port(s)
 *   - commitCommand      — your real Gradle test task
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from '@nizos/probity'

import { kotlinRuleEntries } from '@jjchill/probity-rules/presets/kotlin'

const ROOT = dirname(fileURLToPath(import.meta.url))

export default defineConfig({ rules: kotlinRuleEntries(ROOT) })
