import { createRequire } from 'node:module'

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

// The parts of @ast-grep/napi used here. Probity depends on it (its own
// test counting parses with it), so it is resolved from Probity's install.
type JsNode = {
  kind(): string
  text(): string
  isNamed(): boolean
  children(): JsNode[]
  field(name: string): JsNode | null
  range(): { start: { line: number } }
  find(matcher: { rule: { kind: string } }): JsNode | null
}
type JsAstGrep = { parse(lang: string, source: string): { root(): JsNode } }

let jsAstGrep: JsAstGrep | null | undefined
function loadJsAstGrep(): JsAstGrep | null {
  if (jsAstGrep !== undefined) return jsAstGrep
  try {
    const fromProbity = createRequire(createRequire(import.meta.url).resolve('@nizos/probity'))
    jsAstGrep = fromProbity('@ast-grep/napi') as JsAstGrep
  } catch {
    jsAstGrep = null
  }
  return jsAstGrep
}

/** The file parsed by its extension, or null when it can't be parsed cleanly (the judge decides then). */
function parseJs(path: string, source: string): JsNode | null {
  const ast = loadJsAstGrep()
  if (!ast) return null
  const lang = /\.tsx$/.test(path) ? 'Tsx' : /\.[cm]?ts$/.test(path) ? 'TypeScript' : 'JavaScript'
  try {
    const root = ast.parse(lang, source).root()
    return root.find({ rule: { kind: 'ERROR' } }) ? null : root
  } catch {
    return null
  }
}

function named(node: JsNode): JsNode[] {
  return node.children().filter((child) => child.isNamed() && child.kind() !== 'comment')
}

function* descendants(node: JsNode): Generator<JsNode> {
  for (const child of node.children()) {
    yield child
    yield* descendants(child)
  }
}

const JS_SOURCE = /\.[cm]?[jt]sx?$/
const JS_TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|[\\/]__tests__[\\/].+\.[cm]?[jt]sx?)$/

/**
 * Every placement of the one block of whole lines `after` inserts into
 * `before` (a block can slide over identical lines), as its first line
 * and text, or none when the write does anything else: changes or
 * removes a line, or inserts in two places.
 */
function insertedBlocks(before: string, after: string): Array<{ line: number; text: string }> {
  const a = before.split('\n')
  const b = after.split('\n')
  if (b.length <= a.length) return []
  let prefix = 0
  while (prefix < a.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < a.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  if (prefix + suffix !== a.length) return []
  const size = b.length - a.length
  const blocks = []
  for (let start = prefix; ; start--) {
    blocks.push({ line: start, text: b.slice(start, start + size).join('\n') })
    if (!(start > 0 && b[start - 1] === b[start + size - 1])) break
  }
  return blocks
}

const TEST_FUNCTIONS = new Set(['it', 'test', 'describe', 'suite', 'bench', 'xit', 'fit', 'xtest', 'xdescribe', 'fdescribe'])
const DISABLING = new Set(['only', 'skip', 'todo', 'skipIf', 'runIf', 'fails', 'failing', 'each', 'concurrent'])
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'global', 'self'])
const ASSIGNMENTS = new Set(['assignment_expression', 'augmented_assignment_expression', 'update_expression'])

/** The identifier at the root of `a.b[c].d`, or null for anything else (`this`, a call). */
function rootName(target: JsNode): string | null {
  let node: JsNode | null = target
  while (node && (node.kind() === 'member_expression' || node.kind() === 'subscript_expression' || node.kind() === 'parenthesized_expression')) {
    node = node.kind() === 'parenthesized_expression' ? named(node)[0] ?? null : node.field('object')
  }
  return node?.kind() === 'identifier' ? node.text() : null
}

/** Names the test function declares: parameters, variables, inner functions. */
function declaredNames(fn: JsNode): Set<string> {
  const names = new Set<string>()
  const addPattern = (pattern: JsNode | null) => {
    if (!pattern) return
    for (const node of [pattern, ...descendants(pattern)]) {
      if (node.kind() === 'identifier' || node.kind() === 'shorthand_property_identifier_pattern') names.add(node.text())
    }
  }
  addPattern(fn.field('parameters'))
  addPattern(fn.field('parameter'))
  for (const node of descendants(fn)) {
    if (node.kind() === 'variable_declarator') addPattern(node.field('name'))
    if (node.kind() === 'function_declaration') addPattern(node.field('name'))
  }
  return names
}

/**
 * Whether `statement` is one plain test: `it`/`test` called with a
 * title and a function and nothing else, holding no other test, nothing
 * that skips or focuses one, no reach into global objects or the test
 * framework, and no assignment to anything but its own locals.
 */
function isPlainTest(statement: JsNode): boolean {
  const call = named(statement)[0]
  if (statement.kind() !== 'expression_statement' || call?.kind() !== 'call_expression') return false
  const callee = call.field('function')
  if (callee?.kind() !== 'identifier' || !['it', 'test'].includes(callee.text())) return false
  const args = call.field('arguments')
  const [title, body, ...extra] = args ? named(args) : []
  if (!title || !body || extra.length) return false
  if (title.kind() !== 'string' && !(title.kind() === 'template_string' && !named(title).some((n) => n.kind() === 'template_substitution'))) return false
  if (!['arrow_function', 'function_expression', 'function'].includes(body.kind())) return false
  const locals = declaredNames(body)
  for (const node of descendants(body)) {
    const kind = node.kind()
    if (kind === 'identifier' && (TEST_FUNCTIONS.has(node.text()) || GLOBAL_OBJECTS.has(node.text()))) return false
    if (kind === 'property_identifier' && DISABLING.has(node.text())) return false
    if (kind === 'member_expression') {
      const object = node.field('object')
      if (object?.kind() === 'identifier' && ['vi', 'jest'].includes(object.text()) && node.field('property')?.text() !== 'fn') return false
    }
    if (ASSIGNMENTS.has(kind)) {
      const target = node.field('left') ?? node.field('argument')
      const name = target ? rootName(target) : null
      if (!name || !locals.has(name)) return false
    }
  }
  return true
}

/**
 * Passes, without the judge, a write to an existing JS/TS test file that
 * inserts exactly one plain test and changes nothing else (#169, #170).
 * The red step is adding one test, and a judge (Sonnet, in the report)
 * miscounted such writes, or counted earlier uncommitted tests as new.
 * The baseline is the file on disk.
 *
 * The decision is made on the parsed file, not on text: the inserted
 * lines must be exactly one statement of the new file, a call to
 * `it`/`test` with a title and a function, holding no other test, no
 * only/skip/todo/each, no global object or `vi`/`jest` call beyond
 * `fn`, and no assignment beyond its own locals. A write that edits,
 * removes or disables an existing test, adds anything beside the test,
 * or touches a production file goes to `rule`, as does any file that
 * doesn't parse cleanly. Narrower than Probity's own `fastPath`, which
 * only counts tests.
 */
export function withJsTestFastPath(rule: Rule): Rule {
  const wrapped: Rule = async (action, ctx) => {
    if (action.kind === 'write' && JS_TEST_FILE.test(action.path)) {
      const before = await ctx?.readFile?.(action.path)
      const blocks = before?.kind === 'present' ? insertedBlocks(before.content, action.content) : []
      const root = blocks.length ? parseJs(action.path, action.content) : null
      if (root) {
        const statements = [...descendants(root)].filter((node) => node.kind() === 'expression_statement')
        const inserted = blocks.some(({ line, text }) => {
          const firstLine = line + (text.match(/^\s*/)![0].split('\n').length - 1)
          return statements.some(
            (statement) => statement.range().start.line === firstLine && statement.text() === text.trim() && isPlainTest(statement),
          )
        })
        if (inserted) return { kind: 'pass', reason: 'One new test inserted, nothing else changed: the red step.' }
      }
    }
    return rule(action, ctx)
  }
  Object.defineProperty(wrapped, 'name', { value: rule.name })
  return wrapped
}

function isDirective(node: JsNode): boolean {
  const parts = named(node)
  return node.kind() === 'expression_statement' && parts.length === 1 && parts[0]!.kind() === 'string'
}

/** The names an import statement binds: default, `* as ns`, and each specifier's local name. */
function importedNames(statement: JsNode): string[] {
  const clause = named(statement).find((node) => node.kind() === 'import_clause')
  if (!clause) return []
  const names: string[] = []
  for (const part of named(clause)) {
    if (part.kind() === 'identifier') names.push(part.text())
    else if (part.kind() === 'namespace_import') names.push(...named(part).map((n) => n.text()))
    else if (part.kind() === 'named_imports') {
      for (const specifier of named(part)) {
        const local = named(specifier).at(-1)
        if (local) names.push(local.text())
      }
    }
  }
  return names
}

const REFERENCES = new Set(['identifier', 'type_identifier', 'shorthand_property_identifier'])

/**
 * Passes, without the judge, a write to an existing JS/TS file that only
 * adds static imports (issue #171). An import does nothing until code
 * uses it, and Probity's TDD rules already call an import awaiting a
 * later write a transient state, but a judge (Sonnet, in the report)
 * refused one as "unused import, not minimal green".
 *
 * Decided on the parsed files: every top-level statement and comment of
 * the file on disk is still there, in order and unchanged, and the only
 * new ones are import statements in the leading import block, after any
 * directive (`'use client'`). Each binds at least one name, and none of
 * those names is used anywhere in the file, so nothing calls something
 * different. Binding imports still run their module's top-level code,
 * as every import already there does. Anything else (a removed, changed
 * or aliased import, `import {}` or a side-effect import, a new file, a
 * file that doesn't parse) goes to `rule`.
 */
export function withImportOnlyFastPath(rule: Rule): Rule {
  const wrapped: Rule = async (action, ctx) => {
    if (action.kind === 'write' && JS_SOURCE.test(action.path)) {
      const disk = await ctx?.readFile?.(action.path)
      const before = disk?.kind === 'present' ? parseJs(action.path, disk.content) : null
      const after = before ? parseJs(action.path, action.content) : null
      if (before && after && onlyAddsUnusedImports(before, after)) {
        return { kind: 'pass', reason: 'Only static imports added, none used yet: no behavior to test.' }
      }
    }
    return rule(action, ctx)
  }
  Object.defineProperty(wrapped, 'name', { value: rule.name })
  return wrapped
}

function onlyAddsUnusedImports(before: JsNode, after: JsNode): boolean {
  const old = before.children().filter((node) => node.isNamed())
  const now = after.children().filter((node) => node.isNamed())
  const added: number[] = []
  let i = 0
  for (let j = 0; j < now.length; j++) {
    if (i < old.length && now[j]!.text() === old[i]!.text()) i++
    else if (now[j]!.kind() === 'import_statement') added.push(j)
    else return false
  }
  if (i !== old.length || added.length === 0) return false
  const lastDirective = now.reduce((last, node, index) => (isDirective(node) ? index : last), -1)
  const leading = (node: JsNode) => ['import_statement', 'comment'].includes(node.kind()) || isDirective(node)
  if (added.some((j) => j < lastDirective || !now.slice(0, j).every(leading))) return false
  const names = added.flatMap((j) => importedNames(now[j]!))
  if (added.some((j) => importedNames(now[j]!).length === 0)) return false
  const used = new Set<string>()
  for (const node of now) {
    if (node.kind() === 'import_statement') continue
    for (const part of [node, ...descendants(node)]) if (REFERENCES.has(part.kind())) used.add(part.text())
  }
  return names.every((name) => !used.has(name))
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
