// Tests for spec-test-parity.ts dual-format support.
// Run: node --experimental-strip-types rules/spec-test-parity.test.mts
//
// Mirrors Scripts/spec-parity.test.mjs at the rule level: the Probity
// enforcement hook must parse both Markdown `## Scenario:` specs and
// Gherkin `.feature` specs, treat the extensions as interchangeable in
// Covers-tag resolution, and reject a stem present in both forms.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  extractScenarios,
  extractCoversRefs,
  enforceSpecTestParity,
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

console.log(`\nspec-test-parity tests: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
