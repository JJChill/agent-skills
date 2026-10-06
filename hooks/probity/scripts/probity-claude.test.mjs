// Issue #40: a sub-agent's PreToolUse payload carries the PARENT
// session's transcript_path plus an agent_id; the sub-agent's own tool
// calls live in <session>/subagents/agent-<id>.jsonl. probity-claude
// repoints transcript_path so history-based rules see the sub-agent's
// work.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { PROBITY_MAX_TRANSCRIPT_BYTES, activeConfig, afterState, debugArgs, preparePayload, probityDirectory, subagentTranscript, targetsConfig, transcriptTail } from './probity-claude.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WRAPPER = join(HERE, 'probity-claude.mjs')

function bashCall(id, command, output, extra = {}) {
  return [
    { type: 'assistant', ...extra, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
    { type: 'user', ...extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: false }] } },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')
}

/** A parent transcript plus one sub-agent transcript, laid out as Claude Code writes them. */
function session(t) {
  const dir = mkdtempSync(join(tmpdir(), 'probity-claude-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const parent = join(dir, 'session-1.jsonl')
  writeFileSync(parent, bashCall('toolu_parent', 'echo parent-run', 'parent-run') + '\n')
  mkdirSync(join(dir, 'session-1', 'subagents'), { recursive: true })
  const child = join(dir, 'session-1', 'subagents', 'agent-a1b2.jsonl')
  const failing = 'TokenClientTest[jvm] > rejects expired tokens[jvm] FAILED\n    AssertionError'
  writeFileSync(
    child,
    bashCall('toolu_child', './gradlew :sdk:anonyome:jvmTest', failing, { isSidechain: true, agentId: 'a1b2' }) + '\n',
  )
  return { dir, parent, child }
}

test('subagentTranscript points at the agent transcript beside the parent', (t) => {
  const { parent, child } = session(t)
  assert.equal(subagentTranscript({ transcript_path: parent, agent_id: 'a1b2' }), child)
})

test('payloads without an agent, or with no agent transcript on disk, are left alone', (t) => {
  const { parent } = session(t)
  assert.equal(subagentTranscript({ transcript_path: parent }), null)
  assert.equal(subagentTranscript({ transcript_path: parent, agent_id: 'missing' }), null)
  assert.equal(subagentTranscript({ transcript_path: parent, agent_id: '../../etc' }), null)
  const raw = JSON.stringify({ transcript_path: parent, tool_name: 'Bash' })
  assert.equal(preparePayload(raw).input, raw)
  assert.equal(preparePayload('not json').input, 'not json')
})

/** A project dir whose Probity config denies with every command it sees in history. */
function historyProject(dir) {
  const project = join(dir, 'project')
  mkdirSync(project)
  symlinkSync(join(HERE, '..', 'node_modules'), join(project, 'node_modules'), 'dir')
  writeFileSync(
    join(project, 'probity.config.mjs'),
    `export default { rules: [async function showHistory(action, ctx) {
      const commands = ((await ctx.history?.()) ?? []).filter((e) => e.kind === 'command')
      return { kind: 'violation', reason: 'seen: ' + commands.map((e) => e.command + ' => ' + e.output).join(' | ') }
    }] }\n`,
  )
  return project
}

function runWrapper(project, payload) {
  const res = spawnSync(process.execPath, [WRAPPER], {
    cwd: project,
    input: JSON.stringify({
      session_id: 'session-1',
      cwd: project,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m x' },
      ...payload,
    }),
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, res.stderr)
  return JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason
}

test('end to end: Probity rules see the sub-agent history through the wrapper', (t) => {
  const { dir, parent } = session(t)
  const project = historyProject(dir)
  const fromParent = runWrapper(project, { transcript_path: parent })
  assert.match(fromParent, /echo parent-run/)
  const fromAgent = runWrapper(project, { transcript_path: parent, agent_id: 'a1b2' })
  assert.match(fromAgent, /gradlew :sdk:anonyome:jvmTest => .*rejects expired tokens\[jvm\] FAILED/)
  assert.doesNotMatch(fromAgent, /parent-run/)
})

// Issue #54: Probity refuses a transcript over 100 MiB, and every
// history-based rule then fails closed with "rule error: ... exceeds
// 104857600 bytes" until the session is restarted. The wrapper hands
// Probity the most recent part of an oversized transcript instead.

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'probity-tail-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('transcriptTail leaves a transcript at or under the limit alone', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 's.jsonl')
  writeFileSync(path, 'a'.repeat(99) + '\n')
  assert.equal(transcriptTail(path, { maxBytes: 100, tailBytes: 40 }), null)
})

test('transcriptTail copies the newest whole lines of an oversized transcript to a private file', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 's.jsonl')
  const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({ n: i }))
  writeFileSync(path, lines.join('\n') + '\n')
  const tail = transcriptTail(path, { maxBytes: 50, tailBytes: 40 })
  t.after(() => tail && rmSync(dirname(tail), { recursive: true, force: true }))
  assert.ok(tail, 'expected a tail file')
  assert.ok(tail.endsWith('.jsonl'))
  const kept = readFileSync(tail, 'utf8')
  assert.ok(kept.length <= 40, `tail is ${kept.length} bytes`)
  assert.ok(kept.endsWith(lines.at(-1) + '\n'), 'keeps the newest line')
  for (const line of kept.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line), `partial line kept: ${line}`)
  assert.equal(statSync(tail).mode & 0o777, 0o600)
})

test('transcriptTail leaves a symlinked transcript for Probity to refuse', (t) => {
  const dir = tempDir(t)
  const real = join(dir, 'real.jsonl')
  writeFileSync(real, 'x'.repeat(200) + '\n')
  const link = join(dir, 'link.jsonl')
  symlinkSync(real, link)
  assert.equal(transcriptTail(link, { maxBytes: 100, tailBytes: 40 }), null)
})

test('preparePayload points an oversized transcript at its tail, and cleanup removes it', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 's.jsonl')
  writeFileSync(path, bashCall('toolu_old', 'echo old', 'old') + '\n' + bashCall('toolu_new', 'echo new', 'new') + '\n')
  const { input, cleanup } = preparePayload(JSON.stringify({ transcript_path: path }), { maxBytes: 100, tailBytes: 400 })
  const tail = JSON.parse(input).transcript_path
  assert.notEqual(tail, path)
  assert.match(readFileSync(tail, 'utf8'), /echo new/)
  cleanup()
  assert.equal(existsSync(tail), false)
})

test('end to end: an over-limit transcript still yields the recent history, not a rule error', (t) => {
  const { dir, parent } = session(t)
  const project = historyProject(dir)
  // Push the parent transcript past Probity's cap with blank lines (which
  // Probity skips), then record the run a commit gate would look for.
  appendFileSync(parent, Buffer.alloc(PROBITY_MAX_TRANSCRIPT_BYTES + 1024, '\n'))
  appendFileSync(parent, bashCall('toolu_build', './gradlew build', 'BUILD SUCCESSFUL in 9s') + '\n')
  const reason = runWrapper(project, { transcript_path: parent })
  assert.doesNotMatch(reason, /rule error|exceeds/)
  assert.match(reason, /gradlew build => BUILD SUCCESSFUL/)
})

// Issue #66: the hook runs `cd "$CLAUDE_PROJECT_DIR" && probity-claude`.
// After EnterWorktree, CLAUDE_PROJECT_DIR still names the main checkout,
// so Probity loaded the main checkout's probity.config.ts and every rule
// judged the main checkout's specs and files. The wrapper now runs
// Probity in the git worktree the action targets, when that worktree is
// nested in the project and has its own Probity config.

/** A project dir holding a config, with a nested worktree-shaped dir (a `.git` file + its own config). */
function nestedLayout(t, { worktreeConfig = true } = {}) {
  const root = realpathSync(tempDir(t))
  writeFileSync(join(root, 'probity.config.ts'), 'export default {}\n')
  mkdirSync(join(root, '.git'))
  const worktree = join(root, '.claude', 'worktrees', 'wt')
  mkdirSync(join(worktree, 'cli', 'src'), { recursive: true })
  writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n')
  if (worktreeConfig) writeFileSync(join(worktree, 'probity.config.ts'), 'export default {}\n')
  return { root, worktree }
}

test('probityDirectory picks the nested worktree an edit targets', (t) => {
  const { root, worktree } = nestedLayout(t)
  const payload = { cwd: root, tool_name: 'Edit', tool_input: { file_path: join(worktree, 'cli/src/A.kt') } }
  assert.equal(probityDirectory(payload, root), worktree)
})

test('probityDirectory resolves a relative file path against the payload cwd', (t) => {
  const { root, worktree } = nestedLayout(t)
  const payload = { cwd: worktree, tool_name: 'Write', tool_input: { file_path: 'cli/src/New.kt' } }
  assert.equal(probityDirectory(payload, root), worktree)
})

test('probityDirectory uses the session cwd for commands', (t) => {
  const { root, worktree } = nestedLayout(t)
  const payload = { cwd: join(worktree, 'cli'), tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }
  assert.equal(probityDirectory(payload, root), worktree)
})

test('probityDirectory follows a command\'s explicit directory over the session cwd', (t) => {
  const { root, worktree } = nestedLayout(t)
  const bash = (command, cwd) => ({ cwd, tool_name: 'Bash', tool_input: { command } })
  assert.equal(probityDirectory(bash(`cd ${root} && git commit -m x`, worktree), root), null)
  assert.equal(probityDirectory(bash(`git -C "${root}" commit -m x`, worktree), root), null)
  assert.equal(probityDirectory(bash(`cd ${worktree} && git commit -m x`, root), root), worktree)
  assert.equal(probityDirectory(bash('git -C .claude/worktrees/wt commit -m x', root), root), worktree)
})

test('probityDirectory keeps the project for main-checkout work, outside paths, and worktrees without a config', (t) => {
  const { root, worktree } = nestedLayout(t)
  const edit = (file_path, cwd = root) => ({ cwd, tool_name: 'Edit', tool_input: { file_path } })
  assert.equal(probityDirectory(edit(join(root, 'src/A.kt')), root), null)
  assert.equal(probityDirectory(edit('/somewhere/else/A.kt'), root), null)
  assert.equal(probityDirectory({ cwd: root, tool_name: 'Bash', tool_input: { command: 'ls' } }, root), null)
  assert.equal(probityDirectory({}, root), null)
  const bare = nestedLayout(t, { worktreeConfig: false })
  assert.equal(probityDirectory(edit(join(bare.worktree, 'cli/src/A.kt')), bare.root), null)
})

test('debugArgs keeps a relative --debug log path in the project directory', () => {
  assert.deepEqual(debugArgs(['--debug', 'log.jsonl', '--agent', 'claude-code'], '/proj'), ['--debug', '/proj/log.jsonl', '--agent', 'claude-code'])
  assert.deepEqual(debugArgs(['--debug', '/abs/log.jsonl'], '/proj'), ['--debug', '/abs/log.jsonl'])
  assert.deepEqual(debugArgs(['--agent', 'claude-code'], '/proj'), ['--agent', 'claude-code'])
})

test('end to end: an edit in a nested git worktree is judged by that worktree\'s config', (t) => {
  const { dir, parent } = session(t)
  const project = join(realpathSync(dir), 'project')
  mkdirSync(project)
  symlinkSync(join(HERE, '..', 'node_modules'), join(project, 'node_modules'), 'dir')
  // Each tree's config reports which root it resolved, the way a real
  // config computes ROOT, and imports from node_modules: the worktree has
  // none of its own and must resolve the project's by walking upward.
  const config = `import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@nizos/probity'
const ROOT = dirname(fileURLToPath(import.meta.url))
export default defineConfig({ rules: [function whereAmI() { return { kind: 'violation', reason: 'root=' + ROOT } }] })
`
  writeFileSync(join(project, 'probity.config.ts'), config)
  writeFileSync(join(project, '.gitignore'), '.claude/worktrees/\nnode_modules\n*.jsonl\n')
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' })
  git(project, 'init', '-q', '-b', 'main')
  git(project, 'add', '.')
  git(project, 'commit', '-q', '-m', 'init')
  const worktree = join(project, '.claude', 'worktrees', 'wt')
  git(project, 'worktree', 'add', '-q', worktree, '-b', 'wt')
  const run = (payload) => {
    const res = spawnSync(process.execPath, [WRAPPER, '--debug', 'probity-debug.jsonl'], {
      cwd: project,
      input: JSON.stringify({ session_id: 'session-1', transcript_path: parent, hook_event_name: 'PreToolUse', ...payload }),
      encoding: 'utf8',
    })
    assert.equal(res.status, 0, res.stderr)
    return JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason
  }
  const edit = (cwd, file_path) => ({ cwd, tool_name: 'Write', tool_input: { file_path, content: 'class A\n' } })
  assert.match(run(edit(worktree, join(worktree, 'src/A.kt'))), new RegExp(`root=${worktree}$`))
  assert.match(run(edit(project, join(project, 'src/A.kt'))), new RegExp(`root=${project}$`))
  assert.ok(existsSync(join(project, 'probity-debug.jsonl')), 'debug log stays in the project directory')
  assert.equal(existsSync(join(worktree, 'probity-debug.jsonl')), false)
})

// Issue #81: Probity loads its config on every call and blocks
// everything when that load throws, including the edit that would fix
// the config. The wrapper validates edits to the config before they
// land, and lets edits to an already-broken config through.

const LOADING_CONFIG = `import { defineConfig } from '@nizos/probity'
export default defineConfig({ rules: [function ran() { return { kind: 'violation', reason: 'rule ran' } }] })
`
// The #81 state: a call added before its import.
const BROKEN_CONFIG = LOADING_CONFIG.replace("function ran()", "probe(function ran()").replace("'rule ran' } }]", "'rule ran' } })]")

function configProject(t, content) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'probity-claude-config-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  symlinkSync(join(HERE, '..', 'node_modules'), join(dir, 'node_modules'), 'dir')
  const config = join(dir, 'probity.config.ts')
  writeFileSync(config, content)
  const run = (payload, args = []) => {
    const res = spawnSync(process.execPath, [WRAPPER, ...args], {
      cwd: dir,
      input: JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', cwd: dir, ...payload }),
      encoding: 'utf8',
    })
    assert.equal(res.status, 0, res.stderr)
    return res.stdout === '' ? null : JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason
  }
  return { dir, config, run }
}

const editConfig = (config, old_string, new_string) => ({ tool_name: 'Edit', tool_input: { file_path: config, old_string, new_string } })

test('activeConfig honors --config, else finds the nearest config upward', (t) => {
  const { dir, config } = configProject(t, LOADING_CONFIG)
  mkdirSync(join(dir, 'src'))
  assert.equal(activeConfig(join(dir, 'src')), config)
  assert.equal(activeConfig(dir, ['--config', 'other.config.ts']), join(dir, 'other.config.ts'))
  assert.equal(activeConfig(tmpdir()), null)
})

test('targetsConfig matches Edit and Write of the config, by absolute or relative path', (t) => {
  const { dir, config } = configProject(t, LOADING_CONFIG)
  assert.ok(targetsConfig({ tool_name: 'Edit', tool_input: { file_path: config } }, config))
  assert.ok(targetsConfig({ cwd: dir, tool_name: 'Write', tool_input: { file_path: 'probity.config.ts' } }, config))
  assert.equal(targetsConfig({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'a.ts') } }, config), false)
  assert.equal(targetsConfig({ tool_name: 'Bash', tool_input: { command: `cat ${config}` } }, config), false)
})

test('afterState applies an Edit like Claude Code, and gives up where Claude Code would reject it', (t) => {
  const { config } = configProject(t, 'a $& b a\n')
  const edit = (input) => afterState({ tool_name: 'Edit', tool_input: { file_path: config, ...input } }, config)
  assert.equal(edit({ old_string: 'b', new_string: '$&' }), 'a $& $& a\n')
  assert.equal(edit({ old_string: 'a', new_string: 'c', replace_all: true }), 'c $& b c\n')
  assert.equal(edit({ old_string: 'a', new_string: 'c' }), null, 'ambiguous without replace_all')
  assert.equal(edit({ old_string: 'zzz', new_string: 'c' }), null, 'not found')
  assert.equal(afterState({ tool_name: 'Write', tool_input: { file_path: config, content: 'x' } }, config), 'x')
})

test('end to end: an edit that would leave the config unloadable is blocked before it lands', (t) => {
  const { dir, config, run } = configProject(t, LOADING_CONFIG)
  const reason = run(editConfig(config, 'function ran()', 'probe(function ran()'))
  assert.match(reason, /would leave probity\.config\.ts unable to load/)
  assert.match(reason, /add an import before its first use/)
  assert.equal(readFileSync(config, 'utf8'), LOADING_CONFIG)
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('.probity-config-check')), [], 'scratch copy removed')
})

test('end to end: edits and Writes that keep the config loading go on to the rules', (t) => {
  const { config, run } = configProject(t, LOADING_CONFIG)
  assert.equal(run(editConfig(config, "'rule ran'", "'rule ran'+''")), 'Probity: rule ran')
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: config, content: LOADING_CONFIG } }), 'Probity: rule ran')
})

test('end to end: an edit Claude Code would reject is left to Probity', (t) => {
  const { config, run } = configProject(t, LOADING_CONFIG)
  assert.doesNotMatch(run(editConfig(config, 'not in the file', 'x')), /unable to load/)
})

test('end to end: a broken config lets edits to itself through and says so on every other deny', (t) => {
  const { dir, config, run } = configProject(t, BROKEN_CONFIG)
  assert.equal(run(editConfig(config, 'probe(function', 'function')), null, 'no opinion: the normal permission flow decides')
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: config, content: LOADING_CONFIG } }), null)
  const reason = run({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  assert.match(reason, /^Probity: probe is not defined/)
  assert.ok(reason.includes(`${config} failed to load`), reason)
  assert.ok(reason.includes(`Edit or Write ${config} to fix it`), reason)
  const other = run({ tool_name: 'Write', tool_input: { file_path: join(dir, 'a.ts'), content: 'x' } })
  assert.match(other, /failed to load/)
})

test('end to end: rule denies from a loading config get no lockout hint', (t) => {
  const { run } = configProject(t, LOADING_CONFIG)
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'ls' } }), 'Probity: rule ran')
})

test('end to end: --config names the config the edit guard protects', (t) => {
  const { dir, run } = configProject(t, LOADING_CONFIG)
  const custom = join(dir, 'custom.config.ts')
  writeFileSync(custom, BROKEN_CONFIG)
  assert.equal(run(editConfig(custom, 'probe(function', 'function'), ['--config', 'custom.config.ts']), null)
  assert.match(run({ tool_name: 'Bash', tool_input: { command: 'ls' } }, ['--config', 'custom.config.ts']), /custom\.config\.ts failed to load/)
})

test('end to end: when the edit check cannot run, Probity still judges the edit', (t) => {
  const { dir, config, run } = configProject(t, LOADING_CONFIG)
  chmodSync(dir, 0o555) // no room for the scratch copy
  try {
    assert.equal(run(editConfig(config, 'function ran()', 'probe(function ran()')), 'Probity: rule ran')
  } finally {
    chmodSync(dir, 0o755)
  }
})
