import assert from 'node:assert/strict'
import test from 'node:test'

import * as barrel from '../index.ts'
import * as kotlin from './kotlin.ts'
import * as roundTrips from './round-trips.ts'

// The round-trips moved out of kotlin.ts; configs that import them from
// `@jjchill/probity-rules/rules/kotlin` must keep getting the same rules.
const NAMES = [
  'CHARACTERIZATION_MARKER',
  'enforceCharacterizationResolution',
  'enforceProbeReversion',
  'MUTATION_PROBE_MARKER',
  'withCharacterizationTest',
  'withInverseScenarioGuidance',
  'withMutationProbe',
] as const

test('the round-trips are the same from rules/round-trips, rules/kotlin and the package root', () => {
  for (const name of NAMES) {
    assert.ok(roundTrips[name], name)
    assert.equal(kotlin[name], roundTrips[name], `rules/kotlin ${name}`)
    assert.equal((barrel as Record<string, unknown>)[name], roundTrips[name], `index ${name}`)
  }
})
