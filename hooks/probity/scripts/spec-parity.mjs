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
 *
 *   --specs    specs directory containing *.feature.md (required)
 *   --tests    root(s) to scan for acceptance tests (repeatable, default .)
 *   --pattern  substring/regex a test file path must match
 *              (default: /[/\\]acceptance[/\\]/)
 *
 * Exit codes: 0 parity holds, 1 orphaned scenarios or dangling
 * Covers tags, 2 usage error.
 *
 * Conventions (shared with the probity rule):
 *   spec heading:  ## Scenario: <title>     (## Scenario (wip): exempt)
 *   test tag:      Covers: <spec>.feature.md :: Scenario: <title>
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import process from 'node:process'

const SCENARIO_HEADING = /^##\s*Scenario(\s*\((?:wip|planned)\))?\s*:\s*(.+?)\s*$/gm
const COVERS_TAG = /Covers:\s*([\w.-]+\.feature\.md)\s*::\s*Scenario:\s*([^\n]+)/g
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', '.gradle', 'out', 'dist', '.idea'])

function parseArgs(argv) {
  const args = { specs: undefined, tests: [], pattern: undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--specs') args.specs = argv[++i]
    else if (argv[i] === '--tests') args.tests.push(argv[++i])
    else if (argv[i] === '--pattern') args.pattern = argv[++i]
    else {
      console.error(`Unknown argument: ${argv[i]}`)
      process.exit(2)
    }
  }
  if (!args.specs) {
    console.error('Usage: spec-parity.mjs --specs <dir> [--tests <root>]... [--pattern <regex>]')
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
      key: key(file, m[2]),
      specFile: basename(file),
      title: m[2].trim(),
      wip: m[1] !== undefined,
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
const orphaned = scenarios.filter((s) => !s.wip && !claimed.has(s.key))
const dangling = refs.filter((ref) => !known.has(ref.key))

if (orphaned.length === 0 && dangling.length === 0) {
  const wip = scenarios.filter((s) => s.wip).length
  console.log(
    `Spec↔test parity holds: ${scenarios.length - wip} scenario(s) covered` +
      (wip > 0 ? `, ${wip} wip` : '') +
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
process.exit(1)
