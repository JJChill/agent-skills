// Coverage for issue #76: the thin-driving-adapter rules in the Kotlin
// and KMP presets — opt-in wiring, enum-aware discriminant patterns,
// Kotlin export extraction, and binary-compatibility-validator dumps
// for a repo that consumes the core as a library.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import type { Rule, RuleBlock, RuleContext, RuleEntry } from '@nizos/probity'

import { kmpRuleEntries } from '../presets/kmp.ts'
import { kotlinRuleEntries } from '../presets/kotlin.ts'
import {
  KOTLIN_API_DUMP,
  KOTLIN_EXPORTS,
  kotlinDomainDiscriminantPatterns,
  kotlinExportedNames,
  readKotlinApiDump,
} from './kotlin.ts'
import {
  forbidNewDomainDiscriminantChecks,
  listCoreExports,
  listPublishedApi,
} from './ports-and-adapters.ts'
import { isRuleBlock } from './scoping.ts'

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kotlin-driving-adapter-test-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

function onDisk(content: string | undefined): RuleContext {
  return {
    readFile: async () =>
      content === undefined ? { kind: 'absent' } : { kind: 'present', content },
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

const write = (content: string, path = '/repo/cli/src/main/kotlin/x/commands/SudosCommand.kt') =>
  ({ kind: 'write', path, content }) as const

// ── Enum-aware discriminant patterns ───────────────────────────────

function hits(field: string, text: string): number {
  const [pattern] = kotlinDomainDiscriminantPatterns([field])
  return [...text.matchAll(pattern!.pattern)].length
}

test('kotlinDomainDiscriminantPatterns matches enum, literal, when and is checks', () => {
  assert.equal(hits('role', 'if (viewer.role == Role.SUPER_USER) {}'), 1)
  assert.equal(hits('role', 'viewer?.role != Role.MANAGER'), 1)
  assert.equal(hits('role', 'Role.SUPER_USER == viewer.role'), 1)
  assert.equal(hits('role', 'if (role == "SuperUser") {}'), 1)
  assert.equal(hits('role', '"Manager" != invitee?.role'), 1)
  assert.equal(hits('role', 'when (viewer.role) {'), 1)
  assert.equal(hits('status', 'if (timesheet.status is Status.Draft) {}'), 1)
  assert.equal(hits('status', 'timesheet.status !is Status.Submitted'), 1)
})

test('kotlinDomainDiscriminantPatterns ignores look-alikes', () => {
  assert.equal(hits('role', 'roleName == Role.SUPER_USER'), 0)
  assert.equal(hits('role', 'val role = Role.SUPER_USER'), 0)
  assert.equal(hits('role', 'viewer.role == other.role'), 0)
  assert.equal(hits('role', 'canApprove(viewer.role)'), 0)
  assert.equal(hits('role', 'when (val result = client.roles.list()) {'), 0)
  assert.equal(hits('role', 'is ListSudosOutcome.Listed -> Outcome.Success(role)'), 0)
})

test('the discriminant screen takes Kotlin patterns and stays delta-based', async () => {
  const rule = forbidNewDomainDiscriminantChecks({
    discriminants: ['role'],
    patternsFor: kotlinDomainDiscriminantPatterns,
  })
  const before = 'val a = viewer.role == Role.SUPER_USER\n'
  assert.equal((await rule(write(`${before}val b = 1\n`), onDisk(before))).kind, 'pass')
  const added = await rule(write(`${before}val b = viewer.role == Role.MANAGER\n`), onDisk(before))
  assert.equal(added.kind, 'violation')
  assert.match(added.reason ?? '', /role compared to a domain value/)
})

// ── Kotlin source exports ──────────────────────────────────────────

test('kotlinExportedNames reads public declarations and extension functions', () => {
  const names = kotlinExportedNames(
    [
      'package com.x.domain',
      'fun canEdit(viewer: Viewer): Boolean = true',
      'fun Viewer.canApprove(): Boolean = true',
      'fun <T> List<T>.second(): T = this[1]',
      'suspend fun submit(id: String) {}',
      'val assignableRoles = listOf<Role>()',
      'enum class Role { WORKER, MANAGER }',
      'data class Viewer(val role: Role)',
      'sealed interface Outcome',
      'typealias ViewerId = String',
      'fun interface Approver { fun approve(): Boolean }',
      'object Permissions {',
      '    fun canDelete(viewer: Viewer) = false',
      '    data object Denied',
      '    private fun hidden() = 1',
      '    val notTopLevel = 2',
      '    override fun toString() = ""',
      '}',
      'internal fun internalOnly() = 1',
      'private val secret = 1',
    ].join('\n'),
  )
  assert.deepEqual(names.sort(), [
    'List.second',
    'Outcome',
    'Permissions',
    'Role',
    'Viewer',
    'Viewer.canApprove',
    'ViewerId',
    'assignableRoles',
    'canDelete',
    'canEdit',
    'submit',
  ])
})

test('listCoreExports skips nested worktrees and trims the shared path prefix', () => {
  const root = workspace({
    'sdk/core/src/commonMain/kotlin/x/domain/Permissions.kt': 'fun canApprove() = true',
    'sdk/core/src/commonMain/kotlin/x/usecase/DeleteSudo.kt': 'class DeleteSudo',
    '.claude/worktrees/spike/.git': 'gitdir: /elsewhere',
    '.claude/worktrees/spike/sdk/core/src/commonMain/kotlin/x/domain/Old.kt': 'fun stale() = 1',
  })
  assert.equal(
    listCoreExports({ globs: ['**/src/commonMain/**'], root, maxChars: 8000, language: KOTLIN_EXPORTS }),
    [
      '(paths under sdk/core/src/commonMain/kotlin/x/)',
      'domain/Permissions.kt: canApprove',
      'usecase/DeleteSudo.kt: DeleteSudo',
    ].join('\n'),
  )
})

// ── binary-compatibility-validator dumps ───────────────────────────

const JVM_DUMP = `public final class com/x/domain/Permissions {
	public static final field INSTANCE Lcom/x/domain/Permissions;
	public final fun canDelete (Lcom/x/domain/Viewer;)Z
}

public final class com/x/domain/PermissionsKt {
	public static final fun canApprove (Lcom/x/domain/Viewer;)Z
	public static synthetic fun canApprove$default (Lcom/x/domain/Viewer;ILjava/lang/Object;)Z
}

public final class com/x/domain/Role : java/lang/Enum {
	public static final field MANAGER Lcom/x/domain/Role;
	public static final field WORKER Lcom/x/domain/Role;
	public static fun getEntries ()Lkotlin/enums/EnumEntries;
	public static fun valueOf (Ljava/lang/String;)Lcom/x/domain/Role;
	public static fun values ()[Lcom/x/domain/Role;
}

public final class com/x/domain/Viewer {
	public fun <init> (Lcom/x/domain/Role;)V
	public final fun component1 ()Lcom/x/domain/Role;
	public final fun copy (Lcom/x/domain/Role;)Lcom/x/domain/Viewer;
	public fun equals (Ljava/lang/Object;)Z
	public final fun getRole ()Lcom/x/domain/Role;
	public final fun setRole (Lcom/x/domain/Role;)V
	public fun hashCode ()I
	public fun toString ()Ljava/lang/String;
}
`

const KLIB_DUMP = `// Klib ABI Dump
// Targets: [iosArm64, iosSimulatorArm64]
// Library unique name: <com.x:core>
final enum class com.x.domain/Role : kotlin/Enum<com.x.domain/Role> { // com.x.domain/Role|null[0]
    enum entry MANAGER // com.x.domain/Role.MANAGER|null[0]
    enum entry WORKER // com.x.domain/Role.WORKER|null[0]

    final val entries // com.x.domain/Role.entries|#static{}entries[0]
        final fun <get-entries>(): kotlin.enums/EnumEntries<com.x.domain/Role> // com.x.domain/Role.entries.<get-entries>|<get-entries>#static(){}[0]

    final fun valueOf(kotlin/String): com.x.domain/Role // com.x.domain/Role.valueOf|valueOf#static(kotlin.String){}[0]
}

final class com.x.domain/Viewer { // com.x.domain/Viewer|null[0]
    constructor <init>(com.x.domain/Role) // com.x.domain/Viewer.<init>|<init>(com.x.domain.Role){}[0]

    final val role // com.x.domain/Viewer.role|{}role[0]
        final fun <get-role>(): com.x.domain/Role // com.x.domain/Viewer.role.<get-role>|<get-role>(){}[0]

    final fun component1(): com.x.domain/Role // com.x.domain/Viewer.component1|component1(){}[0]
    final fun copy(com.x.domain/Role = ...): com.x.domain/Viewer // com.x.domain/Viewer.copy|copy(com.x.domain.Role){}[0]
}

final fun (com.x.domain/Viewer).com.x.domain/canApprove(): kotlin/Boolean // com.x.domain/canApprove|canApprove@com.x.domain.Viewer(){}[0]
final fun com.x.domain/canDelete(com.x.domain/Viewer): kotlin/Boolean // com.x.domain/canDelete|canDelete(com.x.domain.Viewer){}[0]
`

test('readKotlinApiDump reads a JVM .api dump, dropping generated members', () => {
  assert.deepEqual(readKotlinApiDump(JVM_DUMP), [
    'Permissions: canDelete',
    '(top level): canApprove',
    'Role: MANAGER, WORKER',
    'Viewer: role',
  ])
})

test('readKotlinApiDump reads a .klib.api dump, naming extension receivers', () => {
  assert.deepEqual(readKotlinApiDump(KLIB_DUMP), [
    'Role: MANAGER, WORKER',
    'Viewer: role',
    '(top level): Viewer.canApprove, canDelete',
  ])
})

test('listPublishedApi reads dump files and directories, skipping missing paths', () => {
  const root = workspace({
    'api/core.api': JVM_DUMP,
    'api/core.klib.api': KLIB_DUMP,
    'api/README.md': 'not a dump',
  })
  const text = listPublishedApi({
    paths: ['api', 'missing/core.api'],
    root,
    maxChars: 8000,
    format: KOTLIN_API_DUMP,
  })
  assert.match(text, /^Permissions: canDelete$/m)
  assert.match(text, /^\(top level\): Viewer\.canApprove, canDelete$/m)
  assert.doesNotMatch(text, /not a dump/)
})

// ── Preset wiring ──────────────────────────────────────────────────

function blockIndex(entries: readonly RuleEntry[], name: string): number {
  return entries.findIndex(
    (entry) => isRuleBlock(entry) && (entry.rules ?? []).some((r: Rule) => r.name === name),
  )
}

function tddIndex(entries: readonly RuleEntry[], firstGlob: string): number {
  return entries.findIndex((entry) => isRuleBlock(entry) && entry.files?.[0] === firstGlob)
}

const PRESETS = [
  { name: 'kmpRuleEntries', build: kmpRuleEntries, tddGlob: '**/src/*Main/kotlin/**' },
  { name: 'kotlinRuleEntries', build: kotlinRuleEntries, tddGlob: '**/src/main/java/**' },
] as const

for (const preset of PRESETS) {
  test(`${preset.name} wires no driving-adapter block by default`, () => {
    assert.equal(blockIndex(preset.build('/repo'), 'enforceThinDrivingAdapter'), -1)
  })

  test(`${preset.name} wires the block before the TDD judge when drivingAdapterGlobs is set`, () => {
    const entries = preset.build('/repo', {
      coreGlobs: ['**/core/**'],
      drivingAdapterGlobs: ['cli/src/main/**/commands/**'],
    })
    const index = blockIndex(entries, 'enforceThinDrivingAdapter')
    assert.ok(index >= 0, 'expected the block')
    assert.ok(index < tddIndex(entries, preset.tddGlob), 'must run before the TDD judge')
    const block = entries[index] as RuleBlock
    assert.equal(block.files?.[0], 'cli/src/main/**/commands/**')
    assert.ok(block.files?.includes('!**/core/**'), 'core globs are excluded')
    assert.deepEqual(block.rules?.map((r) => r.name), ['enforceThinDrivingAdapter'])
  })

  test(`${preset.name} uses Kotlin patterns for domainDiscriminants`, async () => {
    const entries = preset.build('/repo', {
      drivingAdapterGlobs: ['**/ui/**'],
      domainDiscriminants: ['role'],
    })
    const screen = (entries[blockIndex(entries, 'enforceThinDrivingAdapter')] as RuleBlock).rules![0]!
    assert.equal(screen.name, 'forbidNewDomainDiscriminantChecks')
    const result = await screen(write('if (viewer.role == Role.ADMIN) {}'), onDisk(undefined))
    assert.equal(result.kind, 'violation')
  })

  test(`${preset.name} gives the judge the Kotlin addendum, core exports and published API`, async () => {
    const root = workspace({
      'core/src/commonMain/kotlin/x/domain/Permissions.kt': 'fun Viewer.canApprove() = true',
      'api/core.api': JVM_DUMP,
    })
    const entries = preset.build(root, {
      coreGlobs: ['core/src/commonMain/**'],
      drivingAdapterGlobs: ['**/ui/**'],
      coreExportsInJudge: true,
      coreApiPaths: ['api'],
    })
    const judge = (entries[blockIndex(entries, 'enforceThinDrivingAdapter')] as RuleBlock).rules!.at(-1)!
    const prompts: string[] = []
    await judge(write('x'), judgeCtx(prompts))
    const prompt = prompts[0] ?? ''
    assert.match(prompt, /### Kotlin specifics: CLI commands and Compose screens/)
    assert.match(prompt, /exhaustive `when`/)
    assert.match(prompt, /## Core exports\n\ncore\/src\/commonMain\/kotlin\/x\/domain\/Permissions\.kt: Viewer\.canApprove/)
    assert.match(prompt, /^Permissions: canDelete$/m)
  })
}
