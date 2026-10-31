import { enforceTdd, type Rule } from '@nizos/probity'

import { withJudgeFailureDiagnostics, withContradictionRetry } from './gates.js'
import { GENERALISING_TDD_RULE } from '../internal/generalising-tdd.js'
import { IN_PROGRESS_TDD_RULE } from '../internal/in-progress-tdd.js'

/**
 * Appended to Probity's default TDD rules for JS/TS. The defaults say
 * both "adding a test is the red step" and "judge a new red at the
 * green->red boundary too" (the refactor check), and the judge has
 * read the second as a demand that the new test was already observed
 * failing (#73; the Kotlin judge did the same in #43).
 */
export const JS_TDD_ADDENDUM = `## Adding a red test

- Adding a failing test is the red step itself. A test-file write that adds one new test (with any imports, fixtures, or helpers it needs) passes without any prior run of that test: a test cannot have failed before it exists. "Must be observed failing for the right reason" applies only to the production write that follows it, never to the test write. This holds whether the asserted behavior is missing entirely or exists but is wrong, including behavior the previous cycle just implemented.
- At a test write, the only green->red question is whether the prior green left an unmistakable refactor unmade. A passing prior run is the expected state before a new test is added, never a reason to block it. Do not block a test write because the new test has not been observed failing, because the last run was for a previous test, or because the test contradicts what production code does now.
- A type-only fix for a type-check failure needs no red. Test runners such as vitest don't type-check, so a green step can leave \`tsc --noEmit\` failing (a widened union an existing test reads a narrower field from). A write that changes only types to make the type check pass (narrowing a return type, splitting or narrowing a type alias, adding an annotation, a type guard or a type parameter), in production or test code, is part of the step that caused the failure or a refactor under green: it changes no runtime behavior, and a type-check error is not a red for new behavior to answer. In a test, restating an assertion so it type-checks is allowed when it keeps every assertion at least as strong (for example, \`toEqual\` on the whole object in place of reading one field). A write that also changes runtime behavior, or weakens what a test asserts, is judged as usual. When you block one, say which part of the write is not type-only.
- The other rules still hold: a write adding more than one new test is a violation (restructuring existing tests is not adding), and so is a production write with no observed failing test for it. Observed failing means a test run, after the test was written, whose output shows that test failing. A test written in the session with no run after it has not been observed failing, and an earlier failing run of a different test does not count.
${IN_PROGRESS_TDD_RULE}
${GENERALISING_TDD_RULE}`

// Strings, template literals and comments blanked to spaces (newlines
// kept), so brackets and names are read from code only.
function codeOnly(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const two = text.slice(i, i + 2)
    let end = i
    if (two === '//') {
      end = text.indexOf('\n', i)
      if (end === -1) end = text.length
    } else if (two === '/*') {
      end = text.indexOf('*/', i + 2)
      end = end === -1 ? text.length : end + 2
    } else if (text[i] === '"' || text[i] === "'" || text[i] === '`') {
      const quote = text[i]
      end = i + 1
      while (end < text.length && text[end] !== quote && (quote === '`' || text[end] !== '\n')) {
        end += text[end] === '\\' ? 2 : 1
      }
      end += 1
    } else {
      out += text[i]
      i += 1
      continue
    }
    out += text.slice(i, end).replace(/[^\n]/g, ' ')
    i = end
  }
  return out
}

const JS_SOURCE = /\.[cm]?[jt]sx?$/
const JS_TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|[\\/]__tests__[\\/].+\.[cm]?[jt]sx?)$/

/**
 * Every placement of the one block of whole lines `after` inserts into
 * `before` (a block can slide over identical lines), or none when the
 * write does anything else: changes or removes a line, or inserts in two
 * places.
 */
function insertedBlocks(before: string, after: string): string[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (b.length <= a.length) return []
  let prefix = 0
  while (prefix < a.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < a.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  if (prefix + suffix !== a.length) return []
  const size = b.length - a.length
  const blocks = [b.slice(prefix, prefix + size).join('\n')]
  for (let start = prefix; start > 0 && b[start - 1] === b[start + size - 1]; start--) {
    blocks.push(b.slice(start - 1, start - 1 + size).join('\n'))
  }
  return blocks
}

const TEST_CALL = /^(?:it|test)\s*\(/
const DISABLING = /\b(?:only|skip|todo|fails|failing|skipIf|runIf)\b|\b(?:xit|fit|xtest|xdescribe|fdescribe)\b/

/** Whether `block` is exactly one plain `it(...)`/`test(...)` call, holding no other test and nothing that disables one. */
function isOneTest(block: string): boolean {
  const code = codeOnly(block)
  const start = code.search(/\S/)
  if (start === -1 || !TEST_CALL.test(code.slice(start))) return false
  const open = code.indexOf('(', start)
  let depth = 0
  let close = -1
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')' && --depth === 0) {
      close = i
      break
    }
  }
  if (close === -1 || !/^[\s;]*$/.test(code.slice(close + 1))) return false
  const inner = code.slice(open + 1, close)
  return !/\b(?:it|test|describe|bench)\s*[.(]/.test(inner) && !DISABLING.test(inner)
}

/**
 * Passes, without the judge, a write to an existing JS/TS test file that
 * inserts exactly one plain test and changes nothing else (#169, #170).
 * The red step is adding one test, and a judge (Sonnet, in the report)
 * miscounted such writes, or counted earlier uncommitted tests as new.
 * The baseline is the file on disk.
 *
 * Narrower than Probity's own `fastPath`, which only counts tests: a
 * write that also edits, removes or disables an existing test, adds
 * `.only`/`.skip`, adds anything beside the test, or touches a
 * production file goes to `rule`, as in the Kotlin presets' fast path.
 */
export function withJsTestFastPath(rule: Rule): Rule {
  const wrapped: Rule = async (action, ctx) => {
    if (action.kind === 'write' && JS_TEST_FILE.test(action.path)) {
      const before = await ctx?.readFile?.(action.path)
      if (before?.kind === 'present' && insertedBlocks(before.content, action.content).some(isOneTest)) {
        return { kind: 'pass', reason: 'One new test inserted, nothing else changed: the red step.' }
      }
    }
    return rule(action, ctx)
  }
  Object.defineProperty(wrapped, 'name', { value: rule.name })
  return wrapped
}

// One static import statement: `import [type] <bindings> from '<module>'`.
// A side-effect import (`import './polyfill'`) runs code, so it is not one.
const STATIC_IMPORT = /^import\s+(?:type\s+)?([\w$*{},\s]+?)\s+from\s+(['"])[^'"\r\n]+\2\s*;?\s*$/

/** The names an import clause binds: `X, { a as b, type c }`, `* as ns`. */
function boundNames(clause: string): string[] {
  const names: string[] = []
  const braces = clause.match(/\{([^}]*)\}/)
  for (const item of braces?.[1]?.split(',') ?? []) {
    const name = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim()
    if (name) names.push(name)
  }
  const rest = clause.replace(/\{[^}]*\}/, '').replace(/^\s*type\s+/, '')
  const star = rest.match(/\*\s+as\s+([\w$]+)/)
  if (star) names.push(star[1]!)
  const plain = rest.replace(/\*\s+as\s+[\w$]+/, '').split(',').map((part) => part.trim()).filter(Boolean)
  names.push(...plain)
  return names
}

/**
 * A file split into its leading import statements and everything else:
 * the comments among those imports and the body after them. Null when a
 * statement in the leading block isn't a plain static import.
 */
function importsAndRest(text: string): { imports: string[]; comments: string[]; body: string } | null {
  const lines = text.split('\n')
  const imports: string[] = []
  const comments: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!.trim()
    if (line === '') {
      i++
    } else if (line.startsWith('//')) {
      comments.push(line)
      i++
    } else if (line.startsWith('/*')) {
      while (i < lines.length && !lines[i]!.includes('*/')) comments.push(lines[i++]!.trim())
      if (i < lines.length) comments.push(lines[i++]!.trim())
    } else if (/^import\b/.test(line)) {
      let j = i
      let statement = line
      while (!/\bfrom\s+(['"])[^'"\r\n]+\1\s*;?\s*$/.test(statement) && j - i < 50 && j + 1 < lines.length) {
        statement += '\n' + lines[++j]!.trim()
      }
      if (!STATIC_IMPORT.test(statement)) return null
      imports.push(statement)
      i = j + 1
    } else {
      break
    }
  }
  return { imports, comments, body: lines.slice(i).join('\n') }
}

/** Whether `inner` appears in `outer` in order (not necessarily adjacent). */
function inOrder(inner: string[], outer: string[]): boolean {
  let at = 0
  for (const item of outer) if (item === inner[at]) at++
  return at === inner.length
}

/**
 * Passes, without the judge, a write to an existing JS/TS file that only
 * adds static imports to its leading import block (issue #171). An import
 * does nothing until code uses it, and Probity's TDD rules already call
 * an import awaiting a later write a transient state, but a judge
 * (Sonnet, in the report) refused one as "unused import, not minimal
 * green".
 *
 * Only additions: every existing import stays as it was and in order,
 * the rest of the file is unchanged, and no added import binds a name
 * the code already uses (which would change what it calls). Anything
 * else (a removed, changed or aliased import, a side-effect import, a
 * new file) goes to `rule`.
 */
export function withImportOnlyFastPath(rule: Rule): Rule {
  const wrapped: Rule = async (action, ctx) => {
    if (action.kind === 'write' && JS_SOURCE.test(action.path)) {
      const disk = await ctx?.readFile?.(action.path)
      const before = disk?.kind === 'present' ? importsAndRest(disk.content) : null
      const after = before ? importsAndRest(action.content) : null
      if (
        before &&
        after &&
        after.imports.length > before.imports.length &&
        after.body === before.body &&
        after.comments.join('\n') === before.comments.join('\n') &&
        inOrder(before.imports, after.imports)
      ) {
        const added = after.imports.filter((statement) => !before.imports.includes(statement))
        const names = added.flatMap((statement) => boundNames(statement.match(STATIC_IMPORT)![1]!))
        const code = codeOnly(after.body)
        if (names.every((name) => !new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(code))) {
          return { kind: 'pass', reason: 'Only static imports added, none used yet: no behavior to test.' }
        }
      }
    }
    return rule(action, ctx)
  }
  Object.defineProperty(wrapped, 'name', { value: rule.name })
  return wrapped
}

/**
 * Probity's `enforceTdd()` with {@link JS_TDD_ADDENDUM} appended, wrapped
 * as the JS preset wires it: a self-contradicting deny is retried, and a
 * judge that returns no verdict (spend limit, auth failure) is reported
 * as an infrastructure failure rather than a TDD rejection. Use this in
 * place of `withJudgeFailureDiagnostics(withContradictionRetry(enforceTdd()))`.
 *
 * Two kinds of write skip the judge: a test-file write that inserts
 * exactly one plain test and changes nothing else ({@link withJsTestFastPath};
 * #169, #170), and a write that only adds unused static imports
 * ({@link withImportOnlyFastPath}; #171). A one-test write therefore
 * isn't checked for a refactor the previous green left unmade.
 */
export function enforceJsTdd(): Rule {
  return withImportOnlyFastPath(
    withJsTestFastPath(
      withJudgeFailureDiagnostics(
        withContradictionRetry(
          enforceTdd({ instructions: (defaults) => `${defaults}\n\n${JS_TDD_ADDENDUM}` }),
        ),
      ),
    ),
  )
}
