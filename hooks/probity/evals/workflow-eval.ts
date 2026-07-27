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
 * What this does NOT cover: Probity's own engine (hook payload
 * parsing, glob scoping of `files` blocks, transcript adapters).
 * Scoping here is mirrored with predicates; keep them in sync with
 * probity.config.kmp.ts.
 *
 * Exit code: 0 all steps match, 1 otherwise.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Action, Agent, RuleContext, RuleResult, Rule } from '@nizos/probity'
import { enforceTdd, forbidContentPattern, requireCommand } from '@nizos/probity'

import { enforceAcceptanceLanguage } from '../rules/acceptance-language.js'
import {
  forbidNewAmbientEffects,
  GRADLE_TEST_COMMAND,
  KOTLIN_BOUNDARY_ADDENDUM,
  KOTLIN_INFRASTRUCTURE_IMPORTS,
  MOCKING_LIBRARY_IMPORTS,
  withKotlinFastPath,
} from '../rules/kotlin.js'
import { enforcePortsBoundary } from '../rules/ports-and-adapters.js'
import {
  enforceSpecTestParity,
  surfaceScenarioLinkBreakage,
} from '../rules/spec-test-parity.js'

type SessionEvent = Awaited<ReturnType<NonNullable<RuleContext['history']>>>[number]
type RawSessionEvent = Awaited<ReturnType<NonNullable<RuleContext['rawHistory']>>>[number]

// ── Made-up feature: parcel tracking ────────────────────────────────

const SPEC = 'docs/specs/parcel-tracking.feature.md'
const ACCEPTANCE_TEST =
  'feature/tracking/src/commonTest/kotlin/com/example/tracking/acceptance/ParcelTrackingAcceptanceTest.kt'
const USECASE = 'feature/tracking/src/commonMain/kotlin/com/example/tracking/usecase/TrackParcel.kt'
const DOMAIN = 'feature/tracking/src/commonMain/kotlin/com/example/tracking/domain/Parcel.kt'

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

type Step = {
  title: string
  action: Action
  commandOutput?: string
  expect: 'allow' | 'block'
  expectRule?: string
  expectNote?: string
  ai?: Partial<Record<'tdd' | 'boundary' | 'language', 'pass' | 'violation'>>
}

function write(path: string, content: string): Action {
  return { kind: 'write', path, content }
}
function command(cmd: string): Action {
  return { kind: 'command', command: cmd }
}

const EPISODE: Step[] = [
  {
    title: 'Write the spec (domain language, one wip scenario)',
    action: write(SPEC, SPEC_V1),
    expect: 'allow',
    ai: { language: 'pass' },
  },
  {
    title: 'Spec scenario leaking UI mechanics (click / button / page / table)',
    action: write(SPEC, SPEC_UI_LEAK),
    expect: 'block',
    expectRule: 'enforceAcceptanceLanguage',
    ai: { language: 'violation' },
  },
  {
    title: 'Acceptance test with Covers tag (single new @Test → fast-path)',
    action: write(ACCEPTANCE_TEST, ACCEPTANCE_TEST_V1),
    expect: 'allow',
    expectNote: 'fast-path',
    ai: { language: 'pass' },
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
    title: 'Minimal implementation addressing the observed failure',
    action: write(USECASE, USECASE_V1),
    expect: 'allow',
    ai: { tdd: 'pass', boundary: 'pass' },
  },
  {
    title: 'Domain code importing a vendor HTTP client',
    action: write(
      DOMAIN,
      'package com.example.tracking.domain\n\nimport io.ktor.client.HttpClient\n\nclass Parcel(private val http: HttpClient)\n',
    ),
    expect: 'block',
    expectRule: 'forbidContentPattern',
    ai: { tdd: 'pass' },
  },
  {
    title: 'Domain code reading the OS clock directly',
    action: write(
      DOMAIN,
      'package com.example.tracking.domain\n\nclass Parcel {\n    val registeredAt = System.currentTimeMillis()\n}\n',
    ),
    expect: 'block',
    expectRule: 'forbidNewAmbientEffects',
    ai: { tdd: 'pass' },
  },
  {
    title: 'Test reaching for a mocking library',
    action: write(
      ACCEPTANCE_TEST.replace('AcceptanceTest', 'MockedTest'),
      'package com.example.tracking.acceptance\n\nimport io.mockk.mockk\nimport kotlin.test.Test\n\nclass ParcelTrackingMockedTest {\n    @Test\n    fun \`x\`() { val store = mockk<Any>() }\n}\n',
    ),
    expect: 'block',
    expectRule: 'forbidContentPattern',
    ai: { language: 'pass' },
  },
  {
    title: 'Commit with writes since the last test run',
    action: command('git commit -m "parcel tracking"'),
    expect: 'block',
    expectRule: 'requireCommand',
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

function ruleKind(prompt: string): 'tdd' | 'boundary' | 'language' {
  if (prompt.includes('TDD validator')) return 'tdd'
  if (prompt.includes('architecture-boundary validator')) return 'boundary'
  return 'language'
}

const scriptedAgent: Agent = {
  reason: async (prompt) => {
    const kind = currentStep.ai?.[ruleKind(prompt)] ?? 'pass'
    return { kind, reason: kind === 'violation' ? 'scripted violation' : '' }
  },
}

const liveAgent: Agent = {
  reason: async (prompt) => {
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

// Scoping predicates mirroring probity.config.kmp.ts — keep in sync.
type Block = { applies: (action: Action) => boolean; rules: Rule[] }
const isWriteTo = (action: Action, test: (path: string) => boolean): boolean =>
  action.kind === 'write' && test(action.path)

const BLOCKS: Block[] = [
  {
    applies: (a) => isWriteTo(a, (p) => /\/src\/\w+(Main|Test)\/kotlin\/|\/src\/(main|test)\/kotlin\//.test(p)),
    rules: [withKotlinFastPath(enforceTdd())],
  },
  {
    applies: (a) => isWriteTo(a, (p) => /\/commonMain\/.*\/(domain|port|usecase|presentation)\//.test(p)),
    rules: [
      forbidContentPattern({
        match: KOTLIN_INFRASTRUCTURE_IMPORTS,
        reason: 'Core code imports an infrastructure/vendor package.',
      }),
      forbidNewAmbientEffects({}),
      enforcePortsBoundary({ instructions: (d) => d + KOTLIN_BOUNDARY_ADDENDUM }),
    ],
  },
  {
    applies: (a) => isWriteTo(a, (p) => /\/src\/\w*[Tt]est\/kotlin\//.test(p)),
    rules: [
      forbidContentPattern({
        match: MOCKING_LIBRARY_IMPORTS,
        reason: 'This codebase uses hand-written fakes at ports, no mocking library.',
      }),
    ],
  },
  {
    applies: (a) =>
      isWriteTo(a, (p) => (/docs\/specs\/.*\.feature\.md$/.test(p) || /\/acceptance\//.test(p)) && !p.endsWith('Robot.kt')),
    rules: [enforceAcceptanceLanguage()],
  },
  {
    applies: (a) => isWriteTo(a, (p) => /docs\/specs\/.*\.feature\.md$/.test(p)),
    rules: [surfaceScenarioLinkBreakage({ testRoots: [ROOT] })],
  },
  {
    applies: (a) => a.kind === 'command',
    rules: [
      enforceSpecTestParity({ specsDir: join(ROOT, 'docs/specs'), testRoots: [ROOT] }),
      requireCommand({
        before: { kind: 'command', match: /git commit/ },
        command: GRADLE_TEST_COMMAND,
        after: { kind: 'write' },
        reason: 'Run the test suite after the last change before committing.',
      }),
    ],
  },
]

type Decision =
  | { kind: 'allow'; notes: string }
  | { kind: 'block'; rule: string; reason: string; notes: string }

async function evaluate(action: Action): Promise<Decision> {
  let notes = ''
  for (const block of BLOCKS) {
    if (!block.applies(action)) continue
    for (const rule of block.rules) {
      const result: RuleResult = await rule(rebase(action), ctx)
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
  const ok = outcomeOk && ruleOk && noteOk
  if (!ok) failures++
  const fired = decision.kind === 'block' ? ` [${decision.rule}]` : ''
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(index + 1).padStart(2)}. ${step.title} → ${decision.kind}${fired}`)
  if (!ok && decision.kind === 'block') console.log(`      reason: ${decision.reason.split('\n')[0]}`)
  if (ok && decision.kind === 'allow') record(step)
  // A correctly blocked action is not recorded or materialized — the
  // hook prevented it, exactly as in a real session.
}
console.log(`\n${EPISODE.length - failures}/${EPISODE.length} steps behaved as expected.`)
process.exit(failures === 0 ? 0 : 1)
