import assert from 'node:assert/strict'
import test from 'node:test'

import { buildJudgeSet } from './judge-set.ts'
import type { JudgeCase } from './judge-cases.ts'

// The builder runs in CI on every change (no model calls), so a case
// that stops reaching its judge fails the PR, not the release replay.
test('every labelled case reaches the judge it is labelled for', async () => {
  const { records, problems } = await buildJudgeSet()
  assert.deepEqual(problems, [])
  assert.ok(records.length > 0)
  for (const record of records) {
    assert.equal(record.primary.name, 'expected')
    assert.doesNotMatch(record.wholePrompt, /probity-judge-set-/, `${record.at}: scratch path leaked into the prompt`)
  }
})

test('a case decided before its judge is reported, not silently dropped', async () => {
  const blocked: JudgeCase = {
    id: 'vendor-import-in-core',
    task: 'enforceTdd',
    expect: 'violation',
    source: 'test',
    preset: 'js',
    write: { path: 'src/core/thing.ts', content: "import axios from 'axios'\nexport const x = 1\n" },
  }
  const { records, problems } = await buildJudgeSet([blocked])
  assert.equal(records.length, 0)
  assert.match(problems[0]!, /vendor-import-in-core: never reached the enforceTdd judge \(got \(blocked by /)
})
