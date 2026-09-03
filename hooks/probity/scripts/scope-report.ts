#!/usr/bin/env node
/**
 * Scoping dry-run for a Probity config: shows which files each
 * `{ files, rules }` block actually claims in YOUR repo, before the
 * first agent session finds out the hard way.
 *
 * Wrong glob scoping is the template set's main failure mode, and it
 * fails in two directions: over-scoping is loud (enforcePortsBoundary
 * pointed at adapter files blocks work those files are supposed to
 * do), but under-scoping is silent — a glob slightly too narrow for
 * your layout means enforcement simply never fires, and nothing
 * notices. This report surfaces both at setup time:
 *
 *   - DEAD SCOPE: a block whose globs match zero files
 *   - core-purity rules claiming adapter/DI/UI-looking paths
 *   - the acceptance-language rule claiming Robot/driver/DSL files
 *
 * Globs are resolved exactly as Probity resolves them — anchoring and
 * picomatch semantics come from rules/scoping.ts, the same replica
 * the workflow eval uses.
 *
 * Usage (from your project root, next to your probity.config.ts):
 *
 *   npx probity-scope-report [--config probity.config.ts]
 *                             [--root .] [--strict]
 *
 * --config defaults to probity.config.{ts,mts,js,mjs} found in
 * --root; --root defaults to the current working directory. --strict
 * exits 1 when any warning fires (for CI); otherwise warnings are
 * advisory and the exit code is 0.
 *
 * The config is loaded via jiti — the same TypeScript loader Probity
 * itself uses — rather than a bare dynamic `import()` of a .ts file,
 * so this works whether the consumer's config is .ts, .mts, .js, or
 * .mjs, with no separate build step for the config itself.
 */
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { createJiti } from 'jiti'

import type { Config, RuleBlock } from '@nizos/probity'

import { anchorGlob, buildMatcher, isRuleBlock } from '../rules/scoping.js'

const jiti = createJiti(import.meta.url)

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'build',
  '.gradle',
  'out',
  'dist',
  '.idea',
])
const SAMPLE_LIMIT = 6

// Paths a core-purity rule should normally NOT claim (adapters, DI,
// UI, platform source sets) and a spec-language rule should normally
// NOT claim (layer-2 drivers). Heuristics: a hit is a warning to
// review, not proof of misconfiguration.
const CORE_RULES = /PortsBoundary|forbidNewAmbientEffects|forbidContentPattern/
const ADAPTERISH_SEGMENT = /^(adapter|adapters|infra|infrastructure|ui|di)$/
const LANGUAGE_RULES = /AcceptanceLanguage/
const DRIVERISH_FILE = /(Robot|Driver|Dsl)\.\w+$|[/\\](drivers?|dsl)[/\\]/

function parseArgs(argv: string[]): { config?: string; root?: string; strict: boolean } {
  const out: { config?: string; root?: string; strict: boolean } = { strict: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') out.config = argv[++i]
    else if (argv[i] === '--root') out.root = argv[++i]
    else if (argv[i] === '--strict') out.strict = true
    else {
      console.error(`Unknown argument: ${argv[i]}`)
      process.exit(2)
    }
  }
  return out
}

function findConfig(dir: string): string {
  for (const ext of ['ts', 'mts', 'js', 'mjs']) {
    const candidate = join(dir, `probity.config.${ext}`)
    if (existsSync(candidate)) return candidate
  }
  console.error(`No probity.config.{ts,mts,js,mjs} in ${dir} — pass --config.`)
  process.exit(2)
}

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
      out.push(join(dir, entry.name).replace(/\\/g, '/'))
    }
  }
  return out
}

function ruleNames(block: RuleBlock): string {
  return block.rules.map((rule) => rule.name || '(unnamed)').join(', ')
}

const args = parseArgs(process.argv.slice(2))
const root = resolve(args.root ?? process.cwd())
const configPath = resolve(args.config ?? findConfig(root))
const configDir = dirname(configPath)

const config = await jiti.import<Config>(configPath, { default: true })
const tree = walk(root)

console.log(`Scope report for ${configPath}`)
console.log(`Repo root: ${root} (${tree.length} files scanned)\n`)

const warnings: string[] = []
const claimed = new Set<string>()
let flatRules = 0

for (const [index, entry] of config.rules.entries()) {
  if (!isRuleBlock(entry)) {
    flatRules++
    continue
  }
  const label = `block ${index + 1} [${ruleNames(entry)}]`
  if (!entry.files) {
    console.log(`${label}\n  files: (none) — applies to every write\n`)
    continue
  }
  // Anchor against the config's directory, exactly as loadConfig does.
  const globs = entry.files.map((glob) => anchorGlob(glob, configDir))
  const matched = tree.filter(buildMatcher(globs))
  matched.forEach((file) => claimed.add(file))

  console.log(label)
  // Per-glob counts are informational: a template can legitimately
  // carry globs for layouts a given repo doesn't use (e.g. classic
  // src/main alongside KMP source sets) — only a whole-block zero is
  // a warning.
  for (const glob of entry.files) {
    const count = glob.startsWith('!')
      ? null
      : tree.filter(buildMatcher([anchorGlob(glob, configDir)])).length
    console.log(`  ${glob}${count === null ? '' : `  (${count})`}`)
  }
  console.log(`  → ${matched.length} file(s)`)
  for (const file of matched.slice(0, SAMPLE_LIMIT)) console.log(`      ${relative(root, file)}`)
  if (matched.length > SAMPLE_LIMIT) console.log(`      …and ${matched.length - SAMPLE_LIMIT} more`)
  console.log('')

  if (matched.length === 0) {
    warnings.push(
      `DEAD SCOPE: ${label} matches no files — these rules will never fire. ` +
        'Adjust the globs to your layout (this is the silent failure mode).',
    )
  }
  if (CORE_RULES.test(ruleNames(entry))) {
    const suspicious = matched.filter((file) =>
      relative(root, file).split(/[/\\]/).some((segment) => ADAPTERISH_SEGMENT.test(segment)),
    )
    if (suspicious.length > 0) {
      warnings.push(
        `${label} claims ${suspicious.length} adapter/DI/UI-looking file(s), e.g. ` +
          `${relative(root, suspicious[0]!)} — core-purity rules pointed at adapters ` +
          'block work those files are supposed to do. Exclude them (negation globs) ' +
          'or confirm these paths really are core.',
      )
    }
  }
  if (LANGUAGE_RULES.test(ruleNames(entry))) {
    const suspicious = matched.filter((file) => DRIVERISH_FILE.test(file))
    if (suspicious.length > 0) {
      warnings.push(
        `${label} claims ${suspicious.length} driver/DSL-looking file(s), e.g. ` +
          `${relative(root, suspicious[0]!)} — layer-2 drivers are supposed to contain ` +
          'the mechanics the Language Test blocks. Exclude them (e.g. !**/*Robot.kt).',
      )
    }
  }
}

if (flatRules > 0) {
  console.log(`${flatRules} flat rule(s) apply to every action (no files scope).\n`)
}
console.log(
  `${claimed.size}/${tree.length} files are claimed by at least one files-scoped block.\n`,
)

if (warnings.length === 0) {
  console.log('No scoping warnings.')
} else {
  console.log(`${warnings.length} warning(s):\n`)
  for (const warning of warnings) console.log(`  ⚠ ${warning}\n`)
}
process.exit(args.strict && warnings.length > 0 ? 1 : 0)
