import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Action, Rule, RuleContext, RuleResult } from '@nizos/probity'

/**
 * Language-neutral gate rules. These accumulated in the Kotlin preset
 * (`kotlin.ts`) because that's where the real-project trials happened,
 * but nothing in them is Kotlin-specific — they take every
 * language-shaped decision (what a test command looks like, what an
 * ambient-effect call looks like) as a pattern option. This module is
 * their canonical home; `kotlin.ts` re-exports wrappers that apply the
 * Kotlin/Gradle defaults, so existing preset configs are unchanged.
 *
 * All rules here are deterministic — no AI call — and delta-based
 * where they judge file content: only what a write INTRODUCES blocks,
 * so brownfield files migrate incrementally instead of freezing.
 */

/** A labeled content pattern; the label names the hit in deny text. */
export type NamedPattern = { label: string; pattern: RegExp }

function countMatches(content: string, pattern: RegExp): number {
  let count = 0
  for (const _ of content.matchAll(pattern)) count++
  return count
}

/** Patterns whose occurrence count grows from before → after. */
export async function introducedPatterns(
  action: { path: string; content: string },
  ctx: RuleContext | undefined,
  patterns: NamedPattern[],
): Promise<string[]> {
  const hits = patterns.filter(
    ({ pattern }) => countMatches(action.content, pattern) > 0,
  )
  if (hits.length === 0) return []
  const before = await ctx?.readFile?.(action.path)
  const beforeContent = before?.kind === 'present' ? before.content : ''
  return hits
    .filter(
      ({ pattern }) =>
        countMatches(action.content, pattern) >
        countMatches(beforeContent, pattern),
    )
    .map(({ label }) => label)
}

/**
 * Ambient-effect calls for a JS/TS core: OS clock, randomness, and
 * environment reads. Pass to {@link forbidNewAmbientEffects} from a
 * JS/TS config. `process.env` reads belong in the composition root or
 * a config adapter; if your core legitimately branches on injected
 * config, that config should arrive through a port, not the OS.
 */
export const JS_AMBIENT_EFFECT_PATTERNS: NamedPattern[] = [
  { label: 'Date.now()', pattern: /\bDate\.now\s*\(/g },
  { label: 'new Date() (argless)', pattern: /\bnew\s+Date\s*\(\s*\)/g },
  { label: 'Math.random()', pattern: /\bMath\.random\s*\(/g },
  { label: 'crypto.randomUUID()', pattern: /\bcrypto\.randomUUID\s*\(/g },
  { label: 'randomUUID()', pattern: /\brandomUUID\s*\(/g },
  { label: 'process.env', pattern: /\bprocess\.env\b/g },
]

/**
 * Blocks production writes that introduce direct ambient-effect calls.
 * Under ports-and-adapters these are unowned OS dependencies: clock,
 * randomness, and environment are ports.
 *
 * Delta-based: pre-existing call sites in a brownfield codebase don't
 * block edits to their files; only net-new occurrences do. Scope to
 * production sources — tests and adapter implementations (e.g. a
 * `SystemClock`) legitimately touch the real OS, so exclude adapter
 * paths via globs or negations.
 *
 * @param options.patterns — what an ambient-effect call looks like in
 *   your language ({@link JS_AMBIENT_EFFECT_PATTERNS} for JS/TS; the
 *   Kotlin preset supplies JVM patterns). Each RegExp needs `g`.
 * @param options.seamHint — appended to the block message to point
 *   the agent at the project's canonical seam(s), e.g.
 *   "inject the Clock port from src/ports/clock.ts".
 */
export function forbidNewAmbientEffects(options: {
  patterns: NamedPattern[]
  seamHint?: string
}): Rule {
  return async function forbidNewAmbientEffects(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind !== 'write') return { kind: 'pass' }
    const introduced = await introducedPatterns(action, ctx, options.patterns)
    if (introduced.length === 0) return { kind: 'pass' }
    const hint = options.seamHint ? ` ${options.seamHint}.` : ''
    return {
      kind: 'violation',
      reason:
        `This write introduces direct ambient-effect calls (${introduced.join(
          ', ',
        )}). Clock, randomness, and environment are unowned OS ` +
        'dependencies: reach them through a port injected into this ' +
        `code, implemented by a thin adapter.${hint} Existing call ` +
        'sites in the file are untouched by this rule — only new ones ' +
        'are blocked.',
    }
  }
}

/**
 * Commit-on-green, strictly: Probity's `requireCommand` checks only
 * that a matching test invocation was *recorded* after the last write
 * and would happily pass a transcript whose latest run FAILED. This
 * rule additionally judges the recorded run's output: the last
 * matching test command after the last write must look green
 * (`successPattern` present, `failurePattern` absent).
 *
 * Inherent limit (unchanged from requireCommand): the gate sees only
 * the session transcript. A green run in another terminal, CI, or a
 * wrapper script is invisible — rerun the suite in-session, and keep
 * the CI mirror for human commits.
 *
 * Applies to: command actions matching `git commit`. Deterministic —
 * no AI call.
 *
 * @param options.command — regex matching a test invocation.
 * @param options.successPattern — output must match to count as green.
 * @param options.failurePattern — output matching this is red even if
 *   the success pattern also appears.
 */
export function requireGreenTestRun(options: {
  command: RegExp
  successPattern: RegExp
  failurePattern: RegExp
}): Rule {
  return async function requireGreenTestRun(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind !== 'command') return { kind: 'pass' }
    if (!/git commit/.test(action.command)) return { kind: 'pass' }
    const history = (await ctx?.history?.()) ?? []
    const lastWrite = history.reduce(
      (last, event, index) => (event.kind === 'write' ? index : last),
      -1,
    )
    const runs = history.filter(
      (event, index) =>
        index > lastWrite &&
        event.kind === 'command' &&
        options.command.test(event.command),
    )
    if (runs.length === 0) {
      return {
        kind: 'violation',
        reason:
          'Run the test suite after the last change before committing ' +
          '(see test-driven-development: commit only on green).',
      }
    }
    const lastRun = runs[runs.length - 1]!
    const output = 'output' in lastRun ? (lastRun.output ?? '') : ''
    if (options.failurePattern.test(output) || !options.successPattern.test(output)) {
      return {
        kind: 'violation',
        reason:
          'The last recorded test run after your changes was not ' +
          'green — a recorded invocation is not a passing suite. Fix ' +
          'the failures (or the build) and rerun before committing.',
      }
    }
    return { kind: 'pass' }
  }
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
])

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

const DEFAULT_STRING_LITERAL =
  /(['"])((?:(?!\1)[^\\\n]|\\.){4,})\1|`((?:(?!`)(?!\$\{)[^\\]|\\.){4,})`/g

function extractStringLiterals(content: string, minLength: number): Set<string> {
  const out = new Set<string>()
  for (const match of content.matchAll(DEFAULT_STRING_LITERAL)) {
    const value = match[2] ?? match[3] ?? ''
    if (value.trim().length >= minLength) out.add(value)
  }
  return out
}

/**
 * Surfaces the "renamed a button, broke the E2E suite" failure at
 * write time: when a write REMOVES a string literal that still appears
 * verbatim in files under `searchRoots` (typically your E2E/UI-test
 * specs, which select elements by visible text or accessible name),
 * the write is blocked with the list of dependent files.
 *
 * The inverse of a glossary guard: `surfaceGlossaryTermBreakage`
 * protects the vocabulary file from code that depends on it; this
 * protects test selectors from the UI code they depend on. Scope it to
 * your UI sources, with `searchRoots` pointing at the spec layers the
 * quick local loop does NOT run (E2E, smoke) — specs the inner loop
 * runs will fail red on their own.
 *
 * Deterministic, delta-based — no AI call. The write goes through once
 * the dependent specs are updated in the same session (or the string
 * genuinely stops being referenced).
 *
 * @param options.searchRoots — absolute paths to scan for usages.
 * @param options.searchPattern — which files count as usage sites
 *   (default: `*.spec.*` / `*.test.*` under the roots).
 * @param options.minLength — ignore removed literals shorter than
 *   this after trimming (default 8; short strings false-positive).
 */
export function surfaceRemovedStringUsage(options: {
  searchRoots: string[]
  searchPattern?: RegExp
  minLength?: number
}): Rule {
  const pattern = options.searchPattern ?? /\.(spec|test)\.[jt]sx?$/
  const minLength = options.minLength ?? 8
  return async function surfaceRemovedStringUsage(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind !== 'write') return { kind: 'pass' }
    const before = await ctx?.readFile?.(action.path)
    if (!before || before.kind !== 'present') return { kind: 'pass' }
    const beforeStrings = extractStringLiterals(before.content, minLength)
    if (beforeStrings.size === 0) return { kind: 'pass' }
    const afterContent = action.content
    const removed = [...beforeStrings].filter(
      (s) => !afterContent.includes(s),
    )
    if (removed.length === 0) return { kind: 'pass' }
    const files = options.searchRoots
      .flatMap((root) => walk(root))
      .filter((file) => pattern.test(file))
    const broken: string[] = []
    for (const text of removed) {
      // Case-insensitive: specs routinely select via /log out/i-style
      // regexes whose source is lowercased relative to the UI text.
      const needle = text.toLowerCase()
      const users = files.filter((file) => {
        try {
          return readFileSync(file, 'utf8').toLowerCase().includes(needle)
        } catch {
          return false
        }
      })
      if (users.length > 0) {
        broken.push(`"${text}" → ${users.join(', ')}`)
      }
    }
    if (broken.length === 0) return { kind: 'pass' }
    return {
      kind: 'violation',
      reason:
        'This write removes UI text that test specs still select by:\n' +
        broken.map((line) => `  - ${line}`).join('\n') +
        '\nThose suites are not in the quick local loop, so this ' +
        'breaks them silently until CI. Update the listed specs to the ' +
        'new text (and run their suite) alongside this change.',
    }
  }
}
