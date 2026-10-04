import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Which git working tree a `git commit` command records into, so commit
 * gates check that tree rather than the hook's own checkout. Claude Code
 * creates `isolation: "worktree"` sub-agent trees inside the project at
 * .claude/worktrees/<name>/, and a commit there must be judged by that
 * tree's files (issues #39, #57).
 */

// `git commit`, including global options before the subcommand
// (`git -C <dir> commit`, `git -c key=value commit`).
export const GIT_COMMIT = /\bgit(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+commit\b/

export function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

// The directory a `git commit` command acts in: `git -C <dir>`, else a
// leading `cd <dir> &&`, else the hook's own working directory.
export function commitDirectory(command: string): string {
  const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, '$2')
  const gitDashC = command.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)[^;&|]*\bcommit\b/)
  const cd = command.match(/(?:^|&&|;)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)[^]*\bgit\b[^;&|]*\bcommit\b/)
  const target = gitDashC?.[1] ?? cd?.[1]
  if (!target) return process.cwd()
  const dir = unquote(target)
  return isAbsolute(dir) ? dir : resolve(process.cwd(), dir)
}

export function gitToplevel(dir: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/** True when `child` is `parent` itself or lies below it. */
export function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/**
 * The toplevel of the git working tree `command` commits into, when that
 * tree is nested strictly inside `base` (a linked worktree or submodule
 * below the project); otherwise null, meaning "check `base` as usual".
 */
export function nestedCommitTree(command: string, base: string): string | null {
  const dir = commitDirectory(command)
  const top = existsSync(dir) ? gitToplevel(dir) : null
  if (!top) return null
  const [outer, inner] = [canonical(base), canonical(top)]
  return outer !== inner && isWithin(outer, inner) ? inner : null
}
