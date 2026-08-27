#!/usr/bin/env node
/**
 * Tests for spec-parity.mjs — run with `node Scripts/spec-parity.test.mjs`.
 *
 * Covers the parser contract during the Markdown-.feature.md ->
 * Gherkin-.feature migration: the checker must accept BOTH formats and
 * treat the extensions as interchangeable (a Covers tag written against
 * `x.feature.md` still resolves a scenario now living in `x.feature`,
 * and vice versa), so specs can convert one file at a time with parity
 * green throughout.
 *
 * Zero dependencies; each case builds an isolated temp workspace.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'spec-parity.mjs')

let passed = 0
let failed = 0

function run(dir, extraArgs = []) {
  const res = spawnSync(
    'node',
    [SCRIPT, '--specs', join(dir, 'specs'), '--tests', dir, '--pattern', 'tests', ...extraArgs],
    { encoding: 'utf8' },
  )
  return { code: res.status, out: (res.stdout ?? '') + (res.stderr ?? '') }
}

function workspace(files) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-parity-test-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

function check(name, cond) {
  if (cond) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}`)
  }
}

const MD_SPEC = `# Feature\n\n## Scenario: Thing happens\n\nGiven a precondition\nWhen an action\nThen an outcome\n`
const GHERKIN_SPEC = `Feature: Feature\n\n  Scenario: Thing happens\n    Given a precondition\n    When an action\n    Then an outcome\n`
const coversMd = 'tests/T.swift'
const coversTag = (ext) =>
  `// Covers: sample.${ext} :: Scenario: Thing happens\nfunc testThing() {}\n`

// 1. Characterization: markdown spec + .feature.md Covers tag holds.
{
  const d = workspace({ 'specs/sample.feature.md': MD_SPEC, [coversMd]: coversTag('feature.md') })
  const { code } = run(d)
  check('md spec + .feature.md tag -> parity holds (exit 0)', code === 0)
  rmSync(d, { recursive: true, force: true })
}

// 2. New: Gherkin spec + .feature Covers tag holds — and is actually parsed
// (a `1 scenario(s) covered` count distinguishes real parsing from the file
// being silently ignored, which would pass vacuously).
{
  const d = workspace({ 'specs/sample.feature': GHERKIN_SPEC, [coversMd]: coversTag('feature') })
  const { code, out } = run(d)
  check('gherkin spec + .feature tag -> parsed & holds (exit 0)', code === 0 && /1 scenario\(s\) covered/.test(out))
  rmSync(d, { recursive: true, force: true })
}

// 3. New interop: Gherkin spec still resolved by an old .feature.md tag.
{
  const d = workspace({ 'specs/sample.feature': GHERKIN_SPEC, [coversMd]: coversTag('feature.md') })
  const { code } = run(d)
  check('gherkin spec + legacy .feature.md tag -> resolves (exit 0)', code === 0)
  rmSync(d, { recursive: true, force: true })
}

// 4. New interop: markdown spec resolved by a new .feature tag.
{
  const d = workspace({ 'specs/sample.feature.md': MD_SPEC, [coversMd]: coversTag('feature') })
  const { code } = run(d)
  check('md spec + new .feature tag -> resolves (exit 0)', code === 0)
  rmSync(d, { recursive: true, force: true })
}

// 5. Characterization: dangling Covers tag fails.
{
  const d = workspace({ 'specs/sample.feature.md': MD_SPEC, [coversMd]: `// Covers: sample.feature.md :: Scenario: Nonexistent\nfunc testX(){}\n` })
  const { code, out } = run(d)
  check('dangling Covers tag -> exit 1', code === 1 && /no existing scenario/i.test(out))
  rmSync(d, { recursive: true, force: true })
}

// 6. Characterization: orphaned scenario (no covering test) fails.
{
  const d = workspace({ 'specs/sample.feature.md': MD_SPEC, 'tests/T.swift': 'func testNothing(){}\n' })
  const { code, out } = run(d)
  check('orphan scenario -> exit 1', code === 1 && /no covering acceptance test/i.test(out))
  rmSync(d, { recursive: true, force: true })
}

// 7. New: Gherkin @wip scenario is exempt from the orphan check.
{
  const wip = `Feature: F\n\n  @wip\n  Scenario: Work in progress\n    Given x\n    Then y\n`
  const d = workspace({ 'specs/sample.feature': wip, 'tests/T.swift': 'func testNothing(){}\n' })
  const { code, out } = run(d)
  check('gherkin @wip scenario -> parsed & exempt (exit 0)', code === 0 && /1 wip/.test(out))
  rmSync(d, { recursive: true, force: true })
}

// 8. New: Gherkin @system scope tag requires a system-scope covering test.
{
  const sys = `Feature: F\n\n  @system\n  Scenario: Scoped\n    Given x\n    Then y\n`
  const tag = '// Covers: sample.feature :: Scenario: Scoped\nfunc testScoped(){}\n'
  // Covering test is NOT under a system/ path -> system scope unmet -> exit 1.
  const d1 = workspace({ 'specs/sample.feature': sys, 'tests/unit/T.swift': tag })
  const r1 = run(d1, ['--scope', 'system=tests[/\\\\]system[/\\\\]', '--default-scopes', ''])
  check('gherkin @system unmet -> exit 1', r1.code === 1 && /\[system\]/.test(r1.out))
  rmSync(d1, { recursive: true, force: true })
  // Covering test IS under system/ -> satisfied -> exit 0.
  const d2 = workspace({ 'specs/sample.feature': sys, 'tests/system/T.swift': tag })
  const r2 = run(d2, ['--scope', 'system=tests[/\\\\]system[/\\\\]', '--default-scopes', ''])
  check('gherkin @system satisfied -> parsed & holds (exit 0)', r2.code === 0 && /1 scenario\(s\) covered/.test(r2.out))
  rmSync(d2, { recursive: true, force: true })
}

// 9. New safety: the same stem in both extensions is a migration error.
{
  const d = workspace({
    'specs/sample.feature.md': MD_SPEC,
    'specs/sample.feature': GHERKIN_SPEC,
    [coversMd]: coversTag('feature'),
  })
  const { code, out } = run(d)
  check('duplicate stem (.feature.md + .feature) -> error (exit 2)', code === 2 && /exists in both|single extension/i.test(out))
  rmSync(d, { recursive: true, force: true })
}

console.log(`\nspec-parity tests: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
