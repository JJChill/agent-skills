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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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

// 10. Issue #55: a linked git worktree nested in the scanned root (Claude
// Code puts them at .claude/worktrees/<name>/, marked by a `.git` FILE)
// is another checkout. Its Covers tags must not count for this one.
{
  const nested = '.claude/worktrees/other'
  const d = workspace({
    'specs/sample.feature.md': MD_SPEC,
    [`${nested}/.git`]: 'gitdir: /elsewhere/.git/worktrees/other\n',
    [`${nested}/${coversMd}`]: coversTag('feature.md'),
  })
  const { code, out } = run(d)
  check('scenario covered only in a nested worktree -> orphan (exit 1)', code === 1 && /no covering acceptance test/i.test(out))
  rmSync(d, { recursive: true, force: true })
}

// 11. Issue #55: with the tag in both trees, only this tree's tag counts.
{
  const nested = '.claude/worktrees/other'
  const d = workspace({
    'specs/sample.feature.md': MD_SPEC,
    [coversMd]: coversTag('feature.md'),
    [`${nested}/.git`]: 'gitdir: /elsewhere/.git/worktrees/other\n',
    [`${nested}/${coversMd}`]: coversTag('feature.md'),
  })
  const { code, out } = run(d)
  check('nested worktree tags not counted (1 Covers tag resolved)', code === 0 && /, 1 Covers tag\(s\) resolved/.test(out))
  rmSync(d, { recursive: true, force: true })
}

// 12. Issue #55: a --tests root that is itself a linked worktree is still scanned.
{
  const d = workspace({
    'specs/sample.feature.md': MD_SPEC,
    '.git': 'gitdir: /elsewhere/.git/worktrees/this\n',
    [coversMd]: coversTag('feature.md'),
  })
  const { code } = run(d)
  check('scanned root that is a linked worktree -> still scanned (exit 0)', code === 0)
  rmSync(d, { recursive: true, force: true })
}

// 13–23. Issue #105: per-project exclusions and ignored tags, for a spec
// repository shared by several consumers.
const SHARED = `Feature: F

  Scenario: Ours
    Given a
    Then b

  @service
  Scenario: Backend enforces it
    Given a
    Then b
`
const oursCovered = '// Covers: sample.feature :: Scenario: Ours\nfunc testOurs() {}\n'
const EXCLUSION = 'sample.feature :: Backend enforces it # backend enforces the block list\n'

// 13. An excluded scenario passes; the report lists it with its reason.
// Its @service tag is not checked: excluded scenarios skip scope checks.
{
  const d = workspace({
    'specs/sample.feature': SHARED,
    [coversMd]: oursCovered,
    'parity/exclusions.txt': EXCLUSION,
  })
  const { code, out } = run(d, ['--exclusions', join(d, 'parity/exclusions.txt')])
  check(
    'exclusion: excluded scenario passes and is reported with its reason',
    code === 0 &&
      /1 scenario\(s\) covered/.test(out) &&
      /1 not this project's/.test(out) &&
      /Backend enforces it — backend enforces the block list/.test(out),
  )
  rmSync(d, { recursive: true, force: true })
}

// 14. A missing exclusions file means no exclusions.
{
  const d = workspace({ 'specs/sample.feature': SHARED, [coversMd]: oursCovered })
  const { code, out } = run(d, ['--exclusions', join(d, 'parity/none.txt')])
  check('exclusion: missing file -> full enforcement (exit 1)', code === 1 && /Backend enforces it/.test(out))
  rmSync(d, { recursive: true, force: true })
}

// 15. Every exclusion needs a reason.
{
  const d = workspace({
    'specs/sample.feature': SHARED,
    [coversMd]: oursCovered,
    'parity/exclusions.txt': 'sample.feature :: Backend enforces it\n',
  })
  const { code, out } = run(d, ['--exclusions', join(d, 'parity/exclusions.txt')])
  check('exclusion: line without a reason -> usage error (exit 2)', code === 2 && /reason/i.test(out))
  rmSync(d, { recursive: true, force: true })
}

// 16. An exclusion matching no scenario fails, like a dangling Covers tag.
{
  const d = workspace({
    'specs/sample.feature': SHARED,
    [coversMd]: oursCovered,
    'parity/exclusions.txt': EXCLUSION + 'sample.feature :: Renamed away # gone\n',
  })
  const { code, out } = run(d, ['--exclusions', join(d, 'parity/exclusions.txt')])
  check('exclusion: dangling exclusion fails (exit 1)', code === 1 && /Renamed away/.test(out))
  rmSync(d, { recursive: true, force: true })
}

// 17. An exclusion for a scenario a test now claims is stale.
{
  const d = workspace({
    'specs/sample.feature': SHARED,
    [coversMd]: oursCovered + '// Covers: sample.feature :: Scenario: Backend enforces it\n',
    'parity/exclusions.txt': EXCLUSION,
  })
  const { code, out } = run(d, ['--exclusions', join(d, 'parity/exclusions.txt'), '--ignore-tags', 'service'])
  check('exclusion: excluded but claimed -> stale exclusion (exit 1)', code === 1 && /test now claims/.test(out))
  rmSync(d, { recursive: true, force: true })
}

// 18. An excluded scenario also in the baseline is a stale baseline line.
{
  const d = workspace({
    'specs/sample.feature': SHARED,
    [coversMd]: oursCovered,
    'parity/exclusions.txt': EXCLUSION,
    'parity/baseline': 'sample.feature :: Backend enforces it\n',
  })
  const { code, out } = run(d, [
    '--exclusions', join(d, 'parity/exclusions.txt'),
    '--baseline', join(d, 'parity/baseline'),
  ])
  check('exclusion: excluded and baselined -> stale baseline line (exit 1)', code === 1 && /baseline/i.test(out))
  rmSync(d, { recursive: true, force: true })
}

// 19. --write-baseline leaves excluded scenarios out.
{
  const d = workspace({
    'specs/sample.feature': SHARED,
    'parity/exclusions.txt': EXCLUSION,
  })
  const baselineFile = join(d, 'parity/baseline')
  const { code } = run(d, [
    '--exclusions', join(d, 'parity/exclusions.txt'),
    '--baseline', baselineFile, '--write-baseline',
  ])
  const written = readFileSync(baselineFile, 'utf8')
  check(
    'exclusion: --write-baseline skips excluded scenarios',
    code === 0 && /:: Ours/.test(written) && !/Backend enforces it/.test(written),
  )
  rmSync(d, { recursive: true, force: true })
}

// 20. --ignore-tags drops a shared tag the project doesn't use.
{
  const d = workspace({
    'specs/sample.feature': SHARED,
    [coversMd]: oursCovered + '// Covers: sample.feature :: Scenario: Backend enforces it\n',
  })
  const ignored = run(d, ['--ignore-tags', 'service'])
  const unignored = run(d)
  check(
    'ignore-tags: an ignored tag is not a scope; an unlisted one still fails',
    ignored.code === 0 && unignored.code === 1 && /\[service\]/.test(unignored.out),
  )
  rmSync(d, { recursive: true, force: true })
}

// 21. Markdown [tag] markers follow the same ignore rule.
{
  const d = workspace({
    'specs/sample.feature.md': '# F\n\n## Scenario [service]: Thing happens\n\nGiven a\nThen b\n',
    [coversMd]: coversTag('feature.md'),
  })
  const { code } = run(d, ['--ignore-tags', 'service'])
  check('ignore-tags: markdown [tag] is ignored too (exit 0)', code === 0)
  rmSync(d, { recursive: true, force: true })
}

// 22. A tag both declared as a scope and ignored is a contradiction.
{
  const d = workspace({ 'specs/sample.feature': SHARED, [coversMd]: oursCovered })
  const scope = run(d, ['--scope', 'service=tests/', '--ignore-tags', 'service'])
  const marker = run(d, ['--ignore-tags', 'wip'])
  check(
    'ignore-tags: declared scope or wip marker in the list -> usage error (exit 2)',
    scope.code === 2 && marker.code === 2,
  )
  rmSync(d, { recursive: true, force: true })
}

console.log(`\nspec-parity tests: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
