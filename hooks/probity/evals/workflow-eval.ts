/**
 * Scripted-episode evaluation of the full Probity workflow.
 *
 * A made-up feature ("parcel tracking") is driven through the entire
 * outside-in loop — spec → acceptance test → red → green → boundary
 * violations → traceability breakage → commit gates — as a sequence
 * of synthetic write/command actions run through the real rules from
 * ../rules/. Each step asserts the expected decision and, for blocks,
 * the rule that fired.
 *
 * Two validator modes for the AI-judged rules (enforceTdd,
 * enforcePortsBoundary, enforceAcceptanceLanguage):
 *
 *   npx tsx workflow-eval.ts          # scripted verdicts (CI-safe):
 *                                     # exercises wiring, ordering,
 *                                     # and every deterministic rule
 *   npx tsx workflow-eval.ts --live   # real verdicts via the
 *                                     # `claude` CLI: additionally
 *                                     # evaluates the AI rules'
 *                                     # prompt quality
 *
 * Scoping is derived from the config template itself: the episode
 * runs the rule entries `probity.config.kmp.ts` exports, with block
 * `files` globs resolved by rules/scoping.ts (a pinned replica of
 * Probity's own picomatch matcher and glob anchoring). Out-of-scope
 * steps — an adapter with a vendor import, a Koin DI module, a
 * mechanics-laden *Robot.kt and its split-layout *Driver.kt twin —
 * assert that the exclusions hold and that no AI validator is even
 * consulted. Steps blocked by the deterministic wall additionally
 * assert AI silence: rule order must reject them at zero model cost.
 *
 * What this does NOT cover: Probity's own engine (hook payload
 * parsing, transcript adapters) and whether picomatch's semantics
 * drift from the engine's matcher across Probity upgrades — see the
 * pin note in rules/scoping.ts.
 *
 * Exit code: 0 all steps match, 1 otherwise.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Action, Agent, RuleContext, RuleResult } from '@nizos/probity'

import { kmpRuleEntries } from '../probity.config.kmp.js'
import {
  actionMatchesFilesScope,
  anchorEntries,
  isRuleBlock,
} from '../rules/scoping.js'

type SessionEvent = Awaited<ReturnType<NonNullable<RuleContext['history']>>>[number]
type RawSessionEvent = Awaited<ReturnType<NonNullable<RuleContext['rawHistory']>>>[number]

// ── Made-up feature: parcel tracking ────────────────────────────────

const GLOSSARY = 'docs/GLOSSARY.md'
const SPEC = 'docs/specs/parcel-tracking.feature.md'
const ACCEPTANCE_TEST =
  'feature/tracking/src/commonTest/kotlin/com/example/tracking/acceptance/ParcelTrackingAcceptanceTest.kt'
const USECASE = 'feature/tracking/src/commonMain/kotlin/com/example/tracking/usecase/TrackParcel.kt'
const DOMAIN = 'feature/tracking/src/commonMain/kotlin/com/example/tracking/domain/Parcel.kt'
// Out-of-scope by design: the layer-2 Robot DSL (excluded from the
// Language Test via `!**/*Robot.kt`), a split-layout protocol driver
// (`!**/*Driver.kt`, the four-layer variant), a platform adapter
// source set, and a DI package — each written with content the core
// rules would block, to prove the exclusions hold.
const ROBOT =
  'feature/tracking/src/commonTest/kotlin/com/example/tracking/acceptance/TrackingRobot.kt'
const DRIVER =
  'feature/tracking/src/commonTest/kotlin/com/example/tracking/acceptance/TrackingViewModelDriver.kt'
// Incremental-adoption baseline for the spec↔test parity gate.
const BASELINE = 'docs/specs/.parity-baseline'
const ADAPTER =
  'feature/tracking/src/androidMain/kotlin/com/example/tracking/adapter/RoomParcelStore.kt'
const DI_MODULE =
  'feature/tracking/src/commonMain/kotlin/com/example/tracking/di/TrackingModule.kt'

const GLOSSARY_V1 = `# Glossary

## Parcel

A shipment registered for delivery to a recipient.

## Depot

A facility where parcels are scanned while in transit.

## Recipient

The person a parcel is addressed to.

## Waybill

The paper manifest that accompanied parcels before digital tracking.
`

const SPEC_V1 = `# Parcel Tracking

## Scenario: Registered parcel reports its current depot
Given a parcel is registered for delivery
When the parcel arrives at a depot
Then the parcel reports that depot as its current location

## Scenario (wip): Recipient is notified on final delivery
Given a parcel is registered for delivery to a recipient
When the parcel is delivered
Then the recipient is notified of the delivery
`

const SPEC_UI_LEAK = `${SPEC_V1}
## Scenario: Depot history is visible
Given a parcel has passed through two depots
When I click the Track button on the tracking page
Then the depot history table shows two rows
`

const ACCEPTANCE_TEST_V1 = `package com.example.tracking.acceptance

import kotlin.test.Test

class ParcelTrackingAcceptanceTest {
    private val tracking = TrackingRobot()

    // Covers: parcel-tracking.feature.md :: Scenario: Registered parcel reports its current depot
    @Test
    fun \`registered parcel reports its current depot\`() {
        tracking.registerParcel("parcel1")
        tracking.parcelArrivesAtDepot("parcel1", "depot7")
        tracking.confirmCurrentLocation("parcel1", "depot7")
    }
}
`

// Layer 2 of the four-layer model: knows UiState fields and MVI
// intents — exactly the mechanics the Language Test bans from layer 1.
const ROBOT_V1 = `package com.example.tracking.acceptance

import com.example.tracking.presentation.TrackingViewModel
import com.example.tracking.presentation.TrackingIntent

class TrackingRobot {
    private val viewModel = TrackingViewModel()

    fun registerParcel(parcelId: String) {
        viewModel.onIntent(TrackingIntent.Register(parcelId))
    }

    fun parcelArrivesAtDepot(parcelId: String, depotId: String) {
        viewModel.onIntent(TrackingIntent.DepotScan(parcelId, depotId))
    }

    fun confirmCurrentLocation(parcelId: String, depotId: String) {
        check(viewModel.uiState.value.locationOf(parcelId) == depotId)
    }
}
`

// Layer 3 of the four-layer model, split layout: same mechanics as
// the Robot, behind a driver interface — equally exempt.
const DRIVER_V1 = `package com.example.tracking.acceptance

import com.example.tracking.presentation.TrackingViewModel
import com.example.tracking.presentation.TrackingIntent

class TrackingViewModelDriver : TrackingDriver {
    private val viewModel = TrackingViewModel()

    override fun registerParcel(parcelId: String) {
        viewModel.onIntent(TrackingIntent.Register(parcelId))
    }

    override fun verifyCurrentLocation(parcelId: String, depotId: String) {
        check(viewModel.uiState.value.locationOf(parcelId) == depotId)
    }
}
`

// Vendor import + direct clock read: both blocked in core packages,
// both this adapter's job. Carries a structured event so the
// adapter-observability rule passes it — thin, not blind.
const ADAPTER_V1 = `package com.example.tracking.adapter

import androidx.room.RoomDatabase
import com.example.tracking.domain.Parcel
import com.example.tracking.port.ParcelStore
import com.example.tracking.foundation.Logger

class RoomParcelStore(private val db: RoomDatabase, private val logger: Logger) : ParcelStore {
    override suspend fun byId(parcelId: String): Parcel? = null
    override suspend fun save(parcel: Parcel) {
        val syncedAt = System.currentTimeMillis()
        logger.event("ParcelStore", "parcel_saved", fields = listOf("synced_at" to syncedAt.toString()))
    }
}
`

// External I/O with no event, tap, or span anywhere — the
// adapter-observability rule's violation case.
const BLIND_ADAPTER =
  'feature/tracking/src/androidMain/kotlin/com/example/tracking/adapter/HttpDepotDirectory.kt'
const BLIND_ADAPTER_V1 = `package com.example.tracking.adapter

import io.ktor.client.HttpClient
import io.ktor.client.request.get
import com.example.tracking.port.DepotDirectory

class HttpDepotDirectory(private val http: HttpClient) : DepotDirectory {
    override suspend fun depotName(depotId: String): String =
        http.get("https://depots.example.com/" + depotId).toString()
}
`

// Koin is in the core import screen; the di package is a composition
// root and sits outside the core-purity globs.
const DI_MODULE_V1 = `package com.example.tracking.di

import com.example.tracking.usecase.TrackParcel
import org.koin.dsl.module

val trackingModule = module {
    factory { TrackParcel(get()) }
}
`

// A deliberate break of the use case, marked as a mutation probe
// (proving a retrofitted test bites). The TDD gate must let it
// through deterministically; the commit gate must hold it hostage
// until reverted.
const USECASE_PROBE = `package com.example.tracking.usecase

import com.example.tracking.domain.Parcel
import com.example.tracking.port.ParcelStore

class TrackParcel(private val parcels: ParcelStore) {
    suspend fun arriveAtDepot(parcelId: String, depotId: String) {
        val parcel = parcels.byId(parcelId) ?: return
        // probity: mutation-probe — proving the depot test bites; revert before commit
        parcels.save(parcel)
    }
}
`

const USECASE_V1 = `package com.example.tracking.usecase

import com.example.tracking.domain.Parcel
import com.example.tracking.port.ParcelStore

class TrackParcel(private val parcels: ParcelStore) {
    suspend fun arriveAtDepot(parcelId: String, depotId: String) {
        val parcel = parcels.byId(parcelId) ?: return
        parcels.save(parcel.withLocation(depotId))
    }
}
`

const RED_RUN = {
  command: './gradlew :feature:tracking:testAndroidHostTest',
  output:
    'ParcelTrackingAcceptanceTest > registered parcel reports its current depot FAILED\n' +
    '    expected: "depot7" but was: null\n1 test completed, 1 failed',
}
const GREEN_RUN = {
  command: './gradlew :feature:tracking:testAndroidHostTest',
  output: 'BUILD SUCCESSFUL\n1 test completed, 0 failed',
}

// ── Episode ─────────────────────────────────────────────────────────

type AiKind = 'tdd' | 'boundary' | 'language' | 'adapterObs'

type Step = {
  title: string
  action: Action
  commandOutput?: string
  expect: 'allow' | 'block'
  expectRule?: string
  expectNote?: string
  /**
   * AI validators that must NOT be consulted on this step — the
   * scoping assertion for out-of-scope writes. A plain `allow` can't
   * distinguish "excluded by the globs" from "the validator happened
   * to pass"; this can.
   */
  expectAiSilent?: AiKind[]
  ai?: Partial<Record<AiKind, 'pass' | 'violation'>>
}

function write(path: string, content: string): Action {
  return { kind: 'write', path, content }
}
function command(cmd: string): Action {
  return { kind: 'command', command: cmd }
}

const EPISODE: Step[] = [
  {
    title: 'Write the glossary (parcel / depot / recipient)',
    action: write(GLOSSARY, GLOSSARY_V1),
    expect: 'allow',
  },
  {
    title: 'Write the spec (glossary terms, one wip scenario)',
    action: write(SPEC, SPEC_V1),
    expect: 'allow',
    ai: { language: 'pass' },
  },
  {
    title: 'Spec scenario calling a parcel a "package" (glossary conflict)',
    action: write(
      SPEC,
      `${SPEC_V1}
## Scenario: Package location is queried
Given a package is registered for delivery
When the package arrives at a depot
Then the package reports that depot as its current location
`,
    ),
    expect: 'block',
    expectRule: 'enforceAcceptanceLanguage',
    ai: { language: 'violation' },
  },
  {
    title: 'Spec scenario leaking UI mechanics (click / button / page / table)',
    action: write(SPEC, SPEC_UI_LEAK),
    expect: 'block',
    expectRule: 'enforceAcceptanceLanguage',
    ai: { language: 'violation' },
  },
  {
    title: 'Spec scenario naming the backend (one language standard for specs and tests)',
    action: write(
      SPEC,
      `${SPEC_V1}
## Scenario: Failed registration is retryable
Given the backend rejects a parcel registration
When the sender tries again once the backend recovers
Then the parcel is registered
`,
    ),
    expect: 'block',
    expectRule: 'enforceAcceptanceLanguage',
    ai: { language: 'violation' },
  },
  {
    title: 'Robot DSL full of UiState/intent mechanics (*Robot.kt is exempt from the Language Test)',
    action: write(ROBOT, ROBOT_V1),
    expect: 'allow',
    expectAiSilent: ['language'],
    ai: { tdd: 'pass' },
  },
  {
    title: 'Split-layout protocol driver, same mechanics (*Driver.kt is equally exempt)',
    action: write(DRIVER, DRIVER_V1),
    expect: 'allow',
    expectAiSilent: ['language'],
    ai: { tdd: 'pass' },
  },
  {
    title: 'Acceptance test with no Covers tag (spec-first: blocked before any AI call)',
    action: write(
      ACCEPTANCE_TEST,
      ACCEPTANCE_TEST_V1.replace(
        /^\s*\/\/ Covers:[^\n]*\n/m,
        '',
      ),
    ),
    expect: 'block',
    expectRule: 'requireSpecBackedAcceptanceTest',
    expectAiSilent: ['tdd', 'language'],
  },
  {
    title: 'Acceptance test citing a scenario the spec does not have yet',
    action: write(
      ACCEPTANCE_TEST,
      ACCEPTANCE_TEST_V1.replace(
        'Scenario: Registered parcel reports its current depot',
        'Scenario: Parcel teleports between depots',
      ),
    ),
    expect: 'block',
    expectRule: 'requireSpecBackedAcceptanceTest',
    expectAiSilent: ['tdd', 'language'],
  },
  {
    title: 'Acceptance test with Covers tag (single new @Test → both TDD and language fast-paths)',
    action: write(ACCEPTANCE_TEST, ACCEPTANCE_TEST_V1),
    expect: 'allow',
    expectNote: 'fast-path',
    // Overlapping scopes must not defeat the fast-path: the language
    // rule skips its AI call when the one new test only reuses
    // vocabulary already declared in the suite's DSL files.
    expectAiSilent: ['tdd', 'language'],
  },
  {
    title: 'Second driver test for the already-covered scenario (one scenario, many drivers — spec-first must not fire)',
    action: write(
      ACCEPTANCE_TEST,
      ACCEPTANCE_TEST_V1 +
        `
class ParcelTrackingSplitDriverAcceptanceTest {
    private val tracking = TrackingRobot()

    @Test
    fun \`registered parcel reports its current depot via the split driver\`() {
        tracking.registerParcel("parcel2")
        tracking.parcelArrivesAtDepot("parcel2", "depot7")
        tracking.confirmCurrentLocation("parcel2", "depot7")
    }
}
`,
    ),
    expect: 'allow',
    expectNote: 'fast-path',
    // No NEW Covers key is added — the file's existing tag already
    // resolves, which is exactly how a second/third driver transcribes
    // an already-claimed scenario. The spec-first rule must stay quiet.
    expectAiSilent: ['tdd', 'language'],
  },
  {
    title: 'Production code before any failing test was observed',
    action: write(USECASE, USECASE_V1),
    expect: 'block',
    expectRule: 'enforceTdd',
    ai: { tdd: 'violation', boundary: 'pass' },
  },
  {
    title: 'Run the suite — observe red',
    action: command(RED_RUN.command),
    commandOutput: RED_RUN.output,
    expect: 'allow',
  },
  {
    title: 'Commit straight after the red run (a recorded invocation is not a passing suite)',
    action: command('git commit -m "wip parcel tracking"'),
    expect: 'block',
    expectRule: 'requireGreenTestRun',
  },
  {
    title: 'Minimal implementation addressing the observed failure',
    action: write(USECASE, USECASE_V1),
    expect: 'allow',
    ai: { tdd: 'pass', boundary: 'pass' },
  },
  {
    title: 'Room adapter with vendor import and real clock (androidMain — core rules must not fire)',
    action: write(ADAPTER, ADAPTER_V1),
    expect: 'allow',
    expectAiSilent: ['boundary'],
    ai: { tdd: 'pass', adapterObs: 'pass' },
  },
  {
    title: 'Adapter doing network I/O with no boundary observability (thin, but blind)',
    action: write(BLIND_ADAPTER, BLIND_ADAPTER_V1),
    expect: 'block',
    expectRule: 'enforceAdapterObservability',
    ai: { tdd: 'pass', adapterObs: 'violation' },
  },
  {
    title: 'Telemetry-only addition to the adapter (telemetry fast-path — both gates free)',
    action: write(
      ADAPTER,
      ADAPTER_V1.replace(
        '        val syncedAt = System.currentTimeMillis()',
        '        val syncedAt = System.currentTimeMillis()\n' +
          '        logger.event("ParcelStore", "parcel_save_requested")',
      ),
    ),
    expect: 'allow',
    expectNote: 'fast-path',
    expectAiSilent: ['tdd', 'adapterObs'],
  },
  {
    title: 'Koin module wiring the use case (di package — outside the core-purity globs)',
    action: write(DI_MODULE, DI_MODULE_V1),
    expect: 'allow',
    expectAiSilent: ['boundary'],
    ai: { tdd: 'pass' },
  },
  {
    title: 'Domain code importing a vendor HTTP client',
    action: write(
      DOMAIN,
      'package com.example.tracking.domain\n\nimport io.ktor.client.HttpClient\n\nclass Parcel(private val http: HttpClient)\n',
    ),
    expect: 'block',
    expectRule: 'forbidContentPattern',
    // The deterministic wall runs before the AI layer: rejecting this
    // write must cost zero model calls.
    expectAiSilent: ['tdd', 'boundary'],
  },
  {
    title: 'Domain code reading the OS clock directly',
    action: write(
      DOMAIN,
      'package com.example.tracking.domain\n\nclass Parcel {\n    val registeredAt = System.currentTimeMillis()\n}\n',
    ),
    expect: 'block',
    expectRule: 'forbidNewAmbientEffects',
    expectAiSilent: ['tdd', 'boundary'],
  },
  {
    title: 'Test reaching for a mocking library',
    action: write(
      ACCEPTANCE_TEST.replace('AcceptanceTest', 'MockedTest'),
      'package com.example.tracking.acceptance\n\nimport io.mockk.mockk\nimport kotlin.test.Test\n\nclass ParcelTrackingMockedTest {\n    @Test\n    fun \`x\`() { val store = mockk<Any>() }\n}\n',
    ),
    expect: 'block',
    expectRule: 'forbidContentPattern',
    expectAiSilent: ['tdd', 'language'],
  },
  {
    title: 'Commit with writes since the last test run',
    action: command('git commit -m "parcel tracking"'),
    expect: 'block',
    expectRule: 'requireGreenTestRun',
  },
  {
    title: 'Run the suite — green',
    action: command(GREEN_RUN.command),
    commandOutput: GREEN_RUN.output,
    expect: 'allow',
  },
  {
    title: 'Commit on green with spec↔test parity holding',
    action: command('git commit -m "parcel tracking"'),
    expect: 'allow',
  },
  {
    title: 'Rename a covered scenario without updating its test',
    action: write(
      SPEC,
      SPEC_V1.replace(
        'Registered parcel reports its current depot',
        'Parcel reports the depot it was last scanned at',
      ),
    ),
    expect: 'block',
    expectRule: 'surfaceScenarioLinkBreakage',
    ai: { language: 'pass' },
  },
  {
    title: 'Promote the wip scenario without a covering test',
    action: write(SPEC, SPEC_V1.replace('## Scenario (wip):', '## Scenario:')),
    expect: 'allow',
    ai: { language: 'pass' },
  },
  {
    title: 'Run the suite — still green',
    action: command(GREEN_RUN.command),
    commandOutput: GREEN_RUN.output,
    expect: 'allow',
  },
  {
    title: 'Commit with the promoted scenario uncovered',
    action: command('git commit -m "promote notification scenario"'),
    expect: 'block',
    expectRule: 'enforceSpecTestParity',
  },
  {
    title: 'Adopt incrementally: baseline the uncovered scenario (brownfield burn-down)',
    action: write(
      BASELINE,
      '# Brownfield adoption baseline — burn down by deleting lines.\n' +
        'parcel-tracking.feature.md :: Recipient is notified on final delivery\n',
    ),
    expect: 'allow',
  },
  {
    title: 'Run the suite — green after the baseline write',
    action: command(GREEN_RUN.command),
    commandOutput: GREEN_RUN.output,
    expect: 'allow',
  },
  {
    title: 'Commit with the baselined scenario exempt from parity',
    action: command('git commit -m "promote notification scenario"'),
    expect: 'allow',
  },
  {
    title: 'Mutation probe: deliberate break marked for reversion (TDD gate bypassed deterministically)',
    action: write(USECASE, USECASE_PROBE),
    expect: 'allow',
    expectNote: 'mutation-probe',
    expectAiSilent: ['tdd'],
    ai: { boundary: 'pass' },
  },
  {
    title: 'Commit with the probe still on disk',
    action: command('git commit -m "retry scenario"'),
    expect: 'block',
    expectRule: 'enforceProbeReversion',
  },
  {
    title: 'Revert the probe (restore the original implementation)',
    action: write(USECASE, USECASE_V1),
    expect: 'allow',
    ai: { tdd: 'pass', boundary: 'pass' },
  },
  {
    title: 'Run the suite — green after the reversion',
    action: command(GREEN_RUN.command),
    commandOutput: GREEN_RUN.output,
    expect: 'allow',
  },
  {
    title: 'Commit with the probe reverted',
    action: command('git commit -m "retry scenario"'),
    expect: 'allow',
  },
  {
    title: 'Rename glossary term "Depot" while spec and test still use it',
    action: write(GLOSSARY, GLOSSARY_V1.replace('## Depot', '## Hub')),
    expect: 'block',
    expectRule: 'surfaceGlossaryTermBreakage',
  },
  {
    title: 'Retire the unused glossary term "Waybill" (nothing references it)',
    action: write(
      GLOSSARY,
      GLOSSARY_V1.replace(/\n## Waybill\n\nThe paper manifest[^\n]*\n/, ''),
    ),
    expect: 'allow',
  },
]

// ── Harness ─────────────────────────────────────────────────────────

const LIVE = process.argv.includes('--live')
const ROOT = mkdtempSync(join(tmpdir(), 'probity-workflow-eval-'))
const history: SessionEvent[] = []
const rawHistory: RawSessionEvent[] = []
let currentStep: Step

function materialize(path: string, content: string): void {
  const full = join(ROOT, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function ruleKind(prompt: string): AiKind {
  if (prompt.includes('TDD validator')) return 'tdd'
  if (prompt.includes('architecture-boundary validator')) return 'boundary'
  if (prompt.includes('adapter-observability validator')) return 'adapterObs'
  return 'language'
}

// Which AI validators the current step actually consulted — reset per
// step, asserted against `expectAiSilent`.
let invokedAi = new Set<AiKind>()

const scriptedAgent: Agent = {
  reason: async (prompt) => {
    const validator = ruleKind(prompt)
    invokedAi.add(validator)
    const kind = currentStep.ai?.[validator] ?? 'pass'
    return { kind, reason: kind === 'violation' ? 'scripted violation' : '' }
  },
}

const liveAgent: Agent = {
  reason: async (prompt) => {
    invokedAi.add(ruleKind(prompt))
    const out = execFileSync('claude', ['-p'], {
      input: prompt,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    const match = out.match(/\{[^{}]*"kind"\s*:\s*"(?:pass|violation)"[^{}]*\}/g)
    if (!match) throw new Error(`No verdict JSON in validator output: ${out.slice(0, 400)}`)
    return JSON.parse(match[match.length - 1]!) as { kind: 'pass' | 'violation'; reason: string }
  },
}

const ctx: RuleContext = {
  agent: LIVE ? liveAgent : scriptedAgent,
  history: async () => [...history],
  rawHistory: async () => [...rawHistory],
  readFile: async (path) => {
    try {
      const { readFileSync } = await import('node:fs')
      return { kind: 'present', content: readFileSync(path, 'utf8') }
    } catch {
      return { kind: 'absent' }
    }
  },
}

// Scoping derived from the config template: the exact rule entries
// probity.config.kmp.ts exports, instantiated against the episode
// ROOT, with relative globs anchored the way Probity's loadConfig
// anchors them. Glob semantics come from rules/scoping.ts — a pinned
// replica of the engine's matcher — so a template glob edit is
// exercised here automatically.
const ENTRIES = anchorEntries(kmpRuleEntries(ROOT), ROOT)

type Decision =
  | { kind: 'allow'; notes: string }
  | { kind: 'block'; rule: string; reason: string; notes: string }

// Mirrors the engine's resolveRules: flat entries always apply;
// blocks apply when the action passes their `files` scope (commands
// pass every block filter and rules self-filter by action kind).
async function evaluate(action: Action): Promise<Decision> {
  let notes = ''
  const rebased = rebase(action)
  for (const entry of ENTRIES) {
    const rules = !isRuleBlock(entry)
      ? [entry]
      : !entry.files || actionMatchesFilesScope(entry.files, rebased)
        ? entry.rules
        : []
    for (const rule of rules) {
      const result: RuleResult = await rule(rebased, ctx)
      if (result.kind === 'violation') {
        return { kind: 'block', rule: rule.name, reason: result.reason, notes }
      }
      if ('notes' in result && result.notes) notes += result.notes.map((n) => n.kind).join(',')
    }
  }
  return { kind: 'allow', notes }
}

// Actions use repo-relative paths; rules see absolute paths under ROOT.
function rebase(action: Action): Action {
  return action.kind === 'write' ? { ...action, path: join(ROOT, action.path) } : action
}

function record(step: Step): void {
  if (step.action.kind === 'write') {
    materialize(step.action.path, step.action.content)
    history.push({ kind: 'write', path: join(ROOT, step.action.path), content: step.action.content, output: 'ok' })
    rawHistory.push({ kind: 'action', tool: 'Write', input: { file_path: join(ROOT, step.action.path), content: step.action.content }, output: 'ok', toolUseId: `t${history.length}` })
  } else {
    const output = step.commandOutput ?? ''
    history.push({ kind: 'command', command: step.action.command, output })
    rawHistory.push({ kind: 'action', tool: 'Bash', input: step.action.command, output, toolUseId: `t${history.length}` })
  }
}

let failures = 0
console.log(`Workflow eval (${LIVE ? 'LIVE AI validator' : 'scripted validator'}) in ${ROOT}\n`)
for (const [index, step] of EPISODE.entries()) {
  currentStep = step
  invokedAi = new Set()
  const decision = await evaluate(step.action)
  const outcomeOk = decision.kind === (step.expect === 'allow' ? 'allow' : 'block')
  // Live mode asserts outcomes only: with a real validator, a write
  // violating several rules may block on whichever AI rule runs first
  // in config order (exactly as in a real session), so the specific
  // rule is reported for inspection rather than asserted.
  const ruleOk =
    LIVE ||
    step.expect === 'allow' ||
    !step.expectRule ||
    (decision.kind === 'block' && decision.rule.includes(step.expectRule))
  const noteOk = !step.expectNote || decision.notes.includes(step.expectNote)
  const wronglyConsulted = (step.expectAiSilent ?? []).filter((k) => invokedAi.has(k))
  const silentOk = wronglyConsulted.length === 0
  const ok = outcomeOk && ruleOk && noteOk && silentOk
  if (!ok) failures++
  const fired = decision.kind === 'block' ? ` [${decision.rule}]` : ''
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(index + 1).padStart(2)}. ${step.title} → ${decision.kind}${fired}`)
  if (!ok && decision.kind === 'block') console.log(`      reason: ${decision.reason.split('\n')[0]}`)
  if (!silentOk)
    console.log(`      mis-scoped: ${wronglyConsulted.join(', ')} validator consulted on an out-of-scope file`)
  if (ok && decision.kind === 'allow') record(step)
  // A correctly blocked action is not recorded or materialized — the
  // hook prevented it, exactly as in a real session.
}
console.log(`\n${EPISODE.length - failures}/${EPISODE.length} steps behaved as expected.`)
process.exit(failures === 0 ? 0 : 1)
