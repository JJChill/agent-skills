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
const COMMAND_PREFIXES = new Set([
  'sudo', 'env', 'command', 'exec', 'time', 'nohup', 'nice', 'builtin',
  'do', 'then', 'else', 'elif', 'if', 'while', 'until', '{', '!',
])
const INTERPRETER = /^(?:python(?:\d[\d.]*)?|node|nodejs|ruby|perl|bun|deno|php)$/

/** Script APIs that write a file, across the interpreters above. */
const SCRIPT_WRITE_APIS = [
  // Python
  /\bopen\s*\([^)]*?,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]/,
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

type Token = { kind: 'word'; text: string; heredoc?: { body: string } } | { kind: 'op'; text: string }

type SimpleCommand = {
  words: string[]
  redirects: { op: string; target: string }[]
  stdin: string[]
  inputFiles: string[]
}

/** Splits a shell command into words and operators, reading heredoc
 *  bodies into the word token of their delimiter. Quoting is removed;
 *  `$(…)` and backticks stay inside their word as written. */
function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  const pending: { delimiter: string; strip: boolean; target: { body: string } }[] = []
  let word = ''
  let inWord = false
  let quoted = false
  let expectDelimiter: string | undefined
  let i = 0

  const endWord = () => {
    if (!inWord) return
    if (expectDelimiter) {
      const target = { body: '' }
      pending.push({ delimiter: word, strip: expectDelimiter === '<<-', target })
      tokens.push({ kind: 'word', text: word, heredoc: target })
      expectDelimiter = undefined
    } else {
      tokens.push({ kind: 'word', text: word })
    }
    word = ''
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
      let depth = 0
      const start = i
      for (; i < command.length; i++) {
        if (command[i] === '(') depth++
        else if (command[i] === ')' && --depth === 0) break
      }
      word += command.slice(start, ++i)
      inWord = true
      continue
    }
    if (c === '`') {
      const end = command.indexOf('`', i + 1)
      const stop = end === -1 ? command.length : end
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
  let current: SimpleCommand = { words: [], redirects: [], stdin: [], inputFiles: [] }
  const flush = () => {
    if (current.words.length || current.redirects.length || current.stdin.length) commands.push(current)
    current = { words: [], redirects: [], stdin: [], inputFiles: [] }
  }
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]!
    if (token.kind === 'word') {
      current.words.push(token.text)
      continue
    }
    if (SEPARATORS.has(token.text)) {
      flush()
      continue
    }
    const next = tokens[t + 1]
    if (next?.kind !== 'word') continue
    t++
    if (token.text === '<<' || token.text === '<<-') current.stdin.push(next.heredoc?.body ?? '')
    else if (token.text === '<<<') current.stdin.push(next.text)
    else if (token.text === '<') current.inputFiles.push(next.text)
    else if (token.text === '>&' || token.text === '<&') {
      if (!/^(?:\d+|-)$/.test(next.text)) current.redirects.push({ op: '&>', target: next.text })
    } else if (WRITE_REDIRECTS.has(token.text)) current.redirects.push({ op: token.text, target: next.text })
  }
  flush()
  return commands
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
  const vars = new Map<string, string[]>()
  const found: string[] = []
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
      for (const literal of script.matchAll(/(['"])([^'"\n]+)\1/g)) add(literal[2]!)
      args.filter((arg) => !arg.startsWith('-') && !inline.includes(arg)).forEach(add)
      for (const values of vars.values()) values.forEach(add)
    }
  }
  return [...new Set(found)]
}

/**
 * The `root`-relative POSIX paths a shell command run in `cwd` (default:
 * `root`) writes inside `root`; see {@link shellWritePaths}.
 */
export function shellWriteTargets(command: string, root: string, cwd: string = root): string[] {
  const inside: string[] = []
  for (const absolute of shellWritePaths(command, cwd)) {
    const rel = relative(root, absolute).split(/[\\/]/).join(posix.sep)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) inside.push(rel)
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
