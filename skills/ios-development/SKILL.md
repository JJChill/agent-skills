---
name: ios-development
description: Builds, deploys, launches, tests, and diagnoses native Apple-platform applications with Xcode, Swift, XCTest, XCUITest, xcodebuild, and simctl. Use when working in an Xcode project or workspace, selecting schemes and simulators, validating a development build, creating test targets or test plans, automating simulator deployment, or troubleshooting Apple build and signing failures.
---

# iOS Development

## Overview

Drive native iOS work from repository evidence to a reproducible build, simulator deployment, and focused verification. Treat a successful compile, install, launch, and test as separate claims and collect evidence for each.

## When to Use

- Building or diagnosing an Xcode project or workspace
- Deploying and launching a development app on an iOS Simulator
- Selecting schemes, configurations, destinations, or signing settings
- Creating or maintaining XCTest, XCUITest, shared schemes, or test plans
- Adding iOS acceptance tests with durable specifications and UI drivers

Do not use this skill for browser-only applications or non-Apple mobile toolchains.

## Workflow

### 1. Discover the project contract

Inspect before choosing commands:

```bash
xcodebuild -version
xcodebuild -list -workspace App.xcworkspace
xcodebuild -showdestinations -workspace App.xcworkspace -scheme Development
xcrun simctl list devices available
```

- Prefer a workspace when CocoaPods or another generated workspace exists; otherwise use the project.
- Use a shared scheme that matches the requested environment. Never infer that `Debug` means the development backend.
- Read `Podfile`, `Package.resolved`, `.xctestplan`, shared schemes, build configurations, entitlements, and repository instructions.
- Record the selected container, scheme, configuration, SDK, destination UDID, bundle identifier, and minimum OS.
- Check `git status` before dependency generation; preserve unrelated changes.

### 2. Make dependency state reproducible

- Use the repository-pinned dependency command and versions (`bundle exec pod install`, Swift Package resolution, Tuist, or XcodeGen).
- Do not upgrade dependencies while trying to prove the existing development build.
- Prefer an isolated `-derivedDataPath` under a temporary or repository-approved build directory.
- If dependency resolution requires unavailable credentials or network access, stop and report the exact boundary. Do not rewrite private dependencies to public substitutes.

### 3. Build for a concrete simulator

Choose an available device UDID from `-showdestinations` or `simctl`; do not guess a model or OS that may not be installed.

```bash
xcodebuild \
  -workspace App.xcworkspace \
  -scheme Development \
  -configuration Debug-Development \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,id=<UDID>' \
  -derivedDataPath <DERIVED_DATA> \
  build
```

- Keep signing enabled when the app's capabilities require it. Use `CODE_SIGNING_ALLOWED=NO` only after verifying that it does not invalidate embedded extensions or the behavior under test.
- Diagnose the first meaningful error, not the final cascade. Apply `debugging-and-error-recovery` when the build fails.
- Never claim deployability from `BUILD SUCCEEDED` alone.

### 4. Install and launch the built product

Boot the selected device, wait for readiness, then install and launch the actual product:

```bash
xcrun simctl boot <UDID>                    # ignore only "already booted"
open -a Simulator                           # optional; requires GUI authority
xcrun simctl bootstatus <UDID> -b
xcrun simctl install <UDID> <APP_PATH>
xcrun simctl launch --terminate-running-process <UDID> <BUNDLE_ID>
```

Derive `APP_PATH` and `BUNDLE_ID` from build settings or the built product; do not guess them. Capture the launch process identifier and inspect `simctl` logs or a screenshot when launch success is material. An installed app that immediately terminates is not a successful deployment.

### 5. Design the correct test layer

Select the smallest layer that proves the behavior:

| Need | Target |
|---|---|
| Pure Swift behavior | XCTest unit target |
| Framework, persistence, or OS integration | XCTest integration target |
| User-observable behavior of the installed app | XCUITest UI target |

For acceptance tests, also follow `acceptance-testing`:

- The feature file comes first: every scenario exists as a `## Scenario:` heading in a spec artifact (e.g. `docs/specs/<feature>.feature.md`) before its XCUITest, and each test declares what it covers with `// Covers: <spec>.feature.md :: Scenario: <title>`. Never author acceptance tests whose scenarios exist only as test method names.
- Keep test cases in domain language and put `XCUIApplication`, accessibility identifiers, coordinates, and navigation in protocol drivers.
- Put reusable user goals in a DSL between specifications and drivers.
- Launch a real development app product. Replace external systems only through supported launch arguments, environment variables, or production-defined ports.
- Use unique per-test data. Reset only state owned by that test.
- Poll with XCTest expectations, predicate expectations, or element-existence timeouts. Never use fixed sleeps.
- Add the target to a shared scheme or test plan and confirm its host application and bundle loader settings.
- Retrofitted acceptance tests must be mutation-checked: break the specified behavior, observe red, restore it, then observe green.

### 6. Report evidence precisely

Separate each result:

- build: command and `BUILD SUCCEEDED`
- install: simulator UDID and installed application path
- launch: bundle identifier and returned process identifier
- tests: test count and `.xcresult` path

If Xcode, a compatible simulator runtime, credentials, or configuration files are missing, describe the blocked claim and the next exact command. Never translate "not attempted" into "passed."

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The scheme name is obvious" | Schemes frequently encode environments and products. Discover shared schemes first. |
| "A simulator build proves deployment" | Deployment additionally requires boot, install, and launch evidence. |
| "Any available simulator is fine" | The destination must satisfy the app's platform and minimum OS and should be recorded by UDID. |
| "Disabling signing always fixes simulator builds" | Extensions and capabilities can still depend on coherent signing settings. Diagnose before overriding. |
| "UI tests have to mention buttons" | Only drivers should know UI mechanics; specifications express user outcomes. |
| "A short sleep makes XCUITest stable" | Fixed waits are races. Wait for the concluding observable state. |

## Red Flags

- Building an `.xcodeproj` while a dependency-managed `.xcworkspace` exists
- Guessing a scheme, configuration, bundle identifier, product path, device name, or OS version
- Editing dependency locks merely to get a local build
- Reporting success without install and launch evidence
- Acceptance specifications importing or directly using XCUITest APIs
- Acceptance tests whose scenarios exist only as test method names — no feature file, no `Covers:` tag
- Fixed sleeps, shared mutable accounts, or suite-wide destructive cleanup
- Deleting derived data outside an exact task-scoped path

## Verification

- [ ] The selected workspace/project, shared scheme, configuration, SDK, and simulator UDID came from discovery output
- [ ] Dependency resolution used repository-pinned tooling without unintended upgrades
- [ ] The simulator build completed successfully with its command preserved
- [ ] The built `.app` was installed and launched on the selected simulator
- [ ] The bundle identifier, product path, launch PID, and relevant logs or screenshot were captured
- [ ] Tests use the correct XCTest layer; acceptance specs reach the app only through a DSL and driver
- [ ] XCTest/XCUITest synchronization contains no fixed sleeps
- [ ] The focused tests and relevant suite passed with an `.xcresult`, or blockers are reported without claiming success
