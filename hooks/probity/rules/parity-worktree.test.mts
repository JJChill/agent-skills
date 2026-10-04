// Issue #57: the spec-test parity gate always checked the hook's own
// checkout (the project root). A commit made inside a linked worktree
// nested in the project (.claude/worktrees/<name>, where Claude Code puts
// isolation: "worktree" sub-agents) was checked against the main
// checkout's staged files and specs, so it usually passed unchecked.
// Like the marker gates (#39), the gate now checks the commit's own tree.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { enforceSpecTestParity } from './spec-test-parity.ts'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

function write(root: string, rel: string, content: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}

const SPEC = 'specs/features/sample.feature'
const TEST = 'src/test/kotlin/acceptance/SampleSpec.kt'
const spec = (...titles: string[]) =>
  'Feature: F\n' + titles.map((title) => `\n  Scenario: ${title}\n    Given a\n    Then b\n`).join('')
const covers = (...titles: string[]) =>
  titles.map((title) => `// Covers: sample.feature :: Scenario: ${title}\n`).join('') + 'class SampleSpec\n'

/**
 * A project whose main checkout has one covered scenario, plus a linked
 * worktree nested at .claude/worktrees/agent-a, laid out as Claude Code
 * creates it. The hook process runs at the project root.
 */
function project(t: { after: (fn: () => void) => void }) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'probity-parity-wt-')))
  const originalCwd = process.cwd()
  t.after(() => {
    process.chdir(originalCwd)
    rmSync(repo, { recursive: true, force: true })
  })
  git(repo, 'init', '-q', '-b', 'main')
  write(repo, SPEC, spec('Plain'))
  write(repo, TEST, covers('Plain'))
  write(repo, '.gitignore', '.claude/worktrees/\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  const worktree = join(repo, '.claude/worktrees/agent-a')
  git(repo, 'worktree', 'add', '-q', worktree, '-b', 'agent-a')
  process.chdir(repo)
  const rule = enforceSpecTestParity({
    specsDir: join(repo, 'specs/features'),
    testRoots: [repo],
  })
  return { repo, worktree, rule }
}

test('a worktree commit adding an uncovered scenario is blocked', async (t) => {
  const { worktree, rule } = project(t)
  write(worktree, SPEC, spec('Plain', 'Brand new'))
  git(worktree, 'add', SPEC)
  for (const command of [`cd ${worktree} && git commit -m x`, `git -C "${worktree}" commit -m x`]) {
    const result = await rule({ kind: 'command', command })
    assert.equal(result.kind, 'violation', command)
    assert.match(result.reason ?? '', /sample\.feature :: Brand new/)
  }
})

test('a worktree commit is checked against its own tests', async (t) => {
  const { worktree, rule } = project(t)
  write(worktree, SPEC, spec('Plain', 'Brand new'))
  write(worktree, TEST, covers('Plain', 'Brand new'))
  git(worktree, 'add', '.')
  const result = await rule({ kind: 'command', command: `cd ${worktree} && git commit -m x` })
  assert.equal(result.kind, 'pass', result.kind === 'violation' ? result.reason : '')
})

test('an uncovered scenario in the main checkout does not block a worktree commit', async (t) => {
  const { repo, worktree, rule } = project(t)
  write(repo, SPEC, spec('Plain', 'Main only'))
  git(repo, 'add', SPEC)
  write(worktree, TEST, covers('Plain') + '// touched\n')
  git(worktree, 'add', TEST)
  const fromWorktree = await rule({ kind: 'command', command: `cd ${worktree} && git commit -m x` })
  assert.equal(fromWorktree.kind, 'pass', fromWorktree.kind === 'violation' ? fromWorktree.reason : '')
  const fromMain = await rule({ kind: 'command', command: 'git commit -m x' })
  assert.equal(fromMain.kind, 'violation')
  assert.match(fromMain.reason ?? '', /Main only/)
})
