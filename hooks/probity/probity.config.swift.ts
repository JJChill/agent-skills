/**
 * Probity config template — Swift/iOS preset.
 *
 * Same enforcement stack as the Kotlin presets (see hooks/PROBITY.md),
 * recalibrated for a native iOS app: an Xcode workspace with the
 * acceptance suite in AcceptanceTests/ following the four-layer model
 * (Specs + Component test glue / Scenarios / DSL / Drivers), XCUITest
 * plus an app-hosted component-test target, MVVM view models over
 * use-case ports, and Markdown Given/When/Then specs in docs/specs/.
 * Calibrated against a production CocoaPods + SwiftPM app — adjust
 * globs and package names to your layout.
 *
 * Probity runs on Node: `npm install -D @nizos/probity` (a
 * one-dependency package.json with `"type": "module"` next to the
 * xcworkspace is fine).
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  defineConfig,
  enforceTdd,
  forbidContentPattern,
  type RuleEntry,
} from '@nizos/probity'

import {
  enforceAcceptanceLanguage,
  enforceControlledPreconditions,
} from './rules/acceptance-language.js'
import {
  enforceCharacterizationResolution,
  enforceProbeReversion,
  requireGreenTestRun,
  withCharacterizationTest,
  withInverseScenarioGuidance,
  withMutationProbe,
  withTelemetryFastPath,
} from './rules/kotlin.js'
import {
  enforceAdapterObservability,
  enforcePortsBoundary,
} from './rules/ports-and-adapters.js'
import {
  enforceSpecTestParity,
  requireSpecBackedAcceptanceTest,
  surfaceScenarioLinkBreakage,
} from './rules/spec-test-parity.js'
import {
  SWIFT_FIXED_SLEEPS,
  SWIFT_PROBE_FILE_PATTERN,
  XCODEBUILD_TEST_COMMAND,
  XCODEBUILD_TEST_FAILED,
  XCODEBUILD_TEST_SUCCEEDED,
  XCUITEST_MECHANICS,
} from './rules/swift.js'
import { surfaceGlossaryTermBreakage } from './rules/ubiquitous-language.js'

const ROOT = dirname(fileURLToPath(import.meta.url))

// Acceptance test files live under AcceptanceTests/ (capital A) — the
// parity scanners' default pattern expects a lowercase `acceptance/`
// segment, so every spec-traceability rule below overrides it.
const ACCEPTANCE_TEST_FILES = /AcceptanceTests[/\\]/

// Swift telemetry lines the fast-path recognizes as complete
// single-line instrumentation (SudoLogging-style logger calls).
const SWIFT_TELEMETRY_LINES = [
  /^[\w.]*logger\.(?:event|info|debug|error|warning)\(.*\)$/i,
]

/**
 * Rule entries as a factory over the project root, mirroring the KMP
 * preset: Probity reads the default export; tooling (scope reports,
 * workflow evals) can instantiate the same blocks against another
 * root. Relative globs are anchored by Probity's loadConfig against
 * this file's directory.
 */
export function swiftRuleEntries(root: string): RuleEntry[] {
  const glossary = join(root, 'docs/GLOSSARY.md')

  // Rule ordering principle: Probity stops at the first violation, so
  // every deterministic screen (pattern match, free, instant) is
  // listed before any AI-validated rule (a model call per matching
  // write).

  return [
    // ── Deterministic wall ───────────────────────────────────────────

    // No fixed waits anywhere in the acceptance suite: synchronize
    // with XCTest expectations, predicates, or
    // waitForExistence(timeout:) — never sleep.
    {
      files: ['AcceptanceTests/**'],
      rules: [
        forbidContentPattern({
          match: SWIFT_FIXED_SLEEPS,
          reason:
            'Fixed waits are races: XCUITest flakiness starts here. ' +
            'Wait for the concluding observable state with XCTest ' +
            'expectations, predicate expectations, or ' +
            'waitForExistence(timeout:) (see the acceptance-testing ' +
            'and ios-development skills).',
        }),
      ],
    },

    // XCUITest mechanics belong only in the driver that owns the
    // deployed-app scope. Specs, scenario bodies, the DSL, and the
    // app-hosted component tests must stay implementation-neutral.
    {
      files: [
        'AcceptanceTests/Specs/**',
        'AcceptanceTests/Scenarios/**',
        'AcceptanceTests/DSL/**',
        'AcceptanceTests/Component/**',
      ],
      rules: [
        forbidContentPattern({
          match: XCUITEST_MECHANICS,
          reason:
            'XCUIApplication/XCUIElement outside AcceptanceTests/Drivers: ' +
            'only protocol drivers know how to reach the SUT. Move the ' +
            'mechanics into the XCUITest driver and express this layer ' +
            'in domain language (four-layer model, acceptance-testing ' +
            'skill).',
        }),
      ],
    },

    // Spec-first, at write time: adding a new acceptance test case
    // (func test…) requires a Covers: tag resolving to a
    // `## Scenario:` heading that already exists in docs/specs — the
    // feature file is written before the test that claims it. A file
    // whose existing tag already resolves may gain further driver
    // tests for the same scenario (one scenario, many drivers).
    // Scoped to the whole suite directory, not *Tests.swift: XCTest
    // only discovers `func test…` methods, so the declaration pattern
    // is the real detector and a creative filename can't dodge the
    // rule. NOTE the directory itself is the boundary — acceptance
    // tests added outside it (e.g. a new App/Tests/ target) are
    // invisible to every rule here until the globs learn the path.
    {
      files: ['AcceptanceTests/**'],
      rules: [
        requireSpecBackedAcceptanceTest({ specsDir: join(root, 'docs/specs') }),
      ],
    },

    // Editing a spec must not silently break the tests that claim its
    // scenarios: removing or renaming a covered `## Scenario:` heading
    // blocks with the list of affected tests.
    {
      files: ['docs/specs/**/*.feature.md'],
      rules: [
        surfaceScenarioLinkBreakage({
          testRoots: [root],
          testFilePattern: ACCEPTANCE_TEST_FILES,
        }),
      ],
    },

    // Ubiquitous-language drift: renaming or removing a glossary term
    // that specs, tests, or code still use blocks the glossary edit
    // with the list of users.
    {
      files: ['docs/GLOSSARY.md'],
      rules: [surfaceGlossaryTermBreakage({ searchRoots: [root] })],
    },

    // ── AI-validated judgment layer ──────────────────────────────────

    // Inner loop: test-driven-development over app sources and the
    // acceptance suite. On a project whose only suite is the
    // acceptance scheme, the observed red comes from
    // `xcodebuild … test` — the outside-in loop, not an exemption.
    // The mutation-probe wrapper lets a deliberate break marked
    // `// probity: mutation-probe` through without a red-before-green
    // demand; enforceProbeReversion below holds the commit hostage
    // until it is reverted. Telemetry-only additions pass
    // deterministically so the observability rule and the TDD gate
    // never contradict each other.
    // App/*.swift catches root-level sources (AppDelegate.swift lives
    // beside App/Sources, not inside it) — audit these globs against
    // your tree with scripts/scope-report.ts; a write no rule matches
    // is a silent free pass.
    {
      files: [
        'App/*.swift',
        'App/Sources/**',
        'AcceptanceTests/**',
        'VPNNetworkExtension/**',
      ],
      rules: [
        // The inverse-scenario wrapper changes only the DENY TEXT, and
        // only on the test-control layer (the acceptance composition
        // root): when a fixture has no red demanding it because the
        // environment already satisfies the scenario's Given, the
        // correct move — write the inverse scenario and let its red
        // drive the fixture — is stated at the decision point instead
        // of leaving "observe a red first" to read as "delete the
        // control".
        // The characterization wrapper sanctions the FIRST test for
        // behavior that predates it (born green, so no red can be
        // observed before it exists): a test-layer write carrying
        // `// probity: characterization` passes, and the marker only
        // comes off through a proof-checked removal (a recorded run
        // where that test failed under a mutation probe). The
        // resolution gate below blocks commits while a marker is on
        // disk, so the bypass is a round-trip, not an exemption.
        withInverseScenarioGuidance(
          withCharacterizationTest(
            withMutationProbe(
              withTelemetryFastPath(enforceTdd(), {
                patterns: SWIFT_TELEMETRY_LINES,
                filePattern: /\.swift$/,
              }),
            ),
            { filePattern: /AcceptanceTests[/\\]/ },
          ),
          { filePattern: /App[/\\]Sources[/\\]Acceptance[/\\]/ },
        ),
      ],
    },

    // Preconditions are controlled, not observed: a driver method
    // named for a Given must establish it (fixture key, launch
    // environment, programmed fake), and control wiring is never
    // deleted just because the scenario passes without it — on a
    // brownfield system the environment produces the sad path for
    // free, which is exactly when the seam matters most (the success
    // path is unreachable until the port is controlled).
    {
      files: ['AcceptanceTests/Drivers/**', 'App/Sources/Acceptance/**'],
      rules: [enforceControlledPreconditions()],
    },

    // Boundaries: ports-and-adapters judgments the screens can't make
    // — thin adapters, vendor types in port signatures, names
    // conflicting with the glossary. Point at wherever your ports and
    // core behavior live (here: module view-models/use-cases and the
    // application-owned provider ports).
    {
      files: ['App/Sources/Modules/**', 'App/Sources/Utilities/Providers/**'],
      rules: [enforcePortsBoundary({ glossaryPath: glossary })],
    },

    // Adapters must be thin, but not blind: a new adapter path doing
    // external I/O carries boundary observability (structured event,
    // port tap, or span). Delta-based — legacy paths migrate
    // incrementally.
    {
      files: [
        'App/Sources/**/Adapters/**',
        'App/Sources/**/Services/**',
        'App/Sources/**/Analytics/**',
      ],
      rules: [
        withTelemetryFastPath(
          enforceAdapterObservability({
            conventionHint:
              'This codebase uses SudoLogging (a Logger built by the ' +
              'MySudoVpn logger factories — one structured, greppable ' +
              'line per boundary call/outcome), and/or a recording ' +
              'port-tap decorator wired where the app composes its ' +
              'dependencies.',
          }),
          { patterns: SWIFT_TELEMETRY_LINES, filePattern: /\.swift$/ },
        ),
      ],
    },

    // Outer loop: acceptance-testing. The Language Test on the spec
    // layer: Markdown specs, test-case glue, scenario bodies, and the
    // DSL — everything above the drivers must read as pure domain
    // language. Drivers are layer 3 (they know accessibility
    // identifiers, hosted views, view-model ports) — excluded.
    {
      files: [
        'docs/specs/**/*.feature.md',
        'AcceptanceTests/Specs/**',
        'AcceptanceTests/Component/**',
        'AcceptanceTests/Scenarios/**',
        'AcceptanceTests/DSL/**',
      ],
      rules: [enforceAcceptanceLanguage({ glossaryPath: glossary })],
    },

    // ── Ship gates ───────────────────────────────────────────────────

    // Definition of done, made mechanical: every non-wip scenario in
    // docs/specs is claimed by an acceptance test (Covers: tag), and
    // every tag resolves to a real scenario. Brownfield adoption:
    // generate a baseline once with scripts/spec-parity.mjs
    // --write-baseline and burn it down (see hooks/PROBITY.md).
    // Per-scenario driver mapping (optional): declare named driver
    // scopes and tag scenarios that need more than the default suite —
    // `## Scenario [system]: …` then requires a covering test whose
    // path matches that scope. Tags are floors, not ceilings; with a
    // shared scenario layer (AcceptanceTests/Scenarios/) the extra
    // covering test is a thin spec class calling the existing body.
    // The example scopes match the calibration app's layout — the
    // XCUITest target under Specs/, the app-hosted component target
    // under Component/. CALIBRATE TO YOUR LAYOUT before uncommenting.
    enforceSpecTestParity({
      specsDir: join(root, 'docs/specs'),
      testRoots: [root],
      testFilePattern: ACCEPTANCE_TEST_FILES,
      baselinePath: join(root, 'docs/specs/.parity-baseline'),
      // driverScopes: [
      //   { name: 'system', filePattern: /AcceptanceTests[/\\]Specs[/\\]/ },
      //   { name: 'hosted-ui', filePattern: /AcceptanceTests[/\\]Component[/\\]/ },
      // ],
      // defaultScopes: ['hosted-ui'],
    }),

    // The commit half of the mutation-probe round-trip: no commit
    // while a `probity: mutation-probe` marker is still on disk.
    enforceProbeReversion({
      roots: [root],
      filePattern: SWIFT_PROBE_FILE_PATTERN,
    }),

    // The commit half of the characterization round-trip: no commit
    // while a `probity: characterization` marker is still on disk —
    // the marker only comes off once the transcript records the
    // marked test failing under a mutation probe.
    enforceCharacterizationResolution({
      roots: [root],
      filePattern: SWIFT_PROBE_FILE_PATTERN,
    }),

    // No commit on an unverified tree. Matches `xcodebuild … test`
    // and xcresulttool summary readbacks; the recorded output must
    // actually be green (** TEST SUCCEEDED ** or "result": "Passed"),
    // not merely exist. CALIBRATE AGAINST YOUR REAL COMMAND: a
    // `-quiet` run suppresses the verdict banner entirely (verified
    // live), so a runbook that mandates -quiet must also mandate the
    // `xcrun xcresulttool get test-results summary` readback — that
    // readback is the output this gate accepts. Run your documented
    // test command once and confirm successPattern matches what it
    // actually prints before trusting the gate.
    requireGreenTestRun({
      command: XCODEBUILD_TEST_COMMAND,
      successPattern: XCODEBUILD_TEST_SUCCEEDED,
      failurePattern: XCODEBUILD_TEST_FAILED,
    }),
  ]
}

export default defineConfig({ rules: swiftRuleEntries(ROOT) })
