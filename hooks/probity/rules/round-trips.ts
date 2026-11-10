import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import type { Action, Rule, RuleContext, RuleResult } from '@nizos/probity'

import { isGitCommit, nestedCommitTree } from './commit-target.js'
import { transcriptLimitViolation } from './gates.js'

/**
 * Language-neutral round-trips that let a project retrofit tests onto
 * behaviour that already exists, which the plain TDD gate blocks (a
 * test for existing behaviour is born green):
 *
 * - the mutation probe (`withMutationProbe`, `enforceProbeReversion`):
 *   break production code on purpose to see a retrofitted test fail,
 *   and revert before commit;
 * - the characterization test (`withCharacterizationTest`,
 *   `enforceCharacterizationResolution`): pin existing behaviour, then
 *   resolve the marker before commit;
 * - `withInverseScenarioGuidance` for brownfield seam gaps.
 *
 * They take patterns as options and work for any language. Until
 * 0.4.67 they lived in kotlin.ts, which still re-exports them.
 */
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

function walkFiles(dir: string, out: string[] = [], top = true): string[] {
  // A directory holding a `.git` FILE is another working tree — a
  // linked `git worktree` (Claude Code puts sub-agent worktrees at
  // .claude/worktrees/agent-<id>/) or a submodule. Its markers belong
  // to that tree's commits, never to this one's.
  if (!top && isFile(join(dir, '.git'))) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!PROBE_SKIP_DIRS.has(entry.name)) walkFiles(join(dir, entry.name), out, false)
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

/**
 * Files under the scanned roots that carry `marker`, as paths relative
 * to the tree scanned. When the commit targets a git working tree
 * nested inside a root (a linked worktree), that tree is scanned in
 * the root's place — so each worktree is gated by its own markers
 * only, and sibling worktrees never block each other.
 */
function markedFiles(
  roots: string[],
  command: string,
  filePattern: RegExp,
  marker: RegExp,
): string[] {
  return roots.flatMap((root) => {
    const scanned = nestedCommitTree(command, root) ?? root
    return walkFiles(scanned)
      .filter((file) => filePattern.test(file))
      .filter((file) => {
        try {
          return marker.test(readFileSync(file, 'utf8'))
        } catch {
          return false
        }
      })
      .map((file) => relative(scanned, file).split(sep).join('/'))
  })
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
 * An unmarked write the TDD rule denies for lacking a red gets a note
 * naming the marker (issue #134): a deliberate break and untested new
 * behaviour look alike to the judge, and a test-support stub in a
 * `src/main` source set is judged as production code.
 *
 * @param rule — the wrapped TDD stack. Shipped presets supply their
 *   package-internal Kotlin-specialized judge before applying this wrapper.
 */
export function withMutationProbe(rule: Rule): Rule {
  const wrapped = async function mutationProbe(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind === 'write' && MUTATION_PROBE_MARKER.test(action.content)) {
      return { kind: 'pass', notes: [{ kind: 'mutation-probe' }] }
    }
    const result = await rule(action, ctx)
    if (
      result.kind === 'violation' &&
      PROBE_CANDIDATE_REASON.test(result.reason ?? '') &&
      !RETROFIT_REASON.test(result.reason ?? '')
    ) {
      return { ...result, reason: `${result.reason}\n\n${PROBE_HINT}` }
    }
    return result
  }
  Object.defineProperty(wrapped, 'name', {
    value: `mutationProbe(${rule.name || 'rule'})`,
  })
  return wrapped
}

// The inverse-scenario note only helps when the denial is about a
// missing red or when the write is removing control — appended
// anywhere else it reads as boilerplate (observed live on a
// minimal-green denial about an undefined symbol).
const MISSING_RED_REASON =
  /never (?:been )?observed|not (?:been )?observed failing|no (?:clean |assertion-level |prior )*red|passe[sd] (?:all|without)|without (?:a |any )?(?:failing|red)/i

// The other recurring composition-root denial: a multi-part fixture
// (fake + fixture accessor + enum value) landed piecewise, and the
// first write is blocked for referencing a sibling it doesn't define.
const UNDEFINED_SIBLING_REASON =
  /not defined|no declaration|undefined|not declared|does not (?:add|define|declare)|isn't defined/i

// A test write denied as bending a red test to the code (issue #136).
// The judge can't tell a wrong expectation about the code from a wrong
// one about the test environment, so the denial stands and the note
// names the way through instead. Neither marker applies to this case.
const RETROFIT_REASON =
  /retrofit|weaken|loosen|bend|(?:fit|match)(?:es|ing)? (?:the )?(?:current |existing |new )?(?:production |implementation|code)|replac\w* (?:the )?(?:asserted|expected) (?:outcome|value|result)/i

const RESTART_HINT =
  'Note: if the original expectation was wrong rather than the code — ' +
  'for example about the test environment — restart the cycle so the ' +
  'corrected expectation is seen failing: revert the production change ' +
  'made since the red and the test itself (git checkout -- <files>, or ' +
  'delete a file git does not track yet), write it again as a new test ' +
  'with the corrected expectation, run it and watch it fail on that ' +
  'assertion against the unchanged code, then reapply the production ' +
  'change. Do not loosen the test or pin what the code now produces.'

// A denial for an untested change under green reads the same whether
// the write is new behaviour or a deliberate break (issue #134, a
// sabotage check on a test-support stub). The note names the
// sanctioned route for the second case.
const PROBE_CANDIDATE_REASON = new RegExp(
  `${MISSING_RED_REASON.source}|under green|no failing test|untested behaviou?r`,
  'i',
)

const PROBE_HINT =
  'Note: if this write is a deliberate break — a mutation check or ' +
  'sabotage made to watch a test or scenario fail, in production code ' +
  'or in a stub or fake used only by tests — put `// probity: ' +
  'mutation-probe` in a comment on the changed line and retry. The write ' +
  'passes; run the tests and watch them fail, then revert the file ' +
  '(git checkout -- <file>). Commits are blocked while the marker is on disk.'

const ATOMIC_FIXTURE_HINT =
  'Note: if this block cites a symbol the write references but does not ' +
  'define, the fake, its fixture key/accessor, and its enum value are ' +
  'ONE coherent unit — land them in a single atomic write instead of ' +
  'piecewise edits judged alone.'

const INVERSE_SCENARIO_GUIDANCE =
  'Note for test-control infrastructure (fixtures, fakes registered in an ' +
  'acceptance composition root): if the scenario this control serves ' +
  'passes WITHOUT it — the environment already satisfies its Given (no ' +
  'network, no credentials, empty state) — do not resolve this block by ' +
  'deleting the control. That leaves the precondition owned by the ' +
  'environment and makes the opposite precondition unspecifiable. The ' +
  'legitimate red is the INVERSE scenario on the same port (e.g. the ' +
  'success path when only failure happens for free): write that scenario, ' +
  'watch it fail, and let it drive this fixture; then move the original ' +
  'scenario onto the explicit fixture as a refactor under green. If the ' +
  'seam itself is missing, mark the scenario `## Scenario (wip):` and ' +
  'surface the seam gap to the user instead of working around it.'

/**
 * Wraps a TDD rule so that a violation on a write to the project's
 * test-control layer — acceptance composition roots, fixture/fake
 * registrations — carries the inverse-scenario escape route in its
 * deny text.
 *
 * Why: on brownfield systems the environment often produces the sad
 * path for free (a simulator with no backend fails every sign-in), so
 * a sad-path scenario never goes red and an unwrapped TDD gate appears
 * to "refuse" the control fixture. The observed failure mode is the
 * agent resolving that tension in the wrong direction — deleting the
 * control and letting the environment own the Given. The deny message
 * is what the agent reads at that decision point, so the correct move
 * (write the inverse scenario; its red drives the fixture) must be
 * stated there, not only in the skill prose.
 *
 * Pass-through everywhere else: verdicts are unchanged, only the
 * violation reason on matching paths gains a guidance paragraph — and
 * only the paragraph that applies. The inverse-scenario note is
 * appended when the denial is about a missing red (or the write
 * removes existing content — the deletion temptation); a denial citing
 * an undefined symbol gets the atomic-fixture hint instead (a
 * multi-part fixture judged piecewise). Other denials pass through
 * untouched, so the guidance never reads as boilerplate.
 *
 * @param rule — the TDD rule to wrap (already wrapped in fast-paths /
 *   mutation-probe as usual).
 * @param options.filePattern — paths that hold test-control
 *   infrastructure (e.g. /App[/\\]Sources[/\\]Acceptance[/\\]/ or a
 *   fixtures directory).
 */
export function withInverseScenarioGuidance(
  rule: Rule,
  options: { filePattern: RegExp },
): Rule {
  const wrapped = async function inverseScenarioGuidance(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    const result = await rule(action, ctx)
    if (
      result.kind !== 'violation' ||
      action.kind !== 'write' ||
      !options.filePattern.test(action.path)
    ) {
      return result
    }
    const reason = result.reason ?? ''
    let removesContent = false
    const before = await ctx?.readFile?.(action.path)
    if (before?.kind === 'present') {
      const after = new Set(
        action.content.split('\n').map((line) => line.trim()),
      )
      removesContent = before.content
        .split('\n')
        .map((line) => line.trim())
        .some((line) => line.length > 0 && !after.has(line))
    }
    if (removesContent || MISSING_RED_REASON.test(reason)) {
      return { ...result, reason: `${reason}\n\n${INVERSE_SCENARIO_GUIDANCE}` }
    }
    if (UNDEFINED_SIBLING_REASON.test(reason)) {
      return { ...result, reason: `${reason}\n\n${ATOMIC_FIXTURE_HINT}` }
    }
    return result
  }
  Object.defineProperty(wrapped, 'name', {
    value: `inverseScenarioGuidance(${rule.name || 'rule'})`,
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
    if (!isGitCommit(action.command)) return { kind: 'pass' }
    const outstanding = markedFiles(
      options.roots,
      action.command,
      filePattern,
      MUTATION_PROBE_MARKER,
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
 * Marker that declares a test a characterization test: the first test
 * for behavior that already exists in production, so no natural red
 * can precede it (the test is born green). Put it in a comment on or
 * directly above the test function:
 *
 *     // probity: characterization
 *     func testSignedInUserWithoutAnEntitlementIsOfferedPlans() async { … }
 */
export const CHARACTERIZATION_MARKER = /probity:\s*characterization\b/

// Kotlin test names are often backticked sentences
// (fun `rejects blank ids`()); capture the whole name so the removal
// proof looks for that test, not its first word.
const FUNCTION_NAME = /(?:func|fun)\s+(?:`([^`]+)`|([A-Za-z_]\w*))/

/** Test names whose characterization markers this write removes,
 *  paired with `null` when a marker can't be tied to a function. */
function removedMarkerTests(
  before: string,
  after: string,
): (string | null)[] {
  const names = (content: string): (string | null)[] => {
    const lines = content.split('\n')
    const found: (string | null)[] = []
    lines.forEach((line, index) => {
      if (!CHARACTERIZATION_MARKER.test(line)) return
      for (let scan = index; scan < Math.min(index + 6, lines.length); scan++) {
        const match = lines[scan]!.match(FUNCTION_NAME)
        if (match) {
          found.push((match[1] ?? match[2])!)
          return
        }
      }
      found.push(null)
    })
    return found
  }
  const remaining = new Set(names(after).filter(Boolean))
  return names(before).filter((name) => name === null || !remaining.has(name))
}

// A test-layer denial that asks for a red the test can never have —
// the behavior already exists, so the test is born green. Broader than
// MISSING_RED_REASON: judges phrase this as "must be observed failing
// first" or "treats this as new behavior".
const CHARACTERIZATION_CANDIDATE_REASON = new RegExp(
  `${MISSING_RED_REASON.source}|observed? (?:it |the test |to )?fail|fail(?:ing|s)? first|red first|new (?:unimplemented )?behaviou?r|existing behaviou?r|already (?:implemented|exists|passes|satisf)`,
  'i',
)

const CHARACTERIZATION_HINT =
  'Note: if this test pins behavior production ALREADY has (a ' +
  'characterization or regression test — e.g. covering a branch a ' +
  'mutation review found untested), no honest red can precede it. Put ' +
  '`// probity: characterization` in a comment directly above the test ' +
  'function and retry: the write passes, then prove the test bites — ' +
  'mutation-probe the production path (`// probity: mutation-probe`), ' +
  'run the test and watch it fail, revert the probe, remove the marker. ' +
  'Commits are blocked while the marker is on disk. Do not break ' +
  'production to manufacture a red.'

// Claude Code keeps only a 2KB preview of a large tool output in the
// transcript and saves the rest to <session>/tool-results/<id>.txt. A
// full-module Gradle run with a failing test is usually that large, and
// its FAILED line is rarely in the first 2KB.
const PERSISTED_OUTPUT = /<persisted-output>[^]*?Full output saved to: (\S+[/\\]tool-results[/\\][^\s/\\]+\.txt)/

/** A command's output, reading Claude Code's saved full output when the
 *  transcript only kept a preview. */
function fullCommandOutput(output: string): string {
  const saved = output.match(PERSISTED_OUTPUT)?.[1]
  if (!saved) return output
  try {
    return readFileSync(saved, 'utf8')
  } catch {
    return output
  }
}

/**
 * Wraps a TDD rule to sanction the **characterization round-trip** —
 * the only honest way to add the FIRST test for behavior that predates
 * it (common on brownfield systems). A test for existing behavior is
 * born green, so no red keyed to it can be observed before it exists;
 * an unwrapped TDD gate correctly denies it, and a mutation probe
 * can't help yet because a probe only fails tests that already exist.
 * Without this wrapper the only ways out are an override or leaving
 * the behavior unspecified.
 *
 * The round-trip, each step enforced:
 *
 *   1. Write the test carrying {@link CHARACTERIZATION_MARKER} — this
 *      wrapper passes it deterministically (test-layer paths only).
 *   2. Run the suite green, then mutation-probe the production path
 *      (`// probity: mutation-probe`) and observe the new test FAIL —
 *      the recorded red is the proof the test bites.
 *   3. Revert the probe. Remove the characterization marker — this
 *      wrapper allows the removal only when the session transcript
 *      records a test run in which the marked test failed.
 *   4. Commit — {@link enforceCharacterizationResolution} blocks while
 *      any marker is still on disk, so an unproven characterization
 *      test can't land.
 *
 * The bypass is confined: only writes to paths matching
 * `options.filePattern` (the test layer) skip the wrapped rule, so a
 * production write can't borrow the marker. Same inherent limit as
 * every transcript gate: reds observed in another terminal or CI are
 * invisible — run the probe in-session.
 *
 * Discoverability: when the wrapped rule denies an unmarked test-layer
 * write for lacking a red, the deny text gains a note naming the
 * marker, so an agent pinning existing behavior learns the sanctioned
 * route at the point it is blocked instead of breaking production.
 * A test-layer write denied as retrofitting (bending a red test to the
 * code) gets the restart-the-cycle note instead (issue #136), never the
 * marker: a corrected expectation is seen failing by restarting, not
 * by characterizing what the code now does.
 *
 * @param rule — the TDD rule to wrap (fast-paths/probe wrappers
 *   included as usual).
 * @param options.filePattern — paths that hold test code (e.g.
 *   /AcceptanceTests[/\\]/ or /src[/\\]\w+Test[/\\]/). Required: it is
 *   the boundary that keeps the marker useless in production files.
 */
export function withCharacterizationTest(
  rule: Rule,
  options: { filePattern: RegExp },
): Rule {
  const wrapped = async function characterizationTest(
    action: Action,
    ctx?: RuleContext,
  ): Promise<RuleResult> {
    if (action.kind !== 'write' || !options.filePattern.test(action.path)) {
      return rule(action, ctx)
    }
    const before = await ctx?.readFile?.(action.path)
    const beforeText =
      before?.kind === 'present' ? before.content : ''
    const markerRemains = CHARACTERIZATION_MARKER.test(action.content)
    const removed = removedMarkerTests(beforeText, action.content)
    if (removed.length > 0) {
      if (removed.some((name) => name === null)) {
        return {
          kind: 'violation',
          reason:
            'A characterization marker is being removed but could not ' +
            'be tied to a test function — keep the marker in a comment ' +
            'directly above the test it declares, and remove them ' +
            'together with the proof in hand.',
        }
      }
      let history
      try {
        history = (await ctx?.history?.()) ?? []
      } catch (error) {
        return transcriptLimitViolation(error)
      }
      const outputs = history.flatMap((event) =>
        event.kind === 'command' && 'output' in event && typeof event.output === 'string'
          ? [fullCommandOutput(event.output)]
          : [],
      )
      const unproven = (removed as string[]).filter(
        (name) => !outputs.some((output) => output.includes(name) && /fail/i.test(output)),
      )
      if (unproven.length > 0) {
        return {
          kind: 'violation',
          reason:
            'Characterization marker removed without a recorded red: no ' +
            'test run in this session shows the marked test(s) failing ' +
            `(${unproven.join(', ')}). Prove the test bites first — ` +
            'mutation-probe the production path it specifies ' +
            '(// probity: mutation-probe), run the suite, watch this ' +
            'test fail on its concluding assertion, revert the probe — ' +
            'then remove the marker. Working in a Claude Code sub-agent? ' +
            'The PreToolUse hook must run `probity-claude`, not the bare ' +
            '`probity` bin: the bare bin reads the parent session\'s ' +
            'transcript and cannot see a sub-agent\'s test runs.',
        }
      }
      return { kind: 'pass', notes: [{ kind: 'characterization-resolved' }] }
    }
    if (markerRemains) {
      return { kind: 'pass', notes: [{ kind: 'characterization' }] }
    }
    const result = await rule(action, ctx)
    if (result.kind === 'violation' && RETROFIT_REASON.test(result.reason ?? '')) {
      return { ...result, reason: `${result.reason}\n\n${RESTART_HINT}` }
    }
    if (
      result.kind === 'violation' &&
      CHARACTERIZATION_CANDIDATE_REASON.test(result.reason ?? '')
    ) {
      return {
        ...result,
        reason: `${result.reason}\n\n${CHARACTERIZATION_HINT}`,
      }
    }
    return result
  }
  Object.defineProperty(wrapped, 'name', {
    value: `characterizationTest(${rule.name || 'rule'})`,
  })
  return wrapped
}

/**
 * The commit half of the characterization round-trip (see
 * {@link withCharacterizationTest}): blocks `git commit` while any
 * test file under `roots` still carries the characterization marker —
 * the marker only comes off through the proof-checked removal path,
 * so a characterization test that has never been observed failing
 * cannot land. Deterministic filesystem scan — no AI call.
 *
 * Applies to: command actions matching `git commit`.
 *
 * @param options.roots — absolute paths to scan.
 * @param options.filePattern — which files can carry the marker
 *   (default: `.kt`/`.kts`/`.java`).
 */
export function enforceCharacterizationResolution(options: {
  roots: string[]
  filePattern?: RegExp
}): Rule {
  const filePattern = options.filePattern ?? DEFAULT_PROBE_FILE_PATTERN
  return function enforceCharacterizationResolution(
    action: Action,
  ): RuleResult {
    if (action.kind !== 'command') return { kind: 'pass' }
    if (!isGitCommit(action.command)) return { kind: 'pass' }
    const outstanding = markedFiles(
      options.roots,
      action.command,
      filePattern,
      CHARACTERIZATION_MARKER,
    )
    if (outstanding.length === 0) return { kind: 'pass' }
    return {
      kind: 'violation',
      reason:
        'Characterization marker(s) still on disk — a first test for ' +
        'pre-existing behavior must be proven to bite before it lands: ' +
        'mutation-probe the production path, watch the marked test ' +
        'fail, revert the probe, then remove the marker (the removal ' +
        'is checked against the recorded red):\n' +
        outstanding.map((file) => `    ${file}`).join('\n'),
    }
  }
}
