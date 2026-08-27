import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { Action, Rule, RuleContext, RuleResult } from '@nizos/probity'

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
 */

// Two spec formats during the .feature.md -> .feature migration:
//   Markdown:  ## Scenario (wip) [system]: Title
//   Gherkin:   @wip @system\n  Scenario: Title
// parseScenarios below handles both, line by line.
const MD_SCENARIO =
  /^##\s*Scenario(\s*\((?:wip|planned)\))?(\s*\[([^\]]+)\])?\s*:\s*(.+?)\s*$/
const GHERKIN_SCENARIO = /^Scenario(?:\s+Outline)?:\s*(.+?)\s*$/
const COVERS_TAG = /Covers:\s*([\w.-]+\.feature(?:\.md)?)\s*::\s*Scenario:\s*([^\n]+)/g
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
}
type CoversRef = { key: string; testFile: string; specFile: string; title: string }

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
      scenarios.push({
        key: scenarioKey(specFile, title),
        specFile,
        title: title.trim(),
        wip: md[1] !== undefined,
        scopes: parseScopes(md[3]),
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
      scenarios.push({
        key: scenarioKey(specFile, title),
        specFile,
        title: title.trim(),
        wip: tags.includes('wip') || tags.includes('planned'),
        scopes: tags.filter((tag) => tag !== 'wip' && tag !== 'planned'),
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

export function extractCoversRefs(testFile: string, content: string): CoversRef[] {
  const refs: CoversRef[] = []
  for (const match of content.matchAll(COVERS_TAG)) {
    const specFile = match[1] ?? ''
    const title = match[2] ?? ''
    refs.push({
      key: scenarioKey(specFile, title),
      testFile,
      specFile,
      title: title.replace(/\s*(?:\*\/|["')\]]+)?\s*$/, '').trim(),
    })
  }
  return refs
}

function walk(dir: string, out: string[] = []): string[] {
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
        const idx = line.indexOf(' :: ')
        if (idx === -1) return []
        const spec = line.slice(0, idx).trim()
        const title = line.slice(idx + 4)
        return [scenarioKey(spec, title)]
      }),
  )
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
): CoversRef[] {
  return testRoots
    .flatMap((root) => walk(root))
    .filter(
      (file) =>
        testFilePattern.test(file) &&
        !file.endsWith('.feature.md') &&
        !file.endsWith('.feature'),
    )
    .flatMap((file) => extractCoversRefs(file, readFileSync(file, 'utf8')))
}

function formatList(lines: string[], max = 10): string {
  const shown = lines.slice(0, max).map((line) => `    ${line}`)
  if (lines.length > max) shown.push(`    …and ${lines.length - max} more`)
  return shown.join('\n')
}

/**
 * Bidirectional parity gate on `git commit`: blocks when any
 * non-wip `## Scenario:` heading in `specsDir` has no acceptance
 * test claiming it via a `Covers:` tag, or when any `Covers:` tag
 * points at a scenario that no longer exists (spec renamed or
 * removed). Deterministic filesystem scan — no AI call; milliseconds
 * at typical spec-suite scale.
 *
 * The test claiming a scenario may still be red or quarantined —
 * parity requires the *link*, not a passing run; keeping in-progress
 * specs out of the pipeline is the pipeline's job. Alternatively
 * mark the scenario `## Scenario (wip):` to exempt it entirely.
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
 * @param options.driverScopes — optional per-scenario driver mapping;
 *   see {@link DriverScope}. Scenarios tagged `[scope]` (and every
 *   scenario, for `defaultScopes` entries) must be covered by a test
 *   matching that scope's `filePattern`, on top of the base check.
 * @param options.defaultScopes — scope names required of untagged
 *   scenarios too (the project's standard driver set).
 */
export function enforceSpecTestParity(options: ScanOptions): Rule {
  const pattern = options.testFilePattern ?? DEFAULT_TEST_FILE_PATTERN
  const scopes = new Map(
    (options.driverScopes ?? []).map((scope) => [scope.name.toLowerCase(), scope]),
  )
  const defaultScopes = (options.defaultScopes ?? []).map((name) => name.toLowerCase())
  return function enforceSpecTestParity(action: Action): RuleResult {
    if (action.kind !== 'command') return { kind: 'pass' }
    if (!/git commit/.test(action.command)) return { kind: 'pass' }
    if (!existsSync(options.specsDir)) return { kind: 'pass' }
    // During the .feature.md -> .feature migration a spec is one extension
    // or the other; the same stem in both forms double-counts scenarios and
    // masks a half-finished rename.
    const specFiles = findSpecFiles(options.specsDir)
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
    const scenarios = specFiles.flatMap((file) =>
      extractScenarios(file, readFileSync(file, 'utf8')),
    )
    const refs = scanCoversRefs(options.testRoots, pattern)
    const baseline = readBaseline(options.baselinePath)
    const claimed = new Set(refs.map((ref) => ref.key))
    const known = new Set(scenarios.map((scenario) => scenario.key))
    const orphaned = scenarios.filter(
      (s) => !s.wip && !claimed.has(s.key) && !baseline.has(s.key),
    )
    const dangling = refs.filter((ref) => !known.has(ref.key))
    const unknownScopes: string[] = []
    const missingScopes: string[] = []
    for (const scenario of scenarios) {
      if (scenario.wip || baseline.has(scenario.key)) continue
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
      dangling.length === 0 &&
      unknownScopes.length === 0 &&
      missingScopes.length === 0
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
    if (dangling.length > 0) {
      sections.push(
        'Covers tags pointing at no existing scenario (spec renamed or ' +
          'removed — update or delete these tests):\n' +
          formatList(dangling.map((r) => `${r.testFile} → ${r.specFile} :: ${r.title}`)),
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
    const known = new Set(scanSpecs(options.specsDir).map((s) => s.key))
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
        formatList(unresolved.map((ref) => `${ref.specFile} :: Scenario: ${ref.title}`)),
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
 */
export function surfaceScenarioLinkBreakage(
  options: Omit<ScanOptions, 'specsDir'>,
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
    const beforeKeys = new Map(
      extractScenarios(action.path, before.content).map((s) => [s.key, s]),
    )
    const afterKeys = new Set(
      extractScenarios(action.path, action.content).map((s) => s.key),
    )
    const removed = [...beforeKeys.values()].filter((s) => !afterKeys.has(s.key))
    if (removed.length === 0) return { kind: 'pass' }
    const refs = scanCoversRefs(options.testRoots, pattern)
    const broken = removed.flatMap((scenario) => {
      const claimants = [
        ...new Set(
          refs.filter((ref) => ref.key === scenario.key).map((ref) => ref.testFile),
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
        'This edit removes or renames scenario(s) that acceptance ' +
        'tests still claim. Update those tests’ Covers: tags (or ' +
        'delete the tests) in the same change, then re-apply this ' +
        'spec edit.\n' +
        broken.join('\n'),
    }
  }
}
