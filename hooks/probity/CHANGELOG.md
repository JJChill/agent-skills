# Changelog

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
