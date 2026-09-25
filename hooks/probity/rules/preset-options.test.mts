// Coverage for the preset-options work (issues #18, #19, #21):
//   - the JS preset's opt-in spec-to-test parity wiring (off by
//     default, on when `specsDir` is set)
//   - the KMP preset's options object superseding its old
//     `{ driverScopes, defaultScopes }` second parameter, while old
//     callers keep working unchanged
//   - `excludeGlobs` keeping spikes/build output out of every
//     files-scoped block across the KMP, Kotlin, and JS presets
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import test from 'node:test'

import type { Rule, RuleBlock, RuleContext, RuleEntry } from '@nizos/probity'

import { jsRuleEntries } from '../presets/js.ts'
import { kmpRuleEntries } from '../presets/kmp.ts'
import { kotlinRuleEntries } from '../presets/kotlin.ts'
import { anchorGlob, buildMatcher, isRuleBlock } from './scoping.ts'

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'preset-options-test-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

/** Finds a rule by its function name anywhere in a rule-entry list —
 *  as a flat rule, or inside a `{ files, rules }` block. */
function findRule(
  entries: readonly RuleEntry[],
  name: string,
): { block?: RuleBlock; rule: Rule } | undefined {
  for (const entry of entries) {
    if (!isRuleBlock(entry)) {
      if (entry.name === name) return { rule: entry }
      continue
    }
    const rule = entry.rules?.find((r) => r.name === name)
    if (rule) return { block: entry, rule }
  }
  return undefined
}

function findBlockContaining(entries: readonly RuleEntry[], name: string): RuleBlock | undefined {
  return findRule(entries, name)?.block
}

const noopCtx: RuleContext = {
  readFile: async () => ({ kind: 'absent' }),
}

// ── Issue #18: JS preset parity is opt-in, off by default ──────────

test('jsRuleEntries wires no spec-to-test parity rules by default', () => {
  const entries = jsRuleEntries()
  for (const name of [
    'requireSpecBackedAcceptanceTest',
    'surfaceScenarioLinkBreakage',
    'enforceSpecTestParity',
    'surfaceGlossaryTermBreakage',
  ]) {
    assert.equal(findRule(entries, name), undefined, `${name} should not be wired by default`)
  }
})

test('jsRuleEntries wires spec-to-test parity once specsDir is set', () => {
  const dir = workspace({
    'docs/specs/checkout.feature.md': '## Scenario: Existing scenario\nGiven a\nThen b\n',
  })
  try {
    const entries = jsRuleEntries({ specsDir: join(dir, 'docs/specs') })
    assert.ok(findRule(entries, 'requireSpecBackedAcceptanceTest'), 'requireSpecBackedAcceptanceTest wired')
    assert.ok(findRule(entries, 'surfaceScenarioLinkBreakage'), 'surfaceScenarioLinkBreakage wired')
    assert.ok(findRule(entries, 'enforceSpecTestParity'), 'enforceSpecTestParity wired')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('jsRuleEntries blocks a new it() with no Covers tag once specsDir is set', async () => {
  const dir = workspace({
    'docs/specs/checkout.feature.md': '## Scenario: Existing scenario\nGiven a\nThen b\n',
  })
  try {
    const entries = jsRuleEntries({ specsDir: join(dir, 'docs/specs') })
    const found = findRule(entries, 'requireSpecBackedAcceptanceTest')
    assert.ok(found, 'requireSpecBackedAcceptanceTest should be wired')
    const action = {
      kind: 'write' as const,
      path: join(dir, 'acceptance/checkout.test.ts'),
      content: "it('does the thing', () => {})\n",
    }
    const result = await found.rule(action, noopCtx)
    assert.equal(result.kind, 'violation')
    assert.match((result as { reason: string }).reason, /Covers:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('jsRuleEntries passes a new it() carrying a resolving Covers tag', async () => {
  const dir = workspace({
    'docs/specs/checkout.feature.md': '## Scenario: Existing scenario\nGiven a\nThen b\n',
  })
  try {
    const entries = jsRuleEntries({ specsDir: join(dir, 'docs/specs') })
    const found = findRule(entries, 'requireSpecBackedAcceptanceTest')
    assert.ok(found)
    const action = {
      kind: 'write' as const,
      path: join(dir, 'acceptance/checkout.test.ts'),
      content:
        "// Covers: checkout.feature.md :: Scenario: Existing scenario\nit('does the thing', () => {})\n",
    }
    const result = await found.rule(action, noopCtx)
    assert.equal(result.kind, 'pass')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Issue #19: KmpPresetOptions supersedes the old parity param ────

test('kmpRuleEntries: old { driverScopes } callers keep working unchanged', () => {
  const entries = kmpRuleEntries('/repo', {
    driverScopes: [{ name: 'system', filePattern: /acceptance[/\\]system[/\\]/ }],
  })
  assert.ok(Array.isArray(entries) && entries.length > 0)
  assert.ok(findRule(entries, 'enforceSpecTestParity'), 'enforceSpecTestParity still wired')
})

test('kmpRuleEntries: specsDir option overrides where scenarios/covers are scanned', async () => {
  const dir = workspace({
    'custom-specs/checkout.feature.md': '## Scenario: Custom-dir scenario\nGiven a\nThen b\n',
  })
  try {
    const entries = kmpRuleEntries(dir, { specsDir: join(dir, 'custom-specs') })
    const found = findRule(entries, 'requireSpecBackedAcceptanceTest')
    assert.ok(found)
    const blocked = await found.rule(
      {
        kind: 'write',
        path: join(dir, 'acceptance/CheckoutSpec.kt'),
        content: '@Test fun testThing() {}\n',
      },
      noopCtx,
    )
    assert.equal(blocked.kind, 'violation', 'default docs/specs is not scanned once specsDir is overridden')

    const allowed = await found.rule(
      {
        kind: 'write',
        path: join(dir, 'acceptance/CheckoutSpec.kt'),
        content:
          '// Covers: checkout.feature.md :: Scenario: Custom-dir scenario\n@Test fun testThing() {}\n',
      },
      noopCtx,
    )
    assert.equal(allowed.kind, 'pass', 'custom specsDir is scanned for existing scenarios')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('kmpRuleEntries: acceptanceTestGlobs option overrides which files carry the write-time gate', () => {
  const defaultEntries = kmpRuleEntries('/repo')
  const defaultBlock = findBlockContaining(defaultEntries, 'requireSpecBackedAcceptanceTest')
  assert.ok(defaultBlock?.files)
  assert.ok(buildMatcher(defaultBlock!.files!.map((g) => anchorGlob(g, '/repo')))('/repo/acceptance/FooSpec.kt'))

  const customEntries = kmpRuleEntries('/repo', {
    acceptanceTestGlobs: ['**/acceptanceTests/**/*Spec.kt'],
  })
  const customBlock = findBlockContaining(customEntries, 'requireSpecBackedAcceptanceTest')
  assert.ok(customBlock?.files)
  const matches = buildMatcher(customBlock!.files!.map((g) => anchorGlob(g, '/repo')))
  assert.ok(matches('/repo/acceptanceTests/FooSpec.kt'), 'custom glob matches the new layout')
  assert.equal(matches('/repo/acceptance/FooSpec.kt'), false, 'old default layout no longer matches')
})

test('kmpRuleEntries: glossaryPath option overrides which file the glossary-drift gate scopes to', () => {
  const defaultEntries = kmpRuleEntries('/repo')
  const defaultBlock = findBlockContaining(defaultEntries, 'surfaceGlossaryTermBreakage')
  assert.ok(defaultBlock?.files)
  assert.ok(
    buildMatcher(defaultBlock!.files!.map((g) => anchorGlob(g, '/repo')))('/repo/docs/GLOSSARY.md'),
  )

  const customEntries = kmpRuleEntries('/repo', {
    glossaryPath: '/repo/reference/TERMS.md',
  })
  const customBlock = findBlockContaining(customEntries, 'surfaceGlossaryTermBreakage')
  assert.ok(customBlock?.files)
  const matches = buildMatcher(customBlock!.files!.map((g) => anchorGlob(g, '/repo')))
  assert.ok(matches('/repo/reference/TERMS.md'), 'custom glossary path is scoped in')
  assert.equal(matches('/repo/docs/GLOSSARY.md'), false, 'old default path is no longer scoped in')
})

// ── Issue #21: excludeGlobs keeps spikes/build out of scope ─────────

const spikeWrite = {
  kind: 'write' as const,
  path: '/repo/spikes/prototype/src/main/kotlin/Foo.kt',
  content: 'class Foo',
}

function findKotlinTddBlock(entries: readonly RuleEntry[]): RuleBlock | undefined {
  return entries.find(
    (entry): entry is RuleBlock =>
      isRuleBlock(entry) &&
      !!entry.rules?.some((rule) => rule.name.includes('kotlinFastPath(enforceTdd)')),
  )
}

function tddBlockMatches(entries: readonly RuleEntry[], root: string, path: string): boolean {
  const block = findKotlinTddBlock(entries)
  assert.ok(block?.files, 'TDD block should exist')
  return buildMatcher(block!.files!.map((g) => anchorGlob(g, root)))(path)
}

test('kmpRuleEntries: a spikes/ write is excluded from the TDD block by default', () => {
  const entries = kmpRuleEntries('/repo')
  assert.equal(tddBlockMatches(entries, '/repo', spikeWrite.path), false)
})

test('kmpRuleEntries: excludeGlobs: [] re-includes spikes/ in the TDD block', () => {
  const entries = kmpRuleEntries('/repo', { excludeGlobs: [] })
  assert.equal(tddBlockMatches(entries, '/repo', spikeWrite.path), true)
})

test('kotlinRuleEntries: a spikes/ write is excluded from the TDD block by default, included with excludeGlobs: []', () => {
  const defaultEntries = kotlinRuleEntries('/repo')
  assert.equal(tddBlockMatches(defaultEntries, '/repo', spikeWrite.path), false)
  const openEntries = kotlinRuleEntries('/repo', { excludeGlobs: [] })
  assert.equal(tddBlockMatches(openEntries, '/repo', spikeWrite.path), true)
})

test('jsRuleEntries: a build/ write is excluded from the TDD block by default, included with excludeGlobs: []', () => {
  const buildWrite = '/repo/src/build/index.js'
  const defaultEntries = jsRuleEntries()
  const defaultBlock = findRule(defaultEntries, 'enforceTdd')?.block
  assert.ok(defaultBlock?.files, 'TDD block should exist in JS preset')
  assert.equal(
    buildMatcher(defaultBlock!.files!.map((g) => anchorGlob(g, '/repo')))(buildWrite),
    false,
  )
  const openEntries = jsRuleEntries({ excludeGlobs: [] })
  const openBlock = findRule(openEntries, 'enforceTdd')?.block
  assert.ok(openBlock?.files)
  assert.equal(
    buildMatcher(openBlock!.files!.map((g) => anchorGlob(g, '/repo')))(buildWrite),
    true,
  )
})
