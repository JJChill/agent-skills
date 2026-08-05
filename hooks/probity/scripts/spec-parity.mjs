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
 *   scope tag:     ## Scenario [system]: <title>   (after any (wip) marker)
 *   test tag:      Covers: <spec>.feature.md :: Scenario: <title>
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import process from 'node:process'

const SCENARIO_HEADING =
  /^##\s*Scenario(\s*\((?:wip|planned)\))?(\s*\[([^\]]+)\])?\s*:\s*(.+?)\s*$/gm
const COVERS_TAG = /Covers:\s*([\w.-]+\.feature\.md)\s*::\s*Scenario:\s*([^\n]+)/g
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

const key = (specFile, title) => `${basename(specFile)} :: ${normalizeTitle(title)}`

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

const args = parseArgs(process.argv.slice(2))
if (!existsSync(args.specs)) {
  console.log(`No specs directory at ${args.specs} — nothing to enforce.`)
  process.exit(0)
}
const pattern = args.pattern ? new RegExp(args.pattern) : /[/\\]acceptance[/\\]/

const scenarios = walk(args.specs)
  .filter((file) => file.endsWith('.feature.md'))
  .flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(SCENARIO_HEADING)].map((m) => ({
      key: key(file, m[4]),
      specFile: basename(file),
      title: m[4].trim(),
      wip: m[1] !== undefined,
      scopes: (m[3] ?? '')
        .split(',')
        .map((scope) => scope.trim().toLowerCase())
        .filter(Boolean),
    })),
  )

const refs = args.tests
  .flatMap((root) => walk(root))
  .filter((file) => pattern.test(file) && !file.endsWith('.feature.md'))
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
