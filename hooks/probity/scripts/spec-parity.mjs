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
 *                        [--exclusions <file>] [--ignore-tags a,b]
 *                        [--wip <file>] [--shared-wip honor|ignore]
 *                        [--in-progress <regex>]
 *                        [--app-scope <name> [--strict-skeleton]
 *                         [--skeleton-exempt <file>]]
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
 *   --exclusions  scenarios this project is not responsible for, for a
 *              spec repository shared by several consumers (issue #105):
 *              one `<spec>.feature :: <title> # <reason>` per line, `#`
 *              comments allowed, reason required (name the owner, e.g.
 *              `# backend enforces the block list`). Excluded scenarios
 *              skip the orphan and scope checks and are reported with
 *              their reason. An exclusion matching no scenario, one for
 *              a scenario a test now claims, and one for a baselined
 *              scenario all fail. Missing file → no exclusions.
 *   --ignore-tags  comma-separated scenario tags this project does not
 *              treat as driver scopes (shared tags from other
 *              consumers). Unlisted unknown tags still fail. A name
 *              that is also a declared scope, or `wip`/`planned`, is a
 *              usage error.
 *   --wip      this project's work in progress, for a shared spec
 *              repository whose `@wip` markers other consumers control
 *              (issue #111): same line format as --exclusions, with a
 *              required note on what is happening or what blocks it
 *              (the stop-and-ask record for a missing seam). Listed
 *              scenarios are exempt like `@wip` ones and are reported
 *              with their notes. A wip line for a claimed, excluded or
 *              baselined scenario, or matching none, fails. Missing
 *              file → no project wip.
 *   --shared-wip  honor (default) or ignore. `ignore` makes the specs'
 *              own `@wip`/`@planned`/`(wip)` markers informational, so
 *              --wip is this project's only work-in-progress list.
 *   --in-progress  regex for the expected-to-fail marker (issue #115;
 *              default: `= inProgress {`, `test.failing`, `test.fails`,
 *              `withKnownIssue`, `XCTExpectFailure`). A Covers tag on a
 *              test carrying it is an in-progress claim: not coverage, so
 *              its scenario must be wip, and a wip scenario a finished
 *              test claims fails as promoted.
 *   --app-scope  the declared scope that runs the app tier (issue #129).
 *              Turns on the walking-skeleton check from the
 *              acceptance-testing skill's tier rules: every feature file
 *              with scenarios needing proof (not wip, excluded or
 *              baselined) has at least one scenario a finished test
 *              claims at this scope. Feature files without one are listed
 *              as a warning; the exit code doesn't change.
 *   --strict-skeleton  with --app-scope: a missing walking skeleton or a
 *              stale exemption fails (exit 1), for CI.
 *   --skeleton-exempt  with --app-scope: feature files that reach no
 *              external system, so need no app-tier scenario:
 *              `<spec>.feature # <reason>` per line, reason required. A
 *              line matching no feature file, or for a feature that has an
 *              app-scope claim, is stale. Missing file → no exemptions.
 *
 * Exit codes: 0 parity holds, 1 orphaned scenarios, dangling Covers
 * tags, unmet driver scopes, or dangling/stale exclusion or wip lines,
 * 2 usage error (including a malformed exclusions or wip file).
 *
 * Conventions (shared with the probity rule):
 *   spec heading:  ## Scenario: <title>     (## Scenario (wip): exempt)
 *                  or Gherkin `Scenario: <title>` (preceded by @wip / @scope tags)
 *   scope tag:     ## Scenario [system]: <title>   (after any (wip) marker)
 *                  or a Gherkin `@system` tag on the scenario
 *   test tag:      Covers: <spec>.feature[.md] :: Scenario: <title>
 *   stable id:     Gherkin `@id:<slug>` tag, or `id:<slug>` in the Markdown
 *                  bracket list (`## Scenario [system, id:<slug>]: <title>`).
 *                  Optional, unique across the specs directory, one per
 *                  scenario (issue #106). Tests then cite `Covers: @id:<slug>`,
 *                  baseline lines `@id:<slug>`, exclusion lines
 *                  `@id:<slug> # <reason>`, and the title can be reworded
 *                  without breaking them. Title references keep working.
 *
 * Spec files may be either <name>.feature.md (Markdown) or <name>.feature
 * (Gherkin); the two extensions are interchangeable (matched by stem) so a
 * spec can convert one file at a time with parity green throughout. The
 * same stem in both extensions at once is rejected (unfinished rename).
 */
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
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
// Or by stable id (issue #106): Covers: @id:<slug>
const COVERS_ID = /Covers:\s*@id:([\w.-]+)/g
const ID_REF = /^@id:([\w.-]+)$/
// Expected-to-fail markers (issue #115), as in the probity rule: a test
// carrying one passes only while its scenario still fails, so its claim is
// in progress, not coverage. `= inProgress {` or a line starting with it
// (a project-owned Kotlin helper; a DSL call `.inProgress()` never counts),
// Jest `test.failing`, Vitest `test.fails`, Swift `withKnownIssue`,
// XCTest `XCTExpectFailure`. Override with --in-progress <regex>.
const DEFAULT_IN_PROGRESS =
  /(?:=|^)\s*inProgress\s*\{|(?<![\w$.])(?:it|test)\.(?:failing|fails)\b|\bwithKnownIssue\b|\bXCTExpectFailure\b/m
const OWNER_DECLARATION =
  /@Test\b|\bfunc\s+test\w*\s*\(|(?<![\w$.])(?:it|test)(?:\.(?:only|skip|todo|failing|fails|concurrent)\b)?(?:\.each\s*\([^)]*\))?\s*\(/g
const COMMENT_OR_ANNOTATION_LINE = /^\s*(?:$|\/\/|\/\*|\*|@\w)/
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
    exclusions: undefined,
    ignoreTags: [],
    wip: undefined,
    sharedWip: 'honor',
    inProgress: DEFAULT_IN_PROGRESS,
    appScope: undefined,
    strictSkeleton: false,
    skeletonExempt: undefined,
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
    } else if (argv[i] === '--exclusions') args.exclusions = argv[++i]
    else if (argv[i] === '--wip') args.wip = argv[++i]
    else if (argv[i] === '--in-progress') args.inProgress = new RegExp(argv[++i] ?? '', 'm')
    else if (argv[i] === '--app-scope') args.appScope = (argv[++i] ?? '').trim().toLowerCase()
    else if (argv[i] === '--strict-skeleton') args.strictSkeleton = true
    else if (argv[i] === '--skeleton-exempt') args.skeletonExempt = argv[++i]
    else if (argv[i] === '--shared-wip') {
      args.sharedWip = argv[++i]
      if (args.sharedWip !== 'honor' && args.sharedWip !== 'ignore') {
        console.error(`--shared-wip expects honor or ignore, got: ${args.sharedWip}`)
        process.exit(2)
      }
    }
    else if (argv[i] === '--ignore-tags') {
      args.ignoreTags = (argv[++i] ?? '')
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
        '[--default-scopes a,b] [--exclusions <file>] [--ignore-tags a,b] ' +
        '[--wip <file>] [--shared-wip honor|ignore] [--in-progress <regex>] ' +
        '[--app-scope <name> [--strict-skeleton] [--skeleton-exempt <file>]]',
    )
    process.exit(2)
  }
  if (args.appScope !== undefined && !args.scopes.has(args.appScope)) {
    console.error(`--app-scope: "${args.appScope}" is not a declared driver scope (declare it with --scope ${args.appScope}=<regex>).`)
    process.exit(2)
  }
  if ((args.strictSkeleton || args.skeletonExempt) && args.appScope === undefined) {
    console.error('--strict-skeleton and --skeleton-exempt need --app-scope.')
    process.exit(2)
  }
  for (const tag of args.ignoreTags) {
    if (tag === 'wip' || tag === 'planned') {
      console.error(`--ignore-tags: "${tag}" is a work-in-progress marker, not a tag to ignore.`)
      process.exit(2)
    }
    if (args.scopes.has(tag) || args.defaultScopes.includes(tag)) {
      console.error(`--ignore-tags: "${tag}" is also a declared driver scope — pick one.`)
      process.exit(2)
    }
  }
  if (args.tests.length === 0) args.tests = ['.']
  return args
}

/**
 * Whether the test the Covers tag at `at` belongs to carries the
 * expected-to-fail marker: the next declaration when only comments and
 * annotations come between, otherwise the one the tag sits inside; the
 * test runs to the next declaration or the end of the file.
 */
function claimIsInProgress(content, at, marker) {
  const starts = [...content.matchAll(OWNER_DECLARATION)].map((m) => m.index)
  const lineEnd = content.indexOf('\n', at)
  const afterTag = lineEnd === -1 ? content.length : lineEnd + 1
  const next = starts.find((start) => start >= afterTag)
  const above =
    next !== undefined &&
    content.slice(afterTag, next).split('\n').slice(0, -1).every((line) => COMMENT_OR_ANNOTATION_LINE.test(line))
  const owner = above ? next : [...starts].reverse().find((start) => start < at)
  const from = Math.min(at, owner ?? at)
  const end = starts.find((start) => start > (owner ?? at)) ?? content.length
  return marker.test(content.slice(from, end))
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

function walk(dir, out = [], top = true) {
  // A directory holding a `.git` FILE is another working tree — a linked
  // `git worktree` (Claude Code puts them at .claude/worktrees/<name>/) or
  // a submodule. Its Covers tags claim scenarios for that checkout, never
  // for this one (issue #55).
  if (!top && isFile(join(dir, '.git'))) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out, false)
    } else {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const splitScopeList = (raw) =>
  (raw ?? '')
    .split(',')
    .map((scope) => scope.trim().toLowerCase())
    .filter(Boolean)

// `id:<slug>` entries in a tag list are stable ids, not scopes or markers.
const isIdTag = (tag) => tag.startsWith('id:')

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
        scopes: splitScopeList(md[3]).filter((tag) => !isIdTag(tag)),
        ids: splitScopeList(md[3]).filter(isIdTag).map((tag) => tag.slice(3)),
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
        scopes: tags.filter((tag) => tag !== 'wip' && tag !== 'planned' && !isIdTag(tag)),
        ids: tags.filter(isIdTag).map((tag) => tag.slice(3)),
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

/**
 * Parse an exclusions or wip file: `<spec> :: <title> # <reason>` or
 * `@id:<slug> # <reason>` per line. Unlike the baseline, a malformed line
 * is an error, not skipped — every entry must say why.
 */
function readReasonedList(path, { noun, field, why }) {
  if (!path || !existsSync(path)) return []
  const entries = []
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const sep = line.indexOf(' :: ')
    const hash = line.indexOf(' # ', sep === -1 ? 0 : sep + 4)
    const reason = hash === -1 ? '' : line.slice(hash + 3).trim()
    const id = hash === -1 ? null : line.slice(0, hash).trim().toLowerCase().match(ID_REF)
    if ((sep === -1 && !id) || !reason) {
      console.error(
        `${path}:${index + 1}: ${noun} read \`<spec>.feature :: <title> # <${field}>\` ` +
          `or \`@id:<slug> # <${field}>\`, and every line needs a ${field} ${why}:`,
      )
      console.error(`  ${line}`)
      process.exit(2)
    }
    if (id) {
      entries.push({ key: `@id:${id[1]}`, label: `@id:${id[1]}`, reason })
      return
    }
    const specFile = line.slice(0, sep).trim()
    const title = line.slice(sep + 4, hash).trim()
    entries.push({ key: key(specFile, title), label: `${specFile} :: ${title}`, reason })
  })
  return entries
}

/**
 * Feature files exempt from the walking-skeleton check (issue #129):
 * `<spec>.feature # <reason>` per line, `#` comments allowed, reason
 * required (what makes the feature reach no external system).
 */
function readSkeletonExempt(path) {
  if (!path || !existsSync(path)) return []
  const entries = []
  readFileSync(path, 'utf8').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const hash = line.indexOf(' # ')
    const specFile = (hash === -1 ? line : line.slice(0, hash)).trim()
    const reason = hash === -1 ? '' : line.slice(hash + 3).trim()
    if (!/\.feature(?:\.md)?$/.test(specFile) || !reason) {
      console.error(
        `${path}:${index + 1}: skeleton exemptions read \`<spec>.feature # <reason>\`, and every line ` +
          'needs a reason saying why the feature reaches no external system:',
      )
      console.error(`  ${line}`)
      process.exit(2)
    }
    entries.push({ stem: specStem(specFile), label: specFile, reason })
  })
  return entries
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

const ignoredTags = new Set(args.ignoreTags)
const scenarios = specFiles
  .flatMap(parseScenarios)
  .map((s) => ({ ...s, scopes: s.scopes.filter((tag) => !ignoredTags.has(tag)) }))

// Stable ids (issue #106): unique across the specs directory, at most one
// per scenario. A reference `@id:<slug>` resolves to its scenario's key;
// an unknown id stays unresolved and so reads as dangling.
const byId = new Map()
for (const s of scenarios) {
  if (s.ids.length > 1 || s.ids.some((id) => id === '')) {
    console.error(`${s.specFile} :: ${s.title} — a scenario carries one non-empty id, got: ${s.ids.map((id) => `@id:${id}`).join(' ')}`)
    process.exit(2)
  }
  const [id] = s.ids
  if (id === undefined) continue
  const other = byId.get(id)
  if (other) {
    console.error(`Scenario id @id:${id} is used twice — ids are unique across the specs directory:`)
    console.error(`  ${other.specFile} :: ${other.title}`)
    console.error(`  ${s.specFile} :: ${s.title}`)
    process.exit(2)
  }
  byId.set(id, s)
  s.id = id
}
const resolve = (ref) => {
  const id = ref.match(ID_REF)
  return id ? (byId.get(id[1])?.key ?? ref) : ref
}

const exclusions = readReasonedList(args.exclusions, {
  noun: 'exclusions',
  field: 'reason',
  why: 'naming who owns the scenario',
}).map((entry) => ({ ...entry, key: resolve(entry.key) }))
const excluded = new Map(exclusions.map((entry) => [entry.key, entry]))
const wipLines = readReasonedList(args.wip, {
  noun: 'wip lines',
  field: 'note',
  why: 'saying what is happening or what blocks it',
}).map((entry) => ({ ...entry, key: resolve(entry.key) }))
const projectWip = new Map(wipLines.map((entry) => [entry.key, entry]))
const allRefs = args.tests
  .flatMap((root) => walk(root))
  .filter(
    (file) =>
      pattern.test(file) &&
      !file.endsWith('.feature.md') &&
      !file.endsWith('.feature'),
  )
  .flatMap((file) => {
    const content = readFileSync(file, 'utf8')
    const byTitle = [...content.matchAll(COVERS_TAG)].map((m) => ({
      key: key(m[1], m[2]),
      testFile: file,
      label: `${m[1]} :: ${m[2].replace(/\s*(?:\*\/|["')\]]+)?\s*$/, '').trim()}`,
      inProgress: claimIsInProgress(content, m.index, args.inProgress),
    }))
    const byIdRef = [...content.matchAll(COVERS_ID)].map((m) => {
      const ref = `@id:${m[1].toLowerCase()}`
      return { key: resolve(ref), testFile: file, label: ref, inProgress: claimIsInProgress(content, m.index, args.inProgress) }
    })
    return [...byTitle, ...byIdRef]
  })
// Issue #115: an in-progress (expected-to-fail) claim is not coverage.
// Coverage, scopes and wip promotion count finished claims only; dangling
// tags and exclusion contradictions count them all.
const refs = allRefs.filter((ref) => !ref.inProgress)
const claimed = new Set(refs.map((ref) => ref.key))
const anyClaim = new Set(allRefs.map((ref) => ref.key))

// Issue #111: with --shared-wip ignore, the specs' own markers are
// information only; either way, this project's wip lines count as wip.
// A spec-marked wip scenario a finished test claims is promoted.
const promotedSpecWip = []
for (const s of scenarios) {
  if (args.sharedWip === 'ignore') s.wip = false
  if (s.wip && claimed.has(s.key)) promotedSpecWip.push(s)
  if (projectWip.has(s.key)) s.wip = true
}

const known = new Set(scenarios.map((scenario) => scenario.key))
// Precedence: claimed > excluded > wip > baseline. A claimed or
// baselined exclusion is reported below as stale rather than silently won.
const unclaimed = scenarios.filter(
  (s) => !s.wip && !claimed.has(s.key) && !excluded.has(s.key),
)
const dangling = allRefs.filter((ref) => !known.has(ref.key))

if (args.writeBaseline) {
  const header =
    '# spec-parity incremental-adoption baseline — scenarios exempt from the\n' +
    '# orphan check. Burn down by deleting lines as coverage lands.\n' +
    `# Generated by spec-parity.mjs --write-baseline (${unclaimed.length} scenario(s)).\n`
  writeFileSync(
    args.baseline,
    header +
      unclaimed.map((s) => (s.id ? `@id:${s.id}` : `${s.specFile} :: ${s.title}`)).join('\n') +
      '\n',
  )
  console.log(`Wrote ${unclaimed.length} baseline entr(ies) to ${args.baseline}.`)
  if (dangling.length > 0) {
    console.error('Dangling Covers tags are never baselined — fix these:')
    for (const r of dangling) console.error(`  ${r.testFile} → ${r.label}`)
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
          if (ID_REF.test(line.toLowerCase())) return [resolve(line.toLowerCase())]
          const idx = line.indexOf(' :: ')
          return idx === -1 ? [] : [key(line.slice(0, idx).trim(), line.slice(idx + 4))]
        })
    : [],
)
const orphaned = unclaimed.filter((s) => !baseline.has(s.key) && !anyClaim.has(s.key))
const onlyInProgress = unclaimed.filter((s) => !baseline.has(s.key) && anyClaim.has(s.key))
const danglingExclusions = exclusions.filter((entry) => !known.has(entry.key))
const claimedExclusions = exclusions.filter(
  (entry) => known.has(entry.key) && anyClaim.has(entry.key),
)
const baselinedExclusions = exclusions.filter(
  (entry) => known.has(entry.key) && baseline.has(entry.key),
)
const danglingWip = wipLines.filter((entry) => !known.has(entry.key))
const claimedWip = wipLines.filter((entry) => known.has(entry.key) && claimed.has(entry.key))
const excludedWip = wipLines.filter((entry) => excluded.has(entry.key))
// The baseline is a snapshot from adoption that only shrinks: a scenario
// that became wip later leaves it.
const baselinedWip = wipLines.filter(
  (entry) => known.has(entry.key) && !excluded.has(entry.key) && baseline.has(entry.key),
)
const staleWip = danglingWip.length + claimedWip.length + excludedWip.length + baselinedWip.length

const unknownScopes = []
const missingScopes = []
for (const s of scenarios) {
  if (s.wip || baseline.has(s.key) || excluded.has(s.key)) continue
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

// Issue #129, the walking skeleton: every feature file with scenarios that
// need proof has at least one finished claim at the app scope, unless the
// project exempts it. A warning by default; --strict-skeleton fails it.
const skeleton = { missing: [], exempt: [], stale: [] }
if (args.appScope !== undefined) {
  const appPattern = args.scopes.get(args.appScope)
  const exemptions = readSkeletonExempt(args.skeletonExempt)
  const stemOf = (scenarioKey) => scenarioKey.slice(0, scenarioKey.indexOf(' :: '))
  const proven = new Set(
    refs.filter((ref) => known.has(ref.key) && appPattern.test(ref.testFile)).map((ref) => stemOf(ref.key)),
  )
  const needing = new Map()
  for (const s of scenarios) {
    if (s.wip || excluded.has(s.key) || baseline.has(s.key)) continue
    if (!needing.has(stemOf(s.key))) needing.set(stemOf(s.key), s.specFile)
  }
  const exemptStems = new Map(exemptions.map((entry) => [entry.stem, entry]))
  const allStems = new Set(scenarios.map((s) => stemOf(s.key)))
  for (const [stem, specFile] of needing) {
    if (proven.has(stem)) continue
    if (exemptStems.has(stem)) skeleton.exempt.push(`${specFile} — ${exemptStems.get(stem).reason}`)
    else skeleton.missing.push(specFile)
  }
  for (const entry of exemptions) {
    if (!allStems.has(entry.stem)) skeleton.stale.push(`${entry.label} — matches no feature file`)
    else if (proven.has(entry.stem)) skeleton.stale.push(`${entry.label} — has an [${args.appScope}] claim now`)
  }
}
const skeletonFails = args.strictSkeleton && (skeleton.missing.length > 0 || skeleton.stale.length > 0)

function reportSkeleton(print) {
  if (skeleton.missing.length > 0) {
    print(
      `Feature files with no scenario claimed at the [${args.appScope}] scope (walking skeleton — ` +
        'claim the main success path at the app tier, or exempt a feature that reaches no external system):',
    )
    for (const line of skeleton.missing) print(`  ${line}`)
  }
  if (skeleton.stale.length > 0) {
    print('Stale walking-skeleton exemptions (delete them):')
    for (const line of skeleton.stale) print(`  ${line}`)
  }
  if (skeleton.exempt.length > 0) {
    print('Exempt from the walking skeleton:')
    for (const line of skeleton.exempt) print(`  ${line}`)
  }
}

if (
  !skeletonFails &&
  orphaned.length === 0 &&
  onlyInProgress.length === 0 &&
  promotedSpecWip.length === 0 &&
  dangling.length === 0 &&
  unknownScopes.length === 0 &&
  missingScopes.length === 0 &&
  danglingExclusions.length === 0 &&
  claimedExclusions.length === 0 &&
  baselinedExclusions.length === 0 &&
  staleWip === 0
) {
  const notOurs = scenarios.filter((s) => excluded.has(s.key))
  const wip = scenarios.filter((s) => s.wip && !excluded.has(s.key)).length
  const baselined = unclaimed.length
  console.log(
    `Spec↔test parity holds: ${scenarios.length - wip - baselined - notOurs.length} scenario(s) covered` +
      (wip > 0 ? `, ${wip} wip` : '') +
      (baselined > 0 ? `, ${baselined} baselined (burn-down)` : '') +
      (notOurs.length > 0 ? `, ${notOurs.length} not this project's` : '') +
      `, ${refs.length} Covers tag(s) resolved.`,
  )
  if (wipLines.length > 0) {
    console.log("This project's wip:")
    for (const s of scenarios.filter((s) => projectWip.has(s.key))) {
      console.log(`  ${s.specFile} :: ${s.title} — ${projectWip.get(s.key).reason}`)
    }
  }
  if (notOurs.length > 0) {
    console.log("Not this project's:")
    for (const s of notOurs) {
      console.log(`  ${s.specFile} :: ${s.title} — ${excluded.get(s.key).reason}`)
    }
  }
  reportSkeleton(console.log)
  process.exit(0)
}
reportSkeleton(console.error)
if (orphaned.length > 0) {
  console.error('Scenarios with no covering acceptance test:')
  for (const s of orphaned) console.error(`  ${s.specFile} :: ${s.title}`)
}
if (onlyInProgress.length > 0) {
  console.error(
    'Scenarios claimed only by in-progress (expected-to-fail) tests — not covered yet ' +
      '(mark the scenario wip while driving it, or finish it and remove the marker):',
  )
  for (const s of onlyInProgress) console.error(`  ${s.specFile} :: ${s.title}`)
}
if (promotedSpecWip.length > 0) {
  console.error('Wip scenarios a finished test now claims (promoted — remove the @wip/(wip) marker):')
  for (const s of promotedSpecWip) console.error(`  ${s.specFile} :: ${s.title}`)
}
if (dangling.length > 0) {
  console.error('Covers tags pointing at no existing scenario:')
  for (const r of dangling) console.error(`  ${r.testFile} → ${r.label}`)
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
if (danglingExclusions.length > 0) {
  console.error('Exclusions matching no scenario (renamed or removed — update or delete them):')
  for (const e of danglingExclusions) console.error(`  ${e.label}`)
}
if (claimedExclusions.length > 0) {
  console.error('Excluded scenarios a test now claims (delete the exclusion):')
  for (const e of claimedExclusions) console.error(`  ${e.label}`)
}
if (baselinedExclusions.length > 0) {
  console.error('Excluded scenarios still in the baseline (delete the baseline line):')
  for (const e of baselinedExclusions) console.error(`  ${e.label}`)
}
const wipSections = [
  ['Wip lines matching no scenario (renamed or removed — update or delete them):', danglingWip],
  ['Wip lines for scenarios a test now claims (promoted — delete the wip line):', claimedWip],
  ['Wip lines for excluded scenarios (a scenario is ours or not — keep one line):', excludedWip],
  ['Wip scenarios still in the baseline (the baseline only shrinks — delete the baseline line):', baselinedWip],
]
for (const [heading, entries] of wipSections) {
  if (entries.length === 0) continue
  console.error(heading)
  for (const e of entries) console.error(`  ${e.label}`)
}
process.exit(1)
