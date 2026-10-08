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
 *
 * `-quiet` suppresses the verdict banner (confirmed against a real
 * run: the last line is just `Testing started`), so with a -quiet
 * runbook the xcresulttool readback is the ONLY green evidence the
 * gate will see — make it a mandatory step of "run the tests".
 */
export const XCODEBUILD_TEST_COMMAND =
  /\bxcodebuild\b[\s\S]*\btest(?:-without-building)?\b|xcresulttool\s+get\s+test-results/

export const XCODEBUILD_TEST_SUCCEEDED =
  /\*\*\s*TEST SUCCEEDED\s*\*\*|"result"\s*:\s*"Passed"|Test Suite '.*' passed/

export const XCODEBUILD_TEST_FAILED =
  /\*\*\s*(?:TEST|BUILD)\s+FAILED\s*\*\*|"result"\s*:\s*"Failed"|Test Suite '.*' failed/

/** Probe carriers for enforceProbeReversion on an Apple codebase. */
export const SWIFT_PROBE_FILE_PATTERN = /\.(?:swift|m|mm)$/

// ── Thin driving adapters (issue #77) ───────────────────────────────

import type { NamedPattern } from './gates.js'
import type { ApiDumpFormat, ExportLanguage } from './ports-and-adapters.js'

/** Swift source with comments and string literals blanked, line count kept, so braces in them don't count. */
function stripSwift(content: string): string {
  const keepLines = (text: string) => text.replace(/[^\n]/g, '')
  return content
    .replace(/"""[\s\S]*?"""/g, (text) => `""${keepLines(text)}`)
    .replace(/\/\*[\s\S]*?\*\//g, keepLines)
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/\/\/.*$/gm, '')
}

const SWIFT_DECLARATION =
  /^\s*((?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|open|internal|package|private|fileprivate|static|class|final|mutating|nonmutating|nonisolated|override|convenience|required|lazy|weak|unowned|indirect|dynamic)\s+)*)(func|struct|class|enum|protocol|actor|extension|typealias|let|var)\s+([A-Za-z_][\w.]*)/
const SWIFT_TYPE_KINDS = new Set(['struct', 'class', 'enum', 'protocol', 'actor', 'extension'])
const HIDDEN_SWIFT_MODIFIER = /\b(?:private|fileprivate)\b/

type SwiftScope = { name: string | null; depth: number; extension: boolean }

/**
 * Names a Swift core file exposes. Swift's default visibility is
 * `internal`, so in a module the app shares, everything not `private`
 * or `fileprivate` is reachable: top-level types, functions, constants
 * and type aliases, plus member and extension functions (as
 * `Type.name`) and extension properties. Stored properties and nested
 * types are left out, as `kotlinExportedNames` leaves them out.
 */
export function swiftExportedNames(content: string): string[] {
  const names = new Set<string>()
  const scopes: SwiftScope[] = []
  let pending: SwiftScope | undefined
  let depth = 0
  for (const line of stripSwift(content).split('\n')) {
    const match = line.match(SWIFT_DECLARATION)
    if (match) {
      const [, modifiers = '', kind = '', qualified = ''] = match
      const name = qualified.split('.').pop()!
      const hidden = HIDDEN_SWIFT_MODIFIER.test(modifiers)
      const owner = scopes[scopes.length - 1]
      if (depth === 0) {
        if (kind !== 'extension' && !hidden) names.add(name)
      } else if (owner?.name && !hidden && (kind === 'func' || (owner.extension && kind === 'var'))) {
        names.add(`${owner.name}.${name}`)
      }
      if (SWIFT_TYPE_KINDS.has(kind)) {
        pending = { name: hidden || (depth > 0 && !owner?.name) ? null : name, depth: depth + 1, extension: kind === 'extension' }
      }
    }
    const opens = (line.match(/\{/g) ?? []).length
    if (pending && opens > 0) {
      scopes.push(pending)
      pending = undefined
    }
    depth += opens - (line.match(/\}/g) ?? []).length
    while (scopes.length && depth < scopes[scopes.length - 1]!.depth) scopes.pop()
  }
  return [...names]
}

/** Swift exports, for `enforceThinDrivingAdapter`'s `coreExports`. */
export const SWIFT_EXPORTS: ExportLanguage = {
  sourceFile: /\.swift$/,
  testFile: /(?:Tests?|Spec)\.swift$|[/\\](?:[A-Za-z]*Tests|Previews)[/\\]/,
  exportedNames: swiftExportedNames,
}

// Members the compiler generates or every type has: they say nothing
// about the domain.
const SWIFT_GENERATED_MEMBER =
  /^(?:rawValue|hashValue|hash|encode|init|deinit|allCases|description|debugDescription|CodingKeys|id)$/

/**
 * Public API, one `Owner: name, name` line per type, from a
 * `.swiftinterface` file (a framework or package built with library
 * evolution). Members of a type and of its extensions are grouped under
 * the type; enum cases are listed; top-level functions and constants go
 * under `(top level)`. Initializers, operators and generated members are
 * dropped.
 */
export function readSwiftInterface(content: string): string[] {
  const owners = new Map<string, Set<string>>()
  const add = (owner: string, name: string) => {
    if (SWIFT_GENERATED_MEMBER.test(name)) return
    if (!owners.has(owner)) owners.set(owner, new Set())
    owners.get(owner)!.add(name)
  }
  const scopes: { name: string; depth: number }[] = []
  let depth = 0
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '')
    const owner = scopes[scopes.length - 1]?.name
    const type = line.match(
      /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|open|final|indirect|package)\s+)*(?:struct|class|enum|protocol|actor|extension)\s+([\w.]+)/,
    )
    const member = line.match(
      /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|open|static|class|final|mutating|nonmutating|nonisolated|override|convenience|required|lazy|dynamic|indirect)\s+)*(func|var|let)\s+([A-Za-z_]\w*)/,
    )
    const cases = owner ? line.match(/^\s*(?:indirect\s+)?case\s+(.+)$/) : null
    if (cases) {
      for (const part of cases[1]!.split(/,(?![^(]*\))/)) {
        const name = part.trim().match(/^([A-Za-z_]\w*)/)?.[1]
        if (name) add(owner!, name)
      }
    } else if (member) {
      add(owner ?? '(top level)', member[2]!)
    }
    const opens = (line.match(/\{/g) ?? []).length
    if (type && opens > 0) scopes.push({ name: type[1]!.split('.').pop()!, depth: depth + 1 })
    depth += opens - (line.match(/\}/g) ?? []).length
    while (scopes.length && depth < scopes[scopes.length - 1]!.depth) scopes.pop()
  }
  return [...owners].map(([name, members]) => `${name}: ${[...members].join(', ')}`)
}

/** `.swiftinterface` files; the `.private` and `.package` ones are not the published API. */
export const SWIFT_INTERFACE: ApiDumpFormat = {
  file: /(?<!\.private|\.package)\.swiftinterface$/,
  read: readSwiftInterface,
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Swift forms of a domain discriminant check, one pattern per field:
 * comparison to an enum case or a string literal, in either order
 * (`viewer.role == .superUser`, `Role.manager != viewer.role`), a
 * `switch viewer.role` subject, and `if`/`guard`/`while case .draft =
 * timesheet.status`. For `forbidNewDomainDiscriminantChecks`'
 * `patternsFor`.
 */
export function swiftDomainDiscriminantPatterns(discriminants: readonly string[]): NamedPattern[] {
  return discriminants.map((name) => {
    const field = escapeRegExp(name)
    const subject = String.raw`[\w.?!]*\b${field}\b`
    const value = String.raw`(?:(?<![\w)\]])\.[a-z_]\w*|(?:[A-Z]\w*\.)+[a-z_]\w*|"[^"\n]*")`
    return {
      label: `${name} compared to a domain value`,
      pattern: new RegExp(
        [
          String.raw`\b${field}\s*[!=]==?\s*${value}`,
          String.raw`${value}\s*[!=]==?\s*${subject}`,
          String.raw`\bswitch\s+\(?\s*${subject}\s*\)?\s*\{`,
          String.raw`\b(?:if|guard|while)\s+case\s+[^=\n]+=\s*${subject}`,
        ].join('|'),
        'g',
      ),
    }
  })
}

/**
 * Swift addendum for `enforceThinDrivingAdapter`: what thin means for a
 * SwiftUI view. Pass as
 * `instructions: (defaults) => defaults + SWIFT_DRIVING_ADAPTER_ADDENDUM`.
 */
export const SWIFT_DRIVING_ADAPTER_ADDENDUM = `

### Swift specifics: SwiftUI views

  - A SwiftUI \`View\` is a driving adapter. Always allowed: layout,
    modifiers, styling, accessibility labels and identifiers,
    \`@State\`, \`@Binding\`, \`@FocusState\`, \`@Environment\` and
    \`@AppStorage\` view state, a \`.task {}\` or \`.onAppear\` that
    starts loading through one call, \`NavigationStack\` paths and
    sheet or alert presentation, and \`#Preview\` / \`PreviewProvider\`
    code. Rendering a value the core computed, formatting it for
    display, and showing a loading or error state are translation.
  - Sending one intent to a view model (an \`ObservableObject\` or
    \`@Observable\` presenter) or calling one use case per user action
    is the intended pattern. The view model is the presenter: the view
    never decides what an action means.
  - Block a view that decides something in domain terms (switching on
    a role or a status to choose what a user may do or see), coordinates
    several use cases or repository calls in one action, or copies a
    rule the core already exposes.`
