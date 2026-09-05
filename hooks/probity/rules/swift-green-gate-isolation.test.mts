// Run: npx tsx --test rules/swift-green-gate-isolation.test.mts
//
// Regression coverage for preset isolation: the Kotlin re-export of
// requireGreenTestRun (kotlin.ts) must apply its Gradle-specific
// defaults — the default reason text, the Kotlin command predicate,
// and the Kiro exit-status extra-success/failure signals — ONLY when
// the caller's `command` is referentially the exported
// GRADLE_TEST_COMMAND, never merely because other options were left
// unset. The Swift preset calls this same wrapper with its own
// `command`/`successPattern`/`failurePattern` (XCODEBUILD_TEST_COMMAND
// / XCODEBUILD_TEST_SUCCEEDED / XCODEBUILD_TEST_FAILED) and no
// `reason`; this file proves it gets none of the Gradle/Kiro defaults.
import assert from 'node:assert/strict'
import test from 'node:test'

import { requireGreenTestRun } from './kotlin.ts'
import {
  XCODEBUILD_TEST_COMMAND,
  XCODEBUILD_TEST_FAILED,
  XCODEBUILD_TEST_SUCCEEDED,
} from './swift.ts'

const listCommitFiles = () => {
  throw new Error('listCommitFiles should not be called when enforceForPaths is unset')
}

function swiftRule() {
  return requireGreenTestRun({
    command: XCODEBUILD_TEST_COMMAND,
    successPattern: XCODEBUILD_TEST_SUCCEEDED,
    failurePattern: XCODEBUILD_TEST_FAILED,
    listCommitFiles,
  })
}

const commit = { kind: 'command' as const, command: 'git commit -m x' }
const kiroZero = JSON.stringify({ exit_status: 'exit status: 0', stdout: '', stderr: '' })

function commandEvent(command: string, output: string) {
  return { kind: 'command' as const, command, output }
}

function writeEvent(path: string) {
  return { kind: 'write' as const, path, content: '' }
}

function ctxWith(events: readonly unknown[]) {
  return { history: async () => events as never }
}

async function verdictFor(command: string | null, output?: string) {
  const history = command
    ? [writeEvent('App/Foo.swift'), commandEvent(command, output ?? '')]
    : [writeEvent('App/Foo.swift')]
  return swiftRule()(commit, ctxWith(history))
}

const PASSING: Array<[label: string, command: string, output: string]> = [
  ['own TEST SUCCEEDED banner', 'xcodebuild test', '** TEST SUCCEEDED **'],
  ['xcresulttool "Passed" summary', 'xcrun xcresulttool get test-results summary', '"result" : "Passed"'],
]

test('the Swift preset still passes normally on its own success evidence', async () => {
  for (const [label, command, output] of PASSING) {
    const result = await verdictFor(command, output)
    assert.equal(result.kind, 'pass', `expected pass: ${label}`)
  }
})

const RED_WITH_NO_GRADLE_LEAKAGE: Array<[label: string, command: string | null, output?: string]> = [
  ['no run recorded', null],
  ['an explicit TEST FAILED', 'xcodebuild test', '** TEST FAILED **'],
  ['a quiet run with a Kiro zero exit_status but no verdict banner — no Gradle-only Kiro shortcut on Swift', 'xcodebuild test -quiet', kiroZero],
  ['Swift patterns plus a quiet Kiro zero exit_status: still red without the xcodebuild banner', 'xcodebuild test -quiet', kiroZero],
]

test('every Swift denial is red and carries no Gradle-specific reason text', async () => {
  for (const [label, command, output] of RED_WITH_NO_GRADLE_LEAKAGE) {
    const result = await verdictFor(command, output)
    assert.equal(result.kind, 'violation', `expected violation: ${label}`)
    if (result.kind === 'violation') {
      assert.doesNotMatch(result.reason, /Gradle/i, `unexpected Gradle text: ${label}`)
      assert.doesNotMatch(result.reason, /BUILD SUCCESSFUL/, `unexpected Gradle banner text: ${label}`)
    }
  }
})

test('a caller-supplied reason on a non-Gradle command is honored as-is', async () => {
  const rule = requireGreenTestRun({
    command: XCODEBUILD_TEST_COMMAND,
    successPattern: XCODEBUILD_TEST_SUCCEEDED,
    failurePattern: XCODEBUILD_TEST_FAILED,
    reason: 'Run: xcodebuild test -quiet, then xcresulttool get test-results summary.',
    listCommitFiles,
  })
  const result = await rule(commit, ctxWith([writeEvent('App/Foo.swift')]))
  assert.equal(result.kind, 'violation')
  if (result.kind === 'violation') {
    assert.match(result.reason, /xcresulttool get test-results summary/)
    assert.doesNotMatch(result.reason, /Gradle/i)
  }
})
