/**
 * Swift/iOS-shaped deterministic rules and constants for the Probity
 * presets — the Apple-toolchain counterpart of ./kotlin.ts.
 *
 * Most of the enforcement stack is language-neutral and reused as-is
 * (spec-test-parity, acceptance-language, glossary rules, the
 * mutation-probe pair, the green-run gate). This module supplies only
 * what is genuinely Swift/Xcode-specific: content screens for the
 * acceptance suite and the xcodebuild patterns the generic gates need.
 * Calibrated against a production iOS app (CocoaPods + SwiftPM
 * workspace, XCUITest + app-hosted component-test targets, MVVM view
 * models over use-case ports) — adjust to your layout.
 */

/**
 * Fixed waits in test code — the top cause of flaky XCUITest suites.
 * Matches `sleep(2)`, `usleep(...)`, `Thread.sleep(forTimeInterval:)`,
 * and `try await Task.sleep(...)`. Synchronize with XCTest
 * expectations, predicate expectations, or element-existence timeouts
 * instead (`waitForExistence(timeout:)`).
 */
export const SWIFT_FIXED_SLEEPS =
  /\b(?:sleep|usleep)\s*\(|Thread\.sleep|Task\.sleep/

/**
 * XCUITest mechanics — `XCUIApplication`, `XCUIElement`, coordinate
 * taps. In the four-layer model these belong ONLY in protocol drivers
 * (and only in the driver that owns the deployed-app scope): scope
 * this screen to the spec/scenario/DSL layers, where any match means
 * UI mechanics have leaked upward.
 */
export const XCUITEST_MECHANICS = /XCUIApplication|XCUIElement|XCUICoordinate/

/**
 * An `xcodebuild … test` invocation, for the green-run commit gate.
 * Matches plain `test`, `test-without-building`, and scheme-qualified
 * forms. Pair with {@link XCODEBUILD_TEST_SUCCEEDED} /
 * {@link XCODEBUILD_TEST_FAILED}: xcodebuild prints
 * `** TEST SUCCEEDED **` / `** TEST FAILED **` verdict banners, and
 * `xcrun xcresulttool get test-results summary` reports
 * `"result" : "Passed"`. Either counts as evidence; a recorded
 * invocation with neither is not a passing suite.
 */
export const XCODEBUILD_TEST_COMMAND =
  /\bxcodebuild\b[\s\S]*\btest(?:-without-building)?\b|xcresulttool\s+get\s+test-results/

export const XCODEBUILD_TEST_SUCCEEDED =
  /\*\*\s*TEST SUCCEEDED\s*\*\*|"result"\s*:\s*"Passed"|Test Suite '.*' passed/

export const XCODEBUILD_TEST_FAILED =
  /\*\*\s*(?:TEST|BUILD)\s+FAILED\s*\*\*|"result"\s*:\s*"Failed"|Test Suite '.*' failed/

/** Probe carriers for enforceProbeReversion on an Apple codebase. */
export const SWIFT_PROBE_FILE_PATTERN = /\.(?:swift|m|mm)$/
