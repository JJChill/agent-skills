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
 */

const SCENARIO_HEADING = /^##\s*Scenario(\s*\((?:wip|planned)\))?\s*:\s*(.+?)\s*$/gm
const COVERS_TAG = /Covers:\s*([\w.-]+\.feature\.md)\s*::\s*Scenario:\s*([^\n]+)/g
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

function scenarioKey(specFile: string, title: string): string {
  return `${basename(specFile)} :: ${normalizeTitle(title)}`
}

type Scenario = { key: string; specFile: string; title: string; wip: boolean }
type CoversRef = { key: string; testFile: string; specFile: string; title: string }

export function extractScenarios(specFile: string, content: string): Scenario[] {
  const scenarios: Scenario[] = []
  for (const match of content.matchAll(SCENARIO_HEADING)) {
    const title = match[2] ?? ''
    scenarios.push({
      key: scenarioKey(specFile, title),
      specFile,
      title: title.trim(),
      wip: match[1] !== undefined,
    })
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

type ScanOptions = {
  specsDir: string
  testRoots: string[]
  testFilePattern?: RegExp
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

export function scanSpecs(specsDir: string): Scenario[] {
  return walk(specsDir)
    .filter((file) => file.endsWith('.feature.md'))
    .flatMap((file) => extractScenarios(file, readFileSync(file, 'utf8')))
}

export function scanCoversRefs(
  testRoots: string[],
  testFilePattern: RegExp,
): CoversRef[] {
  return testRoots
    .flatMap((root) => walk(root))
    .filter((file) => testFilePattern.test(file) && !file.endsWith('.feature.md'))
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
 */
export function enforceSpecTestParity(options: ScanOptions): Rule {
  const pattern = options.testFilePattern ?? DEFAULT_TEST_FILE_PATTERN
  return function enforceSpecTestParity(action: Action): RuleResult {
    if (action.kind !== 'command') return { kind: 'pass' }
    if (!/git commit/.test(action.command)) return { kind: 'pass' }
    if (!existsSync(options.specsDir)) return { kind: 'pass' }
    const scenarios = scanSpecs(options.specsDir)
    const refs = scanCoversRefs(options.testRoots, pattern)
    const baseline = readBaseline(options.baselinePath)
    const claimed = new Set(refs.map((ref) => ref.key))
    const known = new Set(scenarios.map((scenario) => scenario.key))
    const orphaned = scenarios.filter(
      (s) => !s.wip && !claimed.has(s.key) && !baseline.has(s.key),
    )
    const dangling = refs.filter((ref) => !known.has(ref.key))
    if (orphaned.length === 0 && dangling.length === 0) return { kind: 'pass' }
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
    const newRefs = extractCoversRefs(action.path, action.content).filter(
      (ref) => !beforeKeys.has(ref.key),
    )
    if (newRefs.length === 0) {
      return {
        kind: 'violation',
        reason:
          'This write adds a new acceptance test case with no new ' +
          '`Covers:` tag. Acceptance tests are written spec-first: ' +
          `add a \`## Scenario: <title>\` to a *.feature.md under ` +
          `${options.specsDir} describing the behavior in domain ` +
          'language, then re-apply this test with\n' +
          '  // Covers: <spec>.feature.md :: Scenario: <title>\n' +
          'If the scenario is still being shaped, write it as ' +
          '`## Scenario (wip):` — it still counts.',
      }
    }
    const known = new Set(scanSpecs(options.specsDir).map((s) => s.key))
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
    if (!action.path.endsWith('.feature.md')) return { kind: 'pass' }
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
      const claimants = refs.filter((ref) => ref.key === scenario.key)
      return claimants.length > 0
        ? [
            `"${scenario.title}" is still covered by:\n` +
              formatList(claimants.map((ref) => ref.testFile)),
          ]
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
