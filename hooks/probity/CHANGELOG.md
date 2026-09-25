# Changelog

## 0.4.2

Fixes for Claude Code sub-agents and git worktrees.

- **Sub-agent work is invisible to Probity (#40).** When a Claude Code
  sub-agent calls a tool, the hook payload carries the parent session's
  `transcript_path` plus an `agent_id`. The sub-agent's own tool calls
  are recorded only in `<session>/subagents/agent-<agent_id>.jsonl`, so
  every history-based rule judged sub-agent work against the parent's
  history. The characterization marker could never be released, and the
  TDD judge never saw a sub-agent's red runs. New bin `probity-claude`
  points `transcript_path` at the sub-agent's transcript, then runs
  Probity unchanged. **Action needed:** change the PreToolUse hook
  command to `cd "$CLAUDE_PROJECT_DIR" && ./node_modules/.bin/probity-claude`.
- **Large test output hid the proof (#40).** Claude Code keeps only a
  2KB preview of a large tool output in the transcript and saves the
  rest under `tool-results/`. The characterization removal check now
  reads that saved output, so a long Gradle run's `FAILED` line counts.
- **Worktrees blocked each other's commits (#39).** The mutation-probe
  and characterization commit gates scanned every file under the root,
  including linked worktrees Claude Code creates at
  `.claude/worktrees/agent-<id>/`. They now skip any directory holding
  a `.git` file (a linked worktree or submodule), and a commit made in
  a worktree nested inside the root is checked against that worktree's
  markers only. The target tree is read from `git -C <dir> commit` or
  `cd <dir> && git commit`, else the hook's working directory.
- Both gates now also trigger on `git -C <dir> commit` and
  `git -c key=value commit`; before, only the literal `git commit`
  was gated.

## 0.4.1

More preset options, so a project with its own conventions can call a
preset instead of copying its rules:

- KMP preset: `seamHint` (the core ambient-effect screen's pointer to
  your clock/randomness port), `conventionHint` (your telemetry
  convention, given to the adapter-observability judge), and
  `acceptanceLanguageGlobs` (which files get the acceptance Language
  Test, e.g. `*Spec.kt` only when driver/DSL files use other names).
- Kotlin preset: `conventionHint`.

Every default is unchanged.

## 0.4.0

Preset options, so projects stop forking rule lists:

- **KMP preset options (#19).** `kmpRuleEntries(root, options)` takes a
  `KmpPresetOptions` object: `specsDir`, `specGlobs`, `glossaryPath`,
  `coreGlobs`, `acceptanceTestGlobs`, `testRoots`, `testFilePattern`,
  `testDeclarationPattern`, `baselinePath`, `driverScopes`,
  `defaultScopes`. Each defaults to the previous hardcoded value, and
  the old `kmpRuleEntries(root, { driverScopes, defaultScopes })` call
  still works.
- **Excluding spikes and build output (#21).** The JS, Kotlin, and KMP
  presets take `excludeGlobs`, default `['spikes/**', '**/build/**']`,
  appended as `!` negations to every files-scoped block. Pass `[]` to
  turn it off. **Behavior change:** writes under `spikes/` or a `build/`
  directory are no longer checked by these presets' rules.
- **JS spec-to-test traceability (#18).** Setting `specsDir` on
  `jsRuleEntries` wires `requireSpecBackedAcceptanceTest`,
  `surfaceScenarioLinkBreakage`, `enforceSpecTestParity`, and (with
  `glossaryPath`) `surfaceGlossaryTermBreakage`, as the KMP preset
  does. Off by default.
- **TypeScript test declarations (#12).** New `JS_TEST_DECLARATION`
  matches vitest/jest/mocha `it(`/`test(` and their `.only`/`.skip`/
  `.each(...)(` variants; the JS preset uses it by default.
- New helper `withExcludeGlobs(entries, globs)` in `rules/scoping.ts`.

`probity-scope-report --allow-empty <glob>` (repeatable) marks a block
as expected to be empty, so a greenfield repository can run `--strict`
in CI from its first commit (#20). A flag that matches no block's glob
is a warning; a flag whose block now has files is noted.

## 0.3.0

Kotlin and KMP presets now wire the characterization round-trip the
Swift preset already had (issue #34). A test that pins behavior
production already has — for example a branch an independent mutation
review found untested — is born green, so no red can precede it, and
the TDD judge could block it with no honest way forward. Now:

- a test-source write (`src/test`, or any `src/<name>Test` source set)
  carrying `// probity: characterization` above the test passes without
  the judge; the marker does nothing in production source;
- the marker comes off only when the session transcript records that
  test failing (typically under a `// probity: mutation-probe`), and the
  new `enforceCharacterizationResolution` commit gate blocks `git commit`
  while any marker is on disk;
- `withCharacterizationTest` (all presets that use it) appends a note
  naming the marker when it denies an unmarked test-layer write for
  lacking a red, and resolves backticked Kotlin test names
  (``fun `rejects blank ids`()``) in full for the removal proof.

**Behavior change:** Kotlin/KMP commits are now blocked while a
`probity: characterization` marker is on disk. No existing project
carries the marker unless it opted in.

The TDD judge in every preset reports a judge that returned no verdict
as an infrastructure failure (issue #32). A spend-limit, quota, or auth
notice used to surface as `could not parse verdict from validator
output: …`, which reads as a rejection of the change. The write is
still blocked (fail closed), but the deny text now says it was not
judged, whether the provider reported itself unavailable, and which
writes still pass deterministically. The wrapper is exported as
`withJudgeFailureDiagnostics` from `rules/gates.ts`.

`probity-scope-report` no longer flags test files under a core-purity
rule as "adapter/DI/UI-looking" (issue #26). A test-wide
`forbidContentPattern` (such as a no-mocking-library screen over every
test source set) legitimately covers adapter tests; the old warning
suggested excluding them, which would weaken the check. Production
adapter paths are still flagged.

## 0.2.3

`enforceSpecTestParity` now inspects the pending Git commit before scanning
specifications and acceptance tests. It runs only when that commit records the
specs path (including a git-submodule pointer) or a path matching the configured
acceptance-test pattern; Git inspection failures retain full enforcement.

This restores the documented specs-first order for projects whose specs live in
a separate repository: committing an `@wip` removal inside the specs checkout,
or committing unrelated parent-repository work while that checkout is dirty, no
longer scans an uncommitted submodule worktree that cannot yet contain its
covering SDK test. The later parent commit that records the new specs pointer or
acceptance test still enforces bidirectional parity. No config change is needed.

## 0.2.2

Kotlin and KMP presets now retain up to 20 recent session events, each
clipped at 6,000 characters, for the AI TDD judge. This keeps a nearby
targeted red visible after normal source inspection while bounding prompt
growth. Their Kotlin-specific guidance also makes explicit that:

- as an exception to generic placeholder guidance, a targeted relevant test
  executing `TODO()`/`kotlin.NotImplementedError` is clean red without a
  second assertion-failure run, while implementation remains bounded by
  assertions in that test source visible in recent history;
- compile/import/signature failures authorize scaffolding only, not the
  asserted production behavior;
- one observed failure may drive one cohesive write across every method or
  branch those visible assertions require, without artificial reruns
  mid-write; and
- Git staging/index state is irrelevant to the judgment.

JavaScript and Swift presets retain their existing instructions and history
windows.

## 0.2.1

`requireGreenTestRun`'s Kotlin/Gradle defaults are stricter and cover more
real Gradle usage:

- Accepts `build`/`check` (run tests without the word "test"),
  module-qualified tasks, `allTests`, `jvmTest` — but rejects `--dry-run`,
  `-x`/`--exclude-task`, flag values that read like a task (`--args=build`),
  and lookalike tasks that don't run one (`assembleAndroidTest`, ...).
- Recognizes verification invocations inside compound/piped strings while using
  a structured command check to reject `./gradlew test; echo gradlew` as proof
  from exit status alone.
- Under Kiro, a quiet run with no `BUILD SUCCESSFUL` banner is accepted via
  the tool result's structured `exit_status`, only when that Gradle
  invocation is provably last; piped/chained/`|| true` runs still need the
  banner. A malformed envelope or non-zero `exit_status` is always red.
- Failure detection also recognizes `FAILURE:` and `Execution failed for
  task`.
- `gates.ts`'s `requireGreenTestRun` gained additive, optional hooks:
  `commandPredicate`, `extraSuccessPredicate`, `extraFailurePredicate`.
  Unused by default; no behavior change for existing callers.
- Fixed an isolation defect: the Swift preset no longer inherits
  Gradle-flavored deny text or the Kiro shortcut — both apply only when
  `command` is referentially `GRADLE_TEST_COMMAND`.
- `options.reason`, when set, now appends on both deny paths (previously
  only "no run recorded" did).

## 0.2.0

Kotlin presets now receive the ast-grep Kotlin parser automatically through
exact-version optional dependencies. A normal `@jjchill/probity-rules`
install can therefore recognize a single new red `@Test` deterministically
instead of silently sending it to the AI TDD judge.

The Kotlin fast path is also conservative: only a Kotlin test-source write
that adds one runnable, structurally annotated test and preserves every prior
source byte and test function bypasses the judge. Existing files may make one
contiguous insertion containing only the test (plus comments/whitespace) or a
separate test class with no additional functions; brand-new files may include
imports and property fixtures. Test deletion, disabling or weakening, new disable controls, changes
to existing test-container headers, declarations that shadow identifiers used
by existing tests, and multi-test additions continue to delegate. Production-source paths now always delegate, closing a
latent bypass that becomes material when parser support is installed by
default. If parser support or current-file content is unavailable, the
delegated result carries an explicit fast-path-unavailable diagnostic. As
with Probity's built-in fast paths, a deterministic pass skips the AI judge's
refactor-readiness check for that write.

The optional parser packages include platform-specific native artifacts and
the Kotlin grammar's install script. npm tolerates an unsupported optional
install and the rule falls back as above; consumers that do not use Kotlin or
need to avoid optional install work can use `npm install --omit=optional`.

## 0.1.0

First packaged release. Previously, consumers `cp`'d `probity.config.ts` +
`rules/` + `scripts/` into their project; rule fixes in this fork never
reached them. Rules and scripts are now a versioned npm package
(`@jjchill/probity-rules`); the config stays project-owned and imports
preset factories from the package.

Migrating from the copied-templates layout:

- `./rules/<x>.js` imports → `@jjchill/probity-rules/rules/<x>`
- `npx tsx scripts/scope-report.ts` → `npx probity-scope-report`
- `node scripts/spec-parity.mjs` → `npx probity-spec-parity`

Or run `/probity-update`, which detects the legacy layout and offers to
migrate it for you.
