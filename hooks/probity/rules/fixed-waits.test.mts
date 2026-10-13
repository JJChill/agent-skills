// Coverage for issue #119 (item 1): a fixed-wait screen on acceptance
// paths for Kotlin/KMP and JS/TS, matching the Swift preset's. Fixed
// sleeps postpone a race instead of fixing it; drivers wait for the
// concluding event through one poll-with-timeout helper.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Rule, RuleBlock, RuleContext, RuleEntry } from '@nizos/probity'

import { forbidNewFixedWaits, JS_FIXED_WAIT_PATTERNS } from './gates.ts'
import { KOTLIN_FIXED_WAIT_PATTERNS } from './kotlin.ts'
import { anchorGlob, buildMatcher, isRuleBlock } from './scoping.ts'
import { jsRuleEntries } from '../presets/js.ts'
import { kmpRuleEntries } from '../presets/kmp.ts'
import { kotlinRuleEntries } from '../presets/kotlin.ts'

function ctxWith(before?: string): RuleContext {
  return {
    readFile: async () =>
      before === undefined ? { kind: 'absent' } : { kind: 'present', content: before },
  }
}

function write(path: string, content: string) {
  return { kind: 'write' as const, path, content }
}

const kotlinRule = forbidNewFixedWaits({ patterns: KOTLIN_FIXED_WAIT_PATTERNS })
const jsRule = forbidNewFixedWaits({ patterns: JS_FIXED_WAIT_PATTERNS })

// ── The rule ───────────────────────────────────────────────────────

for (const call of [
  'Thread.sleep(500)',
  'TimeUnit.SECONDS.sleep(1)',
  'delay(250)',
  'kotlinx.coroutines.delay(10)',
  'SystemClock.sleep(100)',
]) {
  test(`Kotlin: a new ${call} on an acceptance path is denied`, async () => {
    const result = await kotlinRule(
      write('/repo/app/src/test/kotlin/acceptance/CheckoutRobot.kt', `fun placeOrder() {\n  ${call}\n}\n`),
      ctxWith(''),
    )
    assert.equal(result.kind, 'violation')
  })
}

for (const call of [
  'await page.waitForTimeout(1000)',
  'await new Promise((r) => setTimeout(r, 200))',
  'cy.wait(500)',
  'await sleep(100)',
  'await browser.pause(300)',
]) {
  test(`JS: a new ${call} on an acceptance path is denied`, async () => {
    const result = await jsRule(
      write('/repo/acceptance/drivers/web.ts', `export async function placeOrder() {\n  ${call}\n}\n`),
      ctxWith(''),
    )
    assert.equal(result.kind, 'violation')
  })
}

test('the deny names the wait and points at a poll-for-concluding-event helper', async () => {
  const result = await kotlinRule(
    write('/repo/acceptance/CheckoutRobot.kt', 'fun f() { Thread.sleep(500) }\n'),
    ctxWith(''),
  )
  assert.equal(result.kind, 'violation')
  const reason = (result as { reason: string }).reason
  assert.match(reason, /Thread\.sleep/)
  assert.match(reason, /concluding event/)
  assert.match(reason, /poll/)
})

test('an existing wait does not block an unrelated edit to its file (delta-based)', async () => {
  const before = 'fun f() { Thread.sleep(500) }\n'
  const result = await kotlinRule(
    write('/repo/acceptance/CheckoutRobot.kt', before + 'fun g() = 1\n'),
    ctxWith(before),
  )
  assert.equal(result.kind, 'pass')
})

test('a second wait in a file that already has one is denied', async () => {
  const before = 'fun f() { Thread.sleep(500) }\n'
  const result = await kotlinRule(
    write('/repo/acceptance/CheckoutRobot.kt', before + 'fun g() { Thread.sleep(100) }\n'),
    ctxWith(before),
  )
  assert.equal(result.kind, 'violation')
})

test('a wait named only in a comment does not count', async () => {
  const content =
    '// the ticker is a recurring `delay(1000)` loop\n' +
    '/* never Thread.sleep(500) here */\n' +
    '/**\n * unlike setTimeout(r, 10), this awaits the event\n */\n' +
    'fun f() = 1\n'
  assert.equal((await kotlinRule(write('/repo/acceptance/A.kt', content), ctxWith(''))).kind, 'pass')
  assert.equal((await jsRule(write('/repo/acceptance/a.ts', content), ctxWith(''))).kind, 'pass')
})

test('names that merely contain a wait word are not waits', async () => {
  const content =
    'val retryDelay = 3\n' +
    'fun scheduleDelay(x: Int) = x\n' +
    'fun sleepModeShown() = true\n' +
    'clearTimeout(handle)\n'
  assert.equal((await kotlinRule(write('/repo/acceptance/A.kt', content), ctxWith(''))).kind, 'pass')
  assert.equal((await jsRule(write('/repo/acceptance/a.ts', content), ctxWith(''))).kind, 'pass')
})

test('non-write actions pass', async () => {
  const result = await kotlinRule({ kind: 'command', command: 'sleep 1' } as never, ctxWith(''))
  assert.equal(result.kind, 'pass')
})

// ── Preset wiring ──────────────────────────────────────────────────

function fixedWaitBlock(entries: readonly RuleEntry[]): RuleBlock | undefined {
  return entries.find(
    (entry): entry is RuleBlock =>
      isRuleBlock(entry) && !!entry.rules?.some((rule: Rule) => rule.name === 'forbidNewFixedWaits'),
  )
}

function scopedTo(entries: readonly RuleEntry[], root: string, path: string): boolean {
  const block = fixedWaitBlock(entries)
  assert.ok(block?.files, 'a fixed-wait block should be wired')
  return buildMatcher(block!.files!.map((g) => anchorGlob(g, root)))(path)
}

async function denies(entries: readonly RuleEntry[], path: string, content: string): Promise<boolean> {
  const rule = fixedWaitBlock(entries)!.rules!.find((r: Rule) => r.name === 'forbidNewFixedWaits')!
  return (await rule(write(path, content), ctxWith(''))).kind === 'violation'
}

const presets: Array<[string, (opts?: { fixedWaitGlobs?: string[] }) => RuleEntry[], string, string, string]> = [
  [
    'kmpRuleEntries',
    (opts) => kmpRuleEntries('/repo', opts),
    '/repo/feature/checkout/src/commonTest/kotlin/acceptance/CheckoutRobot.kt',
    'fun f() { delay(100) }\n',
    '/repo/feature/checkout/src/commonMain/kotlin/Checkout.kt',
  ],
  [
    'kotlinRuleEntries',
    (opts) => kotlinRuleEntries('/repo', opts),
    '/repo/app/src/test/kotlin/acceptance/drivers/ApiDriver.kt',
    'fun f() { Thread.sleep(100) }\n',
    '/repo/app/src/test/kotlin/CheckoutTest.kt',
  ],
  [
    'jsRuleEntries',
    (opts) => jsRuleEntries(opts),
    `${process.cwd()}/acceptance/dsl/checkout.ts`,
    'await page.waitForTimeout(100)\n',
    `${process.cwd()}/src/core/checkout.ts`,
  ],
]

for (const [label, build, acceptancePath, waitContent, otherPath] of presets) {
  const root = label === 'jsRuleEntries' ? process.cwd() : '/repo'

  test(`${label}: the fixed-wait screen covers acceptance code (DSL and drivers too)`, async () => {
    const entries = build()
    assert.ok(scopedTo(entries, root, acceptancePath))
    assert.ok(await denies(entries, acceptancePath, waitContent))
  })

  test(`${label}: the fixed-wait screen leaves non-acceptance code alone`, () => {
    assert.equal(scopedTo(build(), root, otherPath), false)
  })

  test(`${label}: fixedWaitGlobs can exempt the project's poll helper`, () => {
    const entries = build({ fixedWaitGlobs: ['**/acceptance/**', '!**/acceptance/support/Eventually.*'] })
    const helper = acceptancePath.replace(/[^/]+$/, '').replace(/acceptance\/.*$/, 'acceptance/support/Eventually.kt')
    assert.equal(scopedTo(entries, root, helper), false)
    assert.ok(scopedTo(entries, root, acceptancePath))
  })

  test(`${label}: fixedWaitGlobs: [] turns the screen off`, () => {
    assert.equal(fixedWaitBlock(build({ fixedWaitGlobs: [] })), undefined)
  })
}
