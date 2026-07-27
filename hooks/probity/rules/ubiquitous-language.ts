import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { Action, Rule, RuleContext, RuleResult } from '@nizos/probity'

/**
 * Glossary drift protection for the `ubiquitous-language` skill.
 *
 * Glossary format convention (see GLOSSARY.template.md): a Markdown
 * file where each term is a level-2 heading:
 *
 *   ## Parcel
 *   A shipment registered for delivery to a recipient.
 *
 * One term per concept; the definition text is free-form. Terms are
 * matched case-insensitively.
 */

const TERM_HEADING = /^##\s+(.+?)\s*$/gm

export function extractGlossaryTerms(content: string): string[] {
  return [...content.matchAll(TERM_HEADING)].map((m) => (m[1] ?? '').trim())
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A term is "used" when it appears as a phrase in prose (case-
 * insensitive, whitespace-tolerant) or as an identifier in code —
 * PascalCase, camelCase, or snake_case concatenations of its words
 * ("Delivery Window" → DeliveryWindow, deliveryWindow,
 * delivery_window).
 */
export function termUsagePattern(term: string): RegExp {
  const words = term.trim().split(/\s+/).map(escapeRegex)
  const phrase = words.join('\\s+')
  if (words.length === 1) return new RegExp(`\\b${phrase}\\b`, 'i')
  const capitalized = term
    .trim()
    .split(/\s+/)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
  const pascal = escapeRegex(capitalized.join(''))
  const camel = escapeRegex(
    capitalized[0]!.toLowerCase() + capitalized.slice(1).join(''),
  )
  const snake = words.map((w) => w.toLowerCase()).join('_')
  return new RegExp(`\\b(?:${phrase}|${pascal}|${camel}|${snake})\\b`, 'i')
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'build',
  '.gradle',
  'out',
  'dist',
  '.idea',
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

const DEFAULT_SEARCH_PATTERN = /\.(kt|kts|swift|ts|js|py|java|feature|md)$/

/**
 * Surfaces glossary drift at the moment it is created: when a write
 * to the glossary removes or renames a term that specs, tests, or
 * source code still use, the write is blocked with the list of files
 * using the term — rename the usages in the same change (or record
 * the old term's fate in the glossary entry) and re-apply. Removing
 * a term nothing uses passes silently, as do additions and
 * definition edits.
 *
 * The companion invariant — new spec/port vocabulary conforming to
 * the glossary — is judged by `enforceAcceptanceLanguage` and
 * `enforcePortsBoundary` when given `glossaryPath`.
 *
 * Applies to: write actions to the glossary file (scope via a
 * `{ files, rules }` block on its path). Deterministic — no AI call.
 *
 * @param options.searchRoots — absolute paths to scan for usages
 *   (repo root is fine; node_modules/build dirs are skipped).
 * @param options.searchPattern — which files count as usage sites
 *   (default: common source, spec, and doc extensions).
 */
export function surfaceGlossaryTermBreakage(options: {
  searchRoots: string[]
  searchPattern?: RegExp
}): Rule {
  const pattern = options.searchPattern ?? DEFAULT_SEARCH_PATTERN
  return async function surfaceGlossaryTermBreakage(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind !== 'write') return { kind: 'pass' }
    const before = await ctx?.readFile?.(action.path)
    if (!before || before.kind !== 'present') return { kind: 'pass' }
    const beforeTerms = extractGlossaryTerms(before.content)
    const afterTerms = new Set(
      extractGlossaryTerms(action.content).map((t) => t.toLowerCase()),
    )
    const removed = beforeTerms.filter((t) => !afterTerms.has(t.toLowerCase()))
    if (removed.length === 0) return { kind: 'pass' }
    const glossaryPath = resolve(action.path)
    const files = options.searchRoots
      .flatMap((root) => walk(root))
      .filter((file) => pattern.test(file) && resolve(file) !== glossaryPath)
    const broken: string[] = []
    for (const term of removed) {
      const usage = termUsagePattern(term)
      const users = files.filter((file) => {
        try {
          return usage.test(readFileSync(file, 'utf8'))
        } catch {
          return false
        }
      })
      if (users.length > 0) {
        const shown = users.slice(0, 10).map((f) => `    ${f}`)
        if (users.length > 10) shown.push(`    …and ${users.length - 10} more`)
        broken.push(`"${term}" is still used by:\n${shown.join('\n')}`)
      }
    }
    if (broken.length === 0) return { kind: 'pass' }
    return {
      kind: 'violation',
      reason:
        'This edit removes or renames glossary term(s) that specs, ' +
        'tests, or code still use. The glossary is the source of ' +
        'truth: update the usages in the same change, then re-apply ' +
        'this edit.\n' +
        broken.join('\n'),
    }
  }
}
