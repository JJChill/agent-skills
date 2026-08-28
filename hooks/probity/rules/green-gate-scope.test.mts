// Run: node --experimental-strip-types rules/green-gate-scope.test.mts
//
// The canonical commit-on-green gate (gates.ts requireGreenTestRun) must
// only demand a fresh green test run when the pending commit actually
// touches code the suite validates. Infra/docs/tooling-only commits alter
// no behaviour the suite covers, so the prior green run still stands —
// gating them is a false positive. Scope is decided by the git-staged
// file set (commit-accurate), injected here for hermetic testing.
import { requireGreenTestRun } from './gates.ts'

let passed = 0
let failed = 0
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}`) }
}

const COMMAND = /gradlew?\b.*\btest\b|xcodebuild\b.*\btest\b/
const SUCCESS = /BUILD SUCCESSFUL|"result" : "Passed"/
const FAILURE = /BUILD FAILED|FAILED|"result" : "Failed"/
const CODE_PATHS = /^(?:src|app|App|AcceptanceTests)\//

const commit = { kind: 'command', command: 'git commit -m x' } as const
const greenRun = {
  kind: 'command', command: './gradlew test', output: 'BUILD SUCCESSFUL',
} as const
const write = (path: string) => ({ kind: 'write', path, content: '' }) as const
const ctxWith = (events: readonly unknown[]) => ({ history: async () => events })

async function run() {
  // 1. Infra-only commit, no test run -> pass (skipped).
  {
    const rule = requireGreenTestRun({
      command: COMMAND, successPattern: SUCCESS, failurePattern: FAILURE,
      enforceForPaths: CODE_PATHS,
      listCommitFiles: () => ['.gitlab-ci.yml', 'README.md', 'probity.config.ts'],
    })
    const r = await rule(commit, ctxWith([]))
    check('infra-only commit, no green run -> pass (skipped)', r.kind === 'pass')
  }

  // 2. Code commit, no green run -> violation.
  {
    const rule = requireGreenTestRun({
      command: COMMAND, successPattern: SUCCESS, failurePattern: FAILURE,
      enforceForPaths: CODE_PATHS,
      listCommitFiles: () => ['src/main/App.kt'],
    })
    const r = await rule(commit, ctxWith([]))
    check('code commit, no green run -> violation', r.kind === 'violation')
  }

  // 3. Code commit with a green run after the last write -> pass.
  {
    const rule = requireGreenTestRun({
      command: COMMAND, successPattern: SUCCESS, failurePattern: FAILURE,
      enforceForPaths: CODE_PATHS,
      listCommitFiles: () => ['src/main/App.kt'],
    })
    const r = await rule(commit, ctxWith([write('src/main/App.kt'), greenRun]))
    check('code commit, green run present -> pass', r.kind === 'pass')
  }

  // 4. Mixed infra + code commit is still gated.
  {
    const rule = requireGreenTestRun({
      command: COMMAND, successPattern: SUCCESS, failurePattern: FAILURE,
      enforceForPaths: CODE_PATHS,
      listCommitFiles: () => ['README.md', 'src/main/App.kt'],
    })
    const r = await rule(commit, ctxWith([]))
    check('mixed infra+code commit, no green run -> violation', r.kind === 'violation')
  }

  // 5. Unscoped gate (no enforceForPaths) -> original always-on behaviour.
  {
    const rule = requireGreenTestRun({
      command: COMMAND, successPattern: SUCCESS, failurePattern: FAILURE,
    })
    const r = await rule(commit, ctxWith([]))
    check('unscoped gate, no green run -> violation (unchanged)', r.kind === 'violation')
  }

  // 6. Non-commit command is never gated.
  {
    const rule = requireGreenTestRun({
      command: COMMAND, successPattern: SUCCESS, failurePattern: FAILURE,
      enforceForPaths: CODE_PATHS, listCommitFiles: () => ['src/main/App.kt'],
    })
    const r = await rule({ kind: 'command', command: 'ls' } as const, ctxWith([]))
    check('non-commit command -> pass', r.kind === 'pass')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}
run()
