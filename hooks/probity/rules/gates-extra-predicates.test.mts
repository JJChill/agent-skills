// Run: npx tsx --test rules/gates-extra-predicates.test.mts
//
// Unit coverage for the language-neutral extension to
// gates.ts requireGreenTestRun added to support the Kotlin/Gradle
// green-gate remediation (kotlin.ts): `commandPredicate` narrows which
// regex-matched commands count as a run, and `extraSuccessPredicate`/
// `extraFailurePredicate` add command-aware signals alongside
// `successPattern`/`failurePattern`, without disturbing existing
// regex-only behavior when the new options are omitted.
import assert from 'node:assert/strict'
import test from 'node:test'

import { requireGreenTestRun } from './gates.ts'

const commit = { kind: 'command' as const, command: 'git commit -m x' }

function commandEvent(command: string, output: string) {
  return { kind: 'command' as const, command, output }
}

function writeEvent(path: string) {
  return { kind: 'write' as const, path, content: '' }
}

function ctxWith(events: readonly unknown[]) {
  return { history: async () => events as never }
}

test('regex-only behavior is unchanged when no extra options are passed', async () => {
  const rule = requireGreenTestRun({
    command: /run-tests/,
    successPattern: /ALL PASSED/,
    failurePattern: /SOME FAILED/,
  })
  const history = [
    writeEvent('src/App.ts'),
    commandEvent('run-tests', 'ALL PASSED'),
  ]
  const result = await rule(commit, ctxWith(history))
  assert.equal(result.kind, 'pass')
})

test('commandPredicate narrows a regex match without widening it', async () => {
  const rule = requireGreenTestRun({
    command: /run-tests/,
    commandPredicate: (command) => command.includes('--strict'),
    successPattern: /ALL PASSED/,
    failurePattern: /SOME FAILED/,
  })
  const history = [
    writeEvent('src/App.ts'),
    commandEvent('run-tests', 'ALL PASSED'), // matches regex, fails predicate
  ]
  const result = await rule(commit, ctxWith(history))
  assert.equal(result.kind, 'violation')
})

test('commandPredicate lets a regex match through when it also passes', async () => {
  const rule = requireGreenTestRun({
    command: /run-tests/,
    commandPredicate: (command) => command.includes('--strict'),
    successPattern: /ALL PASSED/,
    failurePattern: /SOME FAILED/,
  })
  const history = [
    writeEvent('src/App.ts'),
    commandEvent('run-tests --strict', 'ALL PASSED'),
  ]
  const result = await rule(commit, ctxWith(history))
  assert.equal(result.kind, 'pass')
})

test('extraSuccessPredicate adds a way to count as green beyond successPattern', async () => {
  const rule = requireGreenTestRun({
    command: /run-tests/,
    successPattern: /ALL PASSED/,
    extraSuccessPredicate: (_command, output) => output.includes('"code":0'),
    failurePattern: /SOME FAILED/,
  })
  const history = [
    writeEvent('src/App.ts'),
    commandEvent('run-tests --json', '{"code":0}'),
  ]
  const result = await rule(commit, ctxWith(history))
  assert.equal(result.kind, 'pass')
})

test('failurePattern still wins over extraSuccessPredicate', async () => {
  const rule = requireGreenTestRun({
    command: /run-tests/,
    successPattern: /ALL PASSED/,
    extraSuccessPredicate: (_command, output) => output.includes('"code":0'),
    failurePattern: /SOME FAILED/,
  })
  const history = [
    writeEvent('src/App.ts'),
    commandEvent('run-tests --json', '{"code":0} SOME FAILED'),
  ]
  const result = await rule(commit, ctxWith(history))
  assert.equal(result.kind, 'violation')
})

test('extraFailurePredicate marks a run red even without failurePattern text', async () => {
  const rule = requireGreenTestRun({
    command: /run-tests/,
    successPattern: /ALL PASSED/,
    failurePattern: /SOME FAILED/,
    extraFailurePredicate: (_command, output) => output.includes('"code":1'),
  })
  const history = [
    writeEvent('src/App.ts'),
    commandEvent('run-tests --json', 'ALL PASSED {"code":1}'),
  ]
  const result = await rule(commit, ctxWith(history))
  assert.equal(result.kind, 'violation')
})

test('extraFailurePredicate receives the matched command text', async () => {
  const seenCommands: string[] = []
  const rule = requireGreenTestRun({
    command: /run-tests/,
    successPattern: /ALL PASSED/,
    failurePattern: /SOME FAILED/,
    extraFailurePredicate: (command) => {
      seenCommands.push(command)
      return false
    },
  })
  const history = [
    writeEvent('src/App.ts'),
    commandEvent('run-tests --json', 'ALL PASSED'),
  ]
  await rule(commit, ctxWith(history))
  assert.deepEqual(seenCommands, ['run-tests --json'])
})
