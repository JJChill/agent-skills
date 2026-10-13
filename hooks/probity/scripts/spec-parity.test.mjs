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

// 23–29. Issue #106: stable scenario ids, so a shared spec repository can
// reword titles without breaking every consumer's references.
const withId = (title) =>
  `Feature: F\n\n  @id:blocked-number\n  Scenario: ${title}\n    Given a\n    Then b\n`
const coversId = '// Covers: @id:blocked-number\nfunc testBlocked() {}\n'

// 23. A Covers tag can cite a scenario by id; the id tag is not a scope.
{
  const d = workspace({ 'specs/sample.feature': withId('Blocked number cannot reach the owner'), [coversMd]: coversId })
  const { code, out } = run(d)
  check('ids: Covers by id resolves; @id is not a driver scope (exit 0)', code === 0 && /1 scenario\(s\) covered/.test(out))
  rmSync(d, { recursive: true, force: true })
}

// 24. Rewording the title keeps id references; title references break.
{
  const d = workspace({
    'specs/sample.feature': withId('A blocked number never reaches the owner'),
    [coversMd]: coversId,
  })
  const byId = run(d)
  writeFileSync(join(d, coversMd), '// Covers: sample.feature :: Scenario: Blocked number cannot reach the owner\n')
  const byTitle = run(d)
  check('ids: retitled scenario still claimed by id; stale title tag dangles', byId.code === 0 && byTitle.code === 1)
  rmSync(d, { recursive: true, force: true })
}

// 25. Markdown carries the id in the bracket list, beside scopes.
{
  const d = workspace({
    'specs/sample.feature.md': '# F\n\n## Scenario [system, id:blocked-number]: Blocked\n\nGiven a\nThen b\n',
    [coversMd]: coversId,
  })
  const { code } = run(d, ['--scope', 'system=tests/'])
  check('ids: markdown [scope, id:x] resolves by id and keeps the scope (exit 0)', code === 0)
  rmSync(d, { recursive: true, force: true })
}

// 26. A Covers tag citing an unknown id dangles.
{
  const d = workspace({ 'specs/sample.feature': withId('Blocked'), [coversMd]: coversId + '// Covers: @id:no-such-thing\n' })
  const { code, out } = run(d)
  check('ids: unknown id is a dangling Covers tag (exit 1)', code === 1 && /@id:no-such-thing/.test(out))
  rmSync(d, { recursive: true, force: true })
}

// 27. Ids are unique across the spec directory; one id per scenario.
{
  const dup = workspace({
    'specs/a.feature': withId('One'),
    'specs/b.feature': withId('Two'),
    [coversMd]: coversId,
  })
  const two = workspace({
    'specs/sample.feature': 'Feature: F\n\n  @id:one @id:two\n  Scenario: Both\n    Given a\n',
  })
  const a = run(dup)
  const b = run(two)
  check(
    'ids: duplicate id or two ids on one scenario -> usage error (exit 2)',
    a.code === 2 && /blocked-number/.test(a.out) && b.code === 2,
  )
  rmSync(dup, { recursive: true, force: true })
  rmSync(two, { recursive: true, force: true })
}

// 28. Baseline and exclusion lines can cite ids.
{
  const d = workspace({
    'specs/sample.feature': withId('Blocked') + '\n  @id:ours\n  Scenario: Ours\n    Given a\n',
    'parity/baseline': '@id:ours\n',
    'parity/exclusions.txt': '@id:blocked-number # backend enforces the block list\n',
  })
  const { code, out } = run(d, [
    '--baseline', join(d, 'parity/baseline'),
    '--exclusions', join(d, 'parity/exclusions.txt'),
  ])
  check(
    'ids: baseline and exclusion lines resolve by id (exit 0)',
    code === 0 && /1 baselined/.test(out) && /1 not this project's/.test(out),
  )
  rmSync(d, { recursive: true, force: true })
}

// 29. --write-baseline writes the id form for scenarios that have one.
{
  const d = workspace({ 'specs/sample.feature': withId('Blocked') + '\n  Scenario: Plain\n    Given a\n' })
  const file = join(d, 'parity/baseline')
  mkdirSync(join(d, 'parity'), { recursive: true })
  const { code } = run(d, ['--baseline', file, '--write-baseline'])
  const written = readFileSync(file, 'utf8')
  check(
    'ids: --write-baseline writes @id:<slug> where a scenario has one',
    code === 0 && /^@id:blocked-number$/m.test(written) && /^sample\.feature :: Plain$/m.test(written),
  )
  rmSync(d, { recursive: true, force: true })
}

// 30–35. Issue #111: per-project wip for a shared spec repository.
const TWO = `Feature: F

  Scenario: Ours
    Given a

  @wip @system
  Scenario: Shared wip
    Given a

  Scenario: Driving now
    Given a
`
const ours = '// Covers: sample.feature :: Scenario: Ours\n'
const WIP_LINE = 'sample.feature :: Driving now # outside-in, no clock port yet\n'
const wipArgs = (d) => ['--wip', join(d, 'parity/wip.txt')]

// 30. A wip line exempts the scenario; the report lists it with its note.
{
  const d = workspace({ 'specs/sample.feature': TWO, [coversMd]: ours, 'parity/wip.txt': WIP_LINE })
  const { code, out } = run(d, wipArgs(d))
  const noNote = workspace({ 'specs/sample.feature': TWO, [coversMd]: ours, 'parity/wip.txt': 'sample.feature :: Driving now\n' })
  const bad = run(noNote, wipArgs(noNote))
  check(
    'wip file: line exempts and is listed with its note; a line without a note -> exit 2',
    code === 0 && /2 wip/.test(out) && /Driving now — outside-in, no clock port yet/.test(out) && bad.code === 2,
  )
  rmSync(d, { recursive: true, force: true })
  rmSync(noNote, { recursive: true, force: true })
}

// 31. --shared-wip ignore makes spec markers informational.
{
  const d = workspace({ 'specs/sample.feature': TWO, [coversMd]: ours, 'parity/wip.txt': WIP_LINE })
  const honored = run(d, wipArgs(d))
  const ignored = run(d, [...wipArgs(d), '--shared-wip', 'ignore'])
  writeFileSync(join(d, 'parity/wip.txt'), WIP_LINE + 'sample.feature :: Shared wip # not started here\n')
  const listed = run(d, [...wipArgs(d), '--shared-wip', 'ignore'])
  check(
    'shared-wip ignore: spec @wip no longer exempts; a project wip line does',
    honored.code === 0 && ignored.code === 1 && /Shared wip/.test(ignored.out) && listed.code === 0,
  )
  rmSync(d, { recursive: true, force: true })
}

// 32. Stale wip lines fail: claimed, excluded, baselined, or matching nothing.
{
  const base = { 'specs/sample.feature': TWO, [coversMd]: ours, 'parity/wip.txt': WIP_LINE }
  const claimed = workspace({ ...base, [coversMd]: ours + '// Covers: sample.feature :: Scenario: Driving now\n' })
  const excluded = workspace({ ...base, 'parity/ex.txt': 'sample.feature :: Driving now # backend\n' })
  const baselined = workspace({ ...base, 'parity/baseline': 'sample.feature :: Driving now\n' })
  const dangling = workspace({ ...base, 'parity/wip.txt': WIP_LINE + 'sample.feature :: Gone # old\n' })
  const a = run(claimed, wipArgs(claimed))
  const b = run(excluded, [...wipArgs(excluded), '--exclusions', join(excluded, 'parity/ex.txt')])
  const c = run(baselined, [...wipArgs(baselined), '--baseline', join(baselined, 'parity/baseline')])
  const e = run(dangling, wipArgs(dangling))
  check(
    'wip file: claimed, excluded, baselined and dangling wip lines fail (exit 1)',
    a.code === 1 && /wip line/.test(a.out) &&
      b.code === 1 && /excluded/i.test(b.out) &&
      c.code === 1 && /baseline/i.test(c.out) &&
      e.code === 1 && /Gone/.test(e.out),
  )
  for (const dir of [claimed, excluded, baselined, dangling]) rmSync(dir, { recursive: true, force: true })
}

// 33. --write-baseline leaves wip-listed scenarios out.
{
  const d = workspace({ 'specs/sample.feature': TWO, 'parity/wip.txt': WIP_LINE })
  const file = join(d, 'parity/baseline')
  const { code } = run(d, [...wipArgs(d), '--baseline', file, '--write-baseline'])
  const written = readFileSync(file, 'utf8')
  check('wip file: --write-baseline skips wip lines', code === 0 && /:: Ours/.test(written) && !/Driving now/.test(written))
  rmSync(d, { recursive: true, force: true })
}

// 34. --shared-wip takes honor or ignore.
{
  const d = workspace({ 'specs/sample.feature': TWO, [coversMd]: ours })
  const { code } = run(d, ['--shared-wip', 'sometimes'])
  check('shared-wip: unknown value -> usage error (exit 2)', code === 2)
  rmSync(d, { recursive: true, force: true })
}

// 35. A wip-listed scenario skips scope checks, like a spec @wip.
{
  const d = workspace({
    'specs/sample.feature': 'Feature: F\n\n  @system\n  Scenario: Driving now\n    Given a\n',
    'parity/wip.txt': WIP_LINE,
  })
  const { code } = run(d, wipArgs(d))
  check('wip file: listed scenario skips its scope check (exit 0)', code === 0)
  rmSync(d, { recursive: true, force: true })
}

// 36–39. Issue #115: in-progress (expected-to-fail) claims, as in the rule.
const IN_PROGRESS = '// Covers: sample.feature :: Scenario: Driving now\n@Test\nfun drivingNow() = inProgress {\n  then.theUpload.inProgress()\n}\n'
const FINISHED = '// Covers: sample.feature :: Scenario: Driving now\n@Test\nfun drivingNowDone() {\n}\n'
const SPEC_WIP = TWO.replace('  Scenario: Driving now', '  @wip\n  Scenario: Driving now')
const parityRun = (files, args = []) => {
  const d = workspace(files)
  const res = run(d, [...wipArgs(d), ...args])
  rmSync(d, { recursive: true, force: true })
  return res
}

// 36. Claimed only in progress: fails unless the scenario is wip.
{
  const notWip = parityRun({ 'specs/sample.feature': TWO, 'tests/T.kt': oursCovered + IN_PROGRESS })
  const wipLine = parityRun({ 'specs/sample.feature': TWO, 'tests/T.kt': oursCovered + IN_PROGRESS, 'parity/wip.txt': WIP_LINE })
  const specWip = parityRun({ 'specs/sample.feature': SPEC_WIP, 'tests/T.kt': oursCovered + IN_PROGRESS })
  check(
    'in progress: claimed only in progress fails (exit 1) unless wip',
    notWip.code === 1 && /in-progress/.test(notWip.out) && /Driving now/.test(notWip.out) &&
      wipLine.code === 0 && specWip.code === 0,
  )
}

// 37. A spec @wip scenario a finished test claims is promoted.
{
  const honored = parityRun({ 'specs/sample.feature': SPEC_WIP, 'tests/T.kt': oursCovered + FINISHED })
  const ignored = parityRun(
    { 'specs/sample.feature': SPEC_WIP, 'tests/T.kt': oursCovered + FINISHED, 'parity/wip.txt': 'sample.feature :: Shared wip # not ours yet\n' },
    ['--shared-wip', 'ignore'],
  )
  check(
    'in progress: spec @wip claimed by a finished test fails (exit 1); --shared-wip ignore passes',
    honored.code === 1 && /promoted/i.test(honored.out) && /Driving now/.test(honored.out) && ignored.code === 0,
  )
}

// 38. A wip line is stale only once a finished test claims it.
{
  const inProgressOnly = parityRun({ 'specs/sample.feature': TWO, 'tests/T.kt': oursCovered + IN_PROGRESS, 'parity/wip.txt': WIP_LINE })
  const promoted = parityRun({ 'specs/sample.feature': TWO, 'tests/T.kt': oursCovered + IN_PROGRESS + FINISHED, 'parity/wip.txt': WIP_LINE })
  check(
    'in progress: wip line claimed only in progress passes; by a finished test fails',
    inProgressOnly.code === 0 && promoted.code === 1 && /wip line/.test(promoted.out),
  )
}

// 39. Scopes count finished claims only; --in-progress overrides the marker.
{
  const scoped = 'Feature: F\n\n  @system\n  Scenario: Ours\n    Given a\n'
  const system = '// Covers: sample.feature :: Scenario: Ours\n@Test\nfun ours() = inProgress {\n}\n'
  const scopeRun = parityRun(
    { 'specs/sample.feature': scoped, 'tests/default/T.kt': oursCovered, 'tests/system/T.kt': system },
    ['--scope', 'system=tests/system/'],
  )
  const custom = parityRun(
    { 'specs/sample.feature': TWO, 'tests/T.kt': oursCovered + IN_PROGRESS.replace('inProgress {', 'pending {') },
    ['--in-progress', '=\\s*pending\\s*\\{'],
  )
  check(
    'in progress: an in-progress test does not meet a scope; --in-progress sets the marker',
    scopeRun.code === 1 && /\[system\]/.test(scopeRun.out) && custom.code === 1 && /in-progress/.test(custom.out),
  )
}

// ── Issue #129: walking skeleton — an app-tier claim per feature file ──

const ORDERS = 'Feature: Orders\n\n  Scenario: Placing an order\n    Given a\n\n  Scenario: Rejecting an empty order\n    Given b\n'
const RULES = 'Feature: Rules\n\n  Scenario: Discount rounding\n    Given c\n'
const placing = '// Covers: orders.feature :: Scenario: Placing an order\n@Test\nfun placing() {}\n'
const rejecting = '// Covers: orders.feature :: Scenario: Rejecting an empty order\n@Test\nfun rejecting() {}\n'
const rounding = '// Covers: rules.feature :: Scenario: Discount rounding\n@Test\nfun rounding() {}\n'
const skeletonArgs = ['--scope', 'app=tests/app/', '--scope', 'component=tests/component/', '--app-scope', 'app']

// 40. A feature file with no app-scope claim is reported, but passes.
{
  const res = run(
    workspace({
      'specs/orders.feature': ORDERS,
      'specs/rules.feature': RULES,
      'tests/component/T.kt': placing + rejecting + rounding,
      'tests/app/T.kt': '',
    }),
    skeletonArgs,
  )
  check(
    'skeleton: feature files with no [app] claim are listed as a warning (exit 0)',
    res.code === 0 && /walking skeleton/i.test(res.out) && /orders\.feature/.test(res.out) && /rules\.feature/.test(res.out),
  )
}

// 41. One app-scope claim in a feature file satisfies it.
{
  const res = run(
    workspace({
      'specs/orders.feature': ORDERS,
      'tests/component/T.kt': rejecting,
      'tests/app/T.kt': placing,
    }),
    skeletonArgs,
  )
  check('skeleton: one [app] claim in the feature file satisfies it', res.code === 0 && !/walking skeleton/i.test(res.out))
}

// 42. --strict-skeleton makes a missing skeleton fail.
{
  const res = run(
    workspace({ 'specs/orders.feature': ORDERS, 'tests/component/T.kt': placing + rejecting, 'tests/app/T.kt': '' }),
    [...skeletonArgs, '--strict-skeleton'],
  )
  check('skeleton: --strict-skeleton fails a feature file with no [app] claim (exit 1)', res.code === 1 && /orders\.feature/.test(res.out))
}

// 43. An exempt feature file is skipped and listed with its reason.
{
  const dir = workspace({
    'specs/orders.feature': ORDERS,
    'specs/rules.feature': RULES,
    'tests/component/T.kt': rounding + rejecting,
    'tests/app/T.kt': placing,
    'parity/skeleton-exempt.txt': '# features that reach no external system\nrules.feature # pure pricing rules, no external system\n',
  })
  const res = run(dir, [...skeletonArgs, '--strict-skeleton', '--skeleton-exempt', join(dir, 'parity/skeleton-exempt.txt')])
  check(
    'skeleton: an exempt feature file is skipped and its reason reported',
    res.code === 0 && /pure pricing rules/.test(res.out),
  )
}

// 44. Stale exempt lines fail under --strict-skeleton and warn otherwise.
{
  const files = {
    'specs/orders.feature': ORDERS,
    'tests/component/T.kt': rejecting,
    'tests/app/T.kt': placing,
    'parity/skeleton-exempt.txt': 'orders.feature # thought it was offline\nghost.feature # removed long ago\n',
  }
  const dir = workspace(files)
  const exempt = join(dir, 'parity/skeleton-exempt.txt')
  const loose = run(dir, [...skeletonArgs, '--skeleton-exempt', exempt])
  const strict = run(dir, [...skeletonArgs, '--strict-skeleton', '--skeleton-exempt', exempt])
  check(
    'skeleton: an exempt line for a feature with an [app] claim, or for no feature, is stale',
    loose.code === 0 && /stale/i.test(loose.out) && /ghost\.feature/.test(loose.out) && strict.code === 1,
  )
}

// 45. Only finished claims count; wip, excluded and baselined scenarios don't need proof.
{
  const wipOnly = 'Feature: Later\n\n  @wip\n  Scenario: Not built yet\n    Given a\n'
  const inProgress = '// Covers: orders.feature :: Scenario: Placing an order\n@Test\nfun placing() = inProgress {\n}\n'
  const res = run(
    workspace({
      'specs/orders.feature': ORDERS,
      'specs/later.feature': wipOnly,
      'tests/component/T.kt': placing + rejecting,
      'tests/app/T.kt': inProgress,
    }),
    [...skeletonArgs, '--strict-skeleton'],
  )
  check(
    'skeleton: an in-progress app claim does not count; an all-wip feature file needs no skeleton',
    res.code === 1 && /orders\.feature/.test(res.out) && !/later\.feature/.test(res.out),
  )
}

// 46. Usage errors: --app-scope naming no declared scope; a malformed exempt line.
{
  const undeclared = run(workspace({ 'specs/orders.feature': ORDERS }), ['--app-scope', 'app'])
  const malformedDir = workspace({ 'specs/orders.feature': ORDERS, 'parity/x.txt': 'orders.feature\n' })
  const malformed = run(malformedDir, [...skeletonArgs, '--skeleton-exempt', join(malformedDir, 'parity/x.txt')])
  check(
    'skeleton: --app-scope must name a declared scope; exempt lines need a reason (exit 2)',
    undeclared.code === 2 && malformed.code === 2 && /reason/.test(malformed.out),
  )
}

console.log(`\nspec-parity tests: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
