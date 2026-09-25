// Coverage for JS_TEST_DECLARATION (issue #12): the built-in JS/TS
// test-case-declaration pattern for requireSpecBackedAcceptanceTest,
// matching vitest/jest/mocha test cases without matching describe()
// blocks or identifiers that merely end in "it"/"test".
import assert from 'node:assert/strict'
import test from 'node:test'

import { JS_TEST_DECLARATION } from './spec-test-parity.ts'

function count(content: string): number {
  return [...content.matchAll(JS_TEST_DECLARATION)].length
}

test('JS_TEST_DECLARATION matches common vitest/jest/mocha test-case declarations', () => {
  assert.equal(count("it('does a thing', () => {})"), 1)
  assert.equal(count("test('does a thing', () => {})"), 1)
  assert.equal(count("it.only('focused', () => {})"), 1)
  assert.equal(count("test.skip('later', () => {})"), 1)
  assert.equal(count("it.each([1, 2])('case %i', (n) => {})"), 1)
  assert.equal(count("test.concurrent('parallel', async () => {})"), 1)
})

test('JS_TEST_DECLARATION does not match describe() or identifiers that merely end in it/test', () => {
  assert.equal(count("describe('a suite', () => {})"), 0)
  assert.equal(count("array.split(',')"), 0)
  assert.equal(count("form.submit()"), 0)
  assert.equal(count("logger.audit('event')"), 0)
  assert.equal(count("await wait(100)"), 0)
})

test('JS_TEST_DECLARATION counts every declaration in a file via matchAll', () => {
  assert.ok(JS_TEST_DECLARATION.global, 'pattern must carry the g flag for matchAll')
  const content = [
    "describe('suite', () => {",
    "  it('a', () => {})",
    "  test('b', () => {})",
    '})',
  ].join('\n')
  assert.equal(count(content), 2)
})
