import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'

import type { Action, Rule, RuleContext, RuleResult } from '@nizos/probity'

/**
 * Kotlin/JVM/Android preset for the ports-and-adapters rules. The
 * JS-ecosystem screens in `ports-and-adapters.ts` (ESM imports,
 * jest/vi module mocks) never fire on Kotlin; these are their
 * Kotlin-shaped counterparts.
 *
 * Brownfield note: both rules here judge the DELTA — they block only
 * occurrences the pending write introduces, so files that already
 * carry violations can be edited freely and migrated incrementally.
 */

/**
 * Known framework/vendor/infrastructure imports that never belong in
 * core code under the Dependency Rule. Kotlin `import` syntax.
 * Extend with your stack's packages; `enforcePortsBoundary` catches
 * what this list misses.
 */
export const KOTLIN_INFRASTRUCTURE_IMPORTS =
  /import\s+(?:com\.amazonaws|aws\.sdk\.kotlin|software\.amazon\.awssdk|com\.amplifyframework|com\.apollographql|com\.google\.firebase|com\.sudoplatform|com\.twilio|okhttp3|retrofit2|androidx\.room|androidx\.work|androidx\.datastore|java\.sql|javax\.sql|io\.ktor|org\.koin|org\.springframework|org\.jetbrains\.exposed|app\.cash\.sqldelight|com\.squareup\.sqldelight|net\.zetetic)\./

/**
 * Mocking-library imports, for projects whose convention is
 * hand-written fakes at ports with no mocking library at all (pair
 * with `forbidContentPattern`). Distinct from `forbidStaticMocks`,
 * which permits the library but blocks its monkey-patching APIs.
 */
export const MOCKING_LIBRARY_IMPORTS =
  /import\s+(?:io\.mockk|org\.mockito|org\.powermock)\./

/**
 * Matches Gradle test invocations (`./gradlew test`,
 * `./gradlew :mysudo:testDevDebugUnitTest`, flavored Android unit-test
 * tasks) for the commit-on-green `requireCommand` gate.
 */
export const GRADLE_TEST_COMMAND = /gradlew?\s+(?:[\w:./-]+\s+)*:?[\w:.-]*[tT]est\w*/

type NamedPattern = { label: string; pattern: RegExp }

const STATIC_MOCK_PATTERNS: NamedPattern[] = [
  { label: 'Mockito.mockStatic()', pattern: /\bmockStatic\s*[(<]/g },
  { label: 'mockkStatic()', pattern: /\bmockkStatic\s*\(/g },
  { label: 'mockkObject()', pattern: /\bmockkObject\s*\(/g },
  { label: 'mockkConstructor()', pattern: /\bmockkConstructor\s*\(/g },
  { label: 'PowerMock', pattern: /import\s+org\.powermock\b/g },
]

const AMBIENT_EFFECT_PATTERNS: NamedPattern[] = [
  {
    label: 'java.time .now()',
    pattern: /\b(?:Instant|LocalDate|LocalDateTime|LocalTime|ZonedDateTime|OffsetDateTime)\.now\s*\(/g,
  },
  { label: 'System.currentTimeMillis()', pattern: /\bSystem\.currentTimeMillis\s*\(/g },
  { label: 'Date()', pattern: /\bDate\s*\(\s*\)/g },
  { label: 'UUID.randomUUID()', pattern: /\bUUID\.randomUUID\s*\(/g },
  { label: 'Random()/Math.random()', pattern: /\bRandom\s*\(|\bMath\.random\s*\(/g },
  { label: 'System.getenv', pattern: /\bSystem\.getenv\b/g },
]

function countMatches(content: string, pattern: RegExp): number {
  let count = 0
  for (const _ of content.matchAll(pattern)) count++
  return count
}

/** Patterns whose occurrence count grows from before → after. */
async function introducedPatterns(
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
 * Kotlin counterpart of `forbidInternalModuleMocks`: blocks test
 * writes that introduce static/object/constructor mocking —
 * `Mockito.mockStatic`, MockK's `mockkStatic`/`mockkObject`/
 * `mockkConstructor`, PowerMock — the JVM's monkey-patching
 * equivalents. These always bypass the architecture ("Ports Are the
 * Only Test Seam"): whatever they intercept should be reached through
 * a port and replaced with a fake.
 *
 * Plain `mock<SomeInterface>()` is NOT blocked: whether the mocked
 * type is a port (fine) or an internal class (violation) isn't
 * decidable from the call site — that judgment belongs to
 * `enforcePortsBoundary` or review.
 *
 * Delta-based: pre-existing static mocks in the file don't
 * re-trigger on later edits. Applies to: write actions. No AI call.
 *
 * @example
 * { files: ['**\/src\/test\/**', '**\/src\/androidTest\/**'], rules: [forbidStaticMocks()] }
 */
export function forbidStaticMocks(): Rule {
  return async function forbidStaticMocks(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind !== 'write') return { kind: 'pass' }
    const introduced = await introducedPatterns(
      action,
      ctx,
      STATIC_MOCK_PATTERNS,
    )
    if (introduced.length === 0) return { kind: 'pass' }
    return {
      kind: 'violation',
      reason:
        `This write introduces static/object mocking (${introduced.join(
          ', ',
        )}). Ports are the only test seam: put the intercepted ` +
        'dependency behind a port and substitute an in-memory fake ' +
        'there instead (see the ports-and-adapters skill).',
    }
  }
}

/**
 * Blocks production writes that introduce direct ambient-effect calls
 * — OS clock (`Instant.now()`, `System.currentTimeMillis()`,
 * `Date()`), randomness (`UUID.randomUUID()`, `Random()`), and
 * environment (`System.getenv`). Under ports-and-adapters these are
 * unowned OS dependencies: clock, randomness, and config are ports.
 *
 * Delta-based: the ~hundreds of pre-existing call sites in a
 * brownfield codebase don't block edits to their files; only net-new
 * occurrences do. Scope to production sources — tests and adapter
 * implementations (e.g. a `DefaultTimeProvider`) legitimately touch
 * the real OS, so exclude adapter paths via globs or negations.
 *
 * @param options.seamHint — appended to the block message to point
 *   the agent at the project's canonical seam(s), e.g.
 *   "inject com.anonyome.sudocommons.core.common.TimeProvider".
 * @param options.patterns — replaces the default pattern list; each
 *   RegExp needs the `g` flag.
 *
 * @example
 * { files: ['**\/src\/main\/**', '!**\/adapters\/**'], rules: [forbidNewAmbientEffects()] }
 */
export function forbidNewAmbientEffects(
  options: { seamHint?: string; patterns?: NamedPattern[] } = {},
): Rule {
  const patterns = options.patterns ?? AMBIENT_EFFECT_PATTERNS
  return async function forbidNewAmbientEffects(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind !== 'write') return { kind: 'pass' }
    const introduced = await introducedPatterns(action, ctx, patterns)
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

type AstGrepNode = { findAll(rule: unknown): unknown[] }
type AstGrepModule = {
  registerDynamicLanguage: (langs: Record<string, unknown>) => void
  parse: (lang: string, code: string) => { root(): AstGrepNode }
}

/**
 * ast-grep rules matching a JUnit-style test function. Kotest
 * string-invocation specs (`"does a thing" { }`) would need an
 * additional pattern; add one via `withKotlinFastPath`'s `patterns`
 * option if your suite uses them.
 */
const KOTLIN_TEST_PATTERNS: unknown[] = [
  {
    rule: {
      kind: 'function_declaration',
      regex: '@(Test|ParameterizedTest|RepeatedTest|TestFactory)\\b',
    },
  },
]

let astGrep: AstGrepModule | null | undefined

function loadKotlinAstGrep(): AstGrepModule | null {
  if (astGrep !== undefined) return astGrep
  try {
    const require = createRequire(import.meta.url)
    const napi = require('@ast-grep/napi') as AstGrepModule
    const lang = require('@ast-grep/lang-kotlin') as { default?: unknown }
    napi.registerDynamicLanguage({ kotlin: lang.default ?? lang })
    astGrep = napi
  } catch {
    // Optional peer deps not installed — the wrapper falls through.
    astGrep = null
  }
  return astGrep
}

function countKotlinTests(
  napi: AstGrepModule,
  code: string,
  patterns: unknown[],
): number {
  const root = napi.parse('kotlin', code).root()
  let count = 0
  for (const pattern of patterns) count += root.findAll(pattern).length
  return count
}

/**
 * Kotlin equivalent of `enforceTdd({ fastPath: true })`, which Probity
 * only implements for TS/JS/Python/C#/Ruby/PHP: wraps a rule so that a
 * `.kt`/`.kts` write adding exactly one new test function passes
 * deterministically — no AI call for the most common write in a TDD
 * loop, adding the next red test. Everything else (production writes,
 * multi-test writes, non-Kotlin files) delegates to the wrapped rule
 * unchanged.
 *
 * Requires the optional packages `@ast-grep/napi` and
 * `@ast-grep/lang-kotlin` (`npm install -D` both). When they're
 * missing, or the current file content is unavailable, or parsing
 * fails, the wrapper transparently falls through to the wrapped rule
 * — it can only ever skip work, never block.
 *
 * Same trade-off as Probity's own fast-path: a deterministic pass on
 * every single-test addition skips the green→red refactor-readiness
 * check the AI would otherwise perform.
 *
 * @param rule — the rule to wrap, normally `enforceTdd()`.
 * @param options.patterns — replaces the default ast-grep test-node
 *   patterns (e.g. to add a Kotest spec pattern).
 *
 * @example
 * { files: ['**\/src\/main\/**', '**\/src\/test\/**'], rules: [withKotlinFastPath(enforceTdd())] }
 */
export function withKotlinFastPath(
  rule: Rule,
  options: { patterns?: unknown[] } = {},
): Rule {
  const patterns = options.patterns ?? KOTLIN_TEST_PATTERNS
  const wrapped = async function kotlinFastPath(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind !== 'write' || !/\.kts?$/.test(action.path)) {
      return rule(action, ctx)
    }
    const napi = loadKotlinAstGrep()
    if (!napi) return rule(action, ctx)
    const before = await ctx?.readFile?.(action.path)
    // An unknowable before-count makes any delta unverifiable; fall
    // through to the wrapped rule rather than risk a false pass.
    if (!before || before.kind === 'unknown') return rule(action, ctx)
    const beforeText = before.kind === 'present' ? before.content : ''
    let delta: number
    try {
      delta =
        countKotlinTests(napi, action.content, patterns) -
        countKotlinTests(napi, beforeText, patterns)
    } catch {
      return rule(action, ctx)
    }
    if (delta === 1) return { kind: 'pass', notes: [{ kind: 'fast-path' }] }
    return rule(action, ctx)
  }
  // Surface the wrapped rule in engine traces and block reports:
  // a block coming through the wrapper is the inner rule's verdict.
  Object.defineProperty(wrapped, 'name', {
    value: `kotlinFastPath(${rule.name || 'rule'})`,
  })
  return wrapped
}

/**
 * Commit-on-GREEN gate — the stricter sibling of Probity's built-in
 * `requireCommand`, which only checks that a matching test command was
 * *recorded* after the last write and would happily pass a transcript
 * whose latest run FAILED. This rule additionally judges the recorded
 * run's output: the last matching test command after the last write
 * must look green (`successPattern` present, `failurePattern` absent).
 *
 * Inherent limit (unchanged from requireCommand): the gate sees only
 * the session transcript. A green run in another terminal, CI, or a
 * wrapper script is invisible — rerun the suite in-session, and keep
 * the CI mirror for human commits.
 *
 * Applies to: command actions matching `git commit`. Deterministic —
 * no AI call.
 *
 * @param options.command — regex matching a test invocation (e.g.
 *   {@link GRADLE_TEST_COMMAND}).
 * @param options.successPattern — output must match to count as green
 *   (default `/BUILD SUCCESSFUL/`).
 * @param options.failurePattern — output matching this is red even if
 *   the success pattern also appears (default `/FAILED|BUILD FAILED/`).
 */
export function requireGreenTestRun(options: {
  command: RegExp
  successPattern?: RegExp
  failurePattern?: RegExp
}): Rule {
  const success = options.successPattern ?? /BUILD SUCCESSFUL/
  const failure = options.failurePattern ?? /FAILED|BUILD FAILED/
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
    if (failure.test(output) || !success.test(output)) {
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

/**
 * Marker that declares a write a mutation probe: a deliberate,
 * temporary break of production behavior made to prove a retrofitted
 * test can fail (see acceptance-testing's mutation-check step). Put
 * it in a comment on or near the mutated line:
 *
 *   // probity: mutation-probe — proving RetrySpec bites; revert before commit
 */
export const MUTATION_PROBE_MARKER = /probity:\s*mutation-probe/

const PROBE_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'build',
  '.gradle',
  'out',
  'dist',
  '.idea',
])

const DEFAULT_PROBE_FILE_PATTERN = /\.(?:kt|kts|java)$/

function walkFiles(dir: string, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!PROBE_SKIP_DIRS.has(entry.name)) walkFiles(join(dir, entry.name), out)
    } else {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

/**
 * Wraps a TDD rule so that a write carrying the
 * {@link MUTATION_PROBE_MARKER} passes deterministically — no AI call,
 * no red-before-green demand. Mutation checks (deliberately breaking
 * production code to prove a retrofitted test fails) are *mandated* by
 * the acceptance-testing skill, and an unwrapped `enforceTdd`
 * correctly denies them: a deliberate regression has no failing test
 * in front of it and never will. Without this wrapper the only way to
 * run a mutation check is to override the gate — which trains agents
 * and humans to ignore deny decisions.
 *
 * The bypass is not free: pair this with {@link enforceProbeReversion}
 * so `git commit` is blocked while any probe marker is still on disk.
 * The pair converts an override into an enforced round-trip: mark →
 * watch the test fail → revert (the marker disappears with the
 * mutation) → commit opens again. Removing just the marker while
 * keeping the mutation is a fresh unmarked production write, judged by
 * the wrapped TDD rule as usual.
 *
 * Only the TDD rule is bypassed. Deterministic screens (vendor
 * imports, ambient effects) and the boundary validator still apply to
 * probe writes — a probe has no business introducing those.
 *
 * @param rule — the rule to wrap, normally
 *   `withKotlinFastPath(enforceTdd())`.
 */
export function withMutationProbe(rule: Rule): Rule {
  const wrapped = async function mutationProbe(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind === 'write' && MUTATION_PROBE_MARKER.test(action.content)) {
      return { kind: 'pass', notes: [{ kind: 'mutation-probe' }] }
    }
    return rule(action, ctx)
  }
  Object.defineProperty(wrapped, 'name', {
    value: `mutationProbe(${rule.name || 'rule'})`,
  })
  return wrapped
}

/**
 * The commit half of the mutation-probe round-trip (see
 * {@link withMutationProbe}): blocks `git commit` while any source
 * file under `roots` still contains the probe marker, listing the
 * files. Reverting the mutation (e.g. `git checkout -- <file>`)
 * removes the marker with it, so a clean tree needs no bookkeeping.
 * Deterministic filesystem scan — no AI call.
 *
 * Applies to: command actions matching `git commit`.
 *
 * @param options.roots — absolute paths to scan (the repo root is
 *   fine; node_modules/build dirs are skipped).
 * @param options.filePattern — which files can carry probes
 *   (default: `.kt`/`.kts`/`.java`).
 */
export function enforceProbeReversion(options: {
  roots: string[]
  filePattern?: RegExp
}): Rule {
  const filePattern = options.filePattern ?? DEFAULT_PROBE_FILE_PATTERN
  return function enforceProbeReversion(action: Action): RuleResult {
    if (action.kind !== 'command') return { kind: 'pass' }
    if (!/git commit/.test(action.command)) return { kind: 'pass' }
    const outstanding = options.roots
      .flatMap((root) =>
        walkFiles(root)
          .filter((file) => filePattern.test(file))
          .filter((file) => {
            try {
              return MUTATION_PROBE_MARKER.test(readFileSync(file, 'utf8'))
            } catch {
              return false
            }
          })
          .map((file) => relative(root, file)),
      )
    if (outstanding.length === 0) return { kind: 'pass' }
    return {
      kind: 'violation',
      reason:
        'Mutation probe(s) still on disk — a deliberate break made to ' +
        'prove a test bites must be reverted before committing ' +
        '(git checkout -- <file> restores the original and removes ' +
        'the marker):\n' +
        outstanding.map((file) => `    ${file}`).join('\n'),
    }
  }
}

/**
 * Kotlin/Android addendum for `enforcePortsBoundary` — pass as
 * `enforcePortsBoundary({ instructions: (d) => d + KOTLIN_BOUNDARY_ADDENDUM })`
 * and extend the "Project layout" section with your module/package
 * conventions.
 */
export const KOTLIN_BOUNDARY_ADDENDUM = `

### Kotlin/Android specifics

  - Ambient OS access in core code is a violation: \`Instant.now()\`
    and friends, \`System.currentTimeMillis()\`, \`Date()\`,
    \`UUID.randomUUID()\`, \`Random()\`, \`System.getenv\` — clock,
    randomness, and environment are ports.
  - Vendor/infrastructure packages (AWS SDK, Amplify, Apollo,
    Firebase, OkHttp, Retrofit, Room, WorkManager, JDBC) belong in
    adapter modules only. In core code, their types in signatures are
    leaked boundaries.
  - Dagger/DI modules, \`@Component\` definitions, and \`…di\` packages
    are composition roots: they import both core and adapters by
    design — always allowed.
  - In tests, \`mockStatic\`/\`mockkStatic\`/\`mockkObject\`/
    \`mockkConstructor\`/PowerMock are always violations. A
    mockito-kotlin \`mock<T>()\` where T is a port interface is an
    acceptable seam (though a shared fake is preferred); \`mock<T>()\`
    of a concrete internal class is a violation — the substitute
    belongs at a port.
  - Robolectric in a test signals Android-framework coupling; that is
    an adapter concern, fine in adapter/UI tests, a smell in tests of
    core logic.
  - A port need not be an interface. A function-typed constructor
    parameter injected at the composition root (e.g.
    \`nowEpochMillis: () -> Long\`, \`randomIv: () -> ByteArray\`) is a
    valid seam — but a default value that calls the real OS
    (\`= { System.currentTimeMillis() }\`) inside core/common code
    defeats it; real defaults belong in platform adapters or DI
    wiring.
  - Kotlin Multiplatform: \`commonMain\` core code is the inside of
    the hexagon; \`expect\`/\`actual\` pairs and per-platform source
    sets (\`androidMain\`, \`iosMain\`, \`desktopMain\`) implementing a
    common declaration are adapters and may touch platform APIs.`
