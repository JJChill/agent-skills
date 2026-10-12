import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { Action, Rule, RuleContext, RuleResult } from '@nizos/probity'

import { canonical, isGitCommit, gitToplevel, isWithin, nestedCommitTree } from './commit-target.js'

/**
 * Spec↔test traceability for the `acceptance-testing` workflow:
 * every `## Scenario:` in a `*.feature.md` spec is claimed by an
 * acceptance test, and every claim resolves to a real scenario.
 *
 * The link convention: an acceptance test declares the scenario it
 * covers with a tag anywhere in the file (comment or annotation
 * argument), one per scenario:
 *
 *   // Covers: messaging.feature.md :: Scenario: Message is delivered
 *
 * Scenario keys are `<spec basename> :: <title>`, so titles are link
 * keys: renaming a scenario must update its tests' tags — which
 * `surfaceScenarioLinkBreakage` turns into a guided step instead of
 * silent rot.
 *
 * In-progress scenarios being driven outside-in are exempted with
 * `## Scenario (wip):` — the parity gate ignores them until the
 * marker is dropped.
 *
 * Scenarios may additionally declare **driver scopes** — coverage
 * floors naming which driver suites must cover them, on top of the
 * base "at least one test" requirement:
 *
 *   ## Scenario [system]: Payment is retried after a network failure
 *
 * Scope names are policy labels ("also proven against the deployed
 * system"), not mechanisms; the mapping from scope name to test files
 * is the `driverScopes` option. Tags never change the scenario key,
 * so Covers tags and baselines are unaffected by adding one.
 *
 * A scenario may also carry a **stable id** (issue #106) — a Gherkin
 * `@id:<slug>` tag, or `id:<slug>` in the Markdown bracket list
 * (`## Scenario [system, id:<slug>]: …`). Optional, unique across the
 * specs directory, one per scenario. References may then cite the id
 * instead of the title — `// Covers: @id:<slug>`, a baseline line
 * `@id:<slug>`, an exclusion line `@id:<slug> # <reason>` — so a spec
 * repository shared by several consumers can reword a title without
 * breaking every consumer's references. Title references keep working.
 */

// Two spec formats during the .feature.md -> .feature migration:
//   Markdown:  ## Scenario (wip) [system]: Title
//   Gherkin:   @wip @system\n  Scenario: Title
// parseScenarios below handles both, line by line.
const MD_SCENARIO =
  /^##\s*Scenario(\s*\((?:wip|planned)\))?(\s*\[([^\]]+)\])?\s*:\s*(.+?)\s*$/
const GHERKIN_SCENARIO = /^Scenario(?:\s+Outline)?:\s*(.+?)\s*$/
const COVERS_TAG = /Covers:\s*([\w.-]+\.feature(?:\.md)?)\s*::\s*Scenario:\s*([^\n]+)/g
const COVERS_ID = /Covers:\s*@id:([\w.-]+)/g
const ID_REF = /^@id:([\w.-]+)$/
/**
 * Expected-to-fail markers (issue #115): a test carrying one passes only
 * while its scenario still fails, so its claim is in progress, not
 * coverage. Kotlin has no built-in, so projects own an `inProgress { }`
 * helper (written `= inProgress {` or at the start of a line, so a DSL
 * call such as `.inProgress()` never counts); Jest `test.failing`,
 * Vitest `test.fails`, Swift Testing `withKnownIssue`, XCTest
 * `XCTExpectFailure`.
 */
export const DEFAULT_IN_PROGRESS_PATTERN =
  /(?:=|^)\s*inProgress\s*\{|(?<![\w$.])(?:it|test)\.(?:failing|fails)\b|\bwithKnownIssue\b|\bXCTExpectFailure\b/m
// A test declaration in any supported framework, for finding the test a
// Covers tag belongs to: Kotlin/Java/Swift Testing `@Test`, XCTest
// `func test…(`, and `it(`/`test(` with their modifiers.
const OWNER_DECLARATION =
  /@Test\b|\bfunc\s+test\w*\s*\(|(?<![\w$.])(?:it|test)(?:\.(?:only|skip|todo|failing|fails|concurrent)\b)?(?:\.each\s*\([^)]*\))?\s*\(/g
// Lines that may sit between a Covers tag and the test it annotates.
const COMMENT_OR_ANNOTATION_LINE = /^\s*(?:$|\/\/|\/\*|\*|@\w)/
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'build',
  '.gradle',
  'out',
  'dist',
  '.idea',
])

function normalizeTitle(title: string): string {
  return title
    .replace(/\s*(?:\*\/|["')\]]+)?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// A spec is identified by its stem (filename without .feature/.feature.md)
// so a scenario keeps one key across the extension change and Covers tags
// resolve regardless of which extension either side currently uses.
function specStem(name: string): string {
  return basename(name).replace(/\.feature(?:\.md)?$/i, '')
}

function scenarioKey(specFile: string, title: string): string {
  return `${specStem(specFile)} :: ${normalizeTitle(title)}`
}

type Scenario = {
  key: string
  specFile: string
  title: string
  wip: boolean
  /** Driver scopes the heading declares, e.g. `[system]` → ['system']. */
  scopes: string[]
  /** Stable id (`@id:<slug>`), if the scenario declares exactly one. */
  id?: string
  /** Every id the scenario declares; more than one is an error. */
  ids: string[]
}
/**
 * A `Covers:` tag. By title: `key` is the scenario key. By id: `id` is
 * set and `key` is the raw `@id:<slug>` until resolved against the specs.
 */
type CoversRef = {
  key: string
  testFile: string
  specFile: string
  title: string
  id?: string
  /** The claiming test carries an expected-to-fail marker (issue #115). */
  inProgress: boolean
}

const isIdTag = (tag: string): boolean => tag.startsWith('id:')

function refLabel(ref: CoversRef): string {
  return ref.id ? `@id:${ref.id}` : `${ref.specFile} :: ${ref.title}`
}

/**
 * Indexes scenarios by stable id. `problems` lists duplicate ids and
 * scenarios with more than one (or an empty) id.
 */
function indexIds(scenarios: Scenario[]): { byId: Map<string, Scenario>; problems: string[] } {
  const byId = new Map<string, Scenario>()
  const problems: string[] = []
  for (const s of scenarios) {
    if (s.ids.length > 1 || s.ids.includes('')) {
      problems.push(
        `${basename(s.specFile)} :: ${s.title} — one non-empty id per scenario, got ` +
          s.ids.map((id) => `@id:${id}`).join(' '),
      )
      continue
    }
    if (!s.id) continue
    const other = byId.get(s.id)
    if (other) {
      problems.push(
        `@id:${s.id} is used twice: ${basename(other.specFile)} :: ${other.title} ` +
          `and ${basename(s.specFile)} :: ${s.title}`,
      )
      continue
    }
    byId.set(s.id, s)
  }
  return { byId, problems }
}

/** Resolves an `@id:<slug>` reference to its scenario key; anything else is returned as is. */
function resolveKey(key: string, byId: Map<string, Scenario>): string {
  const id = key.match(ID_REF)?.[1]
  return id ? (byId.get(id)?.key ?? key) : key
}

function parseScopes(tag: string | undefined): string[] {
  if (!tag) return []
  return tag
    .split(',')
    .map((scope) => scope.trim().toLowerCase())
    .filter(Boolean)
}

export function extractScenarios(specFile: string, content: string): Scenario[] {
  const scenarios: Scenario[] = []
  let tags: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const md = line.match(MD_SCENARIO)
    if (md) {
      const title = md[4] ?? ''
      const list = parseScopes(md[3])
      const ids = list.filter(isIdTag).map((tag) => tag.slice(3))
      scenarios.push({
        key: scenarioKey(specFile, title),
        specFile,
        title: title.trim(),
        wip: md[1] !== undefined,
        scopes: list.filter((tag) => !isIdTag(tag)),
        ids,
        id: ids.length === 1 ? ids[0] : undefined,
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
      const title = gherkin[1] ?? ''
      const ids = tags.filter(isIdTag).map((tag) => tag.slice(3))
      scenarios.push({
        key: scenarioKey(specFile, title),
        specFile,
        title: title.trim(),
        wip: tags.includes('wip') || tags.includes('planned'),
        scopes: tags.filter((tag) => tag !== 'wip' && tag !== 'planned' && !isIdTag(tag)),
        ids,
        id: ids.length === 1 ? ids[0] : undefined,
      })
      tags = []
      continue
    }
    // Tags only attach to the next Scenario; any non-tag, non-comment
    // content (a Feature line, a step) ends a dangling tag block.
    if (trimmed !== '' && !trimmed.startsWith('#')) tags = []
  }
  return scenarios
}

/**
 * Whether the test a Covers tag at `at` belongs to carries an
 * expected-to-fail marker. The tag belongs to the next test declaration
 * when only comments and annotations come between (tag above the test),
 * otherwise to the declaration it sits inside (tag in the body). The
 * test runs to the next declaration or the end of the file.
 */
function claimIsInProgress(content: string, at: number, marker: RegExp): boolean {
  const starts = [...content.matchAll(OWNER_DECLARATION)].map((match) => match.index ?? 0)
  const lineEnd = content.indexOf('\n', at)
  const afterTag = lineEnd === -1 ? content.length : lineEnd + 1
  const next = starts.find((start) => start >= afterTag)
  const above =
    next !== undefined &&
    content.slice(afterTag, next).split('\n').slice(0, -1).every((line) => COMMENT_OR_ANNOTATION_LINE.test(line))
  const owner = above ? next : [...starts].reverse().find((start) => start < at)
  const from = Math.min(at, owner ?? at)
  const end = starts.find((start) => start > (owner ?? at)) ?? content.length
  return new RegExp(marker.source, marker.flags.replace('g', '')).test(content.slice(from, end))
}

export function extractCoversRefs(
  testFile: string,
  content: string,
  inProgressPattern: RegExp = DEFAULT_IN_PROGRESS_PATTERN,
): CoversRef[] {
  const refs: CoversRef[] = []
  for (const match of content.matchAll(COVERS_TAG)) {
    const specFile = match[1] ?? ''
    const title = match[2] ?? ''
    refs.push({
      key: scenarioKey(specFile, title),
      testFile,
      specFile,
      title: title.replace(/\s*(?:\*\/|["')\]]+)?\s*$/, '').trim(),
      inProgress: claimIsInProgress(content, match.index ?? 0, inProgressPattern),
    })
  }
  for (const match of content.matchAll(COVERS_ID)) {
    const id = (match[1] ?? '').toLowerCase()
    refs.push({
      key: `@id:${id}`,
      testFile,
      specFile: '',
      title: '',
      id,
      inProgress: claimIsInProgress(content, match.index ?? 0, inProgressPattern),
    })
  }
  return refs
}

function walk(dir: string, out: string[] = [], top = true): string[] {
  // A directory holding a `.git` FILE is another working tree — a
  // linked `git worktree` (Claude Code puts sub-agent worktrees at
  // .claude/worktrees/<name>/) or a submodule. Its Covers tags claim
  // scenarios for that checkout, never for this one (issue #55).
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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const DEFAULT_TEST_FILE_PATTERN = /[/\\]acceptance[/\\]/

/**
 * A named driver scope: which test files count as coverage from a
 * given driver suite. Scope names are the vocabulary scenario
 * headings may use in `[scope, ...]` tags — lowercase by convention
 * (tags are lowercased before matching).
 */
export type DriverScope = { name: string; filePattern: RegExp }

type ScanOptions = {
  specsDir: string
  testRoots: string[]
  testFilePattern?: RegExp
  /**
   * Per-scenario driver mapping (optional). Each entry names a driver
   * suite and the test files that belong to it (e.g.
   * `{ name: 'system', filePattern: /AcceptanceTests[/\\]UITests[/\\]/ }`).
   * A scenario tagged `## Scenario [system]:` must then be covered by
   * at least one test matching that scope's pattern — **in addition
   * to** the base requirement that some acceptance test covers it.
   * Tags are floors, never ceilings: extra coverage in other scopes
   * is always fine, and untagged scenarios only need `defaultScopes`
   * (below) plus the base requirement. A tag naming a scope absent
   * from this list is a violation (misspelling protection); with no
   * `driverScopes` configured, any tag is unknown, so adopting tags
   * requires configuring scopes first.
   */
  driverScopes?: DriverScope[]
  /**
   * Scope names every non-wip, non-baselined scenario must satisfy
   * even without a tag — the project's standard driver set (e.g.
   * `['view-model']`). Names must exist in `driverScopes`. Omit for
   * the status-quo default: untagged scenarios need any one covering
   * test, regardless of driver.
   */
  defaultScopes?: string[]
  /**
   * Incremental-adoption baseline (optional). Path to a text file of
   * scenario keys — one `<spec>.feature.md :: <title>` per line, `#`
   * comments allowed — that are exempt from the orphan check. Use it
   * to adopt the parity gate on a brownfield spec suite: generate the
   * baseline once (`spec-parity.mjs --baseline <path> --write-baseline`),
   * commit it, and from then on only scenarios *not* in the baseline
   * must carry a covering test — new specs are enforced from day one
   * while the backlog burns down by deleting lines. A missing file
   * means full enforcement (the greenfield default). Dangling Covers
   * tags are never baselined: they are actively wrong, not legacy.
   */
  baselinePath?: string
  /**
   * Scenarios this project is not responsible for (optional), for a
   * spec repository shared by several consumers (issue #105). Path to
   * a text file, one `<spec>.feature :: <title> # <reason>` per line,
   * `#` comments allowed; the reason is required and should name the
   * owner (`# backend enforces the block list`). Excluded scenarios
   * skip the orphan and scope checks. Unlike the baseline (debt to burn
   * down), exclusions are standing decisions, so the gate keeps them
   * honest: a malformed line, an exclusion matching no scenario, one
   * for a scenario a test now claims, and one for a baselined scenario
   * all block. Missing file → no exclusions. Keep it outside `specsDir`
   * when the specs are a shared submodule.
   */
  exclusionsPath?: string
  /**
   * Scenario tags this project does not treat as driver scopes —
   * shared tags another consumer uses (optional). Applies to Gherkin
   * `@tags` and Markdown `[tags]`. Unlisted unknown tags still block
   * (misspelling protection). A name that is also in `driverScopes` or
   * `defaultScopes`, or `wip`/`planned`, blocks as a contradiction.
   */
  ignoreTags?: string[]
  /**
   * This project's work in progress (optional), for a shared spec
   * repository whose `@wip` markers other consumers control (issue
   * #111). Same line format as `exclusionsPath`, with a required note on
   * what is happening or what blocks it — in a shared repository this is
   * where the stop-and-ask record for a missing seam goes. Listed
   * scenarios are exempt like `@wip` ones. A wip line for a claimed
   * scenario (promoted: delete the line), an excluded one, a baselined
   * one (the baseline is a snapshot from adoption that only shrinks), or
   * none blocks. Missing file → no project wip.
   */
  wipPath?: string
  /**
   * How the specs' own `@wip`/`@planned`/`(wip)` markers count here:
   * `'honor'` (default) exempts them as before; `'ignore'` makes them
   * information only, so `wipPath` is this project's only wip list.
   */
  sharedWip?: 'honor' | 'ignore'
  /**
   * Expected-to-fail marker (issue #115; default
   * {@link DEFAULT_IN_PROGRESS_PATTERN}). A Covers tag on a test carrying
   * it is an in-progress claim: not coverage, so the scenario must be
   * wip. A wip scenario a test without the marker claims is promoted,
   * and its wip marker or line must go.
   */
  inProgressPattern?: RegExp
  /**
   * Files the pending commit will record, relative to the root of the
   * working tree being committed (`cwd`: the project, or a worktree nested
   * in it). Defaults to Git's staged set plus tracked modifications for
   * `git commit -a`; injectable for deterministic tests.
   */
  listCommitFiles?: (command: string, cwd: string) => string[]
}

/** Parses a baseline file into normalized scenario keys. Missing file → empty set. */
export function readBaseline(path: string | undefined): Set<string> {
  if (!path || !existsSync(path)) return new Set()
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .flatMap((line) => {
        // `@id:<slug>` stays raw here; the gate resolves it against the specs.
        if (ID_REF.test(line.toLowerCase())) return [line.toLowerCase()]
        const idx = line.indexOf(' :: ')
        if (idx === -1) return []
        const spec = line.slice(0, idx).trim()
        const title = line.slice(idx + 4)
        return [scenarioKey(spec, title)]
      }),
  )
}

/** `key` is a scenario key, or a raw `@id:<slug>` until resolved. */
type Exclusion = { key: string; label: string; reason: string }

/**
 * Parses an exclusions or wip file (`<spec> :: <title> # <reason>` or
 * `@id:<slug> # <reason>` per line; the same format serves both).
 * Missing file → none. A line without the separator or a reason lands
 * in `malformed`: unlike the baseline, an exclusion must say why.
 */
export function readExclusions(path: string | undefined): {
  entries: Exclusion[]
  malformed: string[]
} {
  const entries: Exclusion[] = []
  const malformed: string[] = []
  if (!path || !existsSync(path)) return { entries, malformed }
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const sep = line.indexOf(' :: ')
    const hash = line.indexOf(' # ', sep === -1 ? 0 : sep + 4)
    const reason = hash === -1 ? '' : line.slice(hash + 3).trim()
    const id = hash === -1 ? undefined : line.slice(0, hash).trim().toLowerCase().match(ID_REF)?.[1]
    if ((sep === -1 && !id) || !reason) {
      malformed.push(line)
      continue
    }
    if (id) {
      entries.push({ key: `@id:${id}`, label: `@id:${id}`, reason })
      continue
    }
    const specFile = line.slice(0, sep).trim()
    const title = line.slice(sep + 4, hash).trim()
    entries.push({ key: scenarioKey(specFile, title), label: `${specFile} :: ${title}`, reason })
  }
  return { entries, malformed }
}

/** All spec files (either extension) under a directory. */
export function findSpecFiles(specsDir: string): string[] {
  return walk(specsDir).filter(
    (file) => file.endsWith('.feature.md') || file.endsWith('.feature'),
  )
}

export function scanSpecs(specsDir: string): Scenario[] {
  return findSpecFiles(specsDir).flatMap((file) =>
    extractScenarios(file, readFileSync(file, 'utf8')),
  )
}

export function scanCoversRefs(
  testRoots: string[],
  testFilePattern: RegExp,
  inProgressPattern?: RegExp,
): CoversRef[] {
  return testRoots
    .flatMap((root) => walk(root))
    .filter(
      (file) =>
        testFilePattern.test(file) &&
        !file.endsWith('.feature.md') &&
        !file.endsWith('.feature'),
    )
    .flatMap((file) => extractCoversRefs(file, readFileSync(file, 'utf8'), inProgressPattern))
}

function formatList(lines: string[], max = 10): string {
  const shown = lines.slice(0, max).map((line) => `    ${line}`)
  if (lines.length > max) shown.push(`    …and ${lines.length - max} more`)
  return shown.join('\n')
}

function defaultListCommitFiles(command: string, cwd = process.cwd()): string[] {
  const run = (args: string[]): string[] =>
    execFileSync('git', args, { cwd, encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  const files = run(['diff', '--cached', '--name-only'])
  if (/\s-\w*a\w*\b/.test(command) || /--all\b/.test(command)) {
    for (const file of run(['diff', '--name-only'])) {
      if (!files.includes(file)) files.push(file)
    }
  }
  return files
}

function pathsIntersect(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left)
}

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0
  return pattern.test(value)
}

/**
 * Bidirectional parity gate on `git commit`: blocks when any
 * non-wip `## Scenario:` heading in `specsDir` has no acceptance
 * test claiming it via a `Covers:` tag, or when any `Covers:` tag
 * points at a scenario that no longer exists (spec renamed or
 * removed). Deterministic filesystem scan — no AI call; milliseconds
 * at typical spec-suite scale.
 *
 * Parity requires the *link*, not a passing run. An in-progress test
 * is committed expected-to-fail (issue #115: `inProgress { }`,
 * `test.failing`, `withKnownIssue`), so the build stays green; its claim
 * is not coverage, so its scenario stays `(wip)` until the marker comes
 * off, and a finished claim on a wip scenario means the marker must go.
 *
 * Applies to: command actions matching `git commit`.
 *
 * @param options.specsDir — absolute path to the specs directory
 *   (e.g. `<root>/docs/specs`). A missing directory passes: no
 *   specs, nothing to enforce.
 * @param options.testRoots — absolute paths to scan for acceptance
 *   tests (the repo root is fine; node_modules/build dirs are
 *   skipped).
 * @param options.testFilePattern — which files count as acceptance
 *   tests (default: any file under an `acceptance/` directory).
 * @param options.baselinePath — optional incremental-adoption
 *   baseline; scenarios listed there are exempt from the orphan
 *   check (see {@link readBaseline}). Missing file → full enforcement.
 * @param options.exclusionsPath — optional per-project exclusions for a
 *   shared spec repository (see {@link readExclusions}).
 * @param options.ignoreTags — optional scenario tags that are not
 *   driver scopes in this project.
 * @param options.driverScopes — optional per-scenario driver mapping;
 *   see {@link DriverScope}. Scenarios tagged `[scope]` (and every
 *   scenario, for `defaultScopes` entries) must be covered by a test
 *   matching that scope's `filePattern`, on top of the base check.
 * @param options.defaultScopes — scope names required of untagged
 *   scenarios too (the project's standard driver set).
 * @param options.listCommitFiles — optional staged-file lister for
 *   tests. By default the gate reads Git's pending commit and runs only
 *   when it records the specs path (including a submodule pointer), the
 *   baseline, the exclusions file, or an acceptance-test path. Inspection failures preserve
 *   full enforcement.
 */
export function enforceSpecTestParity(options: ScanOptions): Rule {
  const pattern = options.testFilePattern ?? DEFAULT_TEST_FILE_PATTERN
  const listCommitFiles = options.listCommitFiles ?? defaultListCommitFiles
  const scopes = new Map(
    (options.driverScopes ?? []).map((scope) => [scope.name.toLowerCase(), scope]),
  )
  const defaultScopes = (options.defaultScopes ?? []).map((name) => name.toLowerCase())
  const ignoredTags = new Set((options.ignoreTags ?? []).map((tag) => tag.toLowerCase()))
  const tagConflicts = [...ignoredTags].filter(
    (tag) => tag === 'wip' || tag === 'planned' || scopes.has(tag) || defaultScopes.includes(tag),
  )
  return function enforceSpecTestParity(action: Action): RuleResult {
    if (action.kind !== 'command') return { kind: 'pass' }
    if (!isGitCommit(action.command)) return { kind: 'pass' }
    const cwd = process.cwd()
    // A commit made inside a git working tree nested in the project (a
    // linked worktree at .claude/worktrees/<name>) is checked against that
    // tree: its staged files, its specs, its tests (issue #57). Configured
    // paths under the project root map to the same place in that tree.
    const base = gitToplevel(cwd) ?? cwd
    const tree = nestedCommitTree(action.command, base)
    const inTree = (path: string): string => {
      const absolute = canonical(path)
      return tree && isWithin(canonical(base), absolute)
        ? join(tree, relative(canonical(base), absolute))
        : absolute
    }
    const treeRoot = tree ?? cwd
    const specsDir = inTree(options.specsDir)
    const testRoots = options.testRoots.map(inTree)
    const baselinePath = options.baselinePath && inTree(options.baselinePath)
    const exclusionsPath = options.exclusionsPath && inTree(options.exclusionsPath)
    const wipPath = options.wipPath && inTree(options.wipPath)
    // Hook processes are anchored to the project root. Scope only when that
    // relationship is known (or a test injects the lister); otherwise retain
    // the historical fail-safe full scan.
    if (options.listCommitFiles || isWithin(treeRoot, specsDir)) {
      try {
        const relevant = listCommitFiles(action.command, treeRoot).some((file) => {
          const absolute = resolve(treeRoot, file)
          return (
            pathsIntersect(absolute, specsDir) ||
            // A baseline outside specsDir changes what the gate exempts
            // (issue #107).
            (!!baselinePath && pathsIntersect(absolute, baselinePath)) ||
            (!!exclusionsPath && pathsIntersect(absolute, exclusionsPath)) ||
            (!!wipPath && pathsIntersect(absolute, wipPath)) ||
            matches(pattern, file) ||
            matches(pattern, absolute)
          )
        })
        if (!relevant) return { kind: 'pass' }
      } catch {
        // Git unavailable or unreadable: preserve full enforcement.
      }
    }
    if (!existsSync(specsDir)) return { kind: 'pass' }
    if (tagConflicts.length > 0) {
      return {
        kind: 'violation',
        reason:
          'Spec↔test parity is misconfigured: `ignoreTags` lists ' +
          tagConflicts.map((tag) => `"${tag}"`).join(', ') +
          ', which is a driver scope or a wip/planned marker. ' +
          'A tag is either a scope this project checks or one it ignores — pick one.',
      }
    }
    const exclusionFile = readExclusions(exclusionsPath)
    if (exclusionFile.malformed.length > 0) {
      return {
        kind: 'violation',
        reason:
          `Spec↔test parity: exclusion lines in ${exclusionsPath} must read ` +
          '`<spec>.feature :: <title> # <reason>` or `@id:<slug> # <reason>`, ' +
          'and every exclusion needs ' +
          'a reason naming who owns the scenario:\n' +
          formatList(exclusionFile.malformed),
      }
    }
    const wipFile = readExclusions(wipPath)
    if (wipFile.malformed.length > 0) {
      return {
        kind: 'violation',
        reason:
          `Spec↔test parity: wip lines in ${wipPath} must read ` +
          '`<spec>.feature :: <title> # <note>` or `@id:<slug> # <note>`, ' +
          'and every wip line needs a note saying what is happening or what blocks it:\n' +
          formatList(wipFile.malformed),
      }
    }
    // During the .feature.md -> .feature migration a spec is one extension
    // or the other; the same stem in both forms double-counts scenarios and
    // masks a half-finished rename.
    const specFiles = findSpecFiles(specsDir)
    const byStem = new Map<string, string>()
    for (const file of specFiles) {
      const stem = specStem(file)
      const existing = byStem.get(stem)
      if (existing) {
        return {
          kind: 'violation',
          reason:
            `Spec "${stem}" exists in both .feature and .feature.md forms:\n` +
            `    ${existing}\n    ${file}\n` +
            'Finish the migration for this spec — keep a single extension.',
        }
      }
      byStem.set(stem, file)
    }
    const scenarios = specFiles
      .flatMap((file) => extractScenarios(file, readFileSync(file, 'utf8')))
      .map((s) => ({ ...s, scopes: s.scopes.filter((tag) => !ignoredTags.has(tag)) }))
    const { byId, problems } = indexIds(scenarios)
    if (problems.length > 0) {
      return {
        kind: 'violation',
        reason:
          'Scenario ids must be unique across the specs directory, one per scenario:\n' +
          formatList(problems),
      }
    }
    const resolveRef = (key: string) => resolveKey(key, byId)
    const allRefs = scanCoversRefs(testRoots, pattern, options.inProgressPattern).map((ref) => ({
      ...ref,
      key: resolveRef(ref.key),
    }))
    // Issue #115: an in-progress (expected-to-fail) claim is not coverage.
    // Coverage, scopes and wip promotion count finished claims only;
    // dangling tags and exclusion/baseline contradictions count them all.
    const refs = allRefs.filter((ref) => !ref.inProgress)
    const baseline = new Set([...readBaseline(baselinePath)].map(resolveRef))
    const claimed = new Set(refs.map((ref) => ref.key))
    const anyClaim = new Set(allRefs.map((ref) => ref.key))
    const known = new Set(scenarios.map((scenario) => scenario.key))
    // Precedence: claimed > excluded > wip > baseline. A claimed or
    // baselined exclusion blocks below as stale rather than silently winning.
    const exclusions = exclusionFile.entries.map((entry) => ({ ...entry, key: resolveRef(entry.key) }))
    const excluded = new Set(exclusions.map((entry) => entry.key))
    const wipLines = wipFile.entries.map((entry) => ({ ...entry, key: resolveRef(entry.key) }))
    const projectWip = new Set(wipLines.map((entry) => entry.key))
    // Issue #111: with sharedWip 'ignore' the specs' own markers are
    // information only; either way, this project's wip lines count as wip.
    const promotedSpecWip: Scenario[] = []
    for (const s of scenarios) {
      const specWip = options.sharedWip !== 'ignore' && s.wip
      if (specWip && claimed.has(s.key)) promotedSpecWip.push(s)
      s.wip = specWip || projectWip.has(s.key)
    }
    const unclaimed = scenarios.filter(
      (s) => !s.wip && !claimed.has(s.key) && !baseline.has(s.key) && !excluded.has(s.key),
    )
    const orphaned = unclaimed.filter((s) => !anyClaim.has(s.key))
    const onlyInProgress = unclaimed.filter((s) => anyClaim.has(s.key))
    const dangling = allRefs.filter((ref) => !known.has(ref.key))
    const danglingExclusions = exclusions.filter((entry) => !known.has(entry.key))
    const claimedExclusions = exclusions.filter(
      (entry) => known.has(entry.key) && anyClaim.has(entry.key),
    )
    const baselinedExclusions = exclusions.filter(
      (entry) => known.has(entry.key) && baseline.has(entry.key),
    )
    const wipProblems: [string, Exclusion[]][] = [
      [
        'Wip lines matching no scenario (renamed or removed — update or delete them)',
        wipLines.filter((entry) => !known.has(entry.key)),
      ],
      [
        'Wip lines for scenarios a test now claims (promoted — delete the wip line)',
        wipLines.filter((entry) => known.has(entry.key) && claimed.has(entry.key)),
      ],
      [
        'Wip lines for excluded scenarios (a scenario is ours or not — keep one line)',
        wipLines.filter((entry) => excluded.has(entry.key)),
      ],
      [
        'Wip scenarios still in the baseline (the baseline is a snapshot from ' +
          'adoption that only shrinks — delete the baseline line)',
        wipLines.filter(
          (entry) => known.has(entry.key) && !excluded.has(entry.key) && baseline.has(entry.key),
        ),
      ],
    ]
    const staleWip = wipProblems.some(([, entries]) => entries.length > 0)
    const unknownScopes: string[] = []
    const missingScopes: string[] = []
    for (const scenario of scenarios) {
      if (scenario.wip || baseline.has(scenario.key) || excluded.has(scenario.key)) continue
      const required = [...new Set([...defaultScopes, ...scenario.scopes])]
      for (const name of required) {
        const scope = scopes.get(name)
        if (!scope) {
          unknownScopes.push(
            `${basename(scenario.specFile)} :: ${scenario.title} — [${name}]`,
          )
          continue
        }
        const covered = refs.some(
          (ref) => ref.key === scenario.key && scope.filePattern.test(ref.testFile),
        )
        if (!covered) {
          missingScopes.push(
            `${basename(scenario.specFile)} :: ${scenario.title} — needs [${name}] coverage`,
          )
        }
      }
    }
    if (
      orphaned.length === 0 &&
      onlyInProgress.length === 0 &&
      promotedSpecWip.length === 0 &&
      dangling.length === 0 &&
      unknownScopes.length === 0 &&
      missingScopes.length === 0 &&
      danglingExclusions.length === 0 &&
      claimedExclusions.length === 0 &&
      baselinedExclusions.length === 0 &&
      !staleWip
    )
      return { kind: 'pass' }
    const sections: string[] = ['Spec↔test parity check failed.']
    if (orphaned.length > 0) {
      sections.push(
        'Scenarios with no covering acceptance test (add a test with ' +
          '`// Covers: <spec>.feature.md :: Scenario: <title>`, or mark ' +
          'the heading `## Scenario (wip):` while driving it):\n' +
          formatList(orphaned.map((s) => `${basename(s.specFile)} :: ${s.title}`)),
      )
    }
    if (onlyInProgress.length > 0) {
      sections.push(
        'Scenarios claimed only by in-progress (expected-to-fail) tests — not ' +
          'covered yet. Mark the scenario wip while driving it, or finish it and ' +
          'remove the expected-to-fail marker:\n' +
          formatList(onlyInProgress.map((s) => `${basename(s.specFile)} :: ${s.title}`)),
      )
    }
    if (promotedSpecWip.length > 0) {
      sections.push(
        'Wip scenarios a finished test now claims (promoted — remove the ' +
          '`@wip`/`(wip)` marker, or keep the test expected-to-fail):\n' +
          formatList(promotedSpecWip.map((s) => `${basename(s.specFile)} :: ${s.title}`)),
      )
    }
    if (dangling.length > 0) {
      sections.push(
        'Covers tags pointing at no existing scenario (spec renamed or ' +
          'removed — update or delete these tests):\n' +
          formatList(dangling.map((r) => `${r.testFile} → ${refLabel(r)}`)),
      )
    }
    if (missingScopes.length > 0) {
      sections.push(
        'Scenarios covered, but not by every driver scope they require ' +
          '(add a covering test in the named suite — with shared ' +
          'scenario bodies this is a thin spec class calling the ' +
          'existing body):\n' +
          formatList(missingScopes),
      )
    }
    if (unknownScopes.length > 0) {
      sections.push(
        'Scenario tags naming driver scopes this gate does not know ' +
          `(known scopes: ${scopes.size > 0 ? [...scopes.keys()].join(', ') : 'none configured'} — ` +
          'fix the tag or add the scope to `driverScopes`):\n' +
          formatList(unknownScopes),
      )
    }
    const exclusionLines = (entries: Exclusion[]) => formatList(entries.map((e) => e.label))
    if (danglingExclusions.length > 0) {
      sections.push(
        'Exclusions matching no scenario (renamed or removed — update or delete them):\n' +
          exclusionLines(danglingExclusions),
      )
    }
    if (claimedExclusions.length > 0) {
      sections.push(
        'Excluded scenarios a test now claims (delete the exclusion):\n' +
          exclusionLines(claimedExclusions),
      )
    }
    if (baselinedExclusions.length > 0) {
      sections.push(
        'Excluded scenarios still in the baseline (delete the baseline line):\n' +
          exclusionLines(baselinedExclusions),
      )
    }
    for (const [heading, entries] of wipProblems) {
      if (entries.length > 0) sections.push(`${heading}:\n` + exclusionLines(entries))
    }
    return { kind: 'violation', reason: sections.join('\n') }
  }
}

/**
 * Matches a test-case declaration in the acceptance layer: a Kotlin/
 * Java `@Test` annotation or a Swift XCTest `func test…` method. The
 * pattern is intentionally coarse — it only needs to detect that a
 * write ADDS test cases, not parse them.
 */
const DEFAULT_TEST_DECLARATION = /@Test\b|\bfunc\s+test\w*\s*\(/g

/**
 * Matches a vitest/jest/mocha test-case declaration: `it(`/`test(`
 * and their `.only`/`.skip`/`.todo`/`.failing`/`.concurrent`
 * modifiers, plus `.each(...)( `. A negative lookbehind requires a
 * non-identifier character (or start of input) before `it`/`test`,
 * so identifiers merely ending in those letters — `split(`,
 * `submit(`, `logger.audit(`, `await wait(` — never match, and a
 * required `(` (directly, or after a modifier) excludes `describe()`
 * and unrelated identifiers like `items(...)`. Exported for use as
 * `requireSpecBackedAcceptanceTest`'s `testDeclarationPattern` in the
 * JS/TS preset (see `presets/js.ts`).
 */
export const JS_TEST_DECLARATION =
  /(?<![\w$])(?:it|test)(?:\.(?:only|skip|todo|failing|concurrent)\b)?(?:\.each\s*\([^)]*\))?\s*\(/g

function countTests(content: string, pattern: RegExp): number {
  return [...content.matchAll(pattern)].length
}

/**
 * Spec-first, made mechanical: a write that adds a new acceptance
 * test case is blocked unless it also adds a `Covers:` tag pointing
 * at a `## Scenario:` heading that ALREADY EXISTS in `specsDir`. The
 * executable specification (`*.feature.md`) must be written before
 * the test that claims it — an agent that codes the test first gets
 * told exactly what to create and where.
 *
 * This is the write-time front half of the traceability story;
 * {@link enforceSpecTestParity} is the commit-time back half (every
 * scenario covered, every tag resolving). Together they close the
 * gap where an agent authors a whole acceptance suite with no
 * feature file and nothing objects until commit — or ever, if the
 * tests carry no tags at all.
 *
 * Delta-based and deterministic (no AI call): only NEW test cases
 * demand a NEW resolving tag, so edits inside an existing brownfield
 * test file pass untouched, and a pre-existing dangling tag can't
 * block unrelated work (the commit gate owns that). `(wip)` and
 * `(planned)` scenarios count as existing — they are exactly the
 * headings outside-in work drives against.
 *
 * Applies to: write actions — scope it via a `{ files, rules }`
 * block to the acceptance test-case layer only (e.g.
 * `**\/acceptance/**\/*Spec.kt`), never to drivers/DSL/infrastructure.
 *
 * @param options.specsDir — absolute path to the specs directory.
 *   Missing directory ⇒ every new tag is unresolved ⇒ the deny
 *   message says to create the first feature file (greenfield
 *   enforcement, not a free pass).
 * @param options.testDeclarationPattern — what counts as a test-case
 *   declaration (default: Kotlin/Java `@Test` or Swift `func test…`).
 *   For a JS/TS project pass the exported {@link JS_TEST_DECLARATION}
 *   (vitest/jest/mocha `it(`/`test(` and their `.only`/`.skip`/
 *   `.each(...)( `/`.concurrent` variants) — the JS preset does this
 *   by default once its `specsDir` option is set (see `presets/js.ts`).
 */
export function requireSpecBackedAcceptanceTest(options: {
  specsDir: string
  testDeclarationPattern?: RegExp
}): Rule {
  const declaration = options.testDeclarationPattern ?? DEFAULT_TEST_DECLARATION
  return async function requireSpecBackedAcceptanceTest(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind !== 'write') return { kind: 'pass' }
    const before = await ctx?.readFile?.(action.path)
    const beforeContent = before?.kind === 'present' ? before.content : ''
    const testsAdded =
      countTests(action.content, declaration) > countTests(beforeContent, declaration)
    if (!testsAdded) return { kind: 'pass' }
    const beforeKeys = new Set(
      extractCoversRefs(action.path, beforeContent).map((ref) => ref.key),
    )
    const afterRefs = extractCoversRefs(action.path, action.content)
    const newRefs = afterRefs.filter((ref) => !beforeKeys.has(ref.key))
    const specs = scanSpecs(options.specsDir)
    // Duplicate ids are the commit gate's to report; here any match resolves.
    const ids = new Set(specs.flatMap((s) => s.ids))
    const titles = new Set(specs.map((s) => s.key))
    const known = { has: (key: string) => titles.has(key) || ids.has(key.match(ID_REF)?.[1] ?? '\0') }
    if (newRefs.length === 0) {
      // No NEW tag — still fine when the file already claims a real
      // scenario: "one scenario, many drivers" adds a second/third
      // test transcribing an already-covered scenario to a file whose
      // tag resolves. Only a file with no resolving tag at all is a
      // spec-first violation. (File-level granularity by design: the
      // commit-time parity gate owns the per-scenario bookkeeping.)
      if (afterRefs.some((ref) => known.has(ref.key))) return { kind: 'pass' }
      return {
        kind: 'violation',
        reason:
          'This write adds a new acceptance test case with no ' +
          '`Covers:` tag resolving to an existing scenario. ' +
          'Acceptance tests are written spec-first: ' +
          `add a \`## Scenario: <title>\` to a *.feature.md under ` +
          `${options.specsDir} describing the behavior in domain ` +
          'language, then re-apply this test with\n' +
          '  // Covers: <spec>.feature.md :: Scenario: <title>\n' +
          'If the scenario is still being shaped, write it as ' +
          '`## Scenario (wip):` — it still counts.',
      }
    }
    const unresolved = newRefs.filter((ref) => !known.has(ref.key))
    if (unresolved.length === 0) return { kind: 'pass' }
    return {
      kind: 'violation',
      reason:
        'This write adds acceptance test(s) whose `Covers:` tag points ' +
        'at a scenario that does not exist yet. The feature file comes ' +
        'first: create the scenario heading (exact title match, ' +
        `case-insensitive) under ${options.specsDir}, then re-apply ` +
        'this test.\n' +
        formatList(
          unresolved.map((ref) =>
            ref.id ? `@id:${ref.id} (no scenario carries this id)` : `${ref.specFile} :: Scenario: ${ref.title}`,
          ),
        ),
    }
  }
}

/**
 * Surfaces link breakage at the moment it is created: when a write
 * to a `*.feature.md` file removes or renames a `## Scenario:`
 * heading that acceptance tests still claim, the write is blocked
 * with the list of affected tests — update their `Covers:` tags (or
 * delete the tests) in the same change, then re-apply the spec edit.
 * Removing a scenario nothing covers passes silently.
 *
 * Applies to: write actions to `*.feature.md` files (scope via a
 * `{ files, rules }` block). Deterministic — no AI call.
 *
 * @param options.testRoots — absolute paths to scan for acceptance
 *   tests.
 * @param options.testFilePattern — which files count as acceptance
 *   tests (default: any file under an `acceptance/` directory).
 * @param options.specsDir — optional; lets a stable id move to another
 *   spec file. Rewording a title that tests claim by id (`Covers:
 *   @id:<slug>`) passes; dropping the id blocks, unless another spec
 *   file under `specsDir` now carries it.
 */
export function surfaceScenarioLinkBreakage(
  options: Omit<ScanOptions, 'specsDir'> & { specsDir?: string },
): Rule {
  const pattern = options.testFilePattern ?? DEFAULT_TEST_FILE_PATTERN
  return async function surfaceScenarioLinkBreakage(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind !== 'write') return { kind: 'pass' }
    if (!action.path.endsWith('.feature.md') && !action.path.endsWith('.feature'))
      return { kind: 'pass' }
    const before = await ctx?.readFile?.(action.path)
    if (!before || before.kind !== 'present') return { kind: 'pass' }
    const beforeScenarios = extractScenarios(action.path, before.content)
    const afterScenarios = extractScenarios(action.path, action.content)
    const afterKeys = new Set(afterScenarios.map((s) => s.key))
    const afterIds = new Set(afterScenarios.flatMap((s) => s.ids))
    const keyGone = (s: Scenario) => !afterKeys.has(s.key)
    const idGone = (s: Scenario) => !!s.id && !afterIds.has(s.id)
    const removed = beforeScenarios.filter((s) => keyGone(s) || idGone(s))
    if (removed.length === 0) return { kind: 'pass' }
    // An id moved to another spec file is not gone.
    const elsewhere = new Set(
      options.specsDir && removed.some(idGone)
        ? findSpecFiles(options.specsDir)
            .filter((file) => resolve(file) !== resolve(action.path))
            .flatMap((file) => extractScenarios(file, readFileSync(file, 'utf8')).flatMap((s) => s.ids))
        : [],
    )
    const refs = scanCoversRefs(options.testRoots, pattern)
    const broken = removed.flatMap((scenario) => {
      const lostId = idGone(scenario) && !elsewhere.has(scenario.id!)
      const claimants = [
        ...new Set(
          refs
            .filter((ref) =>
              ref.id ? lostId && ref.id === scenario.id : keyGone(scenario) && ref.key === scenario.key,
            )
            .map((ref) => ref.testFile),
        ),
      ]
      return claimants.length > 0
        ? [`"${scenario.title}" is still covered by:\n` + formatList(claimants)]
        : []
    })
    if (broken.length === 0) return { kind: 'pass' }
    return {
      kind: 'violation',
      reason:
        'This edit removes or renames scenario(s), or drops an id, that ' +
        'acceptance tests still claim. Update those tests’ Covers: tags ' +
        '(or delete the tests) in the same change, then re-apply this ' +
        'spec edit. Claiming by id (`// Covers: @id:<slug>`) lets a ' +
        'title change without touching tests.\n' +
        broken.join('\n'),
    }
  }
}
