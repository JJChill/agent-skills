// Issue #70: the Kotlin TDD judge blocked moving existing code into a new
// file under green (a commonMain composition function, and a JVM class
// implementing the extracted interface). The judge sees each session event
// clipped to 6,000 characters, head and tail, so the middle of a 27 KB
// source file it was moved from was invisible, and the original still being
// on disk read as "a parallel new entry point". withExtractionUnderGreen
// gives a separate judge the full, current on-disk sources the session read
// or edited, and passes a new file whose logic is all already there.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Action, Rule, RuleContext } from '@nizos/probity'

type SessionEvent = Awaited<ReturnType<NonNullable<RuleContext['history']>>>[number]

import { withExtractionUnderGreen } from './gates.ts'

const SOURCE = '/repo/sdk/src/jvmMain/kotlin/app/ClientJvm.kt'
const TARGET = '/repo/sdk/src/commonMain/kotlin/app/ClientComposition.kt'
const TEST_FILE = '/repo/sdk/src/jvmTest/kotlin/app/ClientJvmTest.kt'
const MIDDLE = 'val archive = if (useVault) VaultArchive(store) else FileArchive(dir)'
const sourceText = ['fun createJvmClient() {', ...Array.from({ length: 400 }, (_, i) => `  val x${i} = ${i}`), `  ${MIDDLE}`, '}'].join('\n')

const green: SessionEvent = { kind: 'command', command: './gradlew build', output: 'BUILD SUCCESSFUL in 41s' }
const red: SessionEvent = { kind: 'command', command: './gradlew build', output: 'ClientJvmTest > x FAILED\nBUILD FAILED' }
const read = (path: string): SessionEvent => ({ kind: 'other', tool: 'Read', input: { file_path: path }, output: '(clipped)' })

function setup(opts: {
  history?: SessionEvent[]
  disk?: Record<string, string>
  verdict?: 'pass' | 'violation'
  reason?: string
  target?: string
} = {}) {
  const prompts: string[] = []
  let wrappedCalls = 0
  const wrapped: Rule = async function enforceKotlinTdd() {
    wrappedCalls++
    return { kind: 'violation', reason: 'net-new logic without a failing test' }
  }
  const disk = opts.disk ?? { [SOURCE]: sourceText }
  const ctx = {
    history: async () => opts.history ?? [green, read(SOURCE)],
    readFile: async (path: string) =>
      path in disk ? { kind: 'present', content: disk[path] } : { kind: 'absent' },
    agent: {
      reason: async (prompt: string) => {
        prompts.push(prompt)
        return { kind: opts.verdict ?? 'pass', reason: opts.reason ?? 'every function appears in ClientJvm.kt' }
      },
    },
  } as unknown as RuleContext
  const rule = withExtractionUnderGreen(wrapped, {
    command: /gradlew/,
    successPattern: /BUILD SUCCESSFUL/,
    failurePattern: /BUILD FAILED|FAILED/,
    productionPattern: /[/\\]src[/\\]\w*Main[/\\]/,
    testPattern: /[/\\]src[/\\]\w*Test[/\\]/,
  })
  const action: Action = { kind: 'write', path: opts.target ?? TARGET, content: `fun composeClient() {\n  ${MIDDLE}\n}\n` }
  return { rule, ctx, action, prompts, wrapped: () => wrappedCalls }
}

test('a new production file under green is judged against the full on-disk source', async () => {
  const s = setup()
  const result = await s.rule(s.action, s.ctx)
  assert.equal(result.kind, 'pass')
  assert.deepEqual(result.kind === 'pass' ? result.notes : undefined, [{ kind: 'extraction-under-green' }])
  assert.equal(s.wrapped(), 0)
  assert.equal(s.prompts.length, 1)
  // The line from the middle of the source, which the TDD judge's clipped
  // history never shows, is in the extraction prompt; so is the pending file.
  assert.ok(s.prompts[0]!.includes(MIDDLE))
  assert.ok(s.prompts[0]!.includes(`  val x200 = 200`))
  assert.ok(s.prompts[0]!.includes(SOURCE))
  assert.ok(s.prompts[0]!.includes('fun composeClient()'))
})

test('when the extraction judge is unsure, the TDD judge decides', async () => {
  const s = setup({ verdict: 'violation', reason: 'Could not match the retry loop to a shown source.\nFinding: unsure' })
  const result = await s.rule(s.action, s.ctx)
  assert.equal(s.prompts.length, 1)
  assert.equal(s.wrapped(), 1)
  assert.equal(result.kind, 'violation')
  assert.match(result.kind === 'violation' ? result.reason : '', /net-new logic/)
})

test('no extraction judge when the file exists, the run is red, or nothing was run', async () => {
  for (const [name, opts] of [
    ['file exists', { disk: { [SOURCE]: sourceText, [TARGET]: 'fun composeClient() {}' } }],
    ['last run red', { history: [green, read(SOURCE), red] }],
    ['no run', { history: [read(SOURCE)] }],
  ] as const) {
    const s = setup(opts as Parameters<typeof setup>[0])
    await s.rule(s.action, s.ctx)
    assert.equal(s.prompts.length, 0, name)
    assert.equal(s.wrapped(), 1, name)
  }
})

test('no extraction judge for test files, or with no production source read in the session', async () => {
  for (const [name, opts] of [
    ['target is a test', { target: TEST_FILE }],
    ['nothing read', { history: [green] }],
    ['only a test read', { history: [green, read(TEST_FILE)], disk: { [TEST_FILE]: sourceText } }],
    ['source gone from disk', { disk: {} }],
  ] as const) {
    const s = setup(opts as Parameters<typeof setup>[0])
    await s.rule(s.action, s.ctx)
    assert.equal(s.prompts.length, 0, name)
    assert.equal(s.wrapped(), 1, name)
  }
})

test('a green run after an earlier red still counts as green', async () => {
  const s = setup({ history: [red, read(SOURCE), green] })
  const result = await s.rule(s.action, s.ctx)
  assert.equal(result.kind, 'pass')
})

// The gap #71's replay found: a move with one new behavior spliced in was
// recognized by the extraction judge, then let through by the TDD judge,
// which can't see the full source either. Under green there is no failing
// test to justify new behavior, so a confident "Finding: new behavior" blocks.
test('new behavior the extraction judge names is blocked, not handed to the TDD judge', async () => {
  const s = setup({ verdict: 'violation', reason: 'Most of it is moved. composeClient now rejects an http:// legacyServiceUrl; no source checks the scheme.\nFinding: new behavior' })
  const result = await s.rule(s.action, s.ctx)
  assert.equal(s.wrapped(), 0)
  assert.equal(result.kind, 'violation')
  const reason = result.kind === 'violation' ? result.reason : ''
  assert.match(reason, /rejects an http:\/\/ legacyServiceUrl/)
  assert.match(reason, /failing test/)
  assert.doesNotMatch(reason, /Finding:/)
})

test('the extraction prompt asks for a final Finding line', async () => {
  const s = setup()
  await s.rule(s.action, s.ctx)
  for (const finding of ['move', 'new behavior', 'unsure']) {
    assert.ok(s.prompts[0]!.includes(`"Finding: ${finding}"`), finding)
  }
})

// Issue #94: a compile red from a KMP target test task (iosSimulatorArm64Test)
// was not a matching run, so the wrapper saw an older green build, judged the
// TODO() stub the red authorised as a "move", and sometimes blocked it.
test('with the Kotlin green-run options, a red iosSimulatorArm64Test run leaves a new file to the TDD judge', async () => {
  const { kotlinGreenRunOptions, KOTLIN_PRODUCTION_SOURCE_PATTERN, KOTLIN_TEST_SOURCE_PATTERN } = await import('./kotlin.ts')
  let wrappedCalls = 0
  let judged = 0
  const wrapped: Rule = async function enforceKotlinTdd() {
    wrappedCalls++
    return { kind: 'pass' }
  }
  const compileRed: SessionEvent = {
    kind: 'command',
    command: './gradlew :harness:ios-framework:iosSimulatorArm64Test -Pmysudo.targets.native=true 2>&1 | grep -E "^e:|BUILD|FAILED" | head -5',
    output: "> Task :harness:ios-framework:compileTestKotlinIosSimulatorArm64 FAILED\ne: HarnessChecksTest.kt:15:24 Unresolved reference 'HarnessChecks'.\nBUILD FAILED in 6s",
  }
  const ctx = {
    history: async () => [green, read(SOURCE), compileRed],
    readFile: async (path: string) =>
      path === SOURCE
        ? { kind: 'present', content: 'class IosKeychainSecretBackend(private val accessGroup: String?) : SecretBackend' }
        : { kind: 'absent' },
    agent: { reason: async () => { judged++; return { kind: 'violation', reason: 'new entry point. Finding: new behavior' } } },
  } as unknown as RuleContext
  const rule = withExtractionUnderGreen(wrapped, {
    ...kotlinGreenRunOptions(),
    productionPattern: KOTLIN_PRODUCTION_SOURCE_PATTERN,
    testPattern: KOTLIN_TEST_SOURCE_PATTERN,
  })
  const stub: Action = {
    kind: 'write',
    path: '/repo/harness/ios/framework/src/iosMain/kotlin/harness/HarnessChecks.kt',
    content: 'object HarnessChecks {\n    fun secretBackend(accessGroup: String?): List<String> = TODO()\n}\n',
  }
  const result = await rule(stub, ctx)
  assert.equal(result.kind, 'pass')
  assert.equal(judged, 0, 'the extraction judge is not asked')
  assert.equal(wrappedCalls, 1)
})
