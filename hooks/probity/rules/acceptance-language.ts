import type { Action, Rule, RuleContext, RuleResult } from '@nizos/probity'

type FileContent = Awaited<ReturnType<NonNullable<RuleContext['readFile']>>>

const DEFAULT_MAX_GLOSSARY_CHARS = 8000

const RESPONSE_SPEC = `## Response format

Respond with a single JSON object of exactly this shape:
{"kind":"pass"|"violation","reason":"<short explanation>"}
On "pass", leave reason an empty string (""); only a "violation" needs an explanation.
Return JSON only. No prose, no code fences.`

const PROCESS_INSTRUCTIONS = `## Role

You are an acceptance-specification validator. Judge whether the
pending write keeps executable specifications in the language of the
problem domain, per the rules below.

## Inputs

You will see up to four inputs:

1. "Ubiquitous language glossary" (optional) — the project's agreed
   domain vocabulary.
2. "Current file content" — what's on disk right now at the file the
   agent is about to write. May be a parenthesized marker (e.g.
   \`(file does not exist)\`).
3. "Pending action" — the file path and what the agent is about to
   write. Content may be raw file text or a patch/diff.

## What you judge

Judge only the specification content this write adds or changes, not
pre-existing text it leaves untouched. This rule is scoped to
specification files (layer 1 of the four-layer model). If the file is
clearly NOT a test-case layer — it is a DSL implementation, a protocol
driver, a step-definition file that only parses and delegates, or
plain production code — pass: those layers are supposed to know about
UI mechanics and protocols.

A transient file state (unresolved import, half-finished scenario) is
never itself a violation.

A block recorded earlier in the session is a past verdict, not a rule.
Re-derive your judgment from the rules below. When the user tells you
in the session to let this change through, treat it as authoritative
and pass.`

const DEFAULT_LANGUAGE_RULES = `## Specification language rules

An acceptance test is an executable specification: a concrete example,
in the language of the problem domain, that demonstrates a user's need
is met. It states WHAT the system does for an external user and says
nothing about HOW the system works.

### The Language Test

The least technical person who understands the problem domain must be
able to read the specification and confirm it says what they want.
Block spec content that mentions implementation mechanics:

  - UI mechanics: clicking, typing into fields, pages, screens,
    buttons, menus, CSS selectors, element IDs, XPath
  - Protocol mechanics: URLs, endpoints, HTTP verbs, status codes,
    JSON/XML payloads, headers, cookies
  - Persistence mechanics: tables, rows, columns, SQL, cache keys
  - Named internal services, queues, or modules

The fix is always the same: state the outcome in domain terms and push
the mechanics down into the DSL or a protocol driver.

### Structure

  - Each specification asserts a single outcome. Block scenarios with
    long When/Then chains asserting many unrelated outcomes.
  - Express specifications as outcomes ("should ...", "is granted
    access"), not procedures.
  - No sleeps or fixed waits in specs — a delay is a race condition
    with a timer on it; drivers poll for the concluding event.
  - Test-case code talks only to the DSL. Block spec-layer code that
    reaches the system directly (HTTP clients, page objects, database
    handles imported into the spec file).

### Vocabulary

When a glossary is provided, use its terms verbatim — one term per
concept. Block spec content that names a domain concept with a term
that conflicts with the glossary (a synonym or a redefinition). A
concept the glossary simply doesn't cover yet is NOT a violation on
its own; mention it in the reason only alongside a real violation.

### Judgment bar

Block on clear mechanics leaking into a specification. Domain terms
that happen to sound technical (the domain of a deployment tool
includes "server"; a payments domain includes "card") are not
violations — judge against the problem domain, not a banned-word list.
When genuinely ambiguous, pass.`

function formatBefore(before: FileContent): string {
  switch (before.kind) {
    case 'present':
      return before.content
    case 'absent':
      return '(file does not exist)'
    case 'unknown':
      return '(current file content unavailable)'
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n(...glossary truncated...)`
}

function buildPrompt(
  rules: string,
  glossary: string | undefined,
  before: FileContent,
  action: { path: string; content: string },
): string {
  const sections = [PROCESS_INSTRUCTIONS, rules]
  if (glossary) {
    sections.push(`## Ubiquitous language glossary\n\n${glossary}`)
  }
  sections.push(`## Current file content\n\n${formatBefore(before)}`)
  sections.push(
    `## Pending action\n\nFile: ${action.path}\n\n${action.content}`,
  )
  sections.push(RESPONSE_SPEC)
  return sections.join('\n\n')
}

/**
 * AI-validated enforcement of the `acceptance-testing` skill's
 * Language Test: executable specifications stay in domain language —
 * no UI mechanics, protocols, or persistence details — assert a
 * single outcome, and (when a glossary is supplied) use the
 * ubiquitous language verbatim.
 *
 * Applies to: write actions. Scope it with a `{ files, rules }` block
 * to the spec layer only (e.g. `specs/**`, `**\/*.feature`) — the DSL
 * and protocol-driver layers are supposed to contain the mechanics
 * this rule blocks, and every matching write costs an AI call.
 *
 * @param options.glossaryPath — absolute path to the project's
 *   ubiquitous-language glossary (see the `ubiquitous-language`
 *   skill). Resolve it in the config file, e.g.
 *   `fileURLToPath(new URL('./docs/GLOSSARY.md', import.meta.url))`.
 *   When set and readable, the glossary is included in the
 *   validator's prompt and vocabulary conflicts become violations.
 * @param options.instructions — overrides or extends the default
 *   language rules text. Pass a string to replace it, or a function
 *   `(defaults) => ...` to extend it.
 * @param options.maxGlossaryChars — truncate the glossary beyond this
 *   length when building the prompt (default 8000).
 *
 * @example
 * { files: ['specs/**', 'acceptance/**', '**\/*.feature'], rules: [enforceAcceptanceLanguage()] }
 */
export function enforceAcceptanceLanguage(
  options: {
    glossaryPath?: string
    instructions?: string | ((defaults: string) => string)
    maxGlossaryChars?: number
  } = {},
): Rule {
  const rules =
    typeof options.instructions === 'function'
      ? options.instructions(DEFAULT_LANGUAGE_RULES)
      : (options.instructions ?? DEFAULT_LANGUAGE_RULES)
  const maxGlossaryChars =
    options.maxGlossaryChars ?? DEFAULT_MAX_GLOSSARY_CHARS
  return async function enforceAcceptanceLanguage(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind !== 'write') return { kind: 'pass' }
    if (!ctx?.agent) {
      return {
        kind: 'violation',
        reason:
          'enforceAcceptanceLanguage: no AI agent available; configure Config.ai or use a vendor that ships one.',
      }
    }
    let glossary: string | undefined
    if (options.glossaryPath && ctx.readFile) {
      const file = await ctx.readFile(options.glossaryPath)
      if (file.kind === 'present') {
        glossary = truncate(file.content, maxGlossaryChars)
      }
    }
    const before: FileContent = (await ctx.readFile?.(action.path)) ?? {
      kind: 'unknown',
    }
    const verdict = await ctx.agent.reason(
      buildPrompt(rules, glossary, before, action),
    )
    if (verdict.kind === 'violation') {
      return { kind: 'violation', reason: verdict.reason }
    }
    return { kind: 'pass', reason: verdict.reason }
  }
}
