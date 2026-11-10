// The CI templates in ci/ are copied into consuming projects, so a flag a
// bin no longer takes would fail their pipelines. Every probity bin they
// call, and every flag they pass it, must exist.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const here = (path) => new URL(`../${path}`, import.meta.url)
const pkg = JSON.parse(readFileSync(here('package.json'), 'utf8'))
const SOURCES = {
  'probity-scope-report': 'scripts/scope-report.ts',
  'probity-spec-parity': 'scripts/spec-parity.mjs',
  'probity-review-record': 'scripts/review-record.ts',
}

for (const template of ['ci/github-actions.yml', 'ci/gitlab-ci.yml']) {
  test(`${template} calls only bins and flags that exist`, () => {
    // Join continued shell lines so a command's flags stay together.
    const text = readFileSync(here(template), 'utf8').replace(/\\\n\s*/g, ' ')
    const calls = [...text.matchAll(/npx (probity-[\w-]+)([^\n]*)/g)]
    assert.deepEqual([...new Set(calls.map((call) => call[1]))].sort(), Object.keys(SOURCES).sort())
    for (const [, bin, rest] of calls) {
      assert.ok(pkg.bin[bin], `${bin} is not a bin of the package`)
      const source = readFileSync(here(SOURCES[bin]), 'utf8')
      for (const flag of rest.match(/--[\w-]+/g) ?? []) {
        assert.ok(source.includes(`'${flag}'`), `${template}: ${bin} takes no ${flag}`)
      }
    }
  })
}

test('the CI templates ship in the package', () => {
  assert.ok(pkg.files.includes('ci/github-actions.yml'))
  assert.ok(pkg.files.includes('ci/gitlab-ci.yml'))
})
