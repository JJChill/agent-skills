# Wiring the Claude Code hook

How Probity is hooked into Claude Code, and what the package's `probity-claude` bin does that Probity's own `probity` bin doesn't. For Kiro, see [`kiro/README.md`](../kiro/README.md).

Back to the [overview](../../PROBITY.md#setup).

## The hook

Wire the hook manually in `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "cd \"$CLAUDE_PROJECT_DIR\" && ./node_modules/.bin/probity-claude" }
        ]
      }
    ]
  }
}
```

**The plugin alternative.** Probity's plugin (`/plugin marketplace add nizos/probity`, then `/plugin install probity@probity`) is simpler to install. It runs the bare `probity` bin, though, which can't see work done inside sub-agents (below). If agents in the project use sub-agents, use the manual hook.

**Anchor it with `cd "$CLAUDE_PROJECT_DIR" &&`,** never a bare relative `./node_modules/...`.

- **Why.** Hooks aren't guaranteed to run with the repository root as their working directory: a session launched from a parent directory, a worktree, or a `cd` elsewhere all move it. A bare relative path then fails to resolve, and the hook errors **non-blocking**: every rule silently stops enforcing while work continues.
- **Config discovery.** The `cd` matters beyond finding the bin. Probity discovers `probity.config.ts` by searching upward from the working directory, so a hook run from the wrong directory finds no config, even with an absolute bin path.

**Open Claude Code on the repository itself.** The hook lives in the repository's `.claude/settings.json`, and Probity searches upward from `$CLAUDE_PROJECT_DIR` for its config. A session opened on a parent folder that holds several repositories loads neither, and enforces nothing without any error. The agent-skills plugin's SessionStart notice (`hooks/probity-notice.sh`, the only hook the plugin registers) warns about exactly that situation and prints nothing otherwise: a `probity.config.*` in a repository one or two levels below the project, but none at its root.

**Use the bin path, not `npx @nizos/probity`.** The hook runs on **every** matched tool call. npx's resolution costs about 0.6–1.6 s per call, against about 0.2 s for the bin (warm cache). A resident validator process would cut the remaining startup too, but that is engine work for Probity upstream.

## What `probity-claude` adds

`probity-claude` runs Probity unchanged (it adds `--agent claude-code` itself), after fixing up what Claude Code hands the hook.

### Sub-agents are judged against their own transcript

When a Claude Code sub-agent (the Agent tool, including `isolation: "worktree"` agents) calls a tool, the hook payload carries the *parent* session's `transcript_path` plus an `agent_id`. The sub-agent's own tool calls are recorded only in `<session>/subagents/agent-<agent_id>.jsonl`.

- **The bare bin's problem.** It judges sub-agent writes against the parent's history. The TDD judge never sees the sub-agent's red runs, and a characterization marker can never be released.
- **The fix.** `probity-claude` points `transcript_path` at the sub-agent's transcript when there is one.

### Long sessions keep working

Probity refuses a transcript over 100 MiB. Without the wrapper, every history-based rule denies from then on, until a new session starts. When the transcript passes that size, `probity-claude` hands Probity a private copy of its newest 32 MiB instead.

### Duplicate tool-call entries are dropped

Claude Code's transcript has `api-request-blob` entries, each recording a tool call a second time, after its result. Probity reads each as a second call with no output, so every test run gets an empty copy after it.

- **The effect.** `requireGreenTestRun` would judge that empty copy as the last run and deny every commit, and the TDD judge would see each run twice.
- **The fix.** `probity-claude` drops those entries. The bare `probity` bin still reads them.

### Worktrees are judged by their own config

`$CLAUDE_PROJECT_DIR` keeps naming the main checkout after a session enters a worktree.

- **Nested worktrees.** When the edited file, or a command's directory, is inside a git worktree nested in the project that has its own `probity.config.*`, `probity-claude` starts Probity there. The rules then judge that worktree's specs and files.
- **Sibling worktrees.** The same holds for a worktree beside the project (`git worktree add ../<name>`), which `probity-claude` finds through `git worktree list`.
- **Packages.** Such a worktree usually has no `node_modules`, so its config loads the main checkout's packages: `probity-claude` adds that `node_modules` to `NODE_PATH`, which Node consults only after the worktree's own. If the packages resolve nowhere, every call is denied with "Run npm ci in <tree>", except that install command itself.
- **Commands that reach across.** A Bash call keeps the session's cwd, so it often reaches another worktree by path (`sed -i … ../<name>/src/A.kt` from the main checkout). `probity-claude` reads the files a command writes, with the shell-write screen's own parser, and also runs Probity in each other worktree they lie in. The first deny stands.
- **Relative paths.** It passes the session's cwd to the screen as `PROBITY_SESSION_CWD`, so relative paths in a command resolve from where the command runs.

### A broken config stays fixable

Probity loads `probity.config.*` on every call, and blocks every call when the load throws, including the edit that would fix the config. A config edited in two steps, a use before its import, locks the agent out until a person reverts the file.

- **Edits are checked first.** For an Edit or Write to the config Probity would load, `probity-claude` loads the after-state first, from a scratch copy beside the config, and blocks the edit if it wouldn't load.
- **An already-broken config.** If the config already fails to load, edits to it aren't blocked (the normal permission flow decides), and every other deny names the file to fix.

## Capturing what the judge said

Add `--debug <path>` to the hook command to append each hook payload and response to a file. When the judge answers in a malformed format twice, the response quotes its output in full, so the log holds what an issue report needs.
