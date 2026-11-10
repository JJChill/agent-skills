# agent-skills

This is the agent-skills project — a collection of production-grade engineering skills for AI coding agents — in the [`JJChill/agent-skills`](https://github.com/JJChill/agent-skills) fork, which is the repository of record. It carries the upstream skill catalog plus the Probity enforcement layer (`hooks/`, the `@jjchill/probity-rules` package).

> **Scope:** This file configures agents working on this repository itself, not other projects. Don't copy it into another project or a global agent configuration; the reusable assets are the skills in `skills/`.

## Project Structure

```
skills/       → Core skills (SKILL.md per directory)
agents/       → Reusable agent personas (code-reviewer, test-engineer, security-auditor, web-performance-auditor, design-conformance-reviewer, observability-coverage-auditor, domain-expert-proxy, product-owner-proxy)
hooks/        → Session lifecycle hooks
.claude/commands/ → Slash commands (/spec, /plan, /build, /test, /review, /code-simplify, /ship; plus /webperf specialist audit)
references/   → Supplementary checklists (testing, performance, security, accessibility, observability)
evals/        → Skill eval cases + framework (see evals/README.md)
docs/         → Setup guides for different tools
```

## Upstreams

This fork tracks two upstream projects. Both are sources to pull updates from, not targets: work is not sent back to them. Check both when looking for updates to carry in:

- [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills) — the parent repository for the skill catalog itself. The clone has no remote for it; fetch it by URL (`git fetch https://github.com/addyosmani/agent-skills main`) or add one locally when carrying changes in.
- [`nizos/probity`](https://github.com/nizos/probity) — the PreToolUse rule engine that `hooks/PROBITY.md` and the `hooks/probity/` enforcement templates build on. Its releases can change rule behavior the templates depend on.

## Skills by Phase

**Define:** interview-me, idea-refine, event-storming, user-stories, story-mapping, specification-by-example, spec-driven-development, ubiquitous-language
**Plan:** planning-and-task-breakdown
**Build:** incremental-implementation, test-driven-development, context-engineering, source-driven-development, doubt-driven-development, frontend-ui-engineering, ios-development, api-and-interface-design, ports-and-adapters
**Verify:** acceptance-testing, browser-testing-with-devtools, debugging-and-error-recovery
**Review:** code-review-and-quality, code-simplification, security-and-hardening, performance-optimization
**Ship:** git-workflow-and-versioning, ci-cd-and-automation, deprecation-and-migration, documentation-and-adrs, observability-and-instrumentation, shipping-and-launch

## Conventions

- Every skill lives in `skills/<name>/SKILL.md`
- YAML frontmatter with `name` and `description` fields
- Description starts with what the skill does (third person), followed by trigger conditions ("Use when...")
- Every skill has: Overview, When to Use, Process, Common Rationalizations, Red Flags, Verification
- Shared references are in the root `references/` directory; the emerging convention for self-contained, distributable skills keeps a skill's own references inside `skills/<name>/references/`
- Supporting files only created when content exceeds 100 lines

## Contributing

Before adding a new skill or significantly reworking an existing one, run the pre-flight checks in [CONTRIBUTING.md](CONTRIBUTING.md#before-proposing-a-new-skill): search the catalog, check open PRs, confirm the idea fits [docs/skill-anatomy.md](docs/skill-anatomy.md), and justify the gap. Prefer extending an existing skill over adding a near-duplicate. CONTRIBUTING.md is the single source of truth for this workflow; do not restate its checklist here or elsewhere, link to it.

## Commands

- Validate: `node scripts/validate-skills.js` (SKILL.md frontmatter and anatomy) and `node scripts/validate-reference-links.js`
- Evals: `node scripts/run-evals.js` — trigger/routing evals for every skill (CI); `--behavioral <skill>` for graded runs
- Probity package (`cd hooks/probity`, `npm install` once): `npm run typecheck`, `npm test`, `npm run test:kiro`, `npm run eval` (the scripted workflow eval). Before a release that changes a judge, `npm run eval:judge` replays the labelled judge set (model calls; see `hooks/probity/README.md`, "Releasing")

## Pull Requests

PRs target `main` on [`JJChill/agent-skills`](https://github.com/JJChill/agent-skills) (remote `origin`). Nothing is proposed to `addyosmani/agent-skills`.

- Before opening a PR, search this repository's open PRs and issues for work that touches the same files or rules. If any overlaps, coordinate (build on it, align your rules with it, or rebase after it merges) instead of opening a conflicting PR.
- Prefer small, focused PRs over large refactors of widely shared files (for example, files under `scripts/`), which are more likely to collide with in-flight work.

## Boundaries

- Always: Run the CONTRIBUTING.md pre-flight checks before creating a new skill directory
- Always: Follow the skill-anatomy.md format for new skills
- Always: Check this repo's open PRs and issues for overlap before opening a new PR
- Never: Add skills that are vague advice instead of actionable processes
- Never: Duplicate content between skills — reference other skills instead
