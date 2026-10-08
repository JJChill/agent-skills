// Coverage for issue #77: the thin-driving-adapter rules in the Swift
// preset — opt-in wiring, enum-aware discriminant patterns, Swift export
// extraction, and .swiftinterface files for a UI-only app that consumes
// the core as a package or framework.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import type { Rule, RuleBlock, RuleContext, RuleEntry } from '@nizos/probity'

import { swiftRuleEntries } from '../presets/swift.ts'
import { forbidNewDomainDiscriminantChecks, listCoreExports, listPublishedApi } from './ports-and-adapters.ts'
import { anchorGlob, buildMatcher, isRuleBlock } from './scoping.ts'
import {
  SWIFT_EXPORTS,
  SWIFT_INTERFACE,
  readSwiftInterface,
  swiftDomainDiscriminantPatterns,
  swiftExportedNames,
} from './swift.ts'

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'swift-driving-adapter-test-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

function onDisk(content: string | undefined): RuleContext {
  return {
    readFile: async () => (content === undefined ? { kind: 'absent' } : { kind: 'present', content }),
  }
}

function judgeCtx(prompts: string[]): RuleContext {
  return {
    ...onDisk(undefined),
    agent: {
      reason: async (prompt: string) => {
        prompts.push(prompt)
        return { kind: 'pass', reason: '' }
      },
    },
  } as RuleContext
}

const write = (content: string, path = '/repo/App/Sources/Modules/Timesheets/Views/TimesheetView.swift') =>
  ({ kind: 'write', path, content }) as const

// ── Enum-aware discriminant patterns ───────────────────────────────

function hits(field: string, text: string): number {
  const [pattern] = swiftDomainDiscriminantPatterns([field])
  return [...text.matchAll(pattern!.pattern)].length
}

test('swiftDomainDiscriminantPatterns matches enum-case, literal, switch and if-case checks', () => {
  assert.equal(hits('role', 'if viewer.role == .superUser {'), 1)
  assert.equal(hits('role', 'viewer?.role != Role.manager'), 1)
  assert.equal(hits('role', '.superUser != viewer.role'), 1)
  assert.equal(hits('role', 'Role.superUser == viewer.role'), 1)
  assert.equal(hits('role', 'if role == "SuperUser" {'), 1)
  assert.equal(hits('role', 'switch viewer.role {'), 1)
  assert.equal(hits('role', 'switch (viewer.role) {'), 1)
  assert.equal(hits('status', 'if case .draft = timesheet.status {'), 1)
  assert.equal(hits('status', 'guard case .submitted(let at) = timesheet.status else { return }'), 1)
})

test('swiftDomainDiscriminantPatterns ignores look-alikes', () => {
  assert.equal(hits('role', 'roleName == .superUser'), 0)
  assert.equal(hits('role', 'let role: Role = .superUser'), 0)
  assert.equal(hits('role', '@State private var role = Role.worker'), 0)
  assert.equal(hits('role', 'viewer.role == other.role'), 0)
  assert.equal(hits('role', 'canApprove(viewer.role)'), 0)
  assert.equal(hits('role', 'if viewer.role != nil {'), 0)
  assert.equal(hits('role', 'switch result {'), 0)
  assert.equal(hits('status', 'if case .loading = state {'), 0)
})

test('the discriminant screen takes Swift patterns and stays delta-based', async () => {
  const rule = forbidNewDomainDiscriminantChecks({
    discriminants: ['role'],
    patternsFor: swiftDomainDiscriminantPatterns,
  })
  const before = 'let a = viewer.role == .superUser\n'
  assert.equal((await rule(write(`${before}let b = 1\n`), onDisk(before))).kind, 'pass')
  const added = await rule(write(`${before}if viewer.role == .manager {}\n`), onDisk(before))
  assert.equal(added.kind, 'violation')
  assert.match(added.reason ?? '', /role compared to a domain value/)
})

// ── Swift source exports ───────────────────────────────────────────

test('swiftExportedNames reads declarations a core file exposes, with extension and type members', () => {
  const names = swiftExportedNames(
    [
      'import Foundation',
      '',
      '/// Who may do what.',
      'public func canEdit(_ viewer: Viewer) -> Bool { true }',
      'func canDelete(_ viewer: Viewer) -> Bool { false }',
      'enum Role: String { case worker, manager }',
      'struct Viewer: Equatable {',
      '    let role: Role',
      '    func displayName() -> String { "x" }',
      '    private func hidden() -> Int { 1 }',
      '    static func guest() -> Viewer { Viewer(role: .worker) }',
      '}',
      'protocol TimesheetRepository {',
      '    func save(_ timesheet: Timesheet) async throws',
      '}',
      'final class ApproveTimesheet {',
      '    init(repository: TimesheetRepository) {}',
      '    func callAsFunction(_ id: String) async throws {}',
      '}',
      'extension Viewer {',
      '    var canApprove: Bool { role == .manager }',
      '    func canSubmit(_ timesheet: Timesheet) -> Bool { true }',
      '    fileprivate func helper() {}',
      '}',
      'actor Clock {}',
      'typealias ViewerID = String',
      'let assignableRoles: [Role] = [.worker]',
      'private let secret = 1',
      'fileprivate func internalHelper() {}',
      'extension Array where Element == Role {',
      '    func sorted() -> [Role] { self }',
      '}',
    ].join('\n'),
  )
  assert.deepEqual(names.sort(), [
    'ApproveTimesheet',
    'ApproveTimesheet.callAsFunction',
    'Array.sorted',
    'Clock',
    'Role',
    'TimesheetRepository',
    'TimesheetRepository.save',
    'Viewer',
    'Viewer.canApprove',
    'Viewer.canSubmit',
    'Viewer.displayName',
    'Viewer.guest',
    'ViewerID',
    'assignableRoles',
    'canDelete',
    'canEdit',
  ])
})

test('listCoreExports reads Swift core files with SWIFT_EXPORTS, leaving tests out', () => {
  const root = workspace({
    'Core/Sources/Domain/Permissions.swift': 'func canApprove(_ viewer: Viewer) -> Bool { true }',
    'Core/Sources/UseCases/SubmitTimesheet.swift': 'final class SubmitTimesheet {}',
    'Core/Tests/PermissionsTests.swift': 'final class PermissionsTests {}',
  })
  assert.equal(
    listCoreExports({ globs: ['Core/**'], root, maxChars: 8000, language: SWIFT_EXPORTS }),
    ['(paths under Core/Sources/)', 'Domain/Permissions.swift: canApprove', 'UseCases/SubmitTimesheet.swift: SubmitTimesheet'].join('\n'),
  )
})

// ── .swiftinterface files ──────────────────────────────────────────

const INTERFACE = `// swift-interface-format-version: 1.0
// swift-compiler-version: Apple Swift version 6.0
// swift-module-flags: -target arm64-apple-ios17.0 -enable-library-evolution -module-name TimesheetCore
import Foundation
import Swift
public enum Role : Swift.String {
  case worker
  case manager, superUser
  public init?(rawValue: Swift.String)
  public typealias RawValue = Swift.String
  public var rawValue: Swift.String {
    get
  }
}
public struct Viewer : Swift.Equatable {
  public let role: TimesheetCore.Role
  public init(role: TimesheetCore.Role)
  public static func == (a: TimesheetCore.Viewer, b: TimesheetCore.Viewer) -> Swift.Bool
}
extension TimesheetCore.Viewer {
  public func canApprove() -> Swift.Bool
  public var displayName: Swift.String {
    get
  }
}
public func canDelete(_ viewer: TimesheetCore.Viewer) -> Swift.Bool
@_hasMissingDesignatedInitializers final public class SubmitTimesheet {
  public func callAsFunction(_ id: Swift.String) async throws
  @objc deinit
}
extension TimesheetCore.Role : Swift.Equatable {}
extension TimesheetCore.Role : Swift.Hashable {}
extension TimesheetCore.Role : Swift.RawRepresentable {}
`

test('readSwiftInterface reads public members by owner, dropping generated ones', () => {
  assert.deepEqual(readSwiftInterface(INTERFACE), [
    'Role: worker, manager, superUser',
    'Viewer: role, canApprove, displayName',
    '(top level): canDelete',
    'SubmitTimesheet: callAsFunction',
  ])
})

test('listPublishedApi reads .swiftinterface files and directories', () => {
  const root = workspace({
    'Core.xcframework/ios-arm64/Core.framework/Modules/Core.swiftmodule/arm64-apple-ios.swiftinterface': INTERFACE,
    'Core.xcframework/ios-arm64/Core.framework/Modules/Core.swiftmodule/arm64-apple-ios.private.swiftinterface': INTERFACE.replace('canDelete', 'secretHelper'),
    'Core.xcframework/Info.plist': '<plist/>',
  })
  const text = listPublishedApi({ paths: ['Core.xcframework'], root, maxChars: 8000, format: SWIFT_INTERFACE })
  assert.match(text, /^\(top level\): canDelete$/m)
  assert.doesNotMatch(text, /secretHelper/, 'the private interface is not the published API')
  assert.doesNotMatch(text, /plist/)
})

// ── Preset wiring ──────────────────────────────────────────────────

function blockIndex(entries: readonly RuleEntry[], name: string): number {
  return entries.findIndex(
    (entry) => isRuleBlock(entry) && (entry.rules ?? []).some((r: Rule) => r.name === name),
  )
}

function tddIndex(entries: readonly RuleEntry[]): number {
  return entries.findIndex(
    (entry) => isRuleBlock(entry) && (entry.rules ?? []).some((r: Rule) => r.name.includes('enforceTdd')),
  )
}

function covers(block: RuleBlock | undefined, path: string): boolean {
  return !!block?.files && buildMatcher(block.files.map((g) => anchorGlob(g, '/repo')))(path)
}

const VIEWS = ['App/Sources/**/Views/**', 'App/Sources/**/*View.swift', '!**/*Tests.swift', '!**/Previews/**']
const VIEW = '/repo/App/Sources/Modules/Timesheets/Views/TimesheetView.swift'
const VIEW_MODEL = '/repo/App/Sources/Modules/Timesheets/TimesheetViewModel.swift'

test('swiftRuleEntries keeps today\'s paths and wires no driving-adapter block by default', () => {
  const entries = swiftRuleEntries('/repo')
  assert.equal(blockIndex(entries, 'enforceThinDrivingAdapter'), -1)
  const boundary = entries[blockIndex(entries, 'enforcePortsBoundary')] as RuleBlock
  assert.deepEqual(boundary.files, ['App/Sources/Modules/**', 'App/Sources/Utilities/Providers/**'])
})

test('swiftRuleEntries takes coreGlobs, tddGlobs and adapterGlobs', () => {
  const entries = swiftRuleEntries('/repo', {
    coreGlobs: ['Core/Sources/**'],
    tddGlobs: ['Core/Sources/**', 'Core/Tests/**'],
    adapterGlobs: ['Core/Sources/Adapters/**'],
  })
  assert.deepEqual((entries[blockIndex(entries, 'enforcePortsBoundary')] as RuleBlock).files, ['Core/Sources/**'])
  assert.deepEqual((entries[tddIndex(entries)] as RuleBlock).files, ['Core/Sources/**', 'Core/Tests/**'])
  const observability = entries.find(
    (entry) => isRuleBlock(entry) && (entry.rules ?? []).some((r: Rule) => r.name.includes('enforceAdapterObservability')),
  ) as RuleBlock
  assert.deepEqual(observability.files, ['Core/Sources/Adapters/**'])
})

test('with drivingAdapterGlobs, views move from the boundary judge to the driving-adapter judge, before TDD', () => {
  const entries = swiftRuleEntries('/repo', { drivingAdapterGlobs: VIEWS })
  const index = blockIndex(entries, 'enforceThinDrivingAdapter')
  assert.ok(index >= 0, 'expected the block')
  assert.ok(index < tddIndex(entries), 'must run before the TDD judge')
  const driving = entries[index] as RuleBlock
  const boundary = entries[blockIndex(entries, 'enforcePortsBoundary')] as RuleBlock
  assert.ok(covers(driving, VIEW), 'a view inside a module is a driving adapter')
  assert.equal(covers(boundary, VIEW), false, 'and is no longer judged by the boundary rule')
  assert.equal(covers(driving, VIEW_MODEL), false, 'a view model stays core')
  assert.ok(covers(boundary, VIEW_MODEL))
  assert.equal(covers(driving, '/repo/App/Sources/Modules/Timesheets/Views/TimesheetViewTests.swift'), false)
})

test('swiftRuleEntries uses Swift patterns for domainDiscriminants', async () => {
  const entries = swiftRuleEntries('/repo', { drivingAdapterGlobs: VIEWS, domainDiscriminants: ['role'] })
  const screen = (entries[blockIndex(entries, 'enforceThinDrivingAdapter')] as RuleBlock).rules![0]!
  assert.equal(screen.name, 'forbidNewDomainDiscriminantChecks')
  assert.equal((await screen(write('if viewer.role == .superUser {}'), onDisk(undefined))).kind, 'violation')
})

test('swiftRuleEntries gives the judge the SwiftUI addendum, core exports (views left out) and the published interface', async () => {
  const root = workspace({
    'App/Sources/Modules/Timesheets/Domain/Permissions.swift': 'extension Viewer {\n    func canApprove() -> Bool { true }\n}',
    'App/Sources/Modules/Timesheets/Views/TimesheetView.swift': 'struct TimesheetView: View {}',
    'Vendor/Core.swiftinterface': INTERFACE,
  })
  const entries = swiftRuleEntries(root, {
    drivingAdapterGlobs: VIEWS,
    coreExportsInJudge: true,
    coreApiPaths: ['Vendor'],
  })
  const judge = (entries[blockIndex(entries, 'enforceThinDrivingAdapter')] as RuleBlock).rules!.at(-1)!
  const prompts: string[] = []
  await judge(write('x'), judgeCtx(prompts))
  const prompt = prompts[0] ?? ''
  assert.match(prompt, /### Swift specifics: SwiftUI views/)
  assert.match(prompt, /@State/)
  assert.match(prompt, /Viewer\.canApprove/)
  assert.doesNotMatch(prompt, /TimesheetView\.swift: TimesheetView/, 'views are not core exports')
  assert.match(prompt, /^\(top level\): canDelete$/m)
})
