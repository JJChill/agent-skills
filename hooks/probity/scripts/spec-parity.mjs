#!/usr/bin/env node
/**
 * Standalone spec↔test parity check — the CI mirror of the
 * enforceSpecTestParity probity rule (hooks/probity/rules/
 * spec-test-parity.ts). Probity hooks only run in agent sessions;
 * this script makes the same invariant hold for human commits and
 * PRs. Zero dependencies.
 *
 * Usage:
 *   node spec-parity.mjs --specs docs/specs [--tests .] [--pattern acceptance]
 *                        [--baseline <file>] [--write-baseline]
 *                        [--scope name=<regex>]... [--default-scopes a,b]
 *
 *   --specs    specs directory containing *.feature.md (required)
 *   --tests    root(s) to scan for acceptance tests (repeatable, default .)
 *   --pattern  substring/regex a test file path must match
 *              (default: /[/\\]acceptance[/\\]/)
 *   --baseline incremental-adoption baseline file: scenarios listed
 *              there (one `<spec>.feature.md :: <title>` per line, `#`
 *              comments allowed) are exempt from the orphan check.
 *              Missing file → full enforcement.
 *   --write-baseline  with --baseline: write the current orphan set to
 *              the baseline file and exit 0. Run once when adopting the
 *              gate on a brownfield spec suite; burn the file down over
 *              time by deleting lines. Dangling Covers tags are never
 *              baselined — they are actively wrong, not legacy.
 *   --scope    declare a driver scope: a name and the regex its test
 *              files match (repeatable), e.g.
 *              --scope system=AcceptanceTests/UITests/
 *              A scenario tagged `## Scenario [system]:` must then be
 *              covered by a test matching that scope — in addition to
 *              the base one-covering-test requirement. Tags are
 *              floors, not ceilings. Tags naming undeclared scopes
 *              fail the check (misspelling protection).
 *   --default-scopes  comma-separated scope names required of every
 *              non-wip, non-baselined scenario even without a tag —
 *              the project's standard driver set.
 *
 * Exit codes: 0 parity holds, 1 orphaned scenarios, dangling Covers
 * tags, or unmet driver scopes, 2 usage error.
 *
 * Conventions (shared with the probity rule):
 *   spec heading:  ## Scenario: <title>     (## Scenario (wip): exempt)
 *                  or Gherkin `Scenario: <title>` (preceded by @wip / @scope tags)
 *   scope tag:     ## Scenario [system]: <title>   (after any (wip) marker)
 *                  or a Gherkin `@system` tag on the scenario
 *   test tag:      Covers: <spec>.feature[.md] :: Scenario: <title>
 *
 * Spec files may be either <name>.feature.md (Markdown) or <name>.feature
 * (Gherkin); the two extensions are interchangeable (matched by stem) so a
 * spec can convert one file at a time with parity green throughout. The
 * same stem in both extensions at once is rejected (unfinished rename).
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import process from 'node:process'

// Scenario headings come in two forms during the migration from Markdown
// feature files to real Gherkin:
//   Markdown:  ## Scenario (wip) [system]: Title
//   Gherkin:   @wip @system\n  Scenario: Title
// Both are parsed per-line by parseScenarios below.
const MD_SCENARIO =
  /^##\s*Scenario(\s*\((?:wip|planned)\))?(\s*\[([^\]]+)\])?\s*:\s*(.+?)\s*$/
const GHERKIN_SCENARIO = /^Scenario(?:\s+Outline)?:\s*(.+?)\s*$/
// Covers tags accept either extension so a tag survives its spec's
// conversion unchanged: Covers: <spec>.feature[.md] :: Scenario: <title>
const COVERS_TAG = /Covers:\s*([\w.-]+\.feature(?:\.md)?)\s*::\s*Scenario:\s*([^\n]+)/g
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', '.gradle', 'out', 'dist', '.idea'])

function parseArgs(argv) {
  const args = {
    specs: undefined,
    tests: [],
    pattern: undefined,
    baseline: undefined,
    writeBaseline: false,
    scopes: new Map(),
    defaultScopes: [],
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--specs') args.specs = argv[++i]
    else if (argv[i] === '--tests') args.tests.push(argv[++i])
    else if (argv[i] === '--pattern') args.pattern = argv[++i]
    else if (argv[i] === '--baseline') args.baseline = argv[++i]
    else if (argv[i] === '--write-baseline') args.writeBaseline = true
    else if (argv[i] === '--scope') {
      const value = argv[++i] ?? ''
      const idx = value.indexOf('=')
      if (idx < 1) {
        console.error(`--scope expects name=<regex>, got: ${value}`)
        process.exit(2)
      }
      args.scopes.set(value.slice(0, idx).trim().toLowerCase(), new RegExp(value.slice(idx + 1)))
    } else if (argv[i] === '--default-scopes') {
      args.defaultScopes = (argv[++i] ?? '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean)
    } else {
      console.error(`Unknown argument: ${argv[i]}`)
      process.exit(2)
    }
  }
  if (!args.specs || (args.writeBaseline && !args.baseline)) {
    console.error(
      'Usage: spec-parity.mjs --specs <dir> [--tests <root>]... [--pattern <regex>] ' +
        '[--baseline <file>] [--write-baseline] [--scope name=<regex>]... ' +
        '[--default-scopes a,b]',
    )
    process.exit(2)
  }
  if (args.tests.length === 0) args.tests = ['.']
  return args
}

function normalizeTitle(title) {
  return title
    .replace(/\s*(?:\*\/|["')\]]+)?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// A spec is identified by its stem (filename without .feature or
// .feature.md), so a scenario keeps the same key across the extension
// change and Covers tags resolve regardless of which extension either side
// currently uses.
const specStem = (name) => basename(name).replace(/\.feature(?:\.md)?$/i, '')
const key = (specFile, title) => `${specStem(specFile)} :: ${normalizeTitle(title)}`

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out)
    } else {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

const splitScopeList = (raw) =>
  (raw ?? '')
    .split(',')
    .map((scope) => scope.trim().toLowerCase())
    .filter(Boolean)

/**
 * Parse one spec file (Markdown `## Scenario:` or Gherkin `Scenario:`)
 * into scenario records. Gherkin `@tags` on the lines preceding a
 * `Scenario:` map to markers: `@wip`/`@planned` mark work-in-progress,
 * every other tag is a driver-scope name (mirroring Markdown's
 * `(wip)` marker and `[scope]` list).
 */
function parseScenarios(file) {
  const scenarios = []
  let tags = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const md = line.match(MD_SCENARIO)
    if (md) {
      scenarios.push({
        key: key(file, md[4]),
        specFile: basename(file),
        title: md[4].trim(),
        wip: md[1] !== undefined,
        scopes: splitScopeList(md[3]),
      })
      tags = []
      continue
    }
    const trimmed = line.trim()
    if (/^@\S/.test(trimmed)) {
      tags.push(
        ...trimmed
          .split(/\s+/)
          .filter((token) => token.startsWith('@'))
          .map((token) => token.slice(1).toLowerCase()),
      )
      continue
    }
    const gherkin = trimmed.match(GHERKIN_SCENARIO)
    if (gherkin) {
      scenarios.push({
        key: key(file, gherkin[1]),
        specFile: basename(file),
        title: gherkin[1].trim(),
        wip: tags.includes('wip') || tags.includes('planned'),
        scopes: tags.filter((tag) => tag !== 'wip' && tag !== 'planned'),
      })
      tags = []
      continue
    }
    // Tags only attach to the next Scenario. A Feature line, or any other
    // non-tag, non-comment content, ends a dangling tag block.
    if (trimmed !== '' && !trimmed.startsWith('#')) tags = []
  }
  return scenarios
}

const args = parseArgs(process.argv.slice(2))
if (!existsSync(args.specs)) {
  console.log(`No specs directory at ${args.specs} — nothing to enforce.`)
  process.exit(0)
}
const pattern = args.pattern ? new RegExp(args.pattern) : /[/\\]acceptance[/\\]/

const specFiles = walk(args.specs).filter(
  (file) => file.endsWith('.feature.md') || file.endsWith('.feature'),
)

// During the .feature.md -> .feature migration a spec is one extension or
// the other. The same stem in both forms would double-count scenarios and
// mask a half-finished rename, so fail loudly instead of silently passing.
const seenStems = new Map()
for (const file of specFiles) {
  const stem = specStem(file)
  const existing = seenStems.get(stem)
  if (existing) {
    console.error(`Spec "${stem}" exists in both .feature and .feature.md forms:`)
    console.error(`  ${existing}`)
    console.error(`  ${file}`)
    console.error('Finish the migration for this spec — keep a single extension.')
    process.exit(2)
  }
  seenStems.set(stem, file)
}

const scenarios = specFiles.flatMap(parseScenarios)

const refs = args.tests
  .flatMap((root) => walk(root))
  .filter(
    (file) =>
      pattern.test(file) &&
      !file.endsWith('.feature.md') &&
      !file.endsWith('.feature'),
  )
  .flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(COVERS_TAG)].map((m) => ({
      key: key(m[1], m[2]),
      testFile: file,
      specFile: m[1],
      title: m[2].replace(/\s*(?:\*\/|["')\]]+)?\s*$/, '').trim(),
    })),
  )

const claimed = new Set(refs.map((ref) => ref.key))
const known = new Set(scenarios.map((scenario) => scenario.key))
const unclaimed = scenarios.filter((s) => !s.wip && !claimed.has(s.key))
const dangling = refs.filter((ref) => !known.has(ref.key))

if (args.writeBaseline) {
  const header =
    '# spec-parity incremental-adoption baseline — scenarios exempt from the\n' +
    '# orphan check. Burn down by deleting lines as coverage lands.\n' +
    `# Generated by spec-parity.mjs --write-baseline (${unclaimed.length} scenario(s)).\n`
  writeFileSync(
    args.baseline,
    header + unclaimed.map((s) => `${s.specFile} :: ${s.title}`).join('\n') + '\n',
  )
  console.log(`Wrote ${unclaimed.length} baseline entr(ies) to ${args.baseline}.`)
  if (dangling.length > 0) {
    console.error('Dangling Covers tags are never baselined — fix these:')
    for (const r of dangling) console.error(`  ${r.testFile} → ${r.specFile} :: ${r.title}`)
    process.exit(1)
  }
  process.exit(0)
}

const baseline = new Set(
  args.baseline && existsSync(args.baseline)
    ? readFileSync(args.baseline, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .flatMap((line) => {
          const idx = line.indexOf(' :: ')
          return idx === -1 ? [] : [key(line.slice(0, idx).trim(), line.slice(idx + 4))]
        })
    : [],
)
const orphaned = unclaimed.filter((s) => !baseline.has(s.key))

const unknownScopes = []
const missingScopes = []
for (const s of scenarios) {
  if (s.wip || baseline.has(s.key)) continue
  const required = [...new Set([...args.defaultScopes, ...s.scopes])]
  for (const name of required) {
    const scopePattern = args.scopes.get(name)
    if (!scopePattern) {
      unknownScopes.push(`${s.specFile} :: ${s.title} — [${name}]`)
    } else if (
      !refs.some((ref) => ref.key === s.key && scopePattern.test(ref.testFile))
    ) {
      missingScopes.push(`${s.specFile} :: ${s.title} — needs [${name}] coverage`)
    }
  }
}

if (
  orphaned.length === 0 &&
  dangling.length === 0 &&
  unknownScopes.length === 0 &&
  missingScopes.length === 0
) {
  const wip = scenarios.filter((s) => s.wip).length
  const baselined = unclaimed.length
  console.log(
    `Spec↔test parity holds: ${scenarios.length - wip - baselined} scenario(s) covered` +
      (wip > 0 ? `, ${wip} wip` : '') +
      (baselined > 0 ? `, ${baselined} baselined (burn-down)` : '') +
      `, ${refs.length} Covers tag(s) resolved.`,
  )
  process.exit(0)
}
if (orphaned.length > 0) {
  console.error('Scenarios with no covering acceptance test:')
  for (const s of orphaned) console.error(`  ${s.specFile} :: ${s.title}`)
}
if (dangling.length > 0) {
  console.error('Covers tags pointing at no existing scenario:')
  for (const r of dangling) console.error(`  ${r.testFile} → ${r.specFile} :: ${r.title}`)
}
if (missingScopes.length > 0) {
  console.error('Scenarios not covered by every driver scope they require:')
  for (const line of missingScopes) console.error(`  ${line}`)
}
if (unknownScopes.length > 0) {
  const knownNames = [...args.scopes.keys()]
  console.error(
    `Scenario tags naming undeclared driver scopes (declared: ${
      knownNames.length > 0 ? knownNames.join(', ') : 'none'
    }):`,
  )
  for (const line of unknownScopes) console.error(`  ${line}`)
}
process.exit(1)
