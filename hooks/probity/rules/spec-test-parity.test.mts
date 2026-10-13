// Tests for spec-test-parity.ts dual-format support.
// Run: node --experimental-strip-types rules/spec-test-parity.test.mts
//
// Mirrors Scripts/spec-parity.test.mjs at the rule level: the Probity
// enforcement hook must parse both Markdown `## Scenario:` specs and
// Gherkin `.feature` specs, treat the extensions as interchangeable in
// Covers-tag resolution, and reject a stem present in both forms.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  extractScenarios,
  extractCoversRefs,
  enforceSpecTestParity,
  requireSpecBackedAcceptanceTest,
  surfaceScenarioLinkBreakage,
} from './spec-test-parity.ts'

let passed = 0
let failed = 0
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}`) }
}

const GHERKIN = `Feature: F\n\n  @wip @system\n  Scenario: Scoped WIP\n    Given a\n    Then b\n\n  Scenario: Plain\n    Given a\n    When c\n    Then b\n`

// 1. Gherkin scenarios are parsed, with @wip and @scope tags mapped.
{
  const s = extractScenarios('sample.feature', GHERKIN)
  const scoped = s.find((x) => x.title === 'Scoped WIP')
  const plain = s.find((x) => x.title === 'Plain')
  check('gherkin: two scenarios parsed', s.length === 2)
  check('gherkin: @wip -> wip=true', !!scoped?.wip)
  check('gherkin: @system -> scopes=[system]', scoped?.scopes.join(',') === 'system')
  check('gherkin: untagged -> not wip, no scopes', plain?.wip === false && plain?.scopes.length === 0)
}

// 2. Markdown still parses (characterization).
{
  const s = extractScenarios('sample.feature.md', '## Scenario (wip) [system]: T\nGiven a\nThen b\n')
  check('markdown: still parsed with wip+scope', s.length === 1 && s[0]!.wip && s[0]!.scopes.join(',') === 'system')
}

// 3. Covers tag with .feature extension is parsed.
{
  const r = extractCoversRefs('T.swift', '// Covers: sample.feature :: Scenario: Plain\n')
  check('covers: .feature extension parsed', r.length === 1 && r[0]!.title === 'Plain')
}

// 4. Interop: a .feature.md Covers tag and a .feature spec share a key.
{
  const specKey = extractScenarios('sample.feature', GHERKIN).find((x) => x.title === 'Plain')!.key
  const refKey = extractCoversRefs('T.swift', '// Covers: sample.feature.md :: Scenario: Plain\n')[0]!.key
  check('interop: .feature spec key == legacy .feature.md tag key', specKey === refKey)
}

// Helpers for the filesystem-level rule.
function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'stp-test-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}
const commit = { kind: 'command', command: 'git commit -m x' } as const

// 5. enforceSpecTestParity: gherkin .feature spec resolved by legacy tag -> pass.
{
  const dir = workspace({
    'specs/sample.feature': 'Feature: F\n\n  Scenario: Plain\n    Given a\n    Then b\n',
    'tests/T.swift': '// Covers: sample.feature.md :: Scenario: Plain\nfunc testPlain(){}\n',
  })
  const rule = enforceSpecTestParity({ specsDir: join(dir, 'specs'), testRoots: [dir], testFilePattern: /tests/ })
  const res = await rule(commit as any)
  check('rule: gherkin spec + legacy tag -> pass', res.kind === 'pass')
  rmSync(dir, { recursive: true, force: true })
}

// 6. enforceSpecTestParity: duplicate stem across extensions -> violation.
{
  const dir = workspace({
    'specs/sample.feature': 'Feature: F\n\n  Scenario: Plain\n    Given a\n    Then b\n',
    'specs/sample.feature.md': '## Scenario: Plain\nGiven a\nThen b\n',
    'tests/T.swift': '// Covers: sample.feature :: Scenario: Plain\nfunc testPlain(){}\n',
  })
  const rule = enforceSpecTestParity({ specsDir: join(dir, 'specs'), testRoots: [dir], testFilePattern: /tests/ })
  const res = await rule(commit as any)
  check('rule: duplicate stem -> violation', res.kind === 'violation' && /both .*forms|single extension/i.test((res as any).reason))
  rmSync(dir, { recursive: true, force: true })
}

// 7. A dirty specs checkout must not block an unrelated parent commit (issue #25).
{
  const dir = workspace({
    'specs/features/sample.feature': 'Feature: F\n\n  Scenario: Newly untagged\n    Given a\n    Then b\n',
  })
  const originalCwd = process.cwd()
  let commitFiles = ['sdk/core/src/commonMain/kotlin/Unrelated.kt']
  process.chdir(dir)
  try {
    const root = process.cwd()
    const rule = enforceSpecTestParity({
      specsDir: join(root, 'specs/features'),
      testRoots: [root],
      testFilePattern: /[/\\]acceptance[/\\]/,
      listCommitFiles: () => commitFiles,
    })
    const unrelated = await rule(commit as any)
    commitFiles = ['sdk/mysudo/src/jvmTest/kotlin/acceptance/SudosSpec.kt']
    const acceptanceTest = await rule(commit as any)
    commitFiles = ['specs']
    const specsPointer = await rule(commit as any)
    check(
      'rule: only a commit recording specs/tests scans the dirty specs checkout',
      unrelated.kind === 'pass' &&
        acceptanceTest.kind === 'violation' &&
        specsPointer.kind === 'violation',
    )
  } finally {
    process.chdir(originalCwd)
    rmSync(dir, { recursive: true, force: true })
  }
}

// 7b. A commit changing only a baseline outside specsDir still runs the gate
// (issue #107): deleting a line for a still-uncovered scenario must block
// here, not on a later, unrelated specs commit.
{
  const dir = workspace({
    'specs/sample.feature': 'Feature: F\n\n  Scenario: Uncovered\n    Given a\n    Then b\n',
    'parity/baseline': '# burn-down\n',
  })
  const originalCwd = process.cwd()
  let commitFiles = ['parity/baseline']
  process.chdir(dir)
  try {
    const root = process.cwd()
    const rule = enforceSpecTestParity({
      specsDir: join(root, 'specs'),
      testRoots: [root],
      testFilePattern: /[/\\]acceptance[/\\]/,
      baselinePath: join(root, 'parity/baseline'),
      listCommitFiles: () => commitFiles,
    })
    const baselineOnly = await rule(commit as any)
    commitFiles = ['parity/unrelated.txt']
    const unrelated = await rule(commit as any)
    check(
      'rule: a commit changing only a baseline outside specsDir runs the gate',
      baselineOnly.kind === 'violation' && unrelated.kind === 'pass',
    )
  } finally {
    process.chdir(originalCwd)
    rmSync(dir, { recursive: true, force: true })
  }
}

// 8. Git inspection failure must retain full parity enforcement.
{
  const dir = workspace({
    'specs/sample.feature': 'Feature: F\n\n  Scenario: Uncovered\n    Given a\n    Then b\n',
  })
  const rule = enforceSpecTestParity({
    specsDir: join(dir, 'specs'),
    testRoots: [dir],
    testFilePattern: /[/\\]acceptance[/\\]/,
    listCommitFiles: () => { throw new Error('git unavailable') },
  })
  const res = await rule(commit as any)
  check('rule: commit-file inspection failure enforces parity', res.kind === 'violation')
  rmSync(dir, { recursive: true, force: true })
}

// 9. `git commit -a` includes modified tracked specs in the pending set.
{
  const dir = workspace({
    'specs/sample.feature': 'Feature: F\n\n  @wip\n  Scenario: Promoted\n    Given a\n    Then b\n',
  })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Probity Test'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'probity@example.invalid'], { cwd: dir })
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir })
  const originalCwd = process.cwd()
  process.chdir(dir)
  try {
    const root = process.cwd()
    writeFileSync(
      join(root, 'specs/sample.feature'),
      'Feature: F\n\n  Scenario: Promoted\n    Given a\n    Then b\n',
    )
    const rule = enforceSpecTestParity({
      specsDir: join(root, 'specs'),
      testRoots: [root],
      testFilePattern: /[/\\]acceptance[/\\]/,
    })
    const res = await rule({ kind: 'command', command: 'git commit -am x' } as any)
    check('rule: git commit -a scans modified tracked specs', res.kind === 'violation')
  } finally {
    process.chdir(originalCwd)
    rmSync(dir, { recursive: true, force: true })
  }
}

// 10. Issue #55: Covers tags in a linked git worktree nested inside the
// test root (.claude/worktrees/<name>/, marked by a `.git` FILE) belong
// to that checkout and must not cover this one's scenarios.
{
  const nested = '.claude/worktrees/other'
  const dir = workspace({
    'specs/sample.feature': 'Feature: F\n\n  Scenario: Plain\n    Given a\n    Then b\n',
    [`${nested}/.git`]: 'gitdir: /elsewhere/.git/worktrees/other\n',
    [`${nested}/tests/T.swift`]: '// Covers: sample.feature :: Scenario: Plain\nfunc testPlain(){}\n',
  })
  const rule = enforceSpecTestParity({ specsDir: join(dir, 'specs'), testRoots: [dir], testFilePattern: /tests/ })
  const res = await rule(commit as any)
  check('rule: scenario covered only in a nested worktree -> violation', res.kind === 'violation' && /Plain/.test((res as any).reason))
  rmSync(dir, { recursive: true, force: true })
}

// 11. Issue #55: a test root that is itself a linked worktree is still scanned.
{
  const dir = workspace({
    '.git': 'gitdir: /elsewhere/.git/worktrees/this\n',
    'specs/sample.feature': 'Feature: F\n\n  Scenario: Plain\n    Given a\n    Then b\n',
    'tests/T.swift': '// Covers: sample.feature :: Scenario: Plain\nfunc testPlain(){}\n',
  })
  const rule = enforceSpecTestParity({ specsDir: join(dir, 'specs'), testRoots: [dir], testFilePattern: /tests/ })
  const res = await rule(commit as any)
  check('rule: test root that is a linked worktree -> still scanned (pass)', res.kind === 'pass')
  rmSync(dir, { recursive: true, force: true })
}

// 12–18. Issue #105: per-project exclusions and ignored tags.
const SHARED = 'Feature: F\n\n  Scenario: Ours\n    Given a\n    Then b\n\n  @service\n  Scenario: Backend enforces it\n    Given a\n    Then b\n'
const OURS = '// Covers: sample.feature :: Scenario: Ours\nfunc testOurs(){}\n'
const THEIRS = '// Covers: sample.feature :: Scenario: Backend enforces it\n'
const EXCLUSION = 'sample.feature :: Backend enforces it # backend enforces the block list\n'
async function parity(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  const dir = workspace(files)
  try {
    const rule = enforceSpecTestParity({
      specsDir: join(dir, 'specs'),
      testRoots: [dir],
      testFilePattern: /tests/,
      exclusionsPath: join(dir, 'parity/exclusions.txt'),
      baselinePath: join(dir, 'parity/baseline'),
      ...extra,
    } as any)
    return (await rule(commit as any)) as { kind: string; reason?: string }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 12. An excluded scenario passes and skips its scope check.
{
  const res = await parity({ 'specs/sample.feature': SHARED, 'tests/T.swift': OURS, 'parity/exclusions.txt': EXCLUSION })
  const none = await parity({ 'specs/sample.feature': SHARED, 'tests/T.swift': OURS })
  check('rule exclusion: excluded scenario passes; missing file enforces', res.kind === 'pass' && none.kind === 'violation')
}

// 13. Every exclusion needs a reason.
{
  const res = await parity({
    'specs/sample.feature': SHARED,
    'tests/T.swift': OURS,
    'parity/exclusions.txt': 'sample.feature :: Backend enforces it\n',
  })
  check('rule exclusion: line without a reason -> violation', res.kind === 'violation' && /reason/i.test(res.reason ?? ''))
}

// 14. Dangling, claimed and baselined exclusions all fail.
{
  const dangling = await parity({
    'specs/sample.feature': SHARED,
    'tests/T.swift': OURS,
    'parity/exclusions.txt': EXCLUSION + 'sample.feature :: Renamed away # gone\n',
  })
  const claimed = await parity(
    { 'specs/sample.feature': SHARED, 'tests/T.swift': OURS + THEIRS, 'parity/exclusions.txt': EXCLUSION },
    { ignoreTags: ['service'] },
  )
  const baselined = await parity({
    'specs/sample.feature': SHARED,
    'tests/T.swift': OURS,
    'parity/exclusions.txt': EXCLUSION,
    'parity/baseline': 'sample.feature :: Backend enforces it\n',
  })
  check(
    'rule exclusion: dangling, claimed and baselined exclusions -> violations',
    dangling.kind === 'violation' && /Renamed away/.test(dangling.reason ?? '') &&
      claimed.kind === 'violation' && /test now claims/.test(claimed.reason ?? '') &&
      baselined.kind === 'violation' && /baseline/i.test(baselined.reason ?? ''),
  )
}

// 15. ignoreTags drops a shared tag; an unlisted unknown tag still fails.
{
  const files = { 'specs/sample.feature': SHARED, 'tests/T.swift': OURS + THEIRS }
  const ignored = await parity(files, { ignoreTags: ['service'] })
  const unignored = await parity(files)
  const markdown = await parity(
    { 'specs/sample.feature.md': '## Scenario [service]: Plain\nGiven a\nThen b\n', 'tests/T.swift': '// Covers: sample.feature.md :: Scenario: Plain\n' },
    { ignoreTags: ['service'] },
  )
  check(
    'rule ignoreTags: ignored tag is not a scope (Gherkin and Markdown); unlisted still fails',
    ignored.kind === 'pass' && markdown.kind === 'pass' &&
      unignored.kind === 'violation' && /\[service\]/.test(unignored.reason ?? ''),
  )
}

// 16. A tag both declared as a scope and ignored, or wip/planned, is a contradiction.
{
  const files = { 'specs/sample.feature': SHARED, 'tests/T.swift': OURS + THEIRS }
  const scope = await parity(files, {
    ignoreTags: ['service'],
    driverScopes: [{ name: 'service', filePattern: /tests/ }],
  })
  const marker = await parity(files, { ignoreTags: ['wip'] })
  check(
    'rule ignoreTags: declared scope or wip marker in the list -> violation',
    scope.kind === 'violation' && /ignoreTags/.test(scope.reason ?? '') &&
      marker.kind === 'violation' && /ignoreTags/.test(marker.reason ?? ''),
  )
}

// 17. A commit changing only the exclusions file runs the gate.
{
  const dir = workspace({
    'specs/sample.feature': SHARED,
    'tests/T.swift': OURS,
    'parity/exclusions.txt': 'sample.feature :: Renamed away # gone\n' + EXCLUSION,
  })
  const originalCwd = process.cwd()
  process.chdir(dir)
  try {
    const root = process.cwd()
    const rule = enforceSpecTestParity({
      specsDir: join(root, 'specs'),
      testRoots: [root],
      testFilePattern: /tests/,
      exclusionsPath: join(root, 'parity/exclusions.txt'),
      listCommitFiles: () => ['parity/exclusions.txt'],
    } as any)
    const res = await rule(commit as any)
    check('rule exclusion: an exclusions-only commit runs the gate', res.kind === 'violation')
  } finally {
    process.chdir(originalCwd)
    rmSync(dir, { recursive: true, force: true })
  }
}

// 18–23. Issue #106: stable scenario ids.
const withId = (title: string) =>
  `Feature: F\n\n  @id:blocked-number\n  Scenario: ${title}\n    Given a\n    Then b\n`
const COVERS_ID = '// Covers: @id:blocked-number\nfunc testBlocked(){}\n'

// 18. Gherkin and Markdown ids parse; an id is not a scope.
{
  const g = extractScenarios('a.feature', withId('Blocked'))[0]
  const m = extractScenarios('b.feature.md', '## Scenario [system, id:blocked-number]: Blocked\n')[0]
  const ref = extractCoversRefs('T.swift', COVERS_ID)[0]
  check(
    'ids: parsed from @id:/[id:], not scopes; Covers by id parsed',
    g?.id === 'blocked-number' && g.scopes.length === 0 &&
      m?.id === 'blocked-number' && m.scopes.join(',') === 'system' &&
      ref?.id === 'blocked-number',
  )
}

// 19. The gate resolves id references; a retitled scenario keeps them.
{
  const byId = await parity({ 'specs/sample.feature': withId('A blocked number never reaches the owner'), 'tests/T.swift': COVERS_ID })
  const byStaleTitle = await parity({
    'specs/sample.feature': withId('A blocked number never reaches the owner'),
    'tests/T.swift': '// Covers: sample.feature :: Scenario: Blocked\n',
  })
  const unknown = await parity({ 'specs/sample.feature': withId('Blocked'), 'tests/T.swift': COVERS_ID + '// Covers: @id:nope\n' })
  check(
    'ids: gate resolves by id; stale title and unknown id dangle',
    byId.kind === 'pass' && byStaleTitle.kind === 'violation' &&
      unknown.kind === 'violation' && /@id:nope/.test(unknown.reason ?? ''),
  )
}

// 20. Duplicate ids, and two ids on one scenario, block.
{
  const dup = await parity({ 'specs/a.feature': withId('One'), 'specs/b.feature': withId('Two'), 'tests/T.swift': COVERS_ID })
  const two = await parity({ 'specs/a.feature': 'Feature: F\n\n  @id:one @id:two\n  Scenario: Both\n    Given a\n' })
  check('ids: duplicate or double id -> violation', dup.kind === 'violation' && /twice/.test(dup.reason ?? '') && two.kind === 'violation')
}

// 21. Baseline and exclusion lines resolve ids.
{
  const res = await parity({
    'specs/sample.feature': withId('Blocked') + '\n  @id:ours\n  Scenario: Ours\n    Given a\n',
    'parity/baseline': '@id:ours\n',
    'parity/exclusions.txt': '@id:blocked-number # backend enforces the block list\n',
  })
  const dangling = await parity({
    'specs/sample.feature': withId('Blocked'),
    'tests/T.swift': COVERS_ID,
    'parity/exclusions.txt': '@id:gone # removed upstream\n',
  })
  check(
    'ids: baseline and exclusions by id; unknown id exclusion dangles',
    res.kind === 'pass' && dangling.kind === 'violation' && /@id:gone/.test(dangling.reason ?? ''),
  )
}

// 22. Spec-first write gate accepts a Covers tag by id.
{
  const dir = workspace({ 'specs/sample.feature': withId('Blocked') })
  try {
    const rule = requireSpecBackedAcceptanceTest({ specsDir: join(dir, 'specs') })
    const ctx = { readFile: async () => ({ kind: 'absent' as const }) } as any
    const write = (content: string) => ({ kind: 'write', path: join(dir, 'tests/T.swift'), content }) as any
    const known = await rule(write(COVERS_ID), ctx)
    const unknown = await rule(write('// Covers: @id:nope\nfunc testNope(){}\n'), ctx)
    check(
      'ids: spec-first write gate resolves an id; unknown id blocks',
      known.kind === 'pass' && unknown.kind === 'violation' && /@id:nope/.test((unknown as any).reason),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 23. Link breakage: rewording a title claimed by id passes; removing the
// id, or rewording a title claimed by title, blocks.
{
  const dir = workspace({ 'tests/T.swift': COVERS_ID, 'tests/U.swift': '// Covers: sample.feature :: Scenario: Ours\n' })
  try {
    const rule = surfaceScenarioLinkBreakage({ testRoots: [dir], testFilePattern: /tests/ })
    const before = withId('Blocked') + '\n  Scenario: Ours\n    Given a\n'
    const ctx = { readFile: async () => ({ kind: 'present' as const, content: before }) } as any
    const write = (content: string) => ({ kind: 'write', path: join(dir, 'specs/sample.feature'), content }) as any
    const retitled = await rule(write(before.replace('Scenario: Blocked', 'Scenario: Never reaches the owner')), ctx)
    const idRemoved = await rule(write(before.replace('@id:blocked-number', '@system')), ctx)
    const titleRef = await rule(write(before.replace('Scenario: Ours', 'Scenario: Mine')), ctx)
    check(
      'ids: retitle claimed by id passes; dropping the id or retitling a title claim blocks',
      retitled.kind === 'pass' && idRemoved.kind === 'violation' && titleRef.kind === 'violation',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 24. Moving an id'd scenario to another spec file is not breakage.
{
  const dir = workspace({
    'tests/T.swift': COVERS_ID,
    'specs/sample.feature': withId('Blocked'),
    'specs/blocking.feature': withId('Blocked'),
  })
  try {
    const ctx = { readFile: async () => ({ kind: 'present' as const, content: withId('Blocked') }) } as any
    const write = { kind: 'write', path: join(dir, 'specs/sample.feature'), content: 'Feature: F\n' } as any
    const withSpecs = surfaceScenarioLinkBreakage({ testRoots: [dir], testFilePattern: /tests/, specsDir: join(dir, 'specs') })
    const without = surfaceScenarioLinkBreakage({ testRoots: [dir], testFilePattern: /tests/ })
    check(
      'ids: removing an id another spec now carries passes (with specsDir)',
      (await withSpecs(write, ctx)).kind === 'pass' && (await without(write, ctx)).kind === 'violation',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 25–28. Issue #111: per-project wip.
const TWO = 'Feature: F\n\n  Scenario: Ours\n    Given a\n\n  @wip @system\n  Scenario: Shared wip\n    Given a\n\n  Scenario: Driving now\n    Given a\n'
const OURS_ONLY = '// Covers: sample.feature :: Scenario: Ours\n'
const WIP_LINE = 'sample.feature :: Driving now # outside-in, no clock port yet\n'
// Like parity(), plus a project wip file at parity/wip.txt.
async function parityWip(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  const dir = workspace(files)
  try {
    const rule = enforceSpecTestParity({
      specsDir: join(dir, 'specs'),
      testRoots: [dir],
      testFilePattern: /tests/,
      exclusionsPath: join(dir, 'parity/exclusions.txt'),
      baselinePath: join(dir, 'parity/baseline'),
      wipPath: join(dir, 'parity/wip.txt'),
      ...extra,
    } as any)
    return (await rule(commit as any)) as { kind: string; reason?: string }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
// 25. A wip line exempts; a line without a note blocks.
{
  const ok = await parityWip({ 'specs/sample.feature': TWO, 'tests/T.swift': OURS_ONLY, 'parity/wip.txt': WIP_LINE })
  const bad = await parityWip({ 'specs/sample.feature': TWO, 'tests/T.swift': OURS_ONLY, 'parity/wip.txt': 'sample.feature :: Driving now\n' })
  check('rule wip: line exempts; missing note -> violation', ok.kind === 'pass' && bad.kind === 'violation' && /note/.test(bad.reason ?? ''))
}

// 26. sharedWip: 'ignore' makes spec markers informational.
{
  const files = { 'specs/sample.feature': TWO, 'tests/T.swift': OURS_ONLY, 'parity/wip.txt': WIP_LINE }
  const ignored = await parityWip(files, { sharedWip: 'ignore' })
  const listed = await parityWip(
    { ...files, 'parity/wip.txt': WIP_LINE + 'sample.feature :: Shared wip # not started here\n' },
    { sharedWip: 'ignore' },
  )
  check(
    'rule wip: sharedWip ignore requires the spec @wip scenario unless listed',
    ignored.kind === 'violation' && /Shared wip/.test(ignored.reason ?? '') && listed.kind === 'pass',
  )
}

// 27. Stale wip lines block: claimed, excluded, baselined, dangling.
{
  const base = { 'specs/sample.feature': TWO, 'tests/T.swift': OURS_ONLY, 'parity/wip.txt': WIP_LINE }
  const claimed = await parityWip({ ...base, 'tests/T.swift': OURS_ONLY + '// Covers: sample.feature :: Scenario: Driving now\n' })
  const excluded = await parityWip({ ...base, 'parity/exclusions.txt': 'sample.feature :: Driving now # backend\n' })
  const baselined = await parityWip({ ...base, 'parity/baseline': 'sample.feature :: Driving now\n' })
  const dangling = await parityWip({ ...base, 'parity/wip.txt': WIP_LINE + 'sample.feature :: Gone # old\n' })
  check(
    'rule wip: claimed, excluded, baselined and dangling wip lines -> violations',
    claimed.kind === 'violation' && /wip line/.test(claimed.reason ?? '') &&
      excluded.kind === 'violation' && /excluded/i.test(excluded.reason ?? '') &&
      baselined.kind === 'violation' && /only shrinks/.test(baselined.reason ?? '') &&
      dangling.kind === 'violation' && /Gone/.test(dangling.reason ?? ''),
  )
}

// 28. A commit changing only the wip file runs the gate.
{
  const dir = workspace({ 'specs/sample.feature': TWO, 'tests/T.swift': OURS_ONLY, 'parity/wip.txt': WIP_LINE + 'sample.feature :: Gone # old\n' })
  const originalCwd = process.cwd()
  process.chdir(dir)
  try {
    const root = process.cwd()
    const rule = enforceSpecTestParity({
      specsDir: join(root, 'specs'),
      testRoots: [root],
      testFilePattern: /tests/,
      wipPath: join(root, 'parity/wip.txt'),
      listCommitFiles: () => ['parity/wip.txt'],
    } as any)
    check('rule wip: a wip-only commit runs the gate', (await rule(commit as any)).kind === 'violation')
  } finally {
    process.chdir(originalCwd)
    rmSync(dir, { recursive: true, force: true })
  }
}

// 29–33. Issue #115: in-progress (expected-to-fail) acceptance tests.
// 29. A Covers tag belongs to the test it sits on or inside; that test's
// expected-to-fail marker makes the claim in progress.
{
  const kotlin =
    '// Covers: sample.feature :: Scenario: Driving now\n@Test\nfun `driving now`() = inProgress {\n  given.x()\n}\n\n' +
    '// Covers: sample.feature :: Scenario: Ours\n@Test\nfun `ours`() {\n  then.theUploadIs.inProgress()\n}\n'
  const [driving, ours] = extractCoversRefs('T.kt', kotlin)
  const jest = extractCoversRefs('t.test.ts', "// Covers: sample.feature :: Scenario: Ours\ntest.failing('ours', () => {})\n")[0]
  const vitest = extractCoversRefs('t.test.ts', "test.fails('ours', () => {\n  // Covers: sample.feature :: Scenario: Ours\n})\n")[0]
  const swift = extractCoversRefs(
    'T.swift',
    '// Covers: sample.feature :: Scenario: Ours\n@MainActor\nfunc testOurs() {\n  withKnownIssue { dsl.run() }\n}\nfunc testOther() {}\n',
  )[0]
  const xctest = extractCoversRefs('T.swift', 'func testOurs() {\n  // Covers: sample.feature :: Scenario: Ours\n  XCTExpectFailure("wip")\n}\n')[0]
  const bare = extractCoversRefs('T.swift', OURS_ONLY)[0]
  check(
    'in progress: marker on the owning test only; DSL calls named inProgress do not count',
    driving?.inProgress === true && ours?.inProgress === false &&
      jest?.inProgress === true && vitest?.inProgress === true &&
      swift?.inProgress === true && xctest?.inProgress === true && bare?.inProgress === false,
  )
  const custom = extractCoversRefs('T.kt', '// Covers: sample.feature :: Scenario: Ours\n@Test\nfun ours() = pending {\n}\n', /=\s*pending\s*\{/)[0]
  check('in progress: inProgressPattern overrides the marker', custom?.inProgress === true)
}

const IN_PROGRESS = '// Covers: sample.feature :: Scenario: Driving now\n@Test\nfun drivingNow() = inProgress {\n}\n'
// 30. An in-progress claim is not coverage: the scenario must be wip.
{
  const notWip = await parityWip({ 'specs/sample.feature': TWO, 'tests/T.kt': OURS + IN_PROGRESS })
  const wipLine = await parityWip({ 'specs/sample.feature': TWO, 'tests/T.kt': OURS + IN_PROGRESS, 'parity/wip.txt': WIP_LINE })
  const specWip = await parityWip({
    'specs/sample.feature': TWO.replace('  Scenario: Driving now', '  @wip\n  Scenario: Driving now'),
    'tests/T.kt': OURS + IN_PROGRESS,
  })
  check(
    'in progress: claimed only in progress -> violation unless wip (spec marker or wip line)',
    notWip.kind === 'violation' && /in-progress/.test(notWip.reason ?? '') && /Driving now/.test(notWip.reason ?? '') &&
      wipLine.kind === 'pass' && specWip.kind === 'pass',
  )
}

// 31. A wip scenario a finished test claims is promoted: the spec's own
// marker must go too (with sharedWip 'honor').
{
  const specWip = TWO.replace('  Scenario: Driving now', '  @wip\n  Scenario: Driving now')
  const finished = OURS + '// Covers: sample.feature :: Scenario: Driving now\n@Test\nfun drivingNow() {\n}\n'
  const honored = await parityWip({ 'specs/sample.feature': specWip, 'tests/T.kt': finished })
  const ignored = await parityWip(
    { 'specs/sample.feature': specWip, 'tests/T.kt': finished, 'parity/wip.txt': 'sample.feature :: Shared wip # not ours yet\n' },
    { sharedWip: 'ignore' },
  )
  check(
    'in progress: spec @wip claimed by a finished test -> violation; sharedWip ignore -> pass',
    honored.kind === 'violation' && /promoted/i.test(honored.reason ?? '') && /Driving now/.test(honored.reason ?? '') &&
      ignored.kind === 'pass',
  )
}

// 32. A wip line stays valid while only in-progress tests claim it.
{
  const both = OURS + IN_PROGRESS + '// Covers: sample.feature :: Scenario: Driving now\n@Test\nfun drivingNowToo() {\n}\n'
  const inProgressOnly = await parityWip({ 'specs/sample.feature': TWO, 'tests/T.kt': OURS + IN_PROGRESS, 'parity/wip.txt': WIP_LINE })
  const promoted = await parityWip({ 'specs/sample.feature': TWO, 'tests/T.kt': both, 'parity/wip.txt': WIP_LINE })
  check(
    'in progress: wip line claimed only in progress -> pass; also by a finished test -> stale',
    inProgressOnly.kind === 'pass' && promoted.kind === 'violation' && /wip line/.test(promoted.reason ?? ''),
  )
}

// 33. Scope coverage counts only finished tests.
{
  const scoped = 'Feature: F\n\n  @system\n  Scenario: Ours\n    Given a\n'
  const res = await parityWip(
    {
      'specs/sample.feature': scoped,
      'tests/default/T.kt': OURS_ONLY,
      'tests/system/T.kt': '// Covers: sample.feature :: Scenario: Ours\n@Test\nfun ours() = inProgress {\n}\n',
    },
    { driverScopes: [{ name: 'system', filePattern: /tests[/\\]system[/\\]/ }] },
  )
  check('in progress: an in-progress test does not meet a driver scope', res.kind === 'violation' && /\[system\]/.test(res.reason ?? ''))
}

// ── Issue #112: claims by live (opt-in) tests ─────────────────────

const LIVE_SPEC = 'Feature: F\n\n  @critical\n  Scenario: Blocked number\n    Given a\n\n  Scenario: Plain live\n    Given b\n'
const blockedLive = '// Covers: sample.feature :: Scenario: Blocked number\n@Test\nfun blocked() {\n}\n'
const plainLive = '// Covers: sample.feature :: Scenario: Plain live\n@Test\nfun plain() {\n}\n'
const liveScopes = { driverScopes: [{ name: 'critical', filePattern: /tests/ }], liveTestPattern: /tests[/\\]live[/\\]/ }

// 34. A live claim still counts as coverage by default.
{
  const res = await parityWip({ 'specs/sample.feature': LIVE_SPEC, 'tests/live/T.kt': blockedLive + plainLive }, liveScopes)
  check('live: a scenario claimed only by live tests is covered (pass)', res.kind === 'pass')
}

// 35. liveFloorScopes: a tagged scenario needs a non-live claim.
{
  const onlyLive = await parityWip(
    { 'specs/sample.feature': LIVE_SPEC, 'tests/live/T.kt': blockedLive + plainLive },
    { ...liveScopes, liveFloorScopes: ['critical'] },
  )
  const alsoOffline = await parityWip(
    { 'specs/sample.feature': LIVE_SPEC, 'tests/live/T.kt': blockedLive + plainLive, 'tests/offline/T.kt': blockedLive },
    { ...liveScopes, liveFloorScopes: ['critical'] },
  )
  check(
    'live: liveFloorScopes blocks a tagged scenario covered only by live tests, passes with a non-live claim',
    onlyLive.kind === 'violation' &&
      /live tests only/i.test(onlyLive.reason ?? '') &&
      /Blocked number/.test(onlyLive.reason ?? '') &&
      !/Plain live/.test(onlyLive.reason ?? '') &&
      alsoOffline.kind === 'pass',
  )
}

// 36. A live claim on an excluded scenario makes the exclusion stale, as any claim does.
{
  const res = await parityWip(
    {
      'specs/sample.feature': LIVE_SPEC,
      'tests/live/T.kt': blockedLive,
      'tests/offline/T.kt': plainLive,
      'parity/exclusions.txt': 'sample.feature :: Blocked number # the service enforces blocks\n',
    },
    liveScopes,
  )
  check('live: a live claim on an excluded scenario fails the stale exclusion', res.kind === 'violation' && /delete the exclusion/.test(res.reason ?? ''))
}

// ── Issue #114: a pinned dependency's claims ─────────────────────

const SDK_SPEC = 'Feature: Sync\n\n  @id:offline-sync\n  Scenario: Changes made offline sync later\n    Given an offline change\n    Then the change syncs\n\n  Scenario: App badge\n    Given a pending change\n    Then the badge shows\n'
const appBadge = '// Covers: sync.feature :: Scenario: App badge\n@Test\nfun badge() {\n}\n'

/** Claims written by the CLI, so the gate is checked against the real hash. */
function cliClaims(spec: string): string {
  const dir = workspace({ 'specs/sync.feature': spec, 'tests/T.kt': '// Covers: @id:offline-sync\n@Test\nfun sync() {\n}\n' })
  const out = join(dir, 'claims.txt')
  execFileSync('node', [join(dirname(new URL(import.meta.url).pathname), '../scripts/spec-parity.mjs'), '--specs', join(dir, 'specs'), '--tests', dir, '--pattern', 'tests', '--write-claims', out, '--claims-source', 'example-sdk 2.3.0'])
  const text = readFileSync(out, 'utf8')
  rmSync(dir, { recursive: true, force: true })
  return text
}
const SDK_CLAIMS = cliClaims(SDK_SPEC)

// 37. A CLI-written dependency claim covers the scenario in the gate.
{
  const res = await parityWip(
    { 'specs/sync.feature': SDK_SPEC, 'tests/T.kt': appBadge, 'parity/deps.txt': SDK_CLAIMS },
    { dependencyClaimsPaths: [] },
  )
  const withClaims = await (async () => {
    const dir = workspace({ 'specs/sync.feature': SDK_SPEC, 'tests/T.kt': appBadge, 'parity/deps.txt': SDK_CLAIMS })
    try {
      return await enforceSpecTestParity({
        specsDir: join(dir, 'specs'),
        testRoots: [dir],
        testFilePattern: /tests/,
        dependencyClaimsPaths: [join(dir, 'parity/deps.txt')],
      } as any)(commit as any)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })()
  check('claims: without the claim file the scenario is orphaned; with it, covered', res.kind === 'violation' && withClaims.kind === 'pass')
}

async function parityDeps(spec: string, extra: Record<string, unknown> = {}, more: Record<string, string> = {}) {
  const dir = workspace({ 'specs/sync.feature': spec, 'tests/T.kt': appBadge, 'parity/deps.txt': SDK_CLAIMS, ...more })
  try {
    return (await enforceSpecTestParity({
      specsDir: join(dir, 'specs'),
      testRoots: [dir],
      testFilePattern: /tests/,
      dependencyClaimsPaths: [join(dir, 'parity/deps.txt')],
      exclusionsPath: join(dir, 'parity/exclusions.txt'),
      ...extra,
    } as any)(commit as any)) as { kind: string; reason?: string }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 38. Changed steps void the claim, and the gate says so.
{
  const res = await parityDeps(SDK_SPEC.replace('Then the change syncs', 'Then the change syncs fast'))
  check(
    'claims: changed steps void the dependency claim (violation names the source)',
    res.kind === 'violation' && /void/i.test(res.reason ?? '') && /example-sdk 2\.3\.0/.test(res.reason ?? ''),
  )
}

// 39. A tagged scope still needs the app's own test; an exclusion for a covered scenario is stale.
{
  const tagged = await parityDeps(SDK_SPEC.replace('@id:offline-sync', '@id:offline-sync @ui'), {
    driverScopes: [{ name: 'ui', filePattern: /tests[/\\]ui[/\\]/ }],
  })
  const excluded = await parityDeps(SDK_SPEC, {}, { 'parity/exclusions.txt': '@id:offline-sync # covered by example-sdk\n' })
  check(
    'claims: a tagged scope is not met by a dependency claim; an exclusion for a dependency-covered scenario is stale',
    tagged.kind === 'violation' && /needs \[ui\]/.test(tagged.reason ?? '') &&
      excluded.kind === 'violation' && /dependency/i.test(excluded.reason ?? ''),
  )
}

console.log(`\nspec-test-parity tests: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
