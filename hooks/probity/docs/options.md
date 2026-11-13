# Options reference

The options the presets take beyond the per-preset layout globs, what each one switches on, and the rules behind them. Every preset's options and defaults are also documented at the top of its module in [`presets/`](../presets/). Per-preset options are on the preset pages: [JS/TS](presets/js.md), [Kotlin and KMP](presets/kotlin.md), [Swift](presets/swift.md).

Back to the [overview](../../PROBITY.md).

- [Excluding paths from every rule (`excludeGlobs`)](#excluding-paths-from-every-rule-excludeglobs)
- [Adapters only an app can exercise (`harnessGlobs`)](#adapters-only-an-app-can-exercise-harnessglobs)
- [Vendor adapters only a live session can exercise (`vendorAdapterGlobs`)](#vendor-adapters-only-a-live-session-can-exercise-vendoradapterglobs)
- [Review record (`requireReviewRecord`)](#review-record-requirereviewrecord)
- [Review routing (`probity-review-route`)](#review-routing-probity-review-route)
- [Review obligations (TDD exemptions that name a reviewer)](#review-obligations-tdd-exemptions-that-name-a-reviewer)
- [Driving adapters by project layout (`drivingAdapterGlobs`)](#driving-adapters-by-project-layout-drivingadapterglobs)
- [No fixed waits in acceptance code (`fixedWaitGlobs`)](#no-fixed-waits-in-acceptance-code-fixedwaitglobs)
- [Test isolation in the acceptance DSL (`dslIsolationGlobs`)](#test-isolation-in-the-acceptance-dsl-dslisolationglobs)
- [Shell writes to scoped files (`shellWriteScreen`)](#shell-writes-to-scoped-files-shellwritescreen)
- [Layered imports (`enforceLayeredImports`)](#layered-imports-enforcelayeredimports)
- [Spec↔test traceability](#spectest-traceability)
- [Ubiquitous language](#ubiquitous-language)
- [Choosing the AI judge (`ai`)](#choosing-the-ai-judge-ai)
- [Judge prompt size (`compactJudgeFiles`)](#judge-prompt-size-compactjudgefiles)

## Excluding paths from every rule (`excludeGlobs`)

A `{ files, rules }` block's `files` list accepts `!`-prefixed globs as negations (picomatch's `ignore` option) beside the includes; see [`rules/scoping.ts`](../rules/scoping.ts).

The KMP, Kotlin and JS presets take `excludeGlobs` (default `['spikes/**', '**/build/**']`), which appends a `!` negation for each glob to *every* files-scoped block the preset wires. A throwaway spike or generated build output is then never claimed by the TDD gate, the boundary rules or any other write-scoped rule, without hand-editing each block. It doesn't affect flat rules that aren't files-scoped (the commit gates). `excludeGlobs: []` turns it off.

## Adapters only an app can exercise (`harnessGlobs`)

Some adapters can't be tested in a plain test process. The iOS Keychain, for one, refuses an unsigned Kotlin/Native simulator test (errSecNotAvailable), so a Keychain adapter's real behaviour only shows inside a signed app. A project then runs a shared contract in a device harness app that logs the names of the checks that fail ([#94](https://github.com/JJChill/agent-skills/issues/94)). The KMP and Kotlin presets support that loop:

- **`harnessGlobs`** (e.g. `['harness/**']`) takes the harness's own code out of the TDD block. A check-runner that can only run in the app could never be green under the TDD gate, because its Gradle test reaches only the failure path. The paths stay under every other block: core boundary, adapter observability, the shell-write screen.
- **The TDD judge counts a harness run as a red.** When the session shows the app's output naming failing checks, and the checks' source, each named check is an observed failing test for the adapter it exercises, and authorizes the behaviour it asserts. A Gradle test that can only reach the adapter's refusal path doesn't narrow that.
- **Boundary events are part of the minimum green.** The event the observability rule requires at each external call a red covers (one per call or outcome, static fields) goes in with that call's green, instead of needing a red of its own. Anything else the contract doesn't assert, such as an item's accessibility attribute, still needs its own red: write a harness check for it, run it in the app, then implement.

```ts
rules: kmpRuleEntries(ROOT, { harnessGlobs: ['harness/**'] }),
```

## Vendor adapters only a live session can exercise (`vendorAdapterGlobs`)

Some adapter code can't go red in any offline test. A vendor SDK such as Twilio Voice or Video calls `onConnected`, `onParticipantDisconnected` or a call invite's listener only during a live call, with a valid access token or a real push. Host tests reach the decisions behind the port with fakes, and device tests can reach the failure path (Twilio rejects a bad token), but the success callbacks never fire offline, so the TDD gate can never authorize them ([#102](https://github.com/JJChill/agent-skills/issues/102)).

The KMP, Kotlin and Swift presets take `vendorAdapterGlobs`, off by default. The files it names leave the TDD block and are held to **`enforceForwardingOnlyAdapter`** instead, an AI judge for adapters that hold nothing worth testing:

- **Passes:**
  - one-to-one forwarding of a vendor callback to a port method, and of a port call to the SDK (`leave()` → `room.disconnect()`);
  - reading what the vendor objects hold and converting it to the port's types (ids, error codes, a plain enum mapping, the size of the room's participant list);
  - holding and releasing the vendor objects the forwarding needs (invites keyed by call SID);
  - listeners, wiring and boundary telemetry.
- **Blocks:**
  - a decision (a branch on state, a value or a vendor error code);
  - state beyond the held vendor objects (counters, sets, timers);
  - policy (retries, backoff, de-duplication, sequencing several calls);
  - computation the adapter works out itself.

  The deny says to move it behind the port, where a host test with a fake drives it red first.

Adapter observability and the shell-write screen still cover these files. Name only the vendor-facing files, and keep tests out:

```ts
rules: kmpRuleEntries(ROOT, { vendorAdapterGlobs: ['**/src/androidMain/kotlin/**/adapter/Twilio*.kt'] }),
```

If your project *can* get credentials into a session, a device test against the real service is still the stronger evidence: its failing run is an ordinary red for the TDD gate, and the file needs no `vendorAdapterGlobs`.

## Review record (`requireReviewRecord`)

`requireGreenTestRun` proves the tests ran; nothing proved a review ran ([#178](https://github.com/JJChill/agent-skills/issues/178)). A merge into a protected branch can be required to carry the review record from code-review-and-quality (Step 6): `Reviewed-by-agent:` trailers in the last paragraph of the merge message. The record lists every reviewer considered, with `(ran, N findings[, M fixed])` or `(skipped: <reason>)`.

Settings live in a named `review` export next to the default one, because Probity's `Config` only takes `rules` and `ai`:

```ts
import { probityConfig, requireReviewRecord, reviewConfig } from '@jjchill/probity-rules'

// One regex for "code a gate cares about", shared with requireGreenTestRun's enforceForPaths.
const CODE = /^(src|app)\//

export const review = reviewConfig({
  record: { enforceForPaths: CODE, protectedBranches: ['main'] },
})

export default probityConfig({
  rules: [...kotlinRuleEntries(ROOT), requireReviewRecord(review)],
})
```

**The gate (PreToolUse)** denies `git merge` into a protected branch when the merge brings in a file matching `enforceForPaths` and its `-m`/`-F` message has no valid record.

- **Finding the merge.** It finds the merge after a `cd` and with `git -C`. It judges the merge against the branch that a `git switch` or `git checkout` earlier in the same command moves to (`git switch main && git merge …`), not the branch the session was on. It reads a `-m "$(cat <<'EOF' … EOF)"` heredoc.
- **Fast-forwards.** A merge that would fast-forward is denied, because no commit would hold the record; use `--no-ff`.
- **`gh pr merge`.** It reads `--body`/`--body-file` and checks the PR's base branch.
- **Message sources.** It decodes `$'…'` quoting (`-m $'Merge\n\nReviewed-by-agent: …'`). It reads a `-F`/`--body-file` file before the command runs, so write the file in an earlier command and name it by a literal path: a file written by the same command, or named through `$VAR` or `~`, is denied with that reason.
- **`glab mr merge`** (and its `glab mr accept` alias, with or without `--auto-merge` and `-y`). It reads `-m`/`--message`, the merge commit message, and checks the MR's target branch from `glab mr view -F json`. A GitLab project set to fast-forward merges makes no merge commit to hold the record, so the gate denies those. Set **Settings → Merge requests → Merge method** to *Merge commit* or *Merge commit with semi-linear history*.
- **Fail safe.** If it can't list the merged files, it enforces anyway.
- **Not gated:** `--squash`, `--no-commit`, `--abort`/`--continue`, and a merge hidden in `bash -c` or a script.

**The CI backstop.** `npx probity-review-record --range <base>..HEAD` checks every first-parent merge in the range whose own diff touches `enforceForPaths`, and exits 1 naming each commit with a missing or malformed record. It is the only check that sees merges made outside an agent session (a web UI, a person at a shell).

- Start the range where you adopted the record, so earlier merges aren't judged.
- `--all-first-parent` checks direct and squashed commits on the branch too.
- CI needs full history (`fetch-depth: 0` in GitHub Actions), or the range won't resolve and the checker exits 2.
- The [CI templates](../../PROBITY.md#ci) run it on every push to the default branch.

## Review routing (`probity-review-route`)

Which reviewers a change gets shouldn't depend on the agent's judgement ([#181](https://github.com/JJChill/agent-skills/issues/181)). The router maps a diff to the review agents it warrants, using routes in the `review` export, with no model calls:

```ts
export const review = reviewConfig({
  ignore: ['.claude/curator/**'],
  routes: [
    { agent: 'dependency-auditor', why: 'manifest changed', paths: ['**/build.gradle.kts', '**/package.json'] },
    { agent: 'silent-failure-hunter', why: 'error handling', added: /\b(catch|runCatching)\b|getOrNull/ },
    { agent: 'architecture-conformance-reviewer', why: 'test doubles', added: /\b(mockk|Mockito)\b/, lines: 'code' },
    { agent: 'architecture-conformance-reviewer', why: 'third-party import',
      added: /^\s*import /, notAdded: /^\s*import (myapp|kotlin|kotlinx\.coroutines)\./ },
    { agent: 'agent-skills:security-auditor', why: 'secrets', added: /(password|apiKey|bearer|jwt)\b/i },
  ],
  fallback: ['code-reviewer'],
  record: { enforceForPaths: CODE, requireRoutedAgents: true },
})
```

- **A route fires** when a changed file matches `paths`, or when an added line matches `added` and that same line doesn't match `notAdded`. `lines: 'prod'` (the default) greps code files outside `testPaths`; `lines: 'code'` includes test sources too.
- **Never grepped:** files matching `nonCode` (Markdown, text, YAML, JSON, TOML, lockfiles, images), binary files, and `ignore` globs. Ignored files are left out of routing entirely.
- **When nothing fires:** `fallback` runs if a production code file changed. A docs- or config-only diff runs nothing. `always` agents run on any change.
- **Agent names** keep their configured spelling (`agent-skills:security-auditor`). An agent is listed once, with every reason it fired.
- **Globs** in `paths` and `ignore` are relative to `root` (default: the repository root). Regex options are tested against repo-relative paths. Don't point `root` at an absolute path in one checkout: run from another worktree, nothing would match. The CLIs warn when `root` lies outside the repository they route.

**The CLI.** `npx probity-review-route [--base <ref>] [--format text|json]` prints one `agent|why` line per agent, so it can replace a hand-written router hook.

- The base defaults to the merge-base with `origin/<mainBranch>`.
- The diff runs from the base to the working tree, plus the index and any untracked files that aren't gitignored.
- It reads only added lines, never the `+++ b/<path>` header, so a file name can't fire a content route.

**Requiring the routed agents.** With `record.requireRoutedAgents`, the merge gate routes what the merge brings in and denies a record that doesn't list each selected agent (ran, or skipped with a reason). A routing error denies (fail safe). In CI, pass `--routed-range <before>..HEAD` (in GitHub Actions, `${{ github.event.before }}..HEAD`) to `probity-review-record`, so only newly pushed merges are judged against today's routes; re-routing old merges would fail every merge made before a route existed. An all-zero start (a new branch or a force push) skips the routed checks.

## Review obligations (TDD exemptions that name a reviewer)

Projects carve files out of TDD where no harness can drive them red, such as `!**/*Screen.kt` for thin rendering. The carve-out is only safe while review keeps those files thin, and nothing tied the two together, so logic leaked into an exempt screen ([#181](https://github.com/JJChill/agent-skills/issues/181)). An exemption can declare its obligation on the negation itself:

```ts
const rules = kotlinRuleEntries(ROOT, {
  tddGlobs: [
    'ui/web/src/**',
    {
      glob: '!ui/web/src/commonMain/**/*Screen.kt',
      id: 'thin-rendering',
      reviewWith: 'code-reviewer',
      check: 'no branching on domain state; only renders view-model fields',
      reason: 'screens are thin rendering; logic is unit-tested in the view model',
    },
  ],
})

export const review = reviewConfig({ record: { enforceForPaths: CODE, requireObligations: true } })

export default probityConfig({
  rules: [...rules, requireReviewRecord(review, { obligationsFrom: rules })],
})
```

- **Where it's accepted.** `tddGlobs` in the Kotlin, JS and Swift presets, and `tddExemptions` in the KMP preset, whose TDD globs are fixed. For hand-written blocks, use `reviewedBlock({ files: [...], rules })`. Other glob options take strings only.
- **What the block gets.** The plain `!` negation, so TDD scoping is unchanged. The obligation travels with the block as metadata.
- **Routing.** `probity-review-route` lists each obligation a diff incurs, with its files, and routes the `reviewWith` agent with the `check` as the reason. Obligations never suppress the fallback.
- **The record.** It must carry `Review-obligation: <id> (addressed by <agent>)`, and that agent must have run, not been skipped. With `requireObligations`, the merge gate denies otherwise, and so does `probity-review-record --routed-range` in CI.
- **Setup.** `probity-scope-report` lists each obligation with the number of files it covers. It warns (exit 1 under `--strict`) about a plain `!` in `tddGlobs` that declares no obligation.
- **Paths.** Obligation globs, like route globs, are matched relative to `review.root`, which defaults to the repository root. If `probity.config.ts` isn't at the root, set `root: ROOT`.

## Driving adapters by project layout (`drivingAdapterGlobs`)

Where the driving adapters live, and where the [thin-adapter judge](rules.md#enforcethindrivingadapter--forbidnewdomaindiscriminantchecks) learns what the core already exports, depends on the layout. The JS preset wires the block by default, because React apps usually keep UI and domain together. The Kotlin, KMP and Swift presets wire it only when `drivingAdapterGlobs` is set: a core-only repo has no UI, and a default glob there would only show up as a `DEAD SCOPE` in `probity-scope-report`.

| Layout | Example | `drivingAdapterGlobs` to start from | Core exports for the judge |
|---|---|---|---|
| UI with the core | a React app; a KMP app with `composeApp/` | JS: the default. KMP: `['**/composeApp/src/**', '**/src/*Main/**/ui/**', '!**/*Preview*.kt']` | `coreExportsInJudge: true` (reads `coreGlobs` source) |
| Core-only SDK with a CLI | a KMP SDK with a `cli/` module | `['cli/src/main/**/commands/**']` (leave out the composition root and config adapters) | `coreExportsInJudge: true` |
| UI-only app on a core SDK | an Android app depending on the SDK as a library | the app's `ui/` packages | `coreApiPaths: ['path/to/sdk/api']`, the SDK's `.api`/`.klib.api` dumps |
| SwiftUI with the core (one app, or core and UI targets in one repo) | an iOS app with `App/Sources/Modules/*` | `['App/Sources/**/Views/**', 'App/Sources/**/*View.swift', 'App/Sources/**/*Screen.swift', '!**/*Tests.swift', '!AcceptanceTests/**', '!**/Previews/**']` | `coreExportsInJudge: true` (reads `coreGlobs` Swift source, views left out) |
| SwiftUI app on a core package or framework | an iOS app depending on the SDK as a Swift package or XCFramework | the app's view layer | `coreApiPaths: ['path/to/Core.xcframework']`, its `.swiftinterface` files (`.private` and `.package` ones are skipped) |

Swift specifics are on the [Swift preset page](presets/swift.md#views-and-the-thin-adapter-judge).

## No fixed waits in acceptance code (`fixedWaitGlobs`)

The JS/TS, Kotlin and KMP presets screen the acceptance suite for new fixed waits with `forbidNewFixedWaits()` ([`rules/gates.ts`](../rules/gates.ts)), the counterpart of the Swift preset's sleep screen.

- **What it matches.** Kotlin (`KOTLIN_FIXED_WAIT_PATTERNS`): `Thread.sleep`, `TimeUnit.*.sleep`, `SystemClock.sleep` and `delay(`. JS/TS (`JS_FIXED_WAIT_PATTERNS`): `waitForTimeout`, `setTimeout`, numeric `cy.wait`, `sleep(` and `browser.pause`.
- **Why `delay(` too.** Under `runTest` it only moves virtual time, but an acceptance test should advance its test clock or wait for the concluding event, not wait a set amount.
- **Scope.** The whole suite, DSL and drivers included, through `fixedWaitGlobs` (default `['**/acceptance/**']`; `[]` turns it off).
- **Delta-based.** Waits already in a file don't block edits to it, and waits named in comments don't count.
- **The poll helper.** Drivers wait through one poll-for-concluding-event helper; exempt that helper's file with a `!` glob in `fixedWaitGlobs`.

## Test isolation in the acceptance DSL (`dslIsolationGlobs`)

Every preset can judge the acceptance DSL for test isolation with `enforceTestIsolation()` ([`rules/acceptance-language.ts`](../rules/acceptance-language.ts), [#119](https://github.com/JJChill/agent-skills/issues/119)).

- **Denies:** an entity a test creates in a shared SUT reaching it without an alias, a stub keyed on the raw name instead of the aliased one, a write to a shared fixture, and clean-up of test data.
- **Passes:** closing driver resources. A DSL that builds a fresh SUT per test passes the aliasing and clean-up checks.
- **What the judge sees.** The file's first 30 lines and the changed lines with a little context, never the whole file. It isn't called when a write adds no code.
- **Opt-in** through `dslIsolationGlobs` (for example `['**/acceptance/dsl/**']`). Every DSL write that adds code costs a model call, and in-process suites with a fresh SUT per test rarely need it. Turn it on when the suite runs against a SUT that outlives a test.

## Shell writes to scoped files (`shellWriteScreen`)

Probity's content rules judge write actions: `Write`, `Edit` and `NotebookEdit` in Claude Code, the write tool in Kiro. A file changed by a shell command (`sed -i`, `cat > file <<EOF`, `tee`, `cp`/`mv`, `git apply`, or a `python3 - <<'EOF' … open(p, 'w')` script) reaches Probity as a command, so none of those rules see it. Scripted edits are an ordinary shell idiom, which makes this an easy bypass to take by accident ([#79](https://github.com/JJChill/agent-skills/issues/79)).

Every preset puts `forbidShellWritesToScopedFiles` ([`rules/shell-writes.ts`](../rules/shell-writes.ts)) first. It reads each shell command for the files it writes and denies the command when one of them falls inside any files-scoped block the preset wires (`excludeGlobs` applied), telling the agent to make the change with the write tool. It is deterministic and costs no AI call. It covers Claude Code's `Bash` and Kiro's `shell` (through the Kiro shim) alike.

**What it recognises.** It reads the command text and doesn't run it.

- Redirects (`>`, `>>`, `&>`) and `tee`.
- `sed -i` and `perl -i`.
- `cp`/`mv`/`install`/`ln`/`rsync` destinations, `dd of=` and `truncate`.
- Patches from `git apply` or `patch` (a heredoc or a patch file).
- `python`/`node`/`ruby`/`perl`/`bun`/`deno`/`php` scripts given inline (`-c`, `-e`, a heredoc) that call a file-writing API. For such a script, any scoped path the command mentions counts, because the script can name its target through a variable or an argument. A script that reads a scoped file and writes a report elsewhere is therefore denied too; print the report to stdout instead.

It follows shell variables, `for` loop variables and `cd` within the command, and resolves relative paths from the session's cwd when the hook passes it (`probity-claude` and the Kiro shim do).

**What still passes:**
- a script file named on the command line (`python3 tool.py`);
- writes through `find -exec` or `xargs`;
- paths computed at run time;
- formatters (`prettier --write`, `ktlint -F`, `swiftformat`);
- `git checkout` and `git restore`.

**Commit detection.** The commit gates (`requireGreenTestRun`, `enforceSpecTestParity`, `enforceProbeReversion`, `enforceCharacterizationResolution`) read commands with the same parser (`isGitCommit`).

- **A commit** is `git` running with `commit` as its subcommand (any global options before it), or those words reaching something that might execute them: a shell, `eval`, `xargs`, `find -exec`, an interpreter, a pipeline into one, or a `$(…)`/backtick substitution the shell expands whose own command is a commit.
- **Not a commit:** the same words as data. That covers a quoted heredoc written to a file with `cat`, an `echo`, a `gh` or `glab` body (including `--body "$(cat <<'EOF' … EOF)"`), a `grep` pattern, and backticks inside single quotes. `"$(git commit …)"` and backticks inside double quotes still count.
- **Fail closed.** Commands not known to treat their input as data still count.

**Turning it off, and custom blocks.** `shellWriteScreen: false` switches it off. A config that adds its own `{ files, rules }` blocks next to a preset's should screen them too: build the list with the preset's screen off and wrap the whole list.

```ts
import { withShellWriteScreen } from '@jjchill/probity-rules'

rules: withShellWriteScreen(
  [...kmpRuleEntries(ROOT, { shellWriteScreen: false }), ...projectBlocks],
  { root: ROOT },
),
```

## Layered imports (`enforceLayeredImports`)

For code organised as ordered layers, where each layer may use only the layers below it: atomic design levels in a design system (tokens, atoms, molecules, organisms, templates), or presentation over domain over data. A test that scans the sources catches an upward import after the write; this rule refuses it at write time and names the layer order. No preset turns it on. Add a block for the layered code:

```ts
import { enforceLayeredImports } from '@jjchill/probity-rules'

const D = 'com.example.ui.design'
// in Config.rules, after the preset's entries:
{
  files: ['ui/design/src/**/*.kt', '!**/src/*Test/**'],
  rules: [
    enforceLayeredImports({
      layers: [
        { name: 'tokens', packages: [`${D}.tokens`] },
        { name: 'atoms', packages: [`${D}.atoms`] },
        { name: 'molecules', packages: [`${D}.molecules`] },
        { name: 'organisms', packages: [`${D}.organisms`] },
        { name: 'templates', packages: [`${D}.templates`] },
      ],
      hint: 'see ADR 0012',
    }),
  ],
}
```

- **Placing a reference.** `packages` are Kotlin package prefixes or Swift module names; the prefix matching the most segments wins. A Kotlin file is placed by its `package` line, a Swift file by the layer's `paths` globs. A reference or file in no layer is ignored.
- **What counts.** Kotlin: `import` lines and fully-qualified names in code. Swift: `import` lines, including `@testable import` and `import struct M.T`. Comments and string literals are skipped.
- **Siblings.** A nested array is a group at one rank (`[{ name: 'home', … }, { name: 'settings', … }]`): each may use lower ranks, not the others. A `*` segment does the same for packages nobody lists: `com.x.feature.*` makes `feature.home` and `feature.settings` siblings, while `feature.home.ui` may still use `feature.home`.
- **`strict: true`.** A layer may use only the rank directly below it.
- **Delta-based.** Only references the write adds block; an existing upward import doesn't freeze its file.

## Spec↔test traceability

The KMP and Swift presets enforce the `acceptance-testing` skill's definition of done mechanically: every scenario in a spec is claimed by an acceptance test, and every claim resolves to a real scenario. The JS/TS preset does once `specsDir` is set ([JS/TS preset](presets/js.md#spec-first)). The classic Kotlin preset wires only the write-time gate, `requireSpecBackedAcceptanceTest`; nothing there checks parity at commit, link breakage or scenario fidelity, so add those rules yourself or run `probity-spec-parity` in CI. The link is declared, not inferred: a test carries a tag, as a comment or an annotation argument.

```kotlin
// Covers: messaging.feature.md :: Scenario: Message is delivered to a contact
```

**Spec formats.** Markdown feature files (`<name>.feature.md`, `## Scenario:` headings, `(wip)`/`[scope]` markers) and Gherkin (`<name>.feature`, `Scenario:` lines, `@wip`/`@scope` tags) are interchangeable. `Covers:` tags resolve by spec *stem*, so a tag's extension needn't match the file on disk: a suite can migrate one file at a time, or reference specs from a shared `.feature` repository (say, a `docs/specs` git submodule), with parity green throughout. A stem present with both extensions at once is rejected as an unfinished rename.

### The rules

Three deterministic rules in [`rules/spec-test-parity.ts`](../rules/spec-test-parity.ts) hold the invariant from both ends and enforce the *order*, and a judged rule checks the content.

- **`requireSpecBackedAcceptanceTest({ specsDir, testDeclarationPattern? })`** fires at write time on the acceptance test-case layer. A write that adds a new test case must also add a `Covers:` tag naming a scenario heading that **already exists** in `specsDir`.
  - That is spec-first made mechanical: an agent can't author acceptance tests without writing the feature file first, and the deny says what to create and where.
  - It is delta-based: edits inside existing test files pass, and `(wip)`/`(planned)` scenarios count as existing (they are what outside-in work drives against).
  - Without it a tagless suite is invisible to the commit gate. On a real iOS trial, an agent produced a whole suite with no feature file and nothing objected.
  - `testDeclarationPattern` says what counts as a test-case declaration. It defaults to Kotlin/Java `@Test` or Swift `func test…`. For JS/TS the package exports **`JS_TEST_DECLARATION`**: vitest/jest/mocha `it(`/`test(` and their `.only`/`.skip`/`.each(...)(`/`.concurrent` variants, never `describe(` or an identifier that merely ends in "it" or "test" (`split(`, `submit(`, `logger.audit(`). The JS preset passes it by default.
- **`enforceSpecTestParity()`** gates relevant `git commit` actions.
  - **Which commits.** It reads the pending commit and proceeds only when the commit records the specs path (including a git-submodule pointer), the baseline file or an acceptance-test path. Git inspection failures keep full enforcement. That scoping makes a separate specs repository genuinely spec-first: its own commit can remove `@wip` before a covering test exists in the parent, while the parent commit recording the submodule pointer or test still enforces parity.
  - **The check.** It scans `docs/specs/*.feature{,.md}` (the specs directory) for scenarios, Markdown `## Scenario:` or Gherkin `Scenario:`, and the acceptance directories for `Covers:` tags, and blocks with a two-sided report: scenarios no test claims, and tags pointing at scenarios that no longer exist.
  - **What it needs.** Parity requires the *link*, not a passing run (the claiming test may still be red or quarantined). Scenarios still being driven outside-in are exempt as `## Scenario (wip):` or with a Gherkin `@wip` tag.
- **`surfaceScenarioLinkBreakage()`** fires on spec writes. Removing or renaming a scenario heading that tests still claim blocks at once, listing the affected tests, so a rename updates its `Covers:` tags in the same change instead of rotting until commit time.
- **`enforceScenarioFidelity({ specsDir, testRoots?, testFilePattern? })`** ([`rules/scenario-fidelity.ts`](../rules/scenario-fidelity.ts), [#120](https://github.com/JJChill/agent-skills/issues/120)) is the judged half of the link. The rules above prove a tag resolves; this one checks the test says what the scenario says.
  - **On a test write.** It sends each changed claimed test, read through its DSL, to the judge beside the scenario's text. It denies a different precondition, action or outcome, or an outcome the scenario doesn't state. A test that delegates to a shared scenario body in a sibling `*Scenarios.*` file is judged with that file.
  - **On a spec write.** It does the same for each changed scenario that tests already claim.
  - **Adding a step to both sides.** A scenario marked wip (`@wip`, `@planned`, `(wip)`) isn't held to its claims, so a step both sides gain lands in three writes. Mark the scenario wip and add the step. Update the claiming test (judged against the new text). Remove the marker, which judges every claim on the scenario again, a Gherkin tag line included.
  - **Cost.** It calls the model only when a write changes a claim. A write with no changed claim, a claim that resolves to nothing (left to the parity rules), and a test whose body matches another test claiming the same scenario (a second driver running a shared body) all pass for free.
  - **Wiring.** The KMP and Swift presets wire it on their acceptance tests and specs; the JS preset does once `specsDir` is set. `scenarioFidelity: false` turns it off.
  - **Tier check.** Given `appScope` (beside `driverScopes`), the same call checks each changed claim's tier ([#129](https://github.com/JJChill/agent-skills/issues/129)). It reports an untagged scenario whose own text shows the wire, wiring or a platform service decides its outcome. It never reports a tagged one as over-tiered, since walking skeletons and escaped-defect scenarios are app-tier for reasons the text can't show.

### Brownfield adoption

A spec suite that predates the gate would block every specs or acceptance commit (a KMP app it was trialled on had 454 scenarios and no tags). The rule takes a `baselinePath`. Generate the baseline once and commit it:

```bash
npx probity-spec-parity --specs docs/specs --baseline docs/specs/.parity-baseline --write-baseline
```

- Baselined scenarios are exempt from the orphan check, while every new scenario is enforced from day one. Burn the file down by deleting lines as coverage lands.
- A missing baseline file means full enforcement (the greenfield default).
- Dangling `Covers:` tags are never baselined: they are wrong, not legacy.

**The baseline is where dead coverage hides.** While it exists, the parity gate is advisory for everything in it. Mutation checks surface the cost: a mutation probe that stays green under every suite usually means the behaviour's scenario is sitting in the baseline, untested. Treat every green probe as a burn-down prompt (write the claiming test, delete the baseline line), not a reason to pick a different probe.

### Per-scenario driver scopes

The rule can check coverage per *(scenario, driver scope)*, not just per scenario. It is opt-in: the presets set no `driverScopes`.

- **Declaring scopes.** Map each named scope to its test files: `driverScopes: [{ name: 'system', filePattern: /AcceptanceTests[/\\]Specs[/\\]/ }, …]`.
- **Tagging scenarios.** Tag a scenario that needs more than the default suite: `## Scenario [system]: …`, which composes with wip as `## Scenario (wip) [system]:`. A tagged scenario must be covered by a test matching that scope's pattern, on top of the base check.
- **`defaultScopes`** names scopes every scenario must satisfy even untagged (the project's standard driver set).
- **The app tier.** Declare an app scope whose driver builds the app through its shipping composition root, with fakes only at outbound ports. Tag scenarios `[app]` by the `acceptance-testing` skill's tier rules: the wire, wiring or a platform service decides the outcome; a walking skeleton per feature that reaches an external system; and escaped defects. Everything else is claimed at the component tier ([#118](https://github.com/JJChill/agent-skills/issues/118)).
- **Floors, never ceilings.** Extra coverage in other scopes is always fine.
- **Misspelling protection.** A tag naming an undeclared scope blocks.
- **Keys and baselines.** Tags never change scenario keys, so existing `Covers:` tags and baselines are unaffected. Baselined and wip scenarios are exempt from scope checks too.

The rationale and the tag convention are in the `acceptance-testing` skill's Layer 3 section.

### Shared spec repositories

When several projects consume one spec repository (typically a `docs/specs` git submodule), not every scenario is every project's to automate: a backend-enforced rule, say, or SDK-internal behaviour an app built on that SDK doesn't re-cover ([#105](https://github.com/JJChill/agent-skills/issues/105), [#106](https://github.com/JJChill/agent-skills/issues/106), [#111](https://github.com/JJChill/agent-skills/issues/111)). Three files, three meanings:

- **Exclusions file** (`exclusionsPath`; KMP and Swift default `docs/spec-exclusions.txt`; JS `parityExclusionsPath`, no default): standing decisions, "never ours".
  - Format: one `<spec>.feature :: <title> # <reason>` per line. The reason is required and should name the owner (`# backend enforces the block list`, `# covered by the SDK 2.3`).
  - Excluded scenarios skip the orphan and scope checks. They are not debt, so they never go in the baseline, and `--write-baseline` leaves them out.
  - The gate blocks a malformed line, an exclusion matching no scenario, one for a scenario a test now claims, and one for a scenario still in the baseline.
- **Baseline:** a snapshot from adoption that only shrinks. That is a convention; nothing enforces it.
- **Wip file** (`wipPath`; KMP and Swift default `docs/spec-wip.txt`; JS `parityWipPath`, no default; CLI `--wip`): "ours, not done yet".
  - Shared `@wip` markers are controlled by whichever consumer touches the spec first, so each project lists its own here. Same line format as exclusions, with a required note on what is happening or what blocks it.
  - `sharedWip: 'ignore'` (`--shared-wip ignore`) makes the specs' own markers informational, so the wip file is the only list. The default `'honor'` keeps them.
  - The gate blocks a wip line for a claimed scenario (promoted: delete the line), an excluded one, a baselined one, or none.

How they combine:

- **Precedence:** claimed > excluded > wip > baseline.
- **`ignoreTags`:** shared tags that aren't driver scopes in this project, Gherkin `@tags` and Markdown `[tags]` alike. Unknown tags not listed there still block, and a tag listed both as a scope and as ignored blocks as a contradiction.
- **Where the files live.** Keep all three outside the shared tree. The KMP and Swift baseline default is inside `docs/specs`, so a submodule consumer should override it. A commit that changes only one of these files still runs the gate.

### Live-only coverage

Some scenarios' outcomes are produced entirely by a service the project doesn't own (the backend refuses a blocked caller), so a fake can't signal them and only a live run can ([#112](https://github.com/JJChill/agent-skills/issues/112)). A live test, opt-in and usually skipped in CI, still claims the scenario, but that coverage is weaker than a test every build runs.

- **`liveTestPattern`** (CLI `--live <regex>`) marks live test files by path, like a driver scope's `filePattern`. Their claims keep counting. The CLI reports scenarios covered only by live tests as their own group (`… covered (2 by live tests only)`, then the list). The commit gate can't warn, so the pattern alone changes nothing there.
- **`liveFloorScopes`** (CLI `--live-floor a,b`) adds a floor: a scenario tagged with one of those scopes needs a claim from a test that isn't live, and a scenario covered only by live tests blocks.
- When a live test starts claiming an excluded scenario, the exclusion is stale and fails; delete it.

### A dependency's coverage

An app built on an SDK that consumes the same specs shouldn't re-cover the SDK's internals, such as offline sync or how a key backup is sealed ([#114](https://github.com/JJChill/agent-skills/issues/114)). An exclusion naming the SDK works, but nothing checks it. Instead:

1. **The SDK writes its claims** with `spec-parity.mjs --write-claims <file> --claims-source "<name> <version>"`: one line per scenario a finished test claims, pinned to a hash of the scenario's steps (`@id:offline-sync sha=1a2b3c4d5e6f`, or the title form).
2. **The app commits that file** next to its exclusions, points `dependencyClaimsPaths` (CLI `--dependency-claims <file>`, repeatable) at it, and updates it on each SDK bump.

What a claim does:

- **Covers** a scenario the app has no finished test for, while the steps in the app's specs still hash the same.
- **Wording changes.** A reworded title keeps an id claim. Changed steps void it, and the scenario is reported uncovered with a note naming the claim's source.
- **Scopes.** It meets `defaultScopes` but never a scope tagged on the scenario, so a user-facing floor still needs the app's own test.
- **Stale lines.** An exclusion or wip line for a dependency-covered scenario blocks as stale.
- **Unknown scenarios.** Claims for scenarios the app's spec revision doesn't have are ignored.
- **Reporting.** The CLI lists dependency coverage with its source. Everything stays offline: the gate reads only the committed file, never a build cache or lockfile.

### In-progress acceptance tests

A spec that drives a feature is committed with the code while it still fails, **expected-to-fail** ([#115](https://github.com/JJChill/agent-skills/issues/115)). It runs on every build and passes only while its scenario fails, so `requireGreenTestRun` sees a green build and needs no exception, and the build goes red once the feature works.

- **Markers.** The framework's own: Jest `test.failing`, Vitest `test.fails`, Swift Testing `withKnownIssue`, XCTest `XCTExpectFailure`. For Kotlin, a project-owned `inProgress { }` helper; the acceptance-testing skill gives it, since kotlin.test has no expected-failure support and no tags.
- **Claims.** A `Covers:` tag belongs to the test it sits on (the next declaration, with only comments and annotations between) or inside. When that test carries the marker (`inProgressPattern`, CLI `--in-progress`; default `DEFAULT_IN_PROGRESS_PATTERN`), the claim is **in progress**.
- **An in-progress claim is not coverage.** A scenario claimed only by in-progress tests must be wip, or the gate blocks.
- **Promotion.** A wip scenario a finished test claims is promoted, and the gate blocks until its wip marker or line goes. The spec's own marker counts only under `sharedWip: 'honor'`.
- **Which claims count.** Scope checks count only finished claims. Dangling tags and the exclusion contradictions count all of them.
- **The TDD judges** (Kotlin, Swift, JS) are told the same. An expected-to-fail test's green run is no evidence and no red. Adding a new one is allowed. Removing the marker makes it an ordinary test, and adding the marker to an existing test disables it.

### Stable ids

Scenario titles are link keys, so renames must touch the claiming tests; the breakage rule turns that into a guided step. A scenario can instead carry a **stable id**: a Gherkin `@id:<slug>` tag, or `id:<slug>` in the Markdown bracket list (`## Scenario [system, id:<slug>]: …`). References can cite it: `// Covers: @id:<slug>`, a baseline line `@id:<slug>`, an exclusion line `@id:<slug> # <reason>`. Rewording the title then touches nothing else, which matters most with a shared spec repository.

- Ids are optional and written by the spec author.
- They are unique across `specsDir`, one per scenario; both are checked at commit and by the CLI.
- An id is never a driver scope.
- Title references keep working, so a suite migrates one reference at a time.
- The breakage rule passes a title change claimed only by id, blocks dropping an id tests still cite, and, given `specsDir` as the presets pass it, lets an id move to another spec file.
- Retired ids aren't tracked, so don't reuse one.

### The CLI

Hooks only run in agent sessions, so the same check ships as a zero-dependency CLI for CI and human commits: the package's `probity-spec-parity` bin, `npx probity-spec-parity --specs docs/specs` (exit 1 on breakage).

- **Driver scopes:** `--scope system=<path regex>` (repeatable) and `--default-scopes a,b`.
- **Shared-repository settings:** `--exclusions <file>`, `--ignore-tags a,b`, `--wip <file>` and `--shared-wip honor|ignore`.
- **Walking skeletons** ([#129](https://github.com/JJChill/agent-skills/issues/129)). `--app-scope app` (a declared scope) lists feature files with scenarios needing proof but no finished claim at that scope.
  - It is a warning by default, because the commit gate has no warning channel and not every feature file reaches an external system. `--strict-skeleton` makes it fail in CI.
  - Feature files that reach no external system go in a `--skeleton-exempt <file>`, one `<spec>.feature # <reason>` per line. A line for a feature with an app-scope claim, or for no feature, is reported as stale.

## Ubiquitous language

The glossary (`docs/GLOSSARY.md`, format in [`GLOSSARY.template.md`](../GLOSSARY.template.md): one term per `##` heading, one term per concept) is wired into the Kotlin, KMP and Swift presets, and into the JS preset through `glossaryPath`. It is enforced from three directions:

- **Usage in specs:** `enforceAcceptanceLanguage({ glossaryPath })` blocks spec content naming a recorded concept with a synonym or a conflicting term. Strict mode, `requireGlossaryEntry: true`, enforces "the glossary conversation happens first": a domain concept with *no* entry blocks until the glossary gets one. Turn it on once the glossary has real coverage, not on day one.
- **Usage in code:** `enforcePortsBoundary({ glossaryPath })` gives the boundary judge the glossary, so ports and domain types naming a recorded concept with a conflicting term are violations (`ShipmentStore` when the glossary says Parcel).
- **Drift:** `surfaceGlossaryTermBreakage()` on glossary writes blocks removing or renaming a term that specs, tests or code still use, listing the users. Multi-word terms are matched as identifiers too (`Delivery Window` → `DeliveryWindow`/`deliveryWindow`/`delivery_window`). Retiring a term nothing uses passes silently.

All three degrade gracefully while the glossary doesn't exist, so the wiring costs nothing before the glossary conversation starts.

## Choosing the AI judge (`ai`)

The judged rules (the TDD gate and the other AI rules) run on whatever `ai` in `probity.config.ts` names. The templates set `claudeJudge({ model: 'claude-opus-5-5' })`. With no `ai` at all, Probity uses its own judge: the Claude Agent SDK's bundled Claude Code on the logged-in account. When that account hits its spend limit, every judged write is blocked until the limit resets. To judge on kiro-cli instead, or to fall back from one to the other:

```ts
import { claudeJudge, judgeChain, kiroJudge } from '@jjchill/probity-rules'

export default defineConfig({
  rules: kmpRuleEntries(root),
  ai: judgeChain([kiroJudge(), claudeJudge({ model: 'claude-opus-5-5' })]),
})
```

### Pin the judge's model

`claudeJudge()` with no `model` judges on the installed Claude Code's default model, so a project whose CLI defaults to Sonnet gets Sonnet verdicts. The TDD judge's rules were measured on Opus.

- In a JS/TS project whose judge ran on Sonnet, it made three kinds of mistake ([#169](https://github.com/JJChill/agent-skills/issues/169)–[#171](https://github.com/JJChill/agent-skills/issues/171)):
  - it denied with text concluding the write was allowed;
  - it counted tests already on disk, or one new test, as two new tests;
  - it refused an import sent alone before the code that uses it.
- In a KMP project, a week of shadowing Sonnet 5.5 against an Opus primary found Sonnet passed 84 of 319 writes Opus denied.

Every template therefore sets `claudeJudge({ model: 'claude-opus-5-5' })`, and `/probity-update` proposes the same for a config that leaves the Claude judge unpinned, including as a `judgeChain` fallback. Opus costs more per verdict than Sonnet. To use another model, measure it first: run a `shadowJudge` with it as a candidate, or replay the [labelled judge set](evaluating.md#the-labelled-judge-set) on it.

Deterministic shortcuts that skip the judge for such writes were tried and dropped: three reviews in a row got a test-weakening or behaviour-changing write through them.

### `kiroJudge(options?)`

Runs each verdict as one `kiro-cli chat --no-interactive` call, with the prompt on stdin.

- **Model and effort.** It defaults to `claude-opus-5.5` at `high` effort. At `medium` it let a production write with no failing test through 7 times in 25.
- **Isolation.** It uses a judge-only Kiro agent, `probity-judge`, with no tools and no hooks, written into its own working directory (`<tmpdir>/probity-kiro-judge`). A judge run can't edit files, run commands or set off the Kiro shim's hook, and Kiro's saved sessions for judge runs stay out of your project. Kiro keeps one saved session per verdict there, so clear that directory now and then.
- **Unavailable.** When kiro-cli is missing, exits with an error, prints nothing, or takes longer than `timeoutMs` (default 60 s), the verdict is "Kiro judge unavailable".
- **Answering.** kiro-cli can stay running for many seconds after it answers. Once its output holds a complete verdict and it has been quiet for a second, the verdict is taken and kiro-cli is stopped.
- **Under the Kiro shim's deadline** (kiro-cli 3.x; see [Kiro judge timing](#kiro-judge-timing)), a run also stops `fallbackReserveMs` (default 20 s) before the deadline, so the next judge in a `judgeChain` can still answer in the same hook run. With less than 10 s left after that, kiro-cli isn't started at all. Either way the chain falls back, but doesn't skip Kiro for later writes: running out of the hook's time says nothing about kiro-cli. Set `fallbackReserveMs: 0` when `kiroJudge` is the only judge.
- **Options:** `model`, `effort`, `agent` (only an agent with no tools and no hooks), `timeoutMs`, `fallbackReserveMs`, `command`, `cwd`.

### `claudeJudge(options?)`

Probity's Claude judge, for use in a chain or as `ai` on its own.

- **Which Claude Code runs it.** The one installed on the machine, not the copy bundled with Probity's Agent SDK: the binary running the current session (`CLAUDE_CODE_EXECPATH`, which hooks inherit), else the first `claude` on `PATH`, else the bundled copy. Verdicts follow your own Claude Code updates, instead of whatever SDK version Probity pins.
- **`executable`** overrides that: `'installed'` (no fallback; with none found the verdict is "Claude judge unavailable", so a chain moves on), `'bundled'`, or a path. Probity's own judge, used when the config sets no `ai`, always runs the bundled copy.
- **`model`** picks the Claude model each verdict runs on (see [Pin the judge's model](#pin-the-judges-model)). Without it, the Claude Code that runs the judge picks its default.
- **Naming.** A judge given a model is named `claude:<model>`, so `judgeChain` remembers it apart from the default one.

### `judgeChain([...])`

Asks each judge in order and uses the first one that is available, so the array order is the fallback order.

- **When it moves on.** Only when a judge is unavailable: kiro-cli couldn't run, or Claude reports a spend limit, quota, rate limit or authentication failure. A real verdict, deny included, stands. The last judge in a chain is always asked.
- **Skipping a dead judge.** A judge that was just unavailable is skipped for later verdicts (`skipUnavailableMs`), so one dead judge can't use up the hook's time limit. `kiroJudge()` and `claudeJudge()` are named, and the chain keeps a named judge's "unavailable until" in a state file (`<tmpdir>/probity-kiro-judge/judge-chain.json` by default; `stateFile` moves it, `false` keeps it in memory). A hung kiro-cli therefore costs one write its `timeoutMs`, and later writes go straight to the next judge until the skip runs out.
- **Tracing.** A verdict that came from a fallback carries `meta.fallbackFrom` in the `--debug` trace: each earlier judge and why it didn't answer.

### `shadowJudge(primary, candidates, { log })`

Measures other judges on the project's real traffic, without changing enforcement.

- **How it runs.** Every verdict is asked of the primary and each candidate in parallel. The primary's verdict is the one returned, and the prompt and all verdicts are appended to `log` (JSONL, created `0600`).
- **Failures and cost.** A candidate that throws, or hasn't answered `candidateTimeoutMs` (default 60 s) after the verdict started, is logged as such and never changes or blocks the verdict. A write waits for its slowest candidate up to that limit, and each candidate adds its own spend.
- **Prompts in the log.** Prompts contain the code being judged, so keep the log out of git. `includePrompt: false` logs only each prompt's SHA-256, at the cost of replaying later. `includePrompt: 'disagreements'` keeps the prompt only where a candidate disagreed with the primary, the cases `--show` lists, which keeps a long-running log small.
- **Why not `--debug`.** Probity's `--debug` trace records verdicts, not prompts.
- **Log size.** The report reads the log line by line, so its size isn't limited by memory.

```ts
ai: shadowJudge(claudeJudge(), [claudeJudge({ model: 'claude-haiku-5-5' })], { log: '.probity/shadow.jsonl' }),
```

After a week or so of normal work, `npx probity-shadow-report .probity/shadow.jsonl` prints, per candidate:

- **Agreement:** how often it agreed with the primary.
- **Leaks:** it passed what the primary denied, the enforcement a switch would lose, as a share of the primary's denials.
- **Friction:** it denied what the primary passed, as a share of its passes.
- **Availability:** how often it or the primary was unavailable.
- **Speed and tokens:** median latency against the primary's, and tokens per model for both.

How to read it:

- **Upper bounds.** Each rate comes with its 95% upper bound (one-sided Clopper-Pearson): no leak in 20 denials still allows a true leak rate near 14%, so a small sample can't pass for a good result.
- **`--show leaks|friction|all`** lists each disagreement with its task, both reasons and the prompt hash, which finds the full prompt in the log.
- **The primary isn't ground truth either,** so read the leaks rather than going by the agreement rate.

**By judging task.** The report also splits each candidate by judging task, so it can show a candidate is good enough for one rule and not another (say, the acceptance-language check but not the TDD gate).

- **Labels.** A judge sees only a prompt, never the rule that asked, so the presets run each rule labelled with its task: the innermost name of its wrapper chain (`characterizationTest(…(enforceTdd))` is `enforceTdd`). `shadowJudge` logs the label, and `withExtractionUnderGreen`'s own judge call is labelled `extractionUnderGreen`.
- **Your own rules.** The templates export `probityConfig({...})` in place of Probity's `defineConfig({...})`: the same config, with every rule it lists labelled, so a rule a project adds next to a preset is labelled too. With `defineConfig`, such rules are logged as `(unlabelled)` unless their list is wrapped in `withJudgeTasks([...])`. The report says how many verdicts have no task and how to label them.
- **A second question.** A rule that asks the judge a second, different question must label that call itself, with `withJudgeTask('<task>', () => ctx.agent.reason(...))`, as `withExtractionUnderGreen` does. Nothing detects a missing one.

### Kiro judge timing

The Kiro judge works when the call it judges comes from a live Kiro session (Kiro → shim → Probity → kiro-cli judge). In 7 nested sessions, 13 of 14 verdicts came from Kiro, median 15 s and at most 32.5 s. The first verdict of the first session timed out at 60 s and fell back to Claude. The judge inherits the parent session's environment (`KIRO_SESSION_ID` and the like) and still answers.

A committed config with `kiroJudge()` first still works on a checkout without kiro-cli: the chain finds kiro-cli missing in milliseconds and uses Claude.

- **Speed.** Expect Kiro verdicts to be slower: around 15 s typical and 42 s at worst, against 8 s and 12 s on Claude.
- **Hook time limits.** A write occasionally takes up to three verdicts, so leave the hook enough time: a hook that times out doesn't block, and in Claude Code the write then goes ahead unjudged.
  - Claude Code's default limit for a command hook is 10 minutes, which is enough; don't set a lower `timeout` on the Probity hook.
  - The Kiro shim template's `timeout_ms` is 300000 (5 minutes). An agent config with 120000 can be exceeded by three slow Kiro verdicts, so raise it.
  - kiro-cli 3.x ignores `timeout_ms` and lets a call through once its hook has run 60 s. The shim therefore blocks at 55 s (`PROBITY_KIRO_TIMEOUT_S`), and passes that deadline to Probity: `kiroJudge` keeps 20 s of it for the next judge, so a stalled kiro-cli falls back to Claude instead of blocking the write. A kiro-cli that fails on its own (its 60 s timeout, an error exit, no answer) is skipped for later writes; one cut short only by the deadline isn't. When the shim does block, its message names the judge the call was waiting on, says the judges had all answered and the rest of the time went to Probity's rules, or says none had been asked yet.
  - When the shim stops Probity, the kiro-cli judge it was waiting on is stopped too, instead of finishing a verdict nobody reads.
- **The shim's log.** Kiro keeps no hook output, so a blocked call's message is lost once the agent has read it. The shim appends one JSON line per judged call to `<tmpdir>/probity-kiro-judge/shim-log.jsonl` (`PROBITY_KIRO_LOG` moves it; `off` turns it off; it rolls over to `.1` at 5 MB). Each line has the Kiro session, tool, file and working directory; the outcome (`allow`, `deny`, `timeout` or `error`) and a block's reason; when Probity started and finished; and each judge asked, answered or skipped, with any "unavailable" reason, in milliseconds from the hook's start. Time between those points is Probity's own rules. Reasons can quote the code being judged, so the log stays outside the repository and is readable only by you.

## Judge prompt size (`compactJudgeFiles`)

Edits to large files reach the judge as a diff ([#168](https://github.com/JJChill/agent-skills/issues/168)). A write action carries the whole file, so a judge prompt would hold it twice, before and after, and a run of small edits to a large file would resend it every time.

**When it applies.** Every preset replaces those two sections with a unified diff, plus up to 20 unchanged lines either side of each change and the file's import and package lines wherever they are. That happens when:
- the file is at least 8,000 bytes;
- the prompt holds the exact sections (Probity's `enforceTdd` and most of this package's AI rules do);
- the result is clearly smaller.

What still goes whole:
- a file with more than 1,000 changed lines;
- a new file.

Rules still see the whole file, so deterministic checks are unchanged. A one-line edit to a 45 KB file cut the TDD prompt from 100 KB to 13 KB.

**Tuning.** Use `compactJudgeFiles: { minBytes, contextLines }`, or turn it off with `compactJudgeFiles: false`. Outside a preset, wrap rules with `withCompactJudgeFiles(entries)`.

**Checking it doesn't change verdicts**, either live or later:

- **Live.** Run a `shadowJudge` with a candidate on the primary's model wrapped in `wholeFiles(...)`. That candidate is asked the uncompacted prompt, so its disagreements are the verdicts the diff alone decided differently. The shadow log records each compacted verdict's full and sent size, and `probity-shadow-report` prints how many verdicts were compacted and each candidate's agreement on compacted and whole prompts. A live shadow doubles judge cost.
- **Later** ([#174](https://github.com/JJChill/agent-skills/issues/174)). Set `compactJudgeFiles: { record: { log, sample: 0.1 } }`. A sampled share of compacted verdicts then records the whole-file prompt that wasn't sent (built locally, no model call) and the verdict the compacted prompt got.
  - **Replaying.** `npx probity-shadow-replay <log> [--judge claude|kiro] [--model ID] [--limit N] [--repeat N] [--concurrency N] [--show leaks|friction|all]` asks a judge those prompts, one call each, and prints the same agreement, leaks and friction as the report.
  - **Which judge.** By default it replays on the judge the recorded primary ran on, so disagreements measure compaction rather than a different model. A kiro primary's model isn't in its name, so pass `--model` if it wasn't kiro's default.
  - **Privacy.** A recorded prompt is about 120 KB, and it holds code and session context: keep the log local and out of git.
