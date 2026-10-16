// Coverage for issue #136: a red test's expectation was wrong about the
// test environment, not the code (an iOS simulator test host has no
// Keychain). Correcting it after the production change reads as
// retrofitting, and the judge rightly can't tell the two apart. The
// denial names the way through: restart the cycle so the corrected
// expectation is seen failing against the unchanged code.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Rule, RuleContext, RuleEntry } from '@nizos/probity'

import { kmpRuleEntries } from '../presets/kmp.ts'
import { kotlinRuleEntries } from '../presets/kotlin.ts'

const presets = [
  ['KMP', kmpRuleEntries, '/repo/sdk/mysudo/src/iosTest/kotlin/AnswerCallTest.kt'],
  ['classic Kotlin', kotlinRuleEntries, '/repo/app/src/test/kotlin/AnswerCallTest.kt'],
] as const

const RED_TEST = `class AnswerCallTest {
    @Test
    fun answeringBeforeSetUpIsRefused() = runTest {
        assertEquals(AnswerOutcome.NotSetUp(NotSetUpReason.NotSignedIn), client.calls.answer(CALL))
    }
}
`

const CORRECTED_TEST = RED_TEST.replace(
  'AnswerOutcome.NotSetUp(NotSetUpReason.NotSignedIn)',
  'AnswerOutcome.Failed(ProtectedStoreUnavailable)',
)

function tddRule(entries: RuleEntry[], preset: string): Rule {
  for (const entry of entries) {
    if (typeof entry === 'function') continue
    const rule = entry.rules.find((candidate) => candidate.name.includes('enforceTdd'))
    if (rule) return rule
  }
  assert.fail(`${preset} preset should expose a TDD rule`)
}

function denying(reason: string): RuleContext {
  return {
    readFile: async () => ({ kind: 'present', content: RED_TEST }),
    rawHistory: async () => [],
    history: async () => [],
    agent: { reason: async () => ({ kind: 'violation', reason }) },
  }
}

const RETROFIT_REASONS = [
  'This replaces the asserted outcome NotSetUp(NotSignedIn) with ProtectedStoreUnavailable, ' +
    'which is what the production code now produces: retrofitting a red test to fit the implementation.',
  'The write weakens the test so the current production code passes, without a failing run of the new expectation.',
  'Changing the expected value to match the current code after the production change is not tightening.',
]

for (const [preset, factory, testPath] of presets) {
  const rule = tddRule(factory('/repo'), preset)

  for (const reason of RETROFIT_REASONS) {
    test(`${preset}: a retrofit denial names the restart path — "${reason.slice(0, 40)}…"`, async () => {
      const result = await rule({ kind: 'write', path: testPath, content: CORRECTED_TEST }, denying(reason))
      assert.equal(result.kind, 'violation')
      const text = result.reason ?? ''
      assert.ok(text.startsWith(reason), 'the judge reason comes first')
      assert.match(text, /revert the production change/i)
      assert.match(text, /fail/i)
      assert.match(text, /new test/i)
    })

    test(`${preset}: a retrofit denial does not offer the characterization or probe markers — "${reason.slice(0, 40)}…"`, async () => {
      const result = await rule({ kind: 'write', path: testPath, content: CORRECTED_TEST }, denying(reason))
      assert.doesNotMatch(result.reason ?? '', /probity: characterization/)
      assert.doesNotMatch(result.reason ?? '', /probity: mutation-probe/)
    })
  }

  test(`${preset}: an unrelated test denial carries no restart note`, async () => {
    const result = await rule(
      { kind: 'write', path: testPath, content: CORRECTED_TEST },
      denying('Adds three tests in one write; add one at a time.'),
    )
    assert.doesNotMatch(result.reason ?? '', /revert the production change/i)
  })

  test(`${preset}: a production denial carries no restart note`, async () => {
    const result = await rule(
      { kind: 'write', path: testPath.replace(/src\/\w*[tT]est\//, 'src/main/').replace('Test.kt', '.kt'), content: 'class AnswerCall\n' },
      denying('The test was retrofitted earlier; this production write has no failing test.'),
    )
    assert.doesNotMatch(result.reason ?? '', /revert the production change/i)
  })
}
