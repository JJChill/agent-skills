// Run: npx tsx --test rules/gradle-green-gate.test.mts
//
// Regression coverage for the commit-on-green gate's Gradle/Kiro
// defaults (gates.ts requireGreenTestRun, wired through kotlin.ts):
// it accepts any Gradle invocation that actually exercises the test
// suite before a commit — test/*Test*/allTests/jvmTest/build/check,
// piped or chained, or a quiet Kiro run whose structured exit_status
// is provably Gradle's own — and rejects everything else: an explicit
// failure banner, a nonzero/malformed Kiro exit status, unrelated or
// lookalike tasks, flag/value spoofing, and a stale or out-of-order
// recorded run.
//
// This file imports the project's real exported `requireGreenTestRun`
// and `GRADLE_TEST_COMMAND` (no hand-copied regexes) and injects a
// staged-file lister so git state cannot affect the result.
import assert from 'node:assert/strict'
import test from 'node:test'

import { GRADLE_TEST_COMMAND, requireGreenTestRun } from './kotlin.ts'

// `enforceForPaths` is omitted throughout: an unscoped gate always
// demands a fresh green run, so git-staged state can't influence
// whether these assertions hold. `listCommitFiles` is still injected
// (and unused by the rule when unscoped) purely so nothing here ever
// shells out to git.
const listCommitFiles = () => {
  throw new Error('listCommitFiles should not be called when enforceForPaths is unset')
}

function rule() {
  return requireGreenTestRun({ command: GRADLE_TEST_COMMAND, listCommitFiles })
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

async function verdictFor(command: string, output: string) {
  const history = [writeEvent('src/main/App.kt'), commandEvent(command, output)]
  return rule()(commit, ctxWith(history))
}

// ── Accepted verification invocations ───────────────────────────────
const ACCEPTED: Array<[label: string, command: string, output: string]> = [
  ['./gradlew build', './gradlew build', 'BUILD SUCCESSFUL in 4s'],
  ['./gradlew check', './gradlew check', 'BUILD SUCCESSFUL in 6s'],
  ['./gradlew test', './gradlew test', 'BUILD SUCCESSFUL in 4s'],
  ['./gradlew allTests', './gradlew allTests', 'BUILD SUCCESSFUL in 4s'],
  ['./gradlew jvmTest', './gradlew jvmTest', 'BUILD SUCCESSFUL in 4s'],
  ['module-qualified KMP test', './gradlew :desktop:jvmTest', 'BUILD SUCCESSFUL in 4s'],
  ['flavored module-qualified test task', './gradlew :app:testDevDebugUnitTest', 'BUILD SUCCESSFUL in 4s'],
  ['JVM option with shell/path characters before build', './gradlew -Dorg.gradle.java.home=$HOME/.jabba/jdk/temurin@1.17.20/Contents/Home build', 'BUILD SUCCESSFUL in 4s'],
  ['module-qualified build task', './gradlew :sdk:core:build', 'BUILD SUCCESSFUL in 4s'],
  ['module-qualified check task', './gradlew --no-daemon :sdk:core:check', 'BUILD SUCCESSFUL in 4s'],
  ['piped, banner survives the pipe', './gradlew build 2>&1 | grep -E "BUILD|error:"', 'BUILD SUCCESSFUL in 4s'],
  ['compound command, Gradle call last', 'for i in 1 2; do echo "$i"; done; echo ready; ./gradlew build', 'BUILD SUCCESSFUL in 4s'],
  ['quiet run, Kiro exit_status zero', './gradlew test -q', kiroZero],
  ['quiet run, final after a preceding chain', 'echo starting; ./gradlew test -q', kiroZero],
  ['quiet run, only trailing redirects', './gradlew test -q > build.log 2>&1', kiroZero],
  ['quiet run, trailing semicolon', './gradlew test -q;', kiroZero],
  ['quiet run, trailing newline', './gradlew test -q\n', kiroZero],
  ['piped quiet run, own success banner', './gradlew test -q 2>&1 | tee build.log', 'BUILD SUCCESSFUL in 4s'],
]

test('accepts every genuine Gradle verification invocation', async () => {
  for (const [label, command, output] of ACCEPTED) {
    const result = await verdictFor(command, output)
    assert.equal(result.kind, 'pass', `expected pass: ${label}`)
  }
})

// ── Rejected: unrelated/lookalike tasks, flag spoofing, malformed or
//    stale evidence, and the "last command must itself verify" rule ─
const REJECTED: Array<[label: string, command: string, output: string]> = [
  ['unrelated task: assemble', './gradlew assemble', 'BUILD SUCCESSFUL in 3s'],
  ['unrelated task: prebuild', './gradlew prebuild', 'BUILD SUCCESSFUL in 3s'],
  ['unrelated task: rebuild', './gradlew rebuild', 'BUILD SUCCESSFUL in 3s'],
  ['lookalike: assembleAndroidTest (assembles a test APK, runs nothing)', './gradlew assembleAndroidTest', 'BUILD SUCCESSFUL in 4s'],
  ['lookalike: compileTestKotlin (compiles test sources, runs nothing)', './gradlew compileTestKotlin', 'BUILD SUCCESSFUL in 4s'],
  ['lookalike: testClasses (assembles test classes, runs nothing)', './gradlew testClasses', 'BUILD SUCCESSFUL in 4s'],
  ['lookalike: testFixtures (a source-set task, runs nothing)', './gradlew testFixtures', 'BUILD SUCCESSFUL in 4s'],
  ['flag value spoofs a task: --args=build', './gradlew run --args=build', 'BUILD SUCCESSFUL in 2s'],
  ['flag value spoofs a task: --args build', './gradlew run --args build', 'BUILD SUCCESSFUL in 2s'],
  ['--dry-run alongside a real task', './gradlew build --dry-run', 'BUILD SUCCESSFUL in 1s'],
  ['-x exclude-task alongside a real task', './gradlew build -x test', 'BUILD SUCCESSFUL in 3s'],
  ['compact -x exclude-task alongside a real task', './gradlew build -xtest', 'BUILD SUCCESSFUL in 3s'],
  ['--exclude-task= alongside a real task', './gradlew build --exclude-task=test', 'BUILD SUCCESSFUL in 3s'],
  ['explicit BUILD FAILED overrides a claimed-zero Kiro exit_status', './gradlew build', JSON.stringify({ exit_status: 'exit status: 0', stdout: 'BUILD FAILED in 2s', stderr: '' })],
  ['nonzero Kiro exit_status overrides a success banner', './gradlew test -q', JSON.stringify({ exit_status: 'exit status: 1', stdout: 'BUILD SUCCESSFUL in 4s', stderr: '' })],
  ['quiet run piped: exit_status belongs to the pipe target', './gradlew test -q | grep -i fail', kiroZero],
  ['quiet run chained with || true: exit_status belongs to that fallback', './gradlew test -q || true', kiroZero],
  ['quiet run with a trailing command: exit_status belongs to it', './gradlew test -q; echo done', kiroZero],
  ['last simple command only mentions gradlew', './gradlew test; echo gradlew', kiroZero],
  ['last Gradle command does not verify', './gradlew test; ./gradlew help', kiroZero],
  ['redirect target named build is not a task', './gradlew help > build', 'BUILD SUCCESSFUL in 1s'],
  ['malformed JSON envelope, even with a claimed exit_status substring', './gradlew test -q', '{"exit_status": "exit status: 0", not valid json'],
  ['well-formed JSON array, not the canonical object envelope', './gradlew test -q', '["exit_status", "exit status: 0"]'],
  ['envelope exit_status field is not a string', './gradlew test -q', JSON.stringify({ exit_status: 0, stdout: '', stderr: '' })],
  ['envelope missing exit_status entirely', './gradlew test -q', JSON.stringify({ stdout: '', stderr: '' })],
  ['incomplete envelope with status and banner but no stdout/stderr', './gradlew test -q', JSON.stringify({ exit_status: 'exit status: 0', message: 'BUILD SUCCESSFUL in 1s' })],
  ['script/dependency-resolution failure reported only as "FAILURE:"', './gradlew build', 'FAILURE: Build failed with an exception.\n* What went wrong:\nCould not resolve dependencies.'],
  ['task failure reported as "Execution failed for task"', './gradlew build', "Execution failed for task ':sdk:core:test'.\n> There were failing tests."],
]

test('rejects every non-verifying or misleading invocation', async () => {
  for (const [label, command, output] of REJECTED) {
    const result = await verdictFor(command, output)
    assert.equal(result.kind, 'violation', `expected violation: ${label}`)
  }
})

test('help/inspection commands do not spoof a task via --task <name>', async () => {
  // `--task` takes a value, so `build` here is a flag's value, not a
  // positional task; `help` alone doesn't verify anything.
  const result = await verdictFor('./gradlew help --task build', 'BUILD SUCCESSFUL in 1s')
  assert.equal(result.kind, 'violation')
})

test('malformed envelope stays red even alongside a success-banner substring inside it', async () => {
  const result = await verdictFor(
    './gradlew test -q',
    '{"exit_status": "exit status: 0", "stdout": "BUILD SUCCESSFUL in 4s", not valid json',
  )
  assert.equal(result.kind, 'violation')
})

// ── History ordering ────────────────────────────────────────────────

test('rejects a green run recorded before the last write', async () => {
  const history = [
    commandEvent('./gradlew build', 'BUILD SUCCESSFUL in 4s'),
    writeEvent('src/main/App.kt'),
  ]
  const result = await rule()(commit, ctxWith(history))
  assert.equal(result.kind, 'violation')
})

test('requires the latest matching run after the write to be green, not just any run', async () => {
  const history = [
    writeEvent('src/main/App.kt'),
    commandEvent('./gradlew build', 'BUILD SUCCESSFUL in 4s'),
    commandEvent('./gradlew build', 'BUILD FAILED in 1s'),
  ]
  const result = await rule()(commit, ctxWith(history))
  assert.equal(result.kind, 'violation')
})

test('no recorded run at all names the accepted forms in the deny text', async () => {
  const history = [writeEvent('src/main/App.kt')]
  const result = await rule()(commit, ctxWith(history))
  assert.equal(result.kind, 'violation')
  if (result.kind === 'violation') {
    assert.match(result.reason, /Run the test suite after the last change/)
    assert.match(result.reason, /test\/test\.\.\.Test, build, or check/)
  }
})

test('explains accepted Gradle tasks and quiet-run evidence when output is inconclusive', async () => {
  const result = await verdictFor('./gradlew test -q', '')
  assert.equal(result.kind, 'violation')
  if (result.kind === 'violation') {
    assert.match(result.reason, /test\/test\.\.\.Test, build, or check/)
    assert.match(result.reason, /zero exit_status/)
    assert.match(result.reason, /BUILD SUCCESSFUL/)
  }
})

// ── Override semantics: a caller's own patterns replace the Gradle
//    defaults; the Kotlin/Kiro command predicate and extra-success/
//    failure signals apply ONLY to the exact exported command ──────

test('a custom successPattern replaces the default banner text entirely', async () => {
  const custom = requireGreenTestRun({
    command: GRADLE_TEST_COMMAND,
    successPattern: /ALL GREEN/,
    listCommitFiles,
  })
  const history = [
    writeEvent('src/main/App.kt'),
    commandEvent('./gradlew build', 'BUILD SUCCESSFUL in 4s'),
  ]
  const result = await custom(commit, ctxWith(history))
  assert.equal(result.kind, 'violation') // default banner no longer counts
  const passing = await custom(
    commit,
    ctxWith([writeEvent('src/main/App.kt'), commandEvent('./gradlew build', 'ALL GREEN')]),
  )
  assert.equal(passing.kind, 'pass')
})

test('a custom failurePattern replaces the default failure text entirely', async () => {
  const custom = requireGreenTestRun({
    command: GRADLE_TEST_COMMAND,
    failurePattern: /RED ALERT/,
    listCommitFiles,
  })
  const history = [
    writeEvent('src/main/App.kt'),
    // Red under the default failurePattern (FAILURE:), but the caller
    // replaced it, so this now needs the caller's own text.
    commandEvent('./gradlew build', 'BUILD SUCCESSFUL in 4s\nFAILURE: minor'),
  ]
  const result = await custom(commit, ctxWith(history))
  assert.equal(result.kind, 'pass')
})

test('a custom reason replaces the default Gradle reason text', async () => {
  const custom = requireGreenTestRun({
    command: GRADLE_TEST_COMMAND,
    reason: 'Run: make verify',
    listCommitFiles,
  })
  const result = await custom(commit, ctxWith([writeEvent('src/main/App.kt')]))
  assert.equal(result.kind, 'violation')
  if (result.kind === 'violation') {
    assert.match(result.reason, /Run: make verify/)
    assert.doesNotMatch(result.reason, /Gradle verification tasks/)
  }
})

test('a custom command regex gets no Kotlin/Kiro defaults, even with a well-formed Kiro zero-exit envelope', async () => {
  const custom = requireGreenTestRun({
    command: /my-test-runner/,
    successPattern: /ALL PASSED/,
    failurePattern: /SOME FAILED/,
    listCommitFiles,
  })
  const history = [
    writeEvent('src/main/App.kt'),
    commandEvent('my-test-runner --suite all', kiroZero),
  ]
  const result = await custom(commit, ctxWith(history))
  assert.equal(result.kind, 'violation')
  if (result.kind === 'violation') assert.doesNotMatch(result.reason, /Gradle/)
})

test('caller-supplied patterns plus a quiet passing Gradle run still stay red without the custom evidence', async () => {
  // A caller who overrides BOTH successPattern and failurePattern gets
  // no Gradle default at all — a quiet, genuinely green Kiro run with
  // no matching custom text must not slip through some other allowance.
  const custom = requireGreenTestRun({
    command: GRADLE_TEST_COMMAND,
    successPattern: /ALL GREEN/,
    failurePattern: /RED ALERT/,
    listCommitFiles,
  })
  const result = await custom(
    commit,
    ctxWith([writeEvent('src/main/App.kt'), commandEvent('./gradlew test -q', kiroZero)]),
  )
  assert.equal(result.kind, 'violation')
})
