import assert from 'node:assert/strict'
import test from 'node:test'

import type { RuleContext, RuleEntry } from '@nizos/probity'

import { kmpRuleEntries } from '../presets/kmp.ts'
import { kotlinRuleEntries } from '../presets/kotlin.ts'

const productionWrite = {
  kind: 'write' as const,
  path: '/repo/sdk/core/src/commonMain/kotlin/FileStore.kt',
  content: 'class FileStore { fun load() = "value" }',
}

const presetFactories = [
  ['KMP', kmpRuleEntries],
  ['classic Kotlin', kotlinRuleEntries],
] as const

function kotlinTddRule(entries: RuleEntry[], preset: string) {
  const entry = entries.find((candidate) =>
    candidate.rules?.some((rule) => rule.name.includes('kotlinFastPath(enforceTdd)')),
  )
  const rule = entry?.rules?.find((candidate) =>
    candidate.name.includes('kotlinFastPath(enforceTdd)'),
  )
  assert.ok(rule, `${preset} preset should expose its wrapped Kotlin TDD rule`)
  return rule
}

async function forEachCapturedPrompt(
  rawHistory: Awaited<ReturnType<NonNullable<RuleContext['rawHistory']>>>,
  verify: (prompt: string, preset: string) => void,
) {
  for (const [preset, factory] of presetFactories) {
    let prompt = ''
    const ctx: RuleContext = {
      readFile: async () => ({ kind: 'present', content: 'class FileStore' }),
      rawHistory: async () => rawHistory,
      agent: {
        reason: async (value) => {
          prompt = value
          return { kind: 'pass', reason: '' }
        },
      },
    }
    await kotlinTddRule(factory('/repo'), preset)(productionWrite, ctx)
    verify(prompt, preset)
  }
}

test('Kotlin TDD judge treats a TODO runtime failure as clean red evidence', async () => {
  await forEachCapturedPrompt([], (prompt, preset) => {
    assert.match(prompt, /Kotlin-specific exception.*NotImplementedError.*clean red/is, preset)
    assert.match(prompt, /TODO\(\).*Do not require a second run/is, preset)
    assert.match(prompt, /assertions present in the relevant test source/i, preset)
  })
})

test('Kotlin TDD judge limits compile-error red to scaffolding rather than behavior', async () => {
  await forEachCapturedPrompt([], (prompt, preset) => {
    assert.match(prompt, /compile, unresolved-import, or signature failure is not a clean red/i, preset)
    assert.match(prompt, /only placeholder, signature, or scaffolding work/i, preset)
    assert.match(prompt, /does not authorize implementing the asserted behavior/i, preset)
  })
})

test('Kotlin TDD judge permits one cohesive green write across required branches', async () => {
  await forEachCapturedPrompt([], (prompt, preset) => {
    assert.match(prompt, /cohesive green write across multiple methods or branches/i, preset)
    assert.match(prompt, /assertions present in that same relevant test source/i, preset)
    assert.match(prompt, /No artificial test rerun is required/i, preset)
    assert.match(
      prompt,
      /assertions are not visible.*authorizes placeholder or scaffolding work only/is,
      preset,
    )
  })
})

test('Kotlin TDD judge does not depend on git staging', async () => {
  await forEachCapturedPrompt([], (prompt, preset) => {
    assert.match(prompt, /Git staging and git-index state are irrelevant/i, preset)
    assert.match(prompt, /do not require a test or production file to be staged/i, preset)
  })
})

test('Kotlin TDD prompt retains a nearby red beyond the upstream ten-event default', async () => {
  const red = {
    kind: 'action' as const,
    tool: 'Bash',
    input: './gradlew :sdk:core:jvmTest',
    output: 'FileStoreTest > loads value FAILED\nkotlin.NotImplementedError: An operation is not implemented.',
    toolUseId: 'red',
  }
  const filler = (count: number) => Array.from({ length: count }, (_, index) => ({
    kind: 'action' as const,
    tool: 'Read',
    input: { file_path: `/repo/reference-${index}.kt` },
    output: 'reference context',
    toolUseId: `filler-${index}`,
  }))

  await forEachCapturedPrompt([red, ...filler(12)], (prompt, preset) => {
    assert.match(prompt, /FileStoreTest > loads value FAILED/, preset)
    assert.match(prompt, /kotlin\.NotImplementedError/, preset)
  })
  await forEachCapturedPrompt([red, ...filler(20)], (prompt, preset) => {
    assert.doesNotMatch(prompt, /FileStoreTest > loads value FAILED/, preset)
  })
})
