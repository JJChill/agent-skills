// Issue #121: a command is a commit only when it runs `git commit`, not
// when the words appear as data (a heredoc written to a file, an issue
// body, an echo). Anything that could execute the text still counts.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isGitCommit } from './commit-target.ts'
import { requireGreenTestRun } from './gates.ts'
import { enforceCharacterizationResolution, enforceProbeReversion } from './kotlin.ts'
import { enforceSpecTestParity } from './spec-test-parity.ts'

const commits: [string, string][] = [
  ['plain', 'git commit -m x'],
  ['global options', 'git -C "/tmp/a b" -c user.name=x --no-pager commit -q'],
  ['after cd', 'cd /tmp/x && git commit -F - <<EOF\nmsg\nEOF'],
  ['prefixed', 'FOO=1 sudo env git commit -m x'],
  ['shell -c', 'bash -c "cd x && git commit -m y"'],
  ['eval', "eval 'git commit -m x'"],
  ['xargs', 'echo -m | xargs git commit'],
  ['find -exec', 'find . -name x -exec git commit -m y {} \\;'],
  ['interpreter', 'python3 -c "import os; os.system(\'git commit -m x\')"'],
  ['heredoc fed to a shell', "bash <<'EOF'\ngit commit -m x\nEOF"],
  ['heredoc piped into a shell', "cat <<'EOF' | sh\ngit commit -m x\nEOF"],
  ['command substitution in a data command', 'echo "$(git commit -m x)"'],
  ['backticks in double quotes', 'gh issue comment 1 --body "`git commit -m x`"'],
  ['substitution in an expanding heredoc', 'cat > f.md <<EOF\n$(git commit -m x)\nEOF'],
  ['second command of a list', 'echo done; git commit -m x'],
  ['unparseable', 'git commit -m "unterminated'],
]

const notCommits: [string, string][] = [
  ['plumbing', 'git commit-tree HEAD^{tree}'],
  ['other subcommand', 'git log --grep "git commit"'],
  ['echo', 'echo "run git commit next"'],
  ['issue body argument', "gh issue create --title t --body 'then git commit'"],
  ['grep', 'grep -rn "git commit" rules/'],
  ['quoted heredoc to a file', "mkdir -p d && cd d && cat > 1.md <<'EOF'\nThe gate quotes `git commit` here.\nEOF"],
  ['unquoted heredoc without substitution', 'cat > f.md <<EOF\nthen git commit\nEOF'],
  ['heredoc piped into a data command', "cat <<'EOF' | tee f.md\ngit commit -m x\nEOF"],
  ['no git at all', 'npm test'],
]

for (const [name, command] of commits) {
  test(`should count as a commit: ${name}`, () => {
    assert.equal(isGitCommit(command), true, command)
  })
}

for (const [name, command] of notCommits) {
  test(`should not count as a commit: ${name}`, () => {
    assert.equal(isGitCommit(command), false, command)
  })
}

// Every commit gate uses the same reading: the #121 heredoc passes each
// gate while a real commit in the same state is blocked.
test('should let a heredoc that mentions the commit through every commit gate', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'commit-detection-')))
  try {
    mkdirSync(join(dir, 'specs'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'specs/sample.feature'), 'Feature: F\n\n  Scenario: Uncovered\n    Given a\n')
    writeFileSync(join(dir, 'src/A.kt'), '// probity: mutation-probe\n// probity: characterization\n')
    const gates = [
      requireGreenTestRun({ command: /run-tests/, successPattern: /PASSED/, failurePattern: /FAILED/ }),
      enforceProbeReversion({ roots: [dir] }),
      enforceCharacterizationResolution({ roots: [dir] }),
      enforceSpecTestParity({ specsDir: join(dir, 'specs'), testRoots: [dir], listCommitFiles: () => [join(dir, 'specs/sample.feature')] }),
    ]
    const ctx = { history: async () => [{ kind: 'write', path: 'src/A.kt', content: '' }] as never }
    const heredoc = { kind: 'command' as const, command: "cat > notes.md <<'EOF'\nThe gate blocks `git commit` here.\nEOF" }
    const commit = { kind: 'command' as const, command: 'git commit -m x' }
    for (const gate of gates) {
      assert.equal((await gate(heredoc, ctx)).kind, 'pass', gate.name)
      assert.equal((await gate(commit, ctx)).kind, 'violation', gate.name)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
