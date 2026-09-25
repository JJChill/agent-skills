import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'scope-report.ts')
const TSX = join(HERE, '..', 'node_modules', '.bin', 'tsx')

// Rule names are all the report sees, so plain named functions stand
// in for the real rules.
const CONFIG = `
function forbidContentPattern() { return { kind: 'pass' } }
export default {
  rules: [
    { files: ${JSON.stringify(['**/src/test/**'])}, rules: [forbidContentPattern] },
    { files: ${JSON.stringify(['**/src/main/**'])}, rules: [forbidContentPattern] },
  ],
}
`

function workspace(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'scope-report-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

function report(dir) {
  const res = spawnSync(TSX, [SCRIPT, '--root', dir, '--config', join(dir, 'probity.config.mjs')], {
    encoding: 'utf8',
  })
  return (res.stdout ?? '') + (res.stderr ?? '')
}

test('a test-wide content screen over adapter tests is not flagged as core purity', (t) => {
  const dir = workspace(t, {
    'probity.config.mjs': CONFIG,
    'sdk/src/test/kotlin/adapter/HttpAdapterTest.kt': 'class HttpAdapterTest',
    'sdk/src/test/kotlin/di/ModuleTest.kt': 'class ModuleTest',
    'sdk/src/main/kotlin/domain/PathId.kt': 'object PathId',
  })
  const out = report(dir)
  assert.match(out, /No scoping warnings\./, out)
})

test('a core-purity rule claiming production adapter code is still flagged', (t) => {
  const dir = workspace(t, {
    'probity.config.mjs': CONFIG,
    'sdk/src/test/kotlin/adapter/HttpAdapterTest.kt': 'class HttpAdapterTest',
    'sdk/src/main/kotlin/adapter/HttpAdapter.kt': 'class HttpAdapter',
  })
  const out = report(dir)
  assert.match(out, /block 2 \[forbidContentPattern\] claims 1 adapter\/DI\/UI-looking file/, out)
  assert.match(out, /src\/main\/kotlin\/adapter\/HttpAdapter\.kt/, out)
  assert.doesNotMatch(out, /block 1 \[forbidContentPattern\] claims/, out)
})
