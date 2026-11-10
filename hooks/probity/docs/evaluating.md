# Evaluating the rules

How this package tests its own enforcement: a scripted episode that drives every rule, and a labelled judge set that measures the AI judges. Both live in [`evals/`](../evals/). Run `npm install` in `hooks/probity/` once, so `tsx` and `@nizos/probity` resolve.

Back to the [overview](../../PROBITY.md).

## The workflow episode

[`evals/workflow-eval.ts`](../evals/workflow-eval.ts) drives a made-up feature (parcel tracking) through the whole outside-in loop, as 48 synthetic actions run through the real rules. Each step asserts the expected decision and the rule that fired. The episode covers:

- **Specs and glossary:**
  - glossary and spec writes;
  - a glossary-conflicting spec, a UI-leaking spec and a backend-naming scenario, all blocked;
  - a used-term glossary rename (blocked) and an unused-term retirement (allowed).
- **Spec-first:**
  - a tagless acceptance test and a tag citing a missing scenario, both blocked at write time;
  - a tagged acceptance test, passed by the fast path;
  - a covered-scenario rename, blocked.
- **TDD:**
  - premature production code, blocked;
  - a red run, then a minimal implementation.
- **Core purity:** a vendor import, a direct clock read and a mocking-library import, each blocked.
- **Commits:**
  - a commit before tests (blocked) and one on green (allowed);
  - wip promotion without a test: parity-blocked, then baselined and allowed (the incremental-adoption path).
- **Round-trips:**
  - a mutation probe: allowed with no TDD call, the commit blocked while the probe is on disk, then allowed after reversion;
  - a driver scope: a misspelled `[system]` tag and a tag without system-suite coverage, both commit-blocked, then allowed once a thin system-driver test claims the scenario.

Two guarantees beyond outcomes:

- **Rule order.** Deterministically blocked steps also assert that no AI judge was consulted, pinning the deterministic-before-AI order.
- **Honest file state.** Correctly blocked actions aren't materialized, as a real hook prevents them.

**Scoping.** The episode runs the rule entries `probity.config.kmp.ts` exports (`kmpRuleEntries`), resolving each block's `files` globs with [`rules/scoping.ts`](../rules/scoping.ts), a pinned replica of Probity's picomatch matcher and glob anchoring. Four steps are deliberately **out of scope** but carry content the core rules would block:

- a Room adapter with a vendor import and a real clock read;
- a Koin DI module;
- a mechanics-laden `TrackingRobot.kt` and its split-layout `TrackingViewModelDriver.kt` twin.

These assert not just `allow` but that no AI judge was consulted (`expectAiSilent`). An eroded exclusion or an over-broad core glob in the template fails the eval instead of shipping.

**Two modes:**

- **`npm run eval`** (`npx tsx evals/workflow-eval.ts`): scripted verdicts. CI-safe and deterministic. It exercises the wiring, the rule order and every deterministic rule exactly; the AI rules' *invocation* is checked while their verdicts are assumed.
- **`npx tsx evals/workflow-eval.ts --live`**: real verdicts through the `claude` CLI, about a dozen model calls. It also tests the AI rules' prompts: does `enforceTdd` block the premature write and pass the post-red minimal one, and does the Language Test catch the click-the-button scenario. Live mode asserts outcomes only, since a write violating several rules may block on whichever rule runs first, as in a real session.

## The labelled judge set

The episode's live mode asks about a dozen prompts once each, so it can't show whether a judge change made the TDD gate leakier. [`evals/judge-cases.ts`](../evals/judge-cases.ts) is a labelled set for that. Its cases are synthetic, built from judge misverdicts reported in the field ([#169](https://github.com/JJChill/agent-skills/issues/169)–[#171](https://github.com/JJChill/agent-skills/issues/171), the medium-effort leaks under [Choosing the AI judge](options.md#choosing-the-ai-judge-ai), [#200](https://github.com/JJChill/agent-skills/issues/200)). Each has the verdict a correct judge gives and the judging task it is for.

[`evals/judge-set.ts`](../evals/judge-set.ts) runs every case through its preset's real rules with a judge that records the prompt instead of answering, so the set always holds the prompts today's rules send.

- **In CI** (`npm test`, no model calls), it checks that every case still reaches the judge it is labelled for. A case that a deterministic rule or fast path now decides fails the PR; fix or drop it.
- **Before a release** that changes a judge prompt, a judged rule's wiring or the default judge, run this:

  ```sh
  npm run eval:judge -- --judge claude --model claude-opus-5-5 --repeat 3
  ```

  It writes the set to `.probity/judge-set.jsonl` and replays it with `probity-shadow-replay`, which reads a labelled set as one whose primary verdicts are the expected ones. The report is the shadow report's, per judging task with 95% upper bounds:
  - **leaks:** writes labelled `violation` that the judge passed;
  - **friction:** writes labelled `pass` that it denied.

  `--show leaks` lists the case ids. `--repeat` asks each prompt more than once, since one judge can answer the same prompt both ways ([#169](https://github.com/JJChill/agent-skills/issues/169)). Each case costs one judge call per repeat.

Add a case for every judge misverdict reported from the field, reduced to a synthetic one: field transcripts and shadow logs hold project code, which doesn't belong in this repository.

## What the harness doesn't cover

- **Probity's own engine:** hook payload parsing and transcript adapters.
- **Matcher drift.** Any drift between `rules/scoping.ts` and the engine's matcher across Probity upgrades. The replica exists because Probity doesn't export its matcher; it is pinned to a version and says what to diff on an upgrade.
- **Your config.** A mis-scoped glob in your edited config is the scope report's job, not the eval's. Run `npx probity-scope-report` against your real tree at setup and whenever the layout changes.
