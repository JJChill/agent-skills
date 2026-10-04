# Changelog

## 0.4.8

Spec↔test parity no longer counts Covers tags from other checkouts
nested inside the project (#55).

- **What went wrong.** The `probity-spec-parity` CLI and the
  `enforceSpecTestParity` and `surfaceScenarioLinkBreakage` rules
  walked every directory under the test roots. That included linked git worktrees Claude Code
  creates at `.claude/worktrees/<name>/`, which are full checkouts with
  their own `// Covers:` tags. In #55 a parity run reported 510 Covers
  tags for 257 scenarios, about twice the real number. A scenario
  claimed only by a test in the nested worktree counted as covered in
  the main checkout, so the gate could pass with no test for it there.
- **Now:** the scan skips any directory below a root that holds a
  `.git` file (a linked worktree or submodule), as the marker gates
  have since 0.4.2 (#39). A root that is itself a linked worktree is
  still scanned.
- Not changed: a commit made inside a nested worktree is still gated
  against the hook's own checkout, not the worktree's (the marker
  gates retarget; the parity gate does not).

## 0.4.7

A judge answer that is not valid JSON is no longer reported as an
outage (#52), in every preset.

- **What went wrong.** The judge sometimes writes its verdict as broken
  JSON: an unescaped `"` or a line break inside `reason`, or an answer
  cut off mid-string. Probity then reports "could not parse verdict",
  and `withJudgeFailureDiagnostics` rewrote that as "returned no
  verdict … an infrastructure failure … retrying … will not help". In
  #52 the judge had in fact denied the write for over-implementation.
  The agent was told the judge was down, and that retrying was
  pointless.
- **Now:** the wrapper tells the two causes apart.
  - The provider reports it is unavailable (spend limit, quota, rate
    limit, auth), or no AI agent is configured: unchanged. No retry;
    the message still says retrying will not help until the judge is
    back.
  - The judge answered, but not as a valid verdict: it is asked once
    more, and a well-formed second verdict stands. If the second answer
    is still malformed but reads as a deny, the block is reported as
    the policy decision it is, with the judge's reason quoted in full.
    Anything else stays blocked, with the judge's output in full, and
    the message says retrying the same write may succeed.
- Agents already retry a blocked write, so the automatic retry changes
  what the agent is told, not how many chances the write gets.
- Tested with scripted verdicts run through Probity's own parser: an
  unescaped quote, a raw line break, a cut-off answer, a malformed
  pass, and prose. The raw output of the #52 answer was not recorded,
  so this is not a replay of it. `hooks/PROBITY.md` now points at the
  `--debug <path>` hook option for capturing such output.

## 0.4.6

A TDD judge deny that ends in a bare "Pass." is now judged again (#50).

- `withContradictionRetry` (0.4.4, all presets) re-runs the judge once
  when a deny's last sentence concludes the write is allowed. It only
  recognised phrases like "This is permitted." and "should pass". A
  recorded deny ended "Reconsidering: ... It is not
  over-implementation. Pass." and was not retried; the identical write
  passed on the agent's own retry. The pattern now also matches a bare
  verdict word ("Pass.", "Allowed.", optionally after "So," or
  "Verdict:") and a closing "is not over-implementation" or "is not a
  violation". It still ignores "does not pass", "is not permitted",
  and sentences like "the tests pass". The second verdict still
  stands, deny or pass. Tested with scripted verdicts, including the
  recorded #50 reason.

## 0.4.5

The Kotlin and KMP TDD judge no longer blocks a behavior-preserving
extraction under green (#48).

- **Moving tested logic into a helper is allowed as a refactor, not
  only as green.** The 0.4.4 instruction for #46 described the move
  only as a green step for a failing test. The judge then read it as
  the sole way an extraction could pass, and required a fresh red for
  a plain refactor. Removing duplicated logic from two use cases was
  blocked with every test green: "the move-existing-logic allowance
  requires ... a failing test needing this call path". The
  instruction now names both phases. In green, the move serves a
  failing test. In refactor, no failing test is needed when the most
  recent relevant test or build run passed and none is outstanding.
  It also says a move includes rewiring a caller to the helper, and
  renaming the helper, its parameters or its result type. A helper
  with logic that appears nowhere in the session, or a move that adds
  a branch, still needs its own red.
  Live judge on a replica of the recorded #48 session (green build,
  both copies grepped, no failing test): adding the helper was allowed
  2 of 6 times on 0.4.4 and 8 of 8 on 0.4.5. Rewiring a caller passed
  on both. Controls stayed denied 8 of 8 on 0.4.5: a helper with new
  logic under green, moved logic plus a new branch, and the three
  0.4.4 controls.

## 0.4.4

Fixes for a one-test Kotlin write that reached the AI judge and was
denied by a reason that said it was permitted (#45), and for
extracting a shared helper under green (#46).

- **Kotlin fast path: a new test may reuse other tests' local names
  (#45).** The fast path passes a write adding exactly one `@Test`
  without an AI call. Its shadowing screen, which stops a write from
  redefining something existing tests call, counted every `val`
  inside the new test's body as a class-level declaration. Tests in
  one file routinely declare the same locals (`val cli`,
  `val composition`), so the #45 write went to the judge. Declarations
  inside a function body, lambda, initializer or accessor are now
  skipped: they are visible only there. Replayed on the recorded #45
  write and the file as committed just before it: 0.4.3 called the
  judge, 0.4.4 passes with no judge call.
- **A deny that concludes "permitted" is judged again (#45), in every
  preset.** Probity's judge answers `{"kind", "reason"}` in that
  order, with thinking disabled, so it picks `kind` before it
  reasons. The #45 block ended "... adds only ONE new test (the delete
  test). This is permitted." and still denied; the identical retry
  passed. New wrapper `withContradictionRetry` (in `rules/gates.ts`)
  re-runs the judge once when a deny's last sentence says the write is
  permitted, allowed, or should pass. The second verdict stands, deny
  or pass. Every other verdict is untouched. The JS, Swift, Kotlin and
  KMP presets all use it. Tested against the recorded #45 reason with
  scripted verdicts; the contradiction did not recur in 6 live runs,
  so the retry is not measured live.
  Asking the judge to reason before choosing `kind` was tried and
  rejected: it let a production write with no recorded failing test
  through 5 of 8 times, against 0 of 8 without it.
- **Moving tested logic into a shared helper is minimum green (#46),
  Kotlin and KMP judge.** When a second use case's failing test needs
  logic that production code already has, moving that logic into a
  helper (and a small result type) is no longer over-implementation.
  The helper may keep every branch the existing logic has. This
  applies only when the same logic appears in the current file or in
  a production file read or edited in the recent session. A helper
  whose logic appears nowhere else still needs its own red. Live
  judge on a replica: 0.4.3 allowed 0 of 6, 0.4.4 allowed 8 of 8.
  Three negative controls stayed denied 8 of 8: the same helper with
  no sign of the logic in the session, moved logic plus one new
  branch, and a production write whose test was sent but never run.
- **Parallel dependent edits (#46): documentation only.** Each write
  is judged against the file on disk, before its siblings land, and
  the judge cannot tell a parallel sibling from a finished write.
  Telling it that a session action with no output yet is an in-flight
  sibling was tried and dropped. Where the sibling is visible, 0.4.3
  already allowed the call-site edit (6 of 6), and the instruction let
  a production write through when its test had only been sent and
  never run (6 of 6 allowed; 0.4.3 denied 6 of 6). `hooks/PROBITY.md`
  now says to send dependent edits one after another, and to extract a
  helper in place in the file that holds the logic before calling it
  from elsewhere.

## 0.4.3

The Kotlin TDD judge no longer blocks adding a new red test (#43).

- **Fast path missed tests inserted above another test.** The Kotlin
  fast path passes a write that adds exactly one `@Test` without an AI
  call. It located the inserted text with a greedy common prefix, so a
  test inserted ABOVE an existing test (an Edit anchored on the next
  test's header) shared the `@Test` / `fun` header text, the inserted
  span started mid-header, and the write went to the judge. The fast
  path now considers every equivalent placement of the insertion and
  uses the one holding the new test whole. The file is the same in
  every placement, so the existing safety checks are unchanged.
- **The judge demanded a failing run before a test could exist.** When
  a new test did reach the judge, it could apply "must be observed
  failing first" to the test write itself. The Kotlin judge
  instructions now state that adding a failing test is the red step and
  needs no prior run, whether the behavior is missing or present but
  wrong (including uncommitted production changes); the observed-red
  requirement applies only to the production write that follows.
  Checked against the live judge on a replica of the reported case: the
  0.4.2 instructions denied 3 of 3 runs, the new ones allowed 3 of 3.

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
