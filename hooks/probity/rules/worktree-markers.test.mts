// Issue #39: the probe and characterization commit gates scanned every
// file under the configured root, including linked git worktrees that
// Claude Code creates inside the repository (.claude/worktrees/agent-<id>).
// One worktree's open marker blocked commits in every other tree.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { enforceCharacterizationResolution, enforceProbeReversion } from './kotlin.ts'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })

function write(root: string, rel: string, content: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}

/** A repo with two linked worktrees nested inside it, as Claude Code lays them out. */
function repoWithWorktrees(t: { after: (fn: () => void) => void }) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'probity-worktrees-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const a = join(repo, '.claude/worktrees/agent-a')
  const b = join(repo, '.claude/worktrees/agent-b')
  git(repo, 'worktree', 'add', '-q', a, '-b', 'a')
  git(repo, 'worktree', 'add', '-q', b, '-b', 'b')
  return { repo, a, b }
}

const PROBE = 'fun token() = null // probity: mutation-probe — proving the test bites\n'
const MARKED = '// probity: characterization\n@Test\nfun `rejects expired tokens`() {}\n'

const gates = [
  ['enforceProbeReversion', enforceProbeReversion, 'src/main/kotlin/Token.kt', PROBE],
  ['enforceCharacterizationResolution', enforceCharacterizationResolution, 'src/test/kotlin/TokenTest.kt', MARKED],
] as const

for (const [name, gate, rel, content] of gates) {
  test(`${name}: a marker in one worktree does not block a sibling worktree or the main tree`, async (t) => {
    const { repo, a, b } = repoWithWorktrees(t)
    write(a, rel, content)
    const rule = gate({ roots: [repo] })
    const fromSibling = await rule({ kind: 'command', command: `cd ${b} && git commit -m x` })
    assert.equal(fromSibling.kind, 'pass', fromSibling.reason)
    const fromMain = await rule({ kind: 'command', command: `git -C ${repo} commit -m x` })
    assert.equal(fromMain.kind, 'pass', fromMain.reason)
  })

  test(`${name}: a marker still blocks a commit in its own worktree`, async (t) => {
    const { repo, a } = repoWithWorktrees(t)
    write(a, rel, content)
    const rule = gate({ roots: [repo] })
    for (const command of [`cd ${a} && git commit -m x`, `git -C "${a}" commit -m x`]) {
      const result = await rule({ kind: 'command', command })
      assert.equal(result.kind, 'violation', command)
      assert.match(result.reason ?? '', new RegExp(`\\n\\s+${rel.replace(/\./g, '\\.')}$`))
    }
  })

  test(`${name}: a main-tree marker blocks main-tree commits but not worktree commits`, async (t) => {
    const { repo, b } = repoWithWorktrees(t)
    write(repo, rel, content)
    const rule = gate({ roots: [repo] })
    const fromMain = await rule({ kind: 'command', command: `git -C ${repo} commit -m x` })
    assert.equal(fromMain.kind, 'violation')
    assert.doesNotMatch(fromMain.reason ?? '', /\.claude\/worktrees/)
    const fromWorktree = await rule({ kind: 'command', command: `cd ${b} && git commit -m x` })
    assert.equal(fromWorktree.kind, 'pass', fromWorktree.reason)
  })

  test(`${name}: a submodule-style directory (a .git file) is not scanned from the parent`, async (t) => {
    const { repo } = repoWithWorktrees(t)
    write(repo, 'vendor/lib/.git', 'gitdir: ../../.git/modules/lib\n')
    write(repo, join('vendor/lib', rel), content)
    const result = await gate({ roots: [repo] })({
      kind: 'command',
      command: `git -C ${repo} commit -m x`,
    })
    assert.equal(result.kind, 'pass', result.reason)
  })
}
