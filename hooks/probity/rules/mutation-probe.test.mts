// Coverage for issue #134: a deliberate break made to watch a scenario
// fail (a mutation check, here on a test-support stub that lives in a
// `src/main` source set) was denied by the TDD judge as an untested
// behaviour change under green. The sanctioned route is the
// `// probity: mutation-probe` marker; a denial that reads like that
// case names it, so the agent finds the route in either harness.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Action, Rule, RuleContext, RuleResult } from '@nizos/probity'

import { withMutationProbe } from './kotlin.ts'

const STUB = '/repo/testbackend/src/main/kotlin/shop/testbackend/StubEmailService.kt'

function denying(reason: string) {
  const calls: Action[] = []
  const rule: Rule = async (action: Action): Promise<RuleResult> => {
    calls.push(action)
    return { kind: 'violation', reason }
  }
  return { calls, rule }
}

const write = (content: string) => ({ kind: 'write' as const, path: STUB, content })
const ctx = {} as RuleContext

test('a marked break passes without consulting the TDD rule', async () => {
  const { calls, rule } = denying('never observed failing')
  const result = await withMutationProbe(rule)(
    write('fun keyId(k: ByteArray) = digest("SHA-1", k) // probity: mutation-probe\n'),
    ctx,
  )
  assert.equal(result.kind, 'pass')
  assert.equal(calls.length, 0)
})

for (const reason of [
  'This is a behaviour change under green with no failing test behind it.',
  'The digest change has not been observed failing in any test run.',
  'No failing test drives this change.',
]) {
  test(`a denial for an untested change names the probe marker: "${reason}"`, async () => {
    const { rule } = denying(reason)
    const result = await withMutationProbe(rule)(write('fun keyId(k: ByteArray) = digest("SHA-1", k)\n'), ctx)
    assert.equal(result.kind, 'violation')
    const text = (result as { reason: string }).reason
    assert.ok(text.startsWith(reason), 'the judge reason comes first')
    assert.match(text, /\/\/ probity: mutation-probe/)
    assert.match(text, /revert/i)
  })
}

test('other denials pass through untouched', async () => {
  const reason = 'Core code imports an infrastructure package.'
  const { rule } = denying(reason)
  const result = await withMutationProbe(rule)(write('import okhttp3.OkHttpClient\n'), ctx)
  assert.equal((result as { reason: string }).reason, reason)
})

test('a pass from the wrapped rule stays a pass', async () => {
  const rule: Rule = async () => ({ kind: 'pass' })
  const result = await withMutationProbe(rule)(write('fun x() = 1\n'), ctx)
  assert.equal(result.kind, 'pass')
})
