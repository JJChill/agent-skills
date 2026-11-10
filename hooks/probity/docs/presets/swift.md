# Swift preset

[`probity.config.swift.ts`](../../probity.config.swift.ts) (template) + `swiftRuleEntries(root, options?)` ([`presets/swift.ts`](../../presets/swift.ts)), with the Xcode-specific rules in [`rules/swift.ts`](../../rules/swift.ts). Calibrated against a production CocoaPods + SwiftPM app with an XCUITest target and an app-hosted component-test target sharing one scenario layer, in an `AcceptanceTests/` four-layer suite.

Back to the [overview](../../../PROBITY.md). Other presets: [JS/TS](js.md), [Kotlin and KMP](kotlin.md).

## What it reuses, and what it adds

Most of the stack is reused unchanged because it is language-neutral:

- **Spec traceability.** The [spec↔test traceability](../options.md#spectest-traceability) rules already match Swift's `func test…` declarations.
- **Language and glossary.** These rules judge content, whatever the language.
- **Generic gates.** `requireGreenTestRun`, the mutation-probe pair and `withTelemetryFastPath` take patterns as options.

The Swift module supplies only what is Xcode-specific:

- **A fixed-sleep screen** for the acceptance suite: `sleep`, `usleep`, `Thread.sleep` and `Task.sleep`, the top source of XCUITest flakiness.
- **An XCUITest-mechanics containment screen:** `XCUIApplication` and `XCUIElement` are allowed only in `AcceptanceTests/Drivers/`.
- **xcodebuild patterns for the commit gate:** an `xcodebuild … test` run is green on the `** TEST SUCCEEDED **` banner, or on an `xcresulttool` summary reporting `"result": "Passed"`.

**Layout note.** The parity scanners' default test-file pattern expects a lowercase `acceptance/` path segment. iOS suites conventionally live in `AcceptanceTests/`, so the preset overrides `testFilePattern` everywhere. Keep that override if you rename the directory.

## Brownfield seam-gap rules

The Swift preset wires the rules from [Brownfield seam gaps](../rules.md#brownfield-seam-gaps-preconditions-are-controlled-not-observed):

- **`enforceControlledPreconditions()`** on `AcceptanceTests/Drivers/**` and the acceptance composition root.
- **`withInverseScenarioGuidance()`** around the TDD gate, for writes to that root.
- **The characterization round-trip:** `withCharacterizationTest()` on the acceptance suite, plus the `enforceCharacterizationResolution()` commit gate.
- **The mutation-probe round-trip.**

## Views and the thin-adapter judge

The thin-adapter block is opt-in here, through `drivingAdapterGlobs`; the [layout table](../options.md#driving-adapters-by-project-layout-drivingadapterglobs) has starting globs for SwiftUI apps.

- **Views inside `coreGlobs`.** A view inside `coreGlobs` (say, a module folder holding both views and view models) moves to the driving-adapter judge and out of the ports-boundary judge. A view write then costs one AI call, not two.
- **View models** (`ObservableObject`, `@Observable`) are presenters and stay with the core. The view sends them one intent per user action.
- **`domainDiscriminants`** matches enum cases as well as literals: `viewer.role == .superUser` in either order, `switch viewer.role`, and `if case .draft = timesheet.status`.
- **`coreApiPaths`** reads an XCFramework's `.swiftinterface` files (`.private` and `.package` ones are skipped), for an app whose core is a binary dependency.
