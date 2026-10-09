// Coverage for forbidShellWritesToScopedFiles (issue #79): a file edit
// made through a shell command (Claude Code's Bash, Kiro's shell) skips
// every content rule, so a command that writes a path some files-scoped
// block covers is denied with a redirect to the write tool.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { RuleEntry } from '@nizos/probity'

import { jsRuleEntries } from '../presets/js.ts'
import { kmpRuleEntries } from '../presets/kmp.ts'
import { kotlinRuleEntries } from '../presets/kotlin.ts'
import { swiftRuleEntries } from '../presets/swift.ts'
import {
  forbidShellWritesToScopedFiles,
  shellWritePaths,
  shellWriteTargets,
  withShellWriteScreen,
} from './shell-writes.ts'

const ROOT = '/repo'

const rule = forbidShellWritesToScopedFiles({
  root: ROOT,
  scopes: [['src/**', '!**/build/**'], ['**/src/jvmMain/**']],
})

async function verdict(command: string) {
  return rule({ kind: 'command', command })
}

async function assertBlocked(command: string, path: string) {
  const result = await verdict(command)
  assert.equal(result.kind, 'violation', `expected a block for: ${command}`)
  assert.match((result as { reason: string }).reason, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
}

async function assertAllowed(command: string) {
  const result = await verdict(command)
  assert.equal(result.kind, 'pass', `expected a pass for: ${command}\n${JSON.stringify(result)}`)
}

test('blocks the #79 Kiro case: a python heredoc writing a file named by a shell variable', async () => {
  const command = [
    'f=sdk/anonyome/src/jvmMain/kotlin/com/anonyome/AnonyomePushReader.kt',
    `python3 - "$f" <<'EOF'`,
    'import sys',
    'p = sys.argv[1]',
    's = open(p).read()',
    "open(p, 'w').write(s.replace('!!', '?: return'))",
    'EOF',
  ].join('\n')
  await assertBlocked(command, 'sdk/anonyome/src/jvmMain/kotlin/com/anonyome/AnonyomePushReader.kt')
})

test('blocks redirection into a scoped file, including a heredoc', async () => {
  await assertBlocked("cat > src/core/a.ts <<'EOF'\nexport const a = 1\nEOF", 'src/core/a.ts')
  await assertBlocked('echo "x" >> src/core/a.ts', 'src/core/a.ts')
  await assertBlocked("printf '%s' x >| 'src/core/a.ts'", 'src/core/a.ts')
  await assertBlocked('build 2>&1 &> src/log.ts', 'src/log.ts')
})

test('blocks in-place editors and tee', async () => {
  await assertBlocked("sed -i '' 's/a/b/' src/a.ts", 'src/a.ts')
  await assertBlocked("sed -i.bak -e 's/a/b/' src/a.ts", 'src/a.ts')
  await assertBlocked("sed --in-place 's/a/b/' src/a.ts", 'src/a.ts')
  await assertBlocked("perl -pi -e 's/a/b/' src/a.ts", 'src/a.ts')
  await assertBlocked('echo hi | tee -a src/a.ts', 'src/a.ts')
})

test('blocks copies, moves and dd into a scoped path', async () => {
  await assertBlocked('cp /tmp/a.ts src/core/a.ts', 'src/core/a.ts')
  await assertBlocked('cp /tmp/a.ts src/core/', 'src/core/a.ts')
  await assertBlocked('mv -f /tmp/a.ts src/a.ts', 'src/a.ts')
  await assertBlocked('dd if=/tmp/a of=src/a.ts', 'src/a.ts')
})

test('blocks node, ruby and python -c writes', async () => {
  await assertBlocked(`node -e "require('fs').writeFileSync('src/a.ts', '')"`, 'src/a.ts')
  await assertBlocked(`ruby -e "File.write('src/a.rb', 'x')"`, 'src/a.rb')
  await assertBlocked(
    `python3 -c "from pathlib import Path; Path('src/a.py').write_text('x')"`,
    'src/a.py',
  )
})

test('blocks a patch applied from a heredoc', async () => {
  const command = [
    "git apply <<'EOF'",
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'EOF',
  ].join('\n')
  await assertBlocked(command, 'src/a.ts')
})

test('blocks an absolute path inside the root and a write after cd-free chaining', async () => {
  await assertBlocked("sed -i 's/a/b/' /repo/src/a.ts", 'src/a.ts')
  await assertBlocked("npm test && sed -i 's/a/b/' src/a.ts; echo done", 'src/a.ts')
})

test('follows a for loop variable and a cd into the tree', async () => {
  await assertBlocked("for f in src/a.ts src/b.ts; do sed -i 's/a/b/' \"$f\"; done", 'src/b.ts')
  await assertBlocked("cd src && sed -i 's/a/b/' a.ts", 'src/a.ts')
  await assertAllowed("cd /tmp && sed -i 's/a/b/' src/a.ts")
})

// Issue #101: the write went into a worktree the same command created, so no
// existing worktree held it and the main checkout's screen skipped a path
// outside its root. A new worktree is a checkout of the same repository:
// paths under it are judged against this config's scopes, relative to it.
test('blocks a write into a worktree the same command creates (#101)', async () => {
  const command = [
    'git worktree add -b 198-bring-up-to-date ../repo-198 origin/main 2>&1 | tail -1;',
    'cd ../repo-198 && git submodule update --init specs >/dev/null 2>&1;',
    'ln -s ../repo/node_modules node_modules;',
    'cd specs && git fetch -q origin && git checkout -q -b 13-keeping-up-to-date origin/main',
    '&& cp /tmp/keeping-up-to-date.feature features/devices/keeping-up-to-date.feature && git status --short',
  ].join(' ')
  const screen = forbidShellWritesToScopedFiles({ root: ROOT, scopes: [['specs/features/**/*.feature']] })
  const result = await screen({ kind: 'command', command })
  assert.equal(result.kind, 'violation')
  assert.match((result as { reason: string }).reason, /specs\/features\/devices\/keeping-up-to-date\.feature/)
})

test('reads git worktree add forms: options, -C, --detach, an absolute path', () => {
  assert.deepEqual(shellWriteTargets("git worktree add --detach -f /base/wt HEAD && sed -i 's/a/b/' /base/wt/src/a.ts", '/repo'), ['src/a.ts'])
  assert.deepEqual(shellWriteTargets("git -C /repo worktree add ../wt2 -b x; echo x > ../wt2/src/b.ts", '/repo'), ['src/b.ts'])
  assert.deepEqual(shellWriteTargets("git worktree add -B y ../wt3 main && cd ../wt3 && tee src/c.ts < /tmp/c", '/repo'), ['src/c.ts'])
  // A path outside the root and outside any new worktree is still not this config's to judge.
  assert.deepEqual(shellWriteTargets("git worktree add ../wt4 && sed -i 's/a/b/' /elsewhere/src/a.ts", '/repo'), [])
  // git worktree list/remove create nothing.
  assert.deepEqual(shellWriteTargets("git worktree remove ../wt5; sed -i 's/a/b/' ../wt5/src/a.ts", '/repo'), [])
})

test('allows reads, out-of-scope writes and excluded paths', async () => {
  await assertAllowed('cat src/a.ts')
  await assertAllowed("sed -n '1,10p' src/a.ts")
  await assertAllowed('grep -rn foo src > /tmp/out.txt')
  await assertAllowed('echo x > notes.txt')
  await assertAllowed('npm test 2>&1 | tail -20')
  await assertAllowed('echo x > /dev/null')
  await assertAllowed("sed -i 's/a/b/' src/build/gen.ts")
  await assertAllowed('cp src/a.ts /tmp/a.ts')
  await assertAllowed("python3 - <<'EOF'\nprint(open('src/a.ts').read())\nif 1 > 0: pass\nEOF")
  await assertAllowed(`node -e "console.log(require('fs').readFileSync('src/a.ts','utf8'))"`)
  await assertAllowed("sed -i 's/a/b/' /elsewhere/src/a.ts")
})

test('passes write actions through: the write tool is judged by the content rules', async () => {
  const result = await rule({ kind: 'write', path: '/repo/src/a.ts', content: 'x' })
  assert.equal(result.kind, 'pass')
})

test('shellWriteTargets reads a patch file named on the command line', () => {
  const root = mkdtempSync(join(tmpdir(), 'shell-writes-'))
  mkdirSync(join(root, 'tmp'))
  writeFileSync(join(root, 'tmp/fix.patch'), '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n')
  assert.deepEqual(shellWriteTargets('git apply tmp/fix.patch', root), ['src/a.ts'])
  assert.deepEqual(shellWriteTargets('patch -p1 < tmp/fix.patch', root), ['src/a.ts'])
})

test('shellWritePaths gives absolute paths, resolved from the session cwd, inside the project or not', () => {
  assert.deepEqual(shellWritePaths("sed -i 's/a/b/' ../wt/src/a.ts", '/base/repo'), ['/base/wt/src/a.ts'])
  assert.deepEqual(shellWritePaths('echo x > /base/wt/src/a.ts', '/base/repo'), ['/base/wt/src/a.ts'])
  assert.deepEqual(shellWritePaths("cd ../wt && sed -i 's/a/b/' src/a.ts", '/base/repo'), ['/base/wt/src/a.ts'])
  assert.deepEqual(shellWriteTargets("sed -i 's/a/b/' a.ts", '/repo', '/repo/src'), ['src/a.ts'])
  assert.deepEqual(shellWritePaths("sed -E -i 's/a/b/' x.ts", '/r'), ['/r/x.ts'])
  assert.deepEqual(shellWritePaths("sed -i '' 's/a/b/' x.ts", '/r'), ['/r/x.ts'])
  assert.deepEqual(shellWritePaths("perl -i -pe 's/a/b/' x.ts", '/r'), ['/r/x.ts'])
})

test('the screen resolves relative paths from PROBITY_SESSION_CWD when the hook sets it', async (t) => {
  const saved = process.env.PROBITY_SESSION_CWD
  t.after(() => {
    if (saved === undefined) delete process.env.PROBITY_SESSION_CWD
    else process.env.PROBITY_SESSION_CWD = saved
  })
  process.env.PROBITY_SESSION_CWD = '/repo/src'
  await assertBlocked("sed -i 's/a/b/' a.ts", 'src/a.ts')
  process.env.PROBITY_SESSION_CWD = '/elsewhere'
  await assertAllowed("sed -i 's/a/b/' src/a.ts")
  process.env.PROBITY_SESSION_CWD = 'relative/is/ignored'
  await assertBlocked("sed -i 's/a/b/' src/a.ts", 'src/a.ts')
})

test('withShellWriteScreen screens every files-scoped block and can be switched off', async () => {
  const entries: RuleEntry[] = [{ files: ['src/core/**'], rules: [] }]
  const screened = withShellWriteScreen(entries, { root: ROOT })
  assert.equal(screened.length, 2)
  const screen = screened[0]
  assert.equal(typeof screen, 'function')
  const blocked = await (screen as Function)({ kind: 'command', command: "sed -i 's/a/b/' src/core/x.ts" })
  assert.equal(blocked.kind, 'violation')
  const allowed = await (screen as Function)({ kind: 'command', command: "sed -i 's/a/b/' src/ui/x.ts" })
  assert.equal(allowed.kind, 'pass')
  assert.equal(withShellWriteScreen(entries, { root: ROOT, enabled: false }).length, 1)
})

test('every preset puts the screen first, with an opt-out', async () => {
  const sed = { kind: 'command' as const, command: "sed -i 's/a/b/' src/x.ts" }
  const js = jsRuleEntries()
  assert.equal(typeof js[0], 'function')
  assert.equal((await (js[0] as Function)(sed)).kind, 'violation')
  assert.notEqual(typeof jsRuleEntries({ shellWriteScreen: false })[0], 'function')

  const kmp = kmpRuleEntries(ROOT)
  const kmpSed = { kind: 'command' as const, command: "sed -i 's/a/b/' shared/src/commonMain/kotlin/A.kt" }
  assert.equal((await (kmp[0] as Function)(kmpSed)).kind, 'violation')
  assert.equal(kmpRuleEntries(ROOT, { shellWriteScreen: false }).length, kmp.length - 1)
  assert.equal(kotlinRuleEntries(ROOT, { shellWriteScreen: false }).length, kotlinRuleEntries(ROOT).length - 1)

  const swift = swiftRuleEntries(ROOT)
  const swiftSed = { kind: 'command' as const, command: "sed -i '' 's/a/b/' AcceptanceTests/Specs/A.swift" }
  assert.equal((await (swift[0] as Function)(swiftSed)).kind, 'violation')
  assert.equal(swiftRuleEntries(ROOT, { shellWriteScreen: false }).length, swift.length - 1)
})
