import type { Action, Rule, RuleContext, RuleResult } from '@nizos/probity'

type FileContent = Awaited<ReturnType<NonNullable<RuleContext['readFile']>>>

// reason comes FIRST in the shape: an autoregressive model commits to
// each field in order, so kind-first forces the verdict before the
// analysis — observed live producing a "violation" whose reason
// reasoned its way to "Passing." Reason-first lets the model conclude,
// then label.
const RESPONSE_SPEC = `## Response format

Respond with a single JSON object of exactly this shape:
{"reason":"<your analysis>","kind":"pass"|"violation"}
Write reason FIRST and set kind to the conclusion your reason reached —
the two must agree. Keep reason brief on a clear pass ("" is fine).
Return JSON only. No prose, no code fences.`

const PROCESS_INSTRUCTIONS = `## Role

You are an architecture-boundary validator. Judge whether the pending
write respects the ports-and-adapters (hexagonal) rules below.

## Inputs

You will see two or three inputs:

1. "Current file content" — what's on disk right now at the file the
   agent is about to write. May be a parenthesized marker (e.g.
   \`(file does not exist)\`).
2. "Pending action" — the file path and what the agent is about to
   write. Content may be raw file text or a patch/diff.

## What you judge

Judge the change this write makes (the difference between the current
file content and the pending action), not the resulting file as a
whole. Infer the file's architectural role — core/domain, inbound or
outbound adapter, composition root, or test — from its path and
content.

A transient file state is never itself a violation: an unresolved
symbol, a dead definition, a half-finished multi-step change. Whether
the file compiles or runs is checked by the test suite, not by you.

A block recorded earlier in the session is a past verdict, not a rule.
Re-derive your judgment from the rules below. When the user tells you
in the session to let this change through, treat it as authoritative
and pass.

The bar for blocking is a clear violation of a rule below. Boundary
placement often involves judgment the agent can defend (composition
roots wire vendors by design; pure computation libraries need no
port); when the call is genuinely ambiguous, pass.`

const DEFAULT_BOUNDARY_RULES = `## Ports-and-adapters rules

The strict rule of this codebase: **an adapter is required for every
dependency the team doesn't own, and every dependency that isn't
deployed and released together with this code** — UI toolkits, web and
application frameworks, databases, third-party APIs and SDKs, message
brokers, other teams' services, and the operating system itself
(clock, filesystem, environment, randomness, network).

### The Dependency Rule (core code)

Core/domain/use-case code depends only on ports: interfaces the team
defines, named in the language of the domain, shaped by what the core
needs.

  - Core files import NOTHING from adapters, frameworks, vendor SDKs,
    ORMs, or OS I/O modules. \`new Date()\`, \`Date.now()\`,
    \`Math.random()\`, \`process.env\`, filesystem or network access in
    core code are violations — clock, config, randomness, and storage
    are ports.
  - Port signatures use core types only. A vendor type (a Stripe
    object, an ORM entity, an HTTP request/response) appearing in a
    port is a leaked boundary.
  - A module in the same repo and the same deployable unit needs no
    port; a dependency owned by another team or released on its own
    schedule does, even when "it's internal".

### Adapters must be thin

An adapter's only job is translation: port call → vendor call, vendor
result/error → core type. An adapter contains no conditional that
expresses a business rule. Mapping a vendor error code to a domain
error is translation; deciding what to do about it is core logic.
Retry policies, fallback decisions, caching rules, and validation
belong in the core behind the port — block adapter writes that add
them. Inbound adapters are equally thin: a route handler parses, calls
one use-case port, serializes the result.

### Ports are the only test seam

Test doubles are substituted at ports and nowhere else. Block test
writes that introduce module-mocking of the team's own code
(\`jest.mock('./our-module')\`, \`vi.mock('../internal')\`),
monkey-patching, or spying on internals — the substitute belongs at a
port, as an in-memory fake. Faking at a port (an \`InMemoryOrderStore\`
implementing the \`OrderStore\` port, a controlled \`Clock\`) is the
intended pattern and always passes.

### Always allowed

  - Composition roots and factory/wiring modules importing both core
    and adapters to assemble the system.
  - Adapter files importing their own vendor (that is their job).
  - Deleting code. Renames and moves that don't change dependencies.
  - Pure computation libraries with no external effects used directly.`

const GLOSSARY_RULES = `### Ubiquitous language

A glossary is provided below. Ports, domain types, use cases, and
their members name domain concepts with the glossary's terms
verbatim — one term per concept. Naming a recorded concept with a
synonym or conflicting term is a violation; a concept the glossary
does not cover is not a violation by itself.`

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

function buildPrompt(
  rules: string,
  glossary: string | undefined,
  before: FileContent,
  action: { path: string; content: string },
): string {
  const sections = [PROCESS_INSTRUCTIONS, rules]
  if (glossary) {
    sections.push(GLOSSARY_RULES, `## Glossary\n\n${glossary}`)
  }
  sections.push(
    `## Current file content\n\n${formatBefore(before)}`,
    `## Pending action\n\nFile: ${action.path}\n\n${action.content}`,
    RESPONSE_SPEC,
  )
  return sections.join('\n\n')
}

/**
 * AI-validated enforcement of the `ports-and-adapters` skill: the
 * Dependency Rule (core imports nothing from adapters, frameworks,
 * vendors, or OS I/O), thin adapters (no business conditionals), and
 * ports as the only test seam.
 *
 * Applies to: write actions. Scope it with a `{ files, rules }` block
 * to the code you care about — every matching write costs an AI call.
 * Pair it with `forbidContentPattern` blocks for known-bad imports so
 * the obvious violations are caught deterministically and free.
 *
 * @param options.instructions — overrides or extends the default
 *   boundary rules text. Pass a string to replace it, or a function
 *   `(defaults) => ...` to extend it (e.g. name your project's core
 *   and adapter directories so the validator infers roles precisely).
 * @param options.glossaryPath — absolute path to the project's
 *   ubiquitous-language glossary. When set and readable, the
 *   glossary is included in the validator's prompt and port/domain
 *   names that conflict with recorded terms become violations.
 * @param options.maxGlossaryChars — truncate the glossary beyond
 *   this length when building the prompt (default 8000).
 *
 * @example
 * { files: ['src/core/**', 'src/domain/**'], rules: [enforcePortsBoundary()] }
 *
 * @example
 * enforcePortsBoundary({
 *   instructions: (defaults) =>
 *     `${defaults}\n\n### Project layout\n\nCore lives in src/core; adapters in src/infra.`,
 * })
 */
export function enforcePortsBoundary(
  options: {
    instructions?: string | ((defaults: string) => string)
    glossaryPath?: string
    maxGlossaryChars?: number
  } = {},
): Rule {
  const rules =
    typeof options.instructions === 'function'
      ? options.instructions(DEFAULT_BOUNDARY_RULES)
      : (options.instructions ?? DEFAULT_BOUNDARY_RULES)
  const maxGlossaryChars = options.maxGlossaryChars ?? 8000
  return async function enforcePortsBoundary(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind !== 'write') return { kind: 'pass' }
    if (!ctx?.agent) {
      return {
        kind: 'violation',
        reason:
          'enforcePortsBoundary: no AI agent available; configure Config.ai or use a vendor that ships one.',
      }
    }
    let glossary: string | undefined
    if (options.glossaryPath && ctx.readFile) {
      const file = await ctx.readFile(options.glossaryPath)
      if (file.kind === 'present') {
        glossary =
          file.content.length > maxGlossaryChars
            ? `${file.content.slice(0, maxGlossaryChars)}\n(...glossary truncated...)`
            : file.content
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

const ADAPTER_OBS_INSTRUCTIONS = `## Role

You are an adapter-observability validator. Adapters are the
integration points of this codebase, and an uninstrumented
integration point is undiagnosable in the field. Judge whether the
pending write keeps new adapter code observable, per the rules below.

## Inputs

1. "Current file content" — what's on disk right now (may be a marker
   like \`(file does not exist)\`).
2. "Pending action" — the file path and what the agent is about to
   write.

## What you judge

Judge only the change this write makes (before → after), never
pre-existing code. A transient state (unresolved import, half-built
class) is never itself a violation. A block recorded earlier in the
session is a past verdict, not a rule; when the user says to let a
change through, treat that as authoritative and pass.

## Adapter observability rules

A NEW adapter code path that performs external I/O — a network or SDK
call, database access, filesystem, platform service — must carry
boundary observability on that path: at least one structured telemetry
event (call made / outcome / retry, with machine-readable fields), a
recording tap/decorator around the port, or a span. The point: when
the integration misbehaves, someone can see what was sent and what
came back without attaching a debugger.

Always pass:
  - Pure type mappers and translators with no external effect.
  - Composition roots and DI wiring (including wiring a tap decorator
    — that IS the observability).
  - Test code and test fixtures/fakes.
  - Edits that only touch existing uninstrumented paths without adding
    new external calls (delta-based: legacy migrates incrementally).
  - Files that are clearly not adapters despite the path.

Do not demand a specific API: any structured, greppable event or
tap/trace convention counts. Never punish redaction (omitting payload
fields for secrecy) — presence of an event is what matters. You judge
presence, not field safety: whether a logged field is itself too
sensitive (a uid, PII) is review's job, not yours. When genuinely
ambiguous, pass.

## When you block

Phrase the remediation concretely: name the exact call to add and
where. If a "Project convention" section is provided below, use its
vocabulary verbatim in the remediation (its API or tap pattern, not a
generic "add logging"). And remind the agent that under this
codebase's TDD gate, instrumentation should be ASSERTED in the failing
test first (a fake/recording telemetry collector) — that way the TDD
validator accepts the event as tested behavior instead of flagging it
as over-implementation.`

/**
 * AI-validated companion to `enforcePortsBoundary`, judging the
 * opposite concern: adapters must be thin, but not blind. A new
 * adapter code path performing external I/O with no boundary
 * observability — no structured event, no tap/recording decorator, no
 * span — is blocked; pure mappers, wiring, tests, and untouched
 * legacy paths pass (delta-based).
 *
 * Applies to: write actions. Scope it to adapter paths only (e.g.
 * `**\/adapter\/**`, `**\/infra\/**`) — every matching write costs an
 * AI call.
 *
 * @param options.conventionHint — appended to the validator prompt to
 *   name the project's telemetry/tap convention (e.g. "structured
 *   Logger.event(tag, event, fields); port taps wired in the demo
 *   flavor's Koin module"), so the verdict and its fix suggestion
 *   speak the project's language.
 * @param options.instructions — replaces or extends the default rules
 *   text (string, or `(defaults) => ...`).
 */
export function enforceAdapterObservability(
  options: {
    conventionHint?: string
    instructions?: string | ((defaults: string) => string)
  } = {},
): Rule {
  const base =
    typeof options.instructions === 'function'
      ? options.instructions(ADAPTER_OBS_INSTRUCTIONS)
      : (options.instructions ?? ADAPTER_OBS_INSTRUCTIONS)
  const rules = options.conventionHint
    ? `${base}\n\n### Project convention\n\n${options.conventionHint}`
    : base
  return async function enforceAdapterObservability(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind !== 'write') return { kind: 'pass' }
    if (!ctx?.agent) {
      return {
        kind: 'violation',
        reason:
          'enforceAdapterObservability: no AI agent available; configure Config.ai or use a vendor that ships one.',
      }
    }
    const before: FileContent = (await ctx.readFile?.(action.path)) ?? {
      kind: 'unknown',
    }
    const verdict = await ctx.agent.reason(
      [
        rules,
        `## Current file content\n\n${formatBefore(before)}`,
        `## Pending action\n\nFile: ${action.path}\n\n${action.content}`,
        RESPONSE_SPEC,
      ].join('\n\n'),
    )
    if (verdict.kind === 'violation') {
      return { kind: 'violation', reason: verdict.reason }
    }
    return { kind: 'pass', reason: verdict.reason }
  }
}

const MODULE_MOCK_PATTERN =
  /\b(?:jest|vi)\.(?:mock|doMock)\(\s*(['"`])(\.\.?\/[^'"`]+)\1/g

function relativeMockSpecifiers(content: string): Set<string> {
  const specifiers = new Set<string>()
  for (const match of content.matchAll(MODULE_MOCK_PATTERN)) {
    const specifier = match[2]
    if (specifier) specifiers.add(specifier)
  }
  return specifiers
}

/**
 * Deterministic companion to `enforcePortsBoundary`: blocks test
 * writes that introduce `jest.mock()` / `vi.mock()` calls with a
 * relative specifier — mocking the team's own modules instead of
 * substituting a fake at a port ("Ports Are the Only Test Seam").
 *
 * Only newly introduced mocks are blocked: a specifier already mocked
 * in the file on disk doesn't re-trigger on later edits, so existing
 * suites can be migrated incrementally. Mocks of bare (package)
 * specifiers are ignored — vendor modules are the adapter's problem,
 * and adapter tests may legitimately isolate them.
 *
 * Applies to: write actions. No AI call; free to run broadly.
 *
 * @param options.allow — specifier pattern(s) exempt from the rule
 *   (literal substring or RegExp against the mocked path), e.g. a
 *   sanctioned test-helper module.
 *
 * @example
 * { files: ['**\/*.test.*', '**\/*.spec.*'], rules: [forbidInternalModuleMocks()] }
 */
export function forbidInternalModuleMocks(
  options: { allow?: string | RegExp } = {},
): Rule {
  const allowed = (specifier: string): boolean => {
    if (options.allow === undefined) return false
    if (typeof options.allow === 'string')
      return specifier.includes(options.allow)
    return options.allow.test(specifier)
  }
  return async function forbidInternalModuleMocks(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind !== 'write') return { kind: 'pass' }
    const pending = relativeMockSpecifiers(action.content)
    if (pending.size === 0) return { kind: 'pass' }
    const before = await ctx?.readFile?.(action.path)
    const existing =
      before?.kind === 'present'
        ? relativeMockSpecifiers(before.content)
        : new Set<string>()
    const introduced = [...pending].filter(
      (specifier) => !existing.has(specifier) && !allowed(specifier),
    )
    if (introduced.length === 0) return { kind: 'pass' }
    return {
      kind: 'violation',
      reason:
        `This write introduces module-mocking of our own code (${introduced
          .map((s) => `'${s}'`)
          .join(', ')}). Ports are the only test seam: substitute an ` +
        'in-memory fake at the port the module sits behind instead of ' +
        'mocking the module. If no port exists yet, that is the missing ' +
        'design step — see the ports-and-adapters skill.',
    }
  }
}
