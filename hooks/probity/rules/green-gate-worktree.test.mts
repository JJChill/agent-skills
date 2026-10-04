// Issue #63: requireGreenTestRun recognized a commit only by the literal
// text "git commit", so `git -C <dir> commit` and `git -c k=v commit`
// skipped the commit-on-green gate entirely. With enforceForPaths set, it
// also listed staged files in the hook's checkout, so a commit made inside
// a linked worktree nested in the project (.claude/worktrees/<name>) was
// scoped by the main checkout's staged files.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import type { RuleContext } from '@nizos/probity'

import { requireGreenTestRun } from './gates.ts'

const noRuns = { history: async () => [] } as unknown as RuleContext
const gate = (extra: Parameters<typeof requireGreenTestRun>[0] extends infer O ? Partial<O> : never = {}) =>
  requireGreenTestRun({
    command: /gradlew\b.*\btest\b/,
    successPattern: /BUILD SUCCESSFUL/,
    failurePattern: /BUILD FAILED|FAILED/,
    ...extra,
  })

test('git -C <dir> commit and git -c key=value commit are gated', async () => {
  for (const command of ['git -C /repo commit -m x', 'git -C "/my repo" commit -m x', 'git -c user.name=t commit -m x']) {
    const result = await gate()({ kind: 'command', command }, noRuns)
    assert.equal(result.kind, 'violation', command)
  }
})

test('commands that are not commits still pass', async () => {
  for (const command of ['git commit-tree abc', 'git log --grep commit', 'echo done']) {
    const result = await gate()({ kind: 'command', command }, noRuns)
    assert.equal(result.kind, 'pass', command)
  }
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

function write(root: string, rel: string, content: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}

/** A project with a linked worktree nested at .claude/worktrees/agent-a; the hook runs at the root. */
function project(t: { after: (fn: () => void) => void }) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'probity-green-wt-')))
  const originalCwd = process.cwd()
  t.after(() => {
    process.chdir(originalCwd)
    rmSync(repo, { recursive: true, force: true })
  })
  git(repo, 'init', '-q', '-b', 'main')
  write(repo, 'src/main/kotlin/App.kt', 'fun main() {}\n')
  write(repo, 'README.md', '# app\n')
  write(repo, '.gitignore', '.claude/worktrees/\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  const worktree = join(repo, '.claude/worktrees/agent-a')
  git(repo, 'worktree', 'add', '-q', worktree, '-b', 'agent-a')
  process.chdir(repo)
  return { repo, worktree, rule: gate({ enforceForPaths: /^src\// }) }
}

test('a worktree commit staging code is gated by its own staged files', async (t) => {
  const { worktree, rule } = project(t)
  write(worktree, 'src/main/kotlin/App.kt', 'fun main() { println() }\n')
  git(worktree, 'add', '.')
  for (const command of [`cd ${worktree} && git commit -m x`, `git -C "${worktree}" commit -m x`]) {
    const result = await rule({ kind: 'command', command }, noRuns)
    assert.equal(result.kind, 'violation', command)
  }
})

test('code staged in the main checkout does not scope a docs-only worktree commit', async (t) => {
  const { repo, worktree, rule } = project(t)
  write(repo, 'src/main/kotlin/App.kt', 'fun main() { error("x") }\n')
  git(repo, 'add', '.')
  write(worktree, 'README.md', '# app, documented\n')
  git(worktree, 'add', '.')
  const fromWorktree = await rule({ kind: 'command', command: `cd ${worktree} && git commit -m x` }, noRuns)
  assert.equal(fromWorktree.kind, 'pass', fromWorktree.kind === 'violation' ? fromWorktree.reason : '')
  const fromMain = await rule({ kind: 'command', command: 'git commit -m x' }, noRuns)
  assert.equal(fromMain.kind, 'violation')
})

test('an injected lister receives the root of the tree being committed', async (t) => {
  const { repo, worktree } = project(t)
  const seen: string[] = []
  const rule = gate({
    enforceForPaths: /^src\//,
    listCommitFiles: (_command, cwd) => {
      seen.push(cwd)
      return []
    },
  })
  await rule({ kind: 'command', command: `cd ${worktree} && git commit -m x` }, noRuns)
  await rule({ kind: 'command', command: 'git commit -m x' }, noRuns)
  assert.deepEqual(seen, [worktree, repo])
})
