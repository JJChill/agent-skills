// Issue #115: every TDD judge knows an expected-to-fail acceptance test's
// green run is not evidence, that removing its marker is promotion, and
// that adding the marker to an existing test disables it.
import assert from 'node:assert/strict'
import test from 'node:test'

import { KOTLIN_TDD_ADDENDUM } from '../internal/kotlin-tdd.ts'
import { SWIFT_TDD_ADDENDUM } from '../internal/swift-tdd.ts'
import { JS_TDD_ADDENDUM } from './js-tdd.ts'

for (const [name, addendum] of [
  ['Kotlin', KOTLIN_TDD_ADDENDUM],
  ['Swift', SWIFT_TDD_ADDENDUM],
  ['JS', JS_TDD_ADDENDUM],
] as const) {
  test(`${name} TDD addendum covers in-progress acceptance tests`, () => {
    assert.match(addendum, /expected to fail/)
    assert.match(addendum, /not evidence/)
    assert.match(addendum, /promotion/)
    assert.match(addendum, /disables/)
  })
}
