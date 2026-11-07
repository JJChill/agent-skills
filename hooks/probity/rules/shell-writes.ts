import { readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, posix, relative, resolve } from 'node:path'

import type { Action, RuleEntry, RuleResult } from '@nizos/probity'
import type { Rule } from '@nizos/probity'

import { buildMatcher, isRuleBlock } from './scoping.js'

/**
 * Shell-write screen (issue #79).
 *
 * Probity's content rules judge write actions: Write, Edit and
 * NotebookEdit in Claude Code, the write tool in Kiro. A file changed
 * by a shell command (`sed -i`, `cat > file <<EOF`, `tee`, `cp`, a
 * `python3 - <<'EOF' … open(p, 'w')` script) arrives as a command
 * action, so none of those rules see it. Scripted edits are an
 * ordinary shell idiom, which makes the bypass easy to take by
 * accident.
 *
 * This rule reads a command for the files it writes and denies it when
 * one of them falls inside a files-scoped block, with a redirect to
 * the write tool. It is deterministic and free. It reads the command
 * text only: it does not run it, and it can't see a write made by a
 * script file named on the command line (`python3 tool.py`), through
 * `find -exec`/`xargs`, or to a path computed at run time. Those still
 * pass; see hooks/PROBITY.md.
 */

const SEPARATORS = new Set([';', '&&', '||', '|', '|&', '&', '(', ')', '\n', ';;'])
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>'])
const OPERATORS = [
  '&>>', '<<<', '<<-', '&&', '||', '|&', ';;', '&>', '>>', '>|', '>&', '<<', '<>', '<&',
  ';', '|', '&', '(', ')', '>', '<',
]
export const COMMAND_PREFIXES = new Set([
  'sudo', 'env', 'command', 'exec', 'time', 'nohup', 'nice', 'builtin',
  'do', 'then', 'else', 'elif', 'if', 'while', 'until', '{', '!',
])
const INTERPRETER = /^(?:python(?:\d[\d.]*)?|node|nodejs|ruby|perl|bun|deno|php)$/

/** Script APIs that write a file, across the interpreters above. */
const SCRIPT_WRITE_APIS = [
  // Python
  /\bopen\s*\([^)]*?,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]/,
  /\bopen\s*\([^)]*\bmode\s*=\s*['"][^'"]*[wax+]/,
  /\.write_(?:text|bytes)\s*\(/,
  /\bshutil\.(?:copy\w*|move)\s*\(/,
  /\bos\.(?:replace|rename)\s*\(/,
  /\bfileinput\.\w+\([^)]*inplace/,
  // Node, Bun, Deno
  /\b(?:writeFile|appendFile|createWriteStream|copyFile|rename|writeTextFile)(?:Sync)?\s*\(/,
  /\bBun\.write\s*\(/,
  // Ruby
  /\b(?:File|IO)\.write\s*\(/,
  /\bFile\.open\s*\([^)]*['"][wa]/,
  /\bFileUtils\.(?:cp|mv|copy|move)\b/,
  // Perl, PHP
  /\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*['"]?\+?>/,
  /\bfile_put_contents\s*\(/,
]

type TextSpan = { start: number; end: number }

/** Add the first quoted argument of a call to the ignored literal spans. */
function ignoreFirstLiteral(spans: TextSpan[], match: RegExpMatchArray): void {
  const literal = `${match[1]}${match[2]}${match[1]}`
  const offset = (match.index ?? 0) + match[0].indexOf(literal)
  spans.push({ start: offset, end: offset + literal.length })
}

/**
 * String literals that are inputs to known read-only call sites, or source
 * operands of copy calls, are not write targets. Keep their source spans so
 * an inline script can still be scanned conservatively for other literals.
 */
function nonWriteScriptLiterals(script: string): TextSpan[] {
  const spans: TextSpan[] = []
  const calls = /\bopen\s*\(\s*(['"])([^'"\n]+)\1([^)]*)\)/g
  for (const match of script.matchAll(calls)) {
    const rest = (match[3] ?? '').trim().replace(/^,\s*/, '')
    const modeKeyword = /(?:^|,)\s*mode\s*=/.test(rest)
    const mode = /(?:^|,)\s*mode\s*=\s*(['"])([^'"\n]*)\1/.exec(rest)
    const positionalMode = /^\s*(['"])([^'"\n]*)\1/.exec(rest)
    const firstArgumentIsKeyword = /^(?:encoding|errors|newline|closefd|opener)\s*=/.test(rest)
    const unknownMode =
      (modeKeyword && !mode) || (!modeKeyword && !positionalMode && !!rest && !firstArgumentIsKeyword)
    const modeValue = mode?.[2] ?? positionalMode?.[2]
    const readOnly = !unknownMode && (modeValue === undefined || !/[wax+]/.test(modeValue))
    if (!readOnly) continue
    ignoreFirstLiteral(spans, match)
  }

  for (const match of script.matchAll(
    /\b(?:Path|PurePath)\s*\(\s*(['"])([^'"\n]+)\1\s*\)\s*\.\s*read_(?:text|bytes)\s*\(/g,
  )) {
    ignoreFirstLiteral(spans, match)
  }

  for (const match of script.matchAll(
    /\b(?:readFile|readFileSync|readTextFile)\s*\(\s*(['"])([^'"\n]+)\1/g,
  )) {
    ignoreFirstLiteral(spans, match)
  }

  for (const match of script.matchAll(
    /\b(?:shutil\.copy\w*|FileUtils\.(?:cp|copy)|copyFile)\s*\(\s*(['"])([^'"\n]+)\1/g,
  )) {
    ignoreFirstLiteral(spans, match)
  }

  return spans
}

/**
 * Return string literals from an inline interpreter script while excluding
 * literals used only as read inputs by the supported APIs. Unknown or dynamic
 * write paths remain covered by the surrounding shell-variable/argument scan.
 */
function scriptLiterals(script: string): string[] {
  const nonWrite = nonWriteScriptLiterals(script)
  const literals: string[] = []
  for (const match of script.matchAll(/(['"])([^'"\n]+)\1/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (nonWrite.some((span) => start >= span.start && end <= span.end)) continue
    literals.push(match[2]!)
  }
  return literals
}

type Heredoc = { body: string; expands: boolean }
type Token = { kind: 'word'; text: string; heredoc?: Heredoc; substitutions: string[] } | { kind: 'op'; text: string }

export type SimpleCommand = {
  words: string[]
  redirects: { op: string; target: string }[]
  stdin: string[]
  /** Heredoc bodies the shell expands (unquoted delimiter): `$(…)` and
   *  backticks in them run (issue #121). */
  expandingStdin: string[]
  /** The commands inside the `$(…)` and backticks the shell runs in this
   *  command's words: not single-quoted ones (issue #138). */
  substitutions: string[]
  inputFiles: string[]
  /** The pipeline stage writing to this command's stdin, if any. */
  pipedFrom?: SimpleCommand
}

/** The end of the `$(…)` opening at `start`: the index after its `)`. */
function substitutionEnd(text: string, start: number): number {
  let depth = 0
  let i = start
  for (; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) break
  }
  return i + 1
}

/** The commands inside the `$(…)` and backticks of text the shell
 *  expands as a whole, like an unquoted heredoc body. */
export function substitutionsIn(text: string): string[] {
  const found: string[] = []
  for (let i = 0; i < text.length; ) {
    if (text[i] === '$' && text[i + 1] === '(') {
      const end = substitutionEnd(text, i)
      found.push(text.slice(i + 2, end - 1))
      i = end
    } else if (text[i] === '`') {
      const close = text.indexOf('`', i + 1)
      const stop = close === -1 ? text.length : close
      found.push(text.slice(i + 1, stop))
      i = stop + 1
    } else i++
  }
  return found
}

/** Splits a shell command into words and operators, reading heredoc
 *  bodies into the word token of their delimiter. Quoting is removed;
 *  `$(…)` and backticks stay inside their word as written, and the ones
 *  outside single quotes are also listed as the word's substitutions. */
function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  const pending: { delimiter: string; strip: boolean; target: Heredoc }[] = []
  let word = ''
  let substitutions: string[] = []
  let inWord = false
  let quoted = false
  let expectDelimiter: string | undefined
  let i = 0

  const endWord = () => {
    if (!inWord) return
    if (expectDelimiter) {
      // A quoted delimiter (<<'EOF', <<"EOF", <<\EOF) turns expansion off.
      const target = { body: '', expands: !quoted }
      pending.push({ delimiter: word, strip: expectDelimiter === '<<-', target })
      tokens.push({ kind: 'word', text: word, heredoc: target, substitutions })
      expectDelimiter = undefined
    } else {
      tokens.push({ kind: 'word', text: word, substitutions })
    }
    word = ''
    substitutions = []
    inWord = false
    quoted = false
  }

  const readHeredocs = () => {
    for (const doc of pending) {
      const lines: string[] = []
      while (i < command.length) {
        const end = command.indexOf('\n', i)
        const line = command.slice(i, end === -1 ? command.length : end)
        i = end === -1 ? command.length : end + 1
        const compared = doc.strip ? line.replace(/^\t+/, '') : line
        if (compared === doc.delimiter) break
        lines.push(line)
      }
      doc.target.body = lines.join('\n')
    }
    pending.length = 0
  }

  while (i < command.length) {
    const c = command[i]!
    if (c === '\n') {
      endWord()
      tokens.push({ kind: 'op', text: '\n' })
      i++
      readHeredocs()
      continue
    }
    if (c === ' ' || c === '\t') {
      endWord()
      i++
      continue
    }
    if (c === '#' && !inWord) {
      while (i < command.length && command[i] !== '\n') i++
      continue
    }
    if (c === '\\') {
      if (command[i + 1] === '\n') {
        i += 2
        continue
      }
      word += command[i + 1] ?? ''
      inWord = true
      i += 2
      continue
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? command.length : end
      word += command.slice(i + 1, stop)
      inWord = true
      quoted = true
      i = stop + 1
      continue
    }
    if (c === '"') {
      i++
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '$' && command[i + 1] === '(') {
          // A substitution may hold quotes of its own: `"$(cat <<'EOF' …)"`.
          const end = substitutionEnd(command, i)
          substitutions.push(command.slice(i + 2, end - 1))
          word += command.slice(i, end)
          i = end
          continue
        }
        if (command[i] === '`') {
          const close = command.indexOf('`', i + 1)
          const stop = close === -1 ? command.length : close
          substitutions.push(command.slice(i + 1, stop))
          word += command.slice(i, stop + 1)
          i = stop + 1
          continue
        }
        if (command[i] === '\\' && /["\\$`]/.test(command[i + 1] ?? '')) i++
        word += command[i]
        i++
      }
      i++
      inWord = true
      quoted = true
      continue
    }
    if (c === '$' && command[i + 1] === '(') {
      const end = substitutionEnd(command, i)
      substitutions.push(command.slice(i + 2, end - 1))
      word += command.slice(i, end)
      i = end
      inWord = true
      continue
    }
    if (c === '`') {
      const end = command.indexOf('`', i + 1)
      const stop = end === -1 ? command.length : end
      substitutions.push(command.slice(i + 1, stop))
      word += command.slice(i, stop + 1)
      inWord = true
      i = stop + 1
      continue
    }
    const op = OPERATORS.find((candidate) => command.startsWith(candidate, i))
    if (op) {
      // `2>` and `1>>`: the digits are a file descriptor, not a word.
      if ((op.startsWith('>') || op.startsWith('<')) && inWord && !quoted && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      }
      endWord()
      tokens.push({ kind: 'op', text: op })
      if (op === '<<' || op === '<<-') expectDelimiter = op
      i += op.length
      continue
    }
    word += c
    inWord = true
    i++
  }
  endWord()
  return tokens
}

function parse(tokens: Token[]): SimpleCommand[] {
  const commands: SimpleCommand[] = []
  const empty = (): SimpleCommand => ({ words: [], redirects: [], stdin: [], expandingStdin: [], substitutions: [], inputFiles: [] })
  let current = empty()
  const flush = (pipe: boolean) => {
    const done = current.words.length || current.redirects.length || current.stdin.length ? current : undefined
    if (done) commands.push(done)
    current = empty()
    if (pipe && done) current.pipedFrom = done
  }
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]!
    if (token.kind === 'word') {
      current.words.push(token.text)
      current.substitutions.push(...token.substitutions)
      continue
    }
    if (SEPARATORS.has(token.text)) {
      flush(token.text === '|' || token.text === '|&')
      continue
    }
    const next = tokens[t + 1]
    if (next?.kind !== 'word') continue
    t++
    if (token.text === '<<' || token.text === '<<-') {
      current.stdin.push(next.heredoc?.body ?? '')
      if (next.heredoc?.expands) current.expandingStdin.push(next.heredoc.body)
    } else if (token.text === '<<<') {
      current.stdin.push(next.text)
      current.expandingStdin.push(next.text)
    } else if (token.text === '<') current.inputFiles.push(next.text)
    else if (token.text === '>&' || token.text === '<&') {
      if (!/^(?:\d+|-)$/.test(next.text)) current.redirects.push({ op: '&>', target: next.text })
    } else if (WRITE_REDIRECTS.has(token.text)) current.redirects.push({ op: token.text, target: next.text })
  }
  flush(false)
  return commands
}

/** The simple commands of a shell command line, heredocs read, pipeline
 *  stages linked (`pipedFrom`). Text only: nothing runs. */
export function parseShell(command: string): SimpleCommand[] {
  return parse(tokenize(command))
}

const ASSIGNMENT = /^([A-Za-z_]\w*)=(.*)$/s

function nonOptions(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith('-'))
}

/** The file operands of an in-place `sed` or `perl` call: script
 *  arguments (`-e`/`-f` values, else sed's first operand) and a BSD
 *  `-i ''`/`-i .bak` suffix left out. */
function inPlaceFiles(args: string[], tool: 'sed' | 'perl'): string[] {
  const files: string[] = []
  let scripted = false
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!
    if (/^-[ef]$|^--(?:expression|file)$/.test(arg) || (tool === 'perl' && arg === '-E')) {
      scripted = true
      at++
    } else if (arg === '-i' && tool === 'sed' && /^(?:$|\.)/.test(args[at + 1] ?? '-')) {
      at++
    } else if (/^--(?:expression|file)=/.test(arg)) {
      scripted = true
    } else if (tool === 'perl' && /^-[a-zA-Z]*e$/.test(arg)) {
      scripted = true
      at++
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    }
  }
  return tool === 'sed' && !scripted ? files.slice(1) : files
}

/** The diff's file paths, with git's `a/` and `b/` prefixes removed. */
function patchPaths(text: string): string[] {
  const paths: string[] = []
  for (const match of text.matchAll(/^(?:\+\+\+|---) (\S+)/gm)) {
    const path = match[1]!
    if (path === '/dev/null') continue
    paths.push(path.replace(/^[ab]\//, ''))
  }
  return paths
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The absolute paths a shell command run in `cwd` writes, as far as the
 * command text shows. For an interpreter script that calls a
 * file-writing API, every path the command mentions counts, since the
 * script may name its target through a variable or an argument.
 */
export function shellWritePaths(command: string, cwd: string): string[] {
  return scanShellWrites(command, cwd).paths
}

/** Options of `git worktree add` that take a value (`-b <branch>`, …). */
const WORKTREE_ADD_VALUE_FLAGS = new Set(['-b', '-B', '--reason'])

/**
 * {@link shellWritePaths}, plus the roots of the worktrees the command
 * creates with `git worktree add` (issue #101). A write there lands in a
 * checkout of the same repository, which doesn't exist yet when the hook
 * runs.
 */
function scanShellWrites(command: string, cwd: string): { paths: string[]; worktrees: string[] } {
  const vars = new Map<string, string[]>()
  const found: string[] = []
  const worktrees: string[] = []
  const start = cwd

  const expand = (text: string): string[] => {
    const ref = /\$\{?([A-Za-z_]\w*)\}?/.exec(text)
    if (!ref) return [text]
    const values = vars.get(ref[1]!)
    if (!values) return []
    return values.flatMap((value) => expand(text.replace(ref[0], value)))
  }
  const add = (candidate: string) => {
    for (const text of expand(candidate)) {
      if (!text || text.includes('$(') || text.includes('`')) continue
      found.push(resolve(cwd, text.replace(/^~(?=\/)/, process.env.HOME ?? '~')))
    }
  }
  const destination = (sources: string[], dest: string) => {
    for (const target of expand(dest)) {
      if (target.endsWith('/') || isDirectory(resolve(cwd, target))) {
        for (const source of sources) add(join(target, basename(source)))
      } else {
        add(target)
      }
    }
  }

  for (const simple of parse(tokenize(command))) {
    for (const redirect of simple.redirects) add(redirect.target)

    let words = [...simple.words]
    while (words.length && ASSIGNMENT.test(words[0]!)) {
      const [, name, value] = ASSIGNMENT.exec(words.shift()!)!
      vars.set(name!, expand(value!))
    }
    while (words.length && (COMMAND_PREFIXES.has(words[0]!) || ASSIGNMENT.test(words[0]!) || /^-/.test(words[0]!))) {
      words.shift()
    }
    if (!words.length) continue
    const name = basename(words[0]!)
    const args = words.slice(1)

    if (name === 'export' || name === 'local' || name === 'declare' || name === 'readonly') {
      for (const arg of args) {
        const assignment = ASSIGNMENT.exec(arg)
        if (assignment) vars.set(assignment[1]!, expand(assignment[2]!))
      }
    } else if (name === 'for') {
      const inAt = args.indexOf('in')
      if (args[0] && inAt !== -1) vars.set(args[0], args.slice(inAt + 1).filter((arg) => arg !== 'do'))
    } else if (name === 'cd') {
      const target = expand(args[0] ?? start)[0]
      if (target) cwd = resolve(cwd, target)
    } else if (name === 'tee') {
      nonOptions(args).forEach(add)
    } else if (name === 'sed' || name === 'gsed') {
      const inPlace = args.some((arg) => /^--in-place/.test(arg) || /^-[a-zA-Z]*i/.test(arg))
      if (inPlace) inPlaceFiles(args, 'sed').forEach(add)
    } else if (name === 'perl' && args.some((arg) => /^-[a-zA-Z]*i/.test(arg))) {
      inPlaceFiles(args, 'perl').forEach(add)
    } else if (name === 'cp' || name === 'mv' || name === 'install' || name === 'ln' || name === 'rsync') {
      const targetDir = args.findIndex((arg) => arg === '-t' || arg === '--target-directory')
      const paths = nonOptions(args)
      if (targetDir !== -1 && args[targetDir + 1]) {
        destination(paths.filter((path) => path !== args[targetDir + 1]), `${args[targetDir + 1]}/`)
      } else if (paths.length >= 2) {
        destination(paths.slice(0, -1), paths[paths.length - 1]!)
      }
    } else if (name === 'dd') {
      for (const arg of args) if (arg.startsWith('of=')) add(arg.slice(3))
    } else if (name === 'truncate') {
      nonOptions(args).forEach(add)
    } else if (name === 'git' && args.includes('worktree')) {
      // `git [-C <dir>] worktree add [options] <path> [<commit-ish>]`
      const dirFlag = args.indexOf('-C')
      const base = dirFlag !== -1 && args[dirFlag + 1] ? resolve(cwd, args[dirFlag + 1]!) : cwd
      const sub = args.slice(args.indexOf('worktree') + 1)
      if (sub[0] === 'add') {
        for (let at = 1; at < sub.length; at++) {
          const arg = sub[at]!
          if (WORKTREE_ADD_VALUE_FLAGS.has(arg)) at++
          else if (!arg.startsWith('-')) {
            for (const path of expand(arg)) worktrees.push(resolve(base, path))
            break
          }
        }
      }
    } else if (name === 'patch' || (name === 'git' && args[0] === 'apply')) {
      const files = name === 'git' ? nonOptions(args.slice(1)) : []
      const patchFile = args.findIndex((arg) => arg === '-i' || arg === '--input')
      if (patchFile !== -1 && args[patchFile + 1]) files.push(args[patchFile + 1]!)
      const texts = [
        ...simple.stdin,
        ...[...files, ...simple.inputFiles].flatMap(expand).map((file) => readText(resolve(cwd, file))),
      ]
      texts.flatMap(patchPaths).forEach(add)
    } else if (INTERPRETER.test(name)) {
      const inline = args.flatMap((arg, at) => (/^-[a-zA-Z]*[ce]$/.test(arg) ? [args[at + 1] ?? ''] : []))
      const script = [...simple.stdin, ...inline].join('\n')
      if (!SCRIPT_WRITE_APIS.some((api) => api.test(script))) continue
      scriptLiterals(script).forEach(add)
      args.filter((arg) => !arg.startsWith('-') && !inline.includes(arg)).forEach(add)
      for (const values of vars.values()) values.forEach(add)
    }
  }
  return { paths: [...new Set(found)], worktrees }
}

function within(base: string, absolute: string): string | undefined {
  const rel = relative(base, absolute).split(/[\\/]/).join(posix.sep)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : undefined
}

/**
 * The `root`-relative POSIX paths a shell command run in `cwd` (default:
 * `root`) writes inside `root`; see {@link shellWritePaths}. A path under
 * a worktree the command creates counts relative to that worktree's
 * root, since it is a checkout of the same repository (issue #101).
 */
export function shellWriteTargets(command: string, root: string, cwd: string = root): string[] {
  const { paths, worktrees } = scanShellWrites(command, cwd)
  const inside: string[] = []
  for (const absolute of paths) {
    const rel = within(root, absolute) ?? worktrees.map((tree) => within(tree, absolute)).find(Boolean)
    if (rel) inside.push(rel)
  }
  return [...new Set(inside)]
}

/** The directory a command runs in: the hook's `PROBITY_SESSION_CWD` when absolute, else `root`. */
function sessionCwd(root: string): string {
  const cwd = process.env.PROBITY_SESSION_CWD
  return cwd && isAbsolute(cwd) ? cwd : root
}

/**
 * Denies a shell command that writes a file inside any of `scopes` —
 * the `files` lists of the config's files-scoped blocks, each with its
 * own `!`-negations — so the edit goes through the write tool, where
 * the content rules judge it. Write actions pass: they are judged
 * already.
 *
 * Applies to: command actions (Claude Code's Bash, Kiro's shell
 * through the Kiro shim). Relative paths resolve from the session's
 * cwd, which probity-claude passes as `PROBITY_SESSION_CWD`; without it,
 * from `root`.
 */
export function forbidShellWritesToScopedFiles(options: {
  /** The directory the scope globs are relative to; default: the hook
   *  process's working directory, the project root. */
  root?: string
  scopes: readonly (readonly string[])[]
}): Rule {
  const root = options.root ?? process.cwd()
  const matchers = options.scopes.map((globs) => buildMatcher(globs))
  return function forbidShellWritesToScopedFiles(action: Action): RuleResult {
    if (action.kind !== 'command') return { kind: 'pass' }
    const scoped = shellWriteTargets(action.command, root, sessionCwd(root)).filter((path) =>
      matchers.some((matches) => matches(path) || matches(join(root, path))),
    )
    if (!scoped.length) return { kind: 'pass' }
    return {
      kind: 'violation',
      reason:
        `This shell command writes ${scoped.join(', ')}, which Probity's ` +
        'content rules cover. A file changed from the shell (a redirect, ' +
        'sed -i, perl -i, tee, cp/mv, a patch, or a python/node/ruby ' +
        'script) skips those rules. Make the change with the Edit or ' +
        'Write tool (in Kiro, the write tool) so the rules can judge it.',
    }
  }
}

/**
 * Puts {@link forbidShellWritesToScopedFiles} first in a preset's
 * entries, screening every files-scoped block's globs. Call it after
 * `withExcludeGlobs`, so excluded paths stay writable from the shell.
 * `enabled: false` returns the entries unchanged.
 */
export function withShellWriteScreen(
  entries: readonly RuleEntry[],
  options: { root?: string; enabled?: boolean } = {},
): RuleEntry[] {
  if (options.enabled === false) return [...entries]
  const scopes = entries.flatMap((entry) => (isRuleBlock(entry) && entry.files ? [[...entry.files]] : []))
  if (!scopes.length) return [...entries]
  return [forbidShellWritesToScopedFiles({ root: options.root, scopes }), ...entries]
}
