# probity enforcement templates

Hard enforcement for this catalog's disciplines, chiefly [`test-driven-development`](../skills/test-driven-development/SKILL.md), [`ports-and-adapters`](../skills/ports-and-adapters/SKILL.md) and [`acceptance-testing`](../skills/acceptance-testing/SKILL.md), through [Probity](https://github.com/nizos/probity), a PreToolUse rule engine for coding agents.

Probity is the second, required half of this distribution's install, not an add-on: the skills teach the disciplines, and Probity enforces them on every tool call. The README's Quick Start ([Part 2](../README.md#part-2-install-and-configure-probity-in-the-target-project)) is the step-by-step install. This page explains how the enforcement works, and links to the reference pages:

| Page | What's there |
|---|---|
| [Rule catalogue](probity/docs/rules.md) | Every rule, the skill it enforces, and how |
| [Options reference](probity/docs/options.md) | Every option beyond the layout globs: exclusions, harness and vendor adapters, review record and routing, the shell-write screen, layered imports, spec↔test traceability, the glossary, choosing the AI judge |
| [JS/TS preset](probity/docs/presets/js.md) | What the default enforces and doesn't, and turning on spec-first |
| [Kotlin and KMP presets](probity/docs/presets/kotlin.md) | The Kotlin screens, the Kotlin TDD gate, KMP options |
| [Swift preset](probity/docs/presets/swift.md) | The Xcode-specific screens, brownfield seam-gap rules, SwiftUI views |
| [Wiring the Claude Code hook](probity/docs/claude-code-hook.md) | The hook command, and what `probity-claude` adds |
| [Evaluating the rules](probity/docs/evaluating.md) | The scripted workflow episode and the labelled judge set |
| [CHANGELOG](probity/CHANGELOG.md) | What changed in each release, and what a config may need |

## Why

The skills in this catalog are prose: the agent reads the rules and follows them. That works until it doesn't; the Common Rationalizations tables exist because prose gets rationalized away under pressure. Probity closes that gap. It intercepts every `Write`/`Edit`/`Bash` call *before it runs*, checks it against the configured rules, and blocks violations with a corrective message the agent recovers from. The skills keep teaching the *why and how*; Probity enforces the *that*, per tool call.

The two layers are complementary by design: when Probity blocks an action, its reason lands on an agent that has the corresponding skill in context, so the recovery is informed rather than blind.

## Mental model

**Two kinds of rule.**

- **Deterministic rules** are the cheap outer wall: pattern matches, no latency. Examples are the vendor-import screen and the green-test-run commit gate.
- **AI-validated rules** are the judgement layer behind it. Each sends a judge a distilled version of the corresponding SKILL.md's rules, plus the current file and the pending write, and gets back pass or violation.

**Rule order enforces that economics.** Probity stops at the first violation, so every preset lists its deterministic screens before any AI rule: a vendor import in core code is rejected free by the import screen, never after a TDD model call. Keep that order when editing a config; the workflow eval asserts it.

**The judge's conventions** follow Probity's own `enforceTdd`:
- judge the *change*, not the whole file;
- never punish transient in-progress states;
- treat an explicit user instruction to let a change through as authoritative.

It's a guardrail, not a jail.

**Scoping is everything.** Rules apply to the files their `{ files, rules }` block names. A glob too wide blocks work a file is supposed to do (`enforcePortsBoundary` on adapters, the Language Test on protocol drivers); both rules tell the judge to pass clearly mis-scoped files, but don't rely on that. A glob too narrow fails silently: the rule never fires. That is why setup ends with a scope report.

**Customizing.** Customize the AI rules without forking them through `instructions: (defaults) => defaults + '...'`, for example to name your project's core and adapter directories so `enforcePortsBoundary` infers file roles precisely.

## What gets enforced

Each skill's discipline maps to rules; the [rule catalogue](probity/docs/rules.md) has the detail.

- **test-driven-development:**
  - every production write must answer an observed failing test, minimally (`enforceTdd`);
  - `git commit` needs a green run recorded after the last write (`requireGreenTestRun`);
  - retrofitting tests onto existing code goes through enforced round-trips (mutation probe, characterization test).
- **ports-and-adapters:**
  - core code imports no vendors and reads no clock, randomness or environment directly;
  - adapters stay thin and observable, and driving adapters (UI, handlers) keep business logic in the core;
  - tests substitute only at ports.
- **acceptance-testing:**
  - specs pass the Language Test;
  - an acceptance test cites an existing scenario, written spec first;
  - every scenario has a covering test before commit, and the test says what the scenario says.
- **ubiquitous-language:** specs and code use the glossary's terms, and a term still in use can't be renamed away.
- **code-review-and-quality:** a merge into a protected branch carries a review record, optionally listing the reviewers a router selected.

## Presets

A preset is a factory that returns the rule entries for one ecosystem. The rules are language-agnostic where they can be (they judge writes, not test runners), and each preset swaps in the ecosystem-specific screens.

| Preset | Template | Page |
|---|---|---|
| JavaScript / TypeScript | [`probity.config.ts`](probity/probity.config.ts) | [JS/TS preset](probity/docs/presets/js.md) |
| Kotlin / JVM / Android | [`probity.config.kotlin.ts`](probity/probity.config.kotlin.ts) | [Kotlin and KMP presets](probity/docs/presets/kotlin.md) |
| Kotlin Multiplatform | [`probity.config.kmp.ts`](probity/probity.config.kmp.ts) | [Kotlin and KMP presets](probity/docs/presets/kotlin.md) |
| Swift / iOS | [`probity.config.swift.ts`](probity/probity.config.swift.ts) | [Swift preset](probity/docs/presets/swift.md) |

## Setup

Probity lives in the **consuming project** (the codebase you're building), not in this repo.

1. **Install** Probity and the rule package:

   ```bash
   npm install -D @nizos/probity @jjchill/probity-rules
   ```

2. **Copy the template** for your preset to the project root. It is the only file to copy; the rule modules and scripts it imports live in the installed package.

   ```bash
   cp node_modules/@jjchill/probity-rules/probity.config.ts .   # or probity.config.kotlin.ts / .kmp.ts / .swift.ts
   ```

3. **Edit the preset's options.** The template calls a preset factory with an options object, and that object is what you edit, not the package internals. Point the core-purity option at your real core code, the spec option at your real spec layer, and the commit-gate option at your real test command. The [preset pages](#presets) list each preset's defaults.

4. **Check the scoping** before the first agent session finds out the hard way:

   ```bash
   npx probity-scope-report --config probity.config.ts
   ```

   The report resolves every `{ files, rules }` block against your real tree, with Probity's own glob semantics, and prints what each block claims. It flags:
   - **dead scopes:** globs matching zero files, the silent failure;
   - **core-purity rules claiming adapter, DI or UI-looking production paths.** Test files are skipped, since a test-wide screen such as a no-mocking-library rule legitimately covers adapter tests.
   - **the acceptance-language rule claiming Robot or driver files.**

   Re-run it whenever the layout or the globs change, and run it with `--strict` in [CI](#ci).
   - **Greenfield.** On a new repository every layer starts empty, so pass `--allow-empty <glob>` (repeatable, an exact glob from a block's `files`) for layers that don't exist yet. Drop each flag once its first file lands; the report notes stale ones.
   - **Anchoring.** Relative globs are anchored at the config file's directory, as Probity anchors them, and the report prints that directory. If the config sits outside `--root`, the report warns `CONFIG OUTSIDE ROOT`: relative includes then match nothing, and relative `!` exclusions exclude nothing. Enforcement behaves the same way, so keep the config at the repository root, or write globs as `**/…` ([#186](https://github.com/JJChill/agent-skills/issues/186)).

5. **Wire the hook.** In Claude Code, run the package's `probity-claude` bin from the project root in a PreToolUse hook. [Wiring the Claude Code hook](probity/docs/claude-code-hook.md) has the settings and explains why the wrapper and the `cd` matter. For Kiro, see [`kiro/README.md`](probity/kiro/README.md).

6. **Choose the judge.** The templates judge on Claude Opus through the installed Claude Code. To use kiro-cli, a fallback chain or another model, see [Choosing the AI judge](probity/docs/options.md#choosing-the-ai-judge-ai).

**Updating:** once this is set up, run `/probity-update` to bring it forward instead of repeating these steps. It upgrades the package, proposes config migrations from the [CHANGELOG](probity/CHANGELOG.md), refreshes the Kiro shim and re-checks scoping.

## CI

Hooks only see what a hooked agent does, so CI is the arbiter of record: it also covers work done in a web UI, by a person, or in an agent Probity can't hook. The package ships the checks as copyable jobs in `node_modules/@jjchill/probity-rules/ci/`:

- **[`ci/github-actions.yml`](probity/ci/github-actions.yml):** copy to `.github/workflows/probity.yml`.
- **[`ci/gitlab-ci.yml`](probity/ci/gitlab-ci.yml):** paste into `.gitlab-ci.yml`, or `include:` it.

What they run:

- **On every change:** `probity-scope-report --strict` and `probity-spec-parity`.
- **On each push to the default branch:** `probity-review-record` over what the push brought in, with full history and `--routed-range`.

Edit the marked lines (the default branch, the specs directory, and whether a parity baseline exists). Delete the parity step or the review-record job if the project doesn't use them.

## Costs and caveats

- **AI rules cost a model call per matching write.** Scope tightly.
  - `enforceTdd({ fastPath: true })` skips the AI when a write adds exactly one test, at the price of skipping refactor enforcement.
  - A fast path must cover **every** rule scoped to a file, or it buys nothing. A single-`@Test` write under `acceptance/**` fast-paths the TDD rule *and*, through `withAcceptanceLanguageFastPath`, the Language Test, provided the new test only reuses vocabulary already declared in the suite's DSL files and contains no mechanism words. Anything novel goes to the judge.
  - Large files reach the judge as a diff; see [Judge prompt size](probity/docs/options.md#judge-prompt-size-compactjudgefiles).
- **Agent support.** Probity supports Claude Code, GitHub Copilot CLI and Codex natively, and Kiro through the shim in [`probity/kiro/`](probity/kiro/). Wherever the agent can be hooked, Probity is a required part of the install. The skills also run in tools Probity can't hook (Cursor, Gemini CLI, Windsurf, …); there they run without gates, so record that in the project's agent instructions rather than assuming enforcement is live.
- **npm is required** in the consuming project, even a non-Node one: a one-dependency `package.json` next to `gradlew` or the `.xcworkspace` is fine.
- **Fail closed.** If a rule throws or the judge is unavailable, Probity blocks. The custom rules return an explicit violation naming the misconfiguration when no judge is wired. To capture what the judge said, add `--debug <path>` to the hook command.
- **AI verdicts vary.** The judge sees the pending file and the session transcript, not the definitions of types the file references, so it can deny on a wrong guess about a referenced type, and an identical retry may pass. Treat a surprising deny as worth one re-read of its reason before adapting. Giving judges access to referenced files is an upstream improvement worth pursuing.
- **Each write is judged alone, against the file as it is on disk.** Dependent edits sent in parallel are each judged before the others land. A call site passing a new argument can be blocked while the edit adding that parameter goes through, so send dependent edits one after another: signature first, then call sites. Moving logic into a shared helper works the same way. Extract it in place in the file that already holds it, so the judge sees the logic in the current content, then call the helper from the new code path.
- **Override is in-session.** The agent can ask the user to wave a blocked change through, and the judge honours that on the next attempt. Softer than it sounds: disagreements surface to you instead of being silently forced either way.
- **These gates deter rationalization, not deliberate deception.** An adversarial replay trial (a real iOS project, 20 fabricated events) confirmed the honest paths and the limits.
  - The green-run gate matches *recorded output*, so an echoed success banner or a re-read of a stale `.xcresult` satisfies it.
  - The green-run gate's "writes since the last run" counts only write-tool events, so a file changed by a shell command after a green run (`cat > file <<EOF`) doesn't reset it. The shell-write screen catches such commands only for scoped files it can parse; see [`requireGreenTestRun()`](probity/docs/rules.md#requiregreentestrun).

  Treat the gates as guardrails for an agent cutting corners under pressure, and keep CI as the arbiter of record.
- **Audit the write-rule globs against your real tree** (`npx probity-scope-report`). A write no rule matches is a silent free pass, and layout surprises are common. The iOS trial found the app's `AppDelegate.swift` sitting *beside* `App/Sources/`, outside every glob, and an acceptance suite created in a new directory would be equally invisible. Scope rules to the *directory* that owns a layer, not to filename suffixes (`AcceptanceTests/**`, not `**/*Tests.swift`): a creative filename dodges a suffix, while a test-method pattern inside the rule doesn't care what the file is called.
- **Division of labour, observed live.**
  - The deterministic screens are easily evaded by construction: `"XCUI" + "Application"` slips a regex.
  - In the same trial, the AI TDD judge caught exactly that obfuscation, with an accurate explanation. It is also the layer that costs seconds and can't see files the globs exclude.

  Regexes are the cheap wall, the AI is the judgement backstop, and neither substitutes for correct scoping.

## Where each former section went

This page used to hold the whole reference. Each former section is linked below under its old anchor, so links to it keep working.

- <a id="whats-in-the-template"></a>What's in the template → [Rule catalogue](probity/docs/rules.md)
- <a id="driving-adapters-by-project-layout"></a>Driving adapters by project layout → [options reference](probity/docs/options.md#driving-adapters-by-project-layout-drivingadapterglobs)
- <a id="language-presets"></a>Language presets → [Presets](#presets) and the preset pages
- <a id="excluding-paths-from-every-rule-excludeglobs"></a>Excluding paths from every rule (`excludeGlobs`) → [options reference](probity/docs/options.md#excluding-paths-from-every-rule-excludeglobs)
- <a id="adapters-only-an-app-can-exercise-harnessglobs"></a>Adapters only an app can exercise (`harnessGlobs`) → [options reference](probity/docs/options.md#adapters-only-an-app-can-exercise-harnessglobs)
- <a id="vendor-adapters-only-a-live-session-can-exercise-vendoradapterglobs"></a>Vendor adapters only a live session can exercise (`vendorAdapterGlobs`) → [options reference](probity/docs/options.md#vendor-adapters-only-a-live-session-can-exercise-vendoradapterglobs)
- <a id="review-record-requirereviewrecord"></a>Review record (`requireReviewRecord`) → [options reference](probity/docs/options.md#review-record-requirereviewrecord)
- <a id="review-routing-probity-review-route"></a>Review routing (`probity-review-route`) → [options reference](probity/docs/options.md#review-routing-probity-review-route)
- <a id="review-obligations-tdd-exemptions-that-name-a-reviewer"></a>Review obligations → [options reference](probity/docs/options.md#review-obligations-tdd-exemptions-that-name-a-reviewer)
- <a id="shell-writes-to-scoped-files-shellwritescreen"></a>Shell writes to scoped files (`shellWriteScreen`) → [options reference](probity/docs/options.md#shell-writes-to-scoped-files-shellwritescreen)
- <a id="layered-imports-enforcelayeredimports"></a>Layered imports (`enforceLayeredImports`) → [options reference](probity/docs/options.md#layered-imports-enforcelayeredimports)
- <a id="spectest-traceability-kmp-preset"></a>Spec↔test traceability (KMP preset), including brownfield adoption, shared spec repositories, live-only coverage, a dependency's coverage and in-progress tests → [options reference](probity/docs/options.md#spectest-traceability)
- <a id="brownfield-seam-gaps-preconditions-are-controlled-not-observed"></a>Brownfield seam gaps → [Rule catalogue](probity/docs/rules.md#brownfield-seam-gaps-preconditions-are-controlled-not-observed)
- <a id="ubiquitous-language"></a>Ubiquitous language → [options reference](probity/docs/options.md#ubiquitous-language)
- <a id="choosing-the-ai-judge"></a>Choosing the AI judge → [options reference](probity/docs/options.md#choosing-the-ai-judge-ai); its "Pin the judge's model" → [options reference](probity/docs/options.md#pin-the-judges-model)
- <a id="evaluating-the-workflow"></a>Evaluating the workflow → [Evaluating the rules](probity/docs/evaluating.md)
- <a id="the-labelled-judge-set"></a>The labelled judge set → [Evaluating the rules](probity/docs/evaluating.md#the-labelled-judge-set)
- Release history ("from 0.4.x") → [CHANGELOG](probity/CHANGELOG.md)
