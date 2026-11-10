# JS/TS preset

[`probity.config.ts`](../../probity.config.ts) (template) + [`presets/js.ts`](../../presets/js.ts) (`jsRuleEntries`, `JsPresetOptions`). Calibrated for a `src/core` + `src/adapters` layout with vitest or jest.

Back to the [overview](../../../PROBITY.md). Other presets: [Kotlin and KMP](kotlin.md), [Swift](swift.md).

## What it enforces as shipped

- **The TDD gate** (`enforceJsTdd`) on `src/**`, `test/**` and `tests/**` (`tddGlobs`).
- **Core purity** on `src/core/**` and `src/domain/**` (`coreGlobs`):
  - known infrastructure imports blocked free (`KNOWN_INFRASTRUCTURE_IMPORTS`, extend it with `infrastructureImports`);
  - new clock, randomness and environment reads (`JS_AMBIENT_EFFECT_PATTERNS`);
  - the boundary judge.
- **No mocking of your own modules** (`forbidInternalModuleMocks`, `mockGlobs`).
- **The Language Test** on spec files (`specGlobs`: `specs/**`, `acceptance/**`, `**/*.feature`).
- **Thin driving adapters** (`drivingAdapterGlobs`: `src/ui/**`, `src/components/**`, `src/**/*.tsx`, minus tests and stories). The free discriminant screen is off until `domainDiscriminants` is set.
- **No fixed waits** in acceptance code (`fixedWaitGlobs`).
- **A green test run before every commit.** The default command counts `npm`/`pnpm`/`yarn`/`bun` `test` or `run test[:…]`, or `vitest`/`jest` directly or through `npx` (`isJsTestInvocation`). A custom `commitCommand` is used as given, so anchor it.
- **The shell-write screen** and **judge prompt compaction**, as in every preset.

Each rule is described in the [rule catalogue](../rules.md); the shared options are in the [options reference](../options.md).

## What it does not enforce until you opt in

- **Spec-first** is off until `specsDir` is set (below).
- **Glossary drift** is off until `glossaryPath` is set.
- **The mutation-probe and characterization round-trips** aren't wired in this preset. They are language-neutral (`@jjchill/probity-rules` or `@jjchill/probity-rules/rules/round-trips`); wire them when you start backfilling coverage, as the [Kotlin preset](../../presets/kotlin.ts) does around its TDD rule.
- **Test isolation** of the acceptance DSL is off until `dslIsolationGlobs` is set.

## Spec-first

Spec-to-test traceability is off by default, so a project that hasn't opted in sees no change. The template carries the line commented out:

```ts
specsDir: fileURLToPath(new URL('./specs', import.meta.url)),
```

`specs/` matches the default `specGlobs`, so uncommenting it is the whole step. It wires the same set as the KMP and Swift presets ([Spec↔test traceability](../options.md#spectest-traceability)):

- `requireSpecBackedAcceptanceTest` on `acceptanceTestGlobs` (default `acceptance/**/*.test.*`, `acceptance/**/*.spec.*`). It is deterministic and ordered before the judged rules, so a tagless acceptance test is rejected free.
- `surfaceScenarioLinkBreakage` on `specGlobs`.
- `enforceScenarioFidelity` on both (`scenarioFidelity: false` turns it off).
- `enforceSpecTestParity` as a commit gate.
- `surfaceGlossaryTermBreakage`, once `glossaryPath` is also set.

The write-time gate's `testDeclarationPattern` defaults to `JS_TEST_DECLARATION`, so it recognises vitest, jest and mocha test cases. `testRoots` defaults to `[process.cwd()]`, because Probity hook processes run at the project root.

**An existing spec suite with gaps:** baseline it once and set `parityBaselinePath` to the same file:

```bash
npx probity-spec-parity --specs specs --baseline specs/.parity-baseline --write-baseline
```

**A shared spec repository:** set `parityExclusionsPath`, `parityWipPath` and `ignoreTags` (no defaults in this preset); see [Shared spec repositories](../options.md#shared-spec-repositories).

## JS-specific notes

- `forbidInternalModuleMocks` recognises jest and vitest module mocks only (`MODULE_MOCK_PATTERN` in [`rules/ports-and-adapters.ts`](../../rules/ports-and-adapters.ts)).
- vitest doesn't type-check, so a green step can leave `tsc --noEmit` failing. The JS TDD addendum lets a write that changes only types fix a type-check failure without a red. A test assertion restated so it type-checks must stay at least as strong.
