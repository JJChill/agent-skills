---
name: specification-by-example
description: Derives a story's acceptance criteria as concrete examples — positive and negative cases refined collaboratively with the domain expert into the smallest representative set — ready to become executable specifications. Use when a user story needs acceptance criteria, when a requirement is stated abstractly and needs illustrating with real cases, when edge cases and boundaries are undiscovered, or when example counts balloon and signal a story that must split. The agent proposes candidate examples as questions; the domain expert rules on every one.
---

# Specification by Example

## Overview

Abstract statements hide ambiguity; **concrete examples expose it**. Specification by example turns a user story's goal into acceptance criteria by collecting realistic cases — "when I add 'Continuous Delivery' by Dave Farley and Jez Humble to my cart, delivery is free" — and refining them with the domain expert until the smallest set remains that still tells the whole truth, boundaries and refusals included.

Each surviving example is an acceptance criterion, and each becomes one executable specification (`acceptance-testing`). The examples illustrate **outcomes in the domain's language** — never UI steps, never the logic that produces the outcome. This is the last translation step before automation: requirements shouldn't specify solutions; they define goals, and examples make those goals precise enough to prove.

## When to Use

- A story (`user-stories`) is ready for its acceptance criteria
- A stakeholder statement is abstract ("free delivery for Dave's books") and needs pinning down
- Boundaries are unclear: what about co-authors? international addresses? mixed carts?
- Deciding whether a story is small enough — examples are the best sizing instrument

**When NOT to use:** automating the examples (that's `acceptance-testing`), exhaustive input-variation coverage (unit tests via `test-driven-development`), or writing the story itself (`user-stories`).

## The Process

### 1. Anchor on the goal

Restate the story's goal in one sentence in domain language. Examples that don't demonstrate this goal don't belong in this story.

### 2. Illustrate with concrete examples

For the goal, collect realistic cases that — if demonstrably present in the software — prove the need is met. Make them **specific**: real-ish book titles, actual amounts, named contexts.

```
Story: free delivery on Dave's books (domestic)

- Add "Modern Software Engineering" by Dave Farley → delivery is free
- Add "Specification by Example" by Gojko Adzic  → delivery is NOT free
```

### 3. Interrogate the examples — this is where the value is

Each example is a question generator. Ask, and let the *domain expert* answer:

```
"Free to anywhere?"            → expert: domestic only
  → NEW: NZ home address, add Dave's book        → NOT free
"What if Dave co-authored?"    → expert: still counts
  → NEW: add "Continuous Delivery" (Farley & Humble) → free
"A book of Dave's AND a guitar amp in the cart?" → expert decides…
```

- **Negative examples are mandatory.** When the feature *doesn't* apply is half the specification; a set with no "NOT" cases hasn't found the boundary.
- **Every question the examples raise is either answered by the expert or recorded as an open question.** Unanswered ambiguity written down beats invented precision.

### 4. Refine to the representative minimum

Start abundant, then cut to the smallest set that still highlights every interesting distinction. Representative, not exhaustive: once "no free delivery for guitar amps" is established, a lawnmower example adds nothing. Variations that don't cross a behavioral boundary are unit-test territory, not acceptance criteria.

**Sizing signal:** if a story needs a large pile of examples to cover its facets, the story is too big — send it back to `user-stories` to split, taking the example clusters as the natural seams.

### 5. Shape each example for automation

Each surviving example should already read like a specification:

- **Domain language throughout** — glossary terms verbatim (`ubiquitous-language`); it must pass the least-technical-person test
- **Outcome-focused** — no screens, clicks, endpoints, or how-the-logic-works; state context, action, result (Given/When/Then fits naturally)
- **One outcome per example**
- Hand the set to `acceptance-testing`: one executable specification per example, written before the production code

## Working With an AI Agent

The division of labor is strict, and it's the point of the practice:

- **The agent generates candidate examples and probing questions** — it is genuinely good at enumerating boundary candidates (empty carts, co-authors, foreign addresses, repeated submissions). Every candidate is phrased as a question.
- **The domain expert rules on every example.** Whether delivery to New Zealand is free is a *business fact*; an agent that fills it in has manufactured a requirement. No example enters the accepted set without a human ruling.
- The agent maintains the artifact — examples recorded with the story, open questions flagged — and keeps the language inside the glossary.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The rule is clear — 'free delivery on Dave's books' — we don't need examples" | Clear until the first co-authored book, foreign address, or mixed cart. The rule felt clear *because* nobody had asked yet; examples are how you ask. |
| "Positive cases are enough; nobody buys guitar amps here" | The negative cases are the boundary, and the boundary is where production bugs live. A criterion set with no NOT-cases is half a specification. |
| "More examples = more coverage, keep them all" | Past the boundary-revealing set, examples obscure intent and multiply maintenance. Refine down; push variations into unit tests. |
| "The agent can infer the edge-case answers, it knows how shops work" | It knows how *typical* shops work. Your business's answer to "co-authored books?" is a decision, not an inference. Record the question; get the ruling. |
| "We'll firm up the examples once the code shows us the real behavior" | Backwards — that documents the implementation instead of specifying the need, and the definition of done arrives after "done". |

## Red Flags

- Acceptance criteria as abstract restatements of the story ("delivery should be free where applicable") instead of concrete cases
- No negative examples anywhere in the set
- Examples mentioning screens, buttons, endpoints, tables, or internal logic
- An example set that grew past a dozen with no story-split conversation
- Business rulings (boundaries, exceptions) filled in by the agent rather than the domain expert
- Open questions resolved by silent assumption instead of being written down
- Accepted examples that never become executable specifications

## Verification

Before handing off to `acceptance-testing`, confirm:

- [ ] Every example is concrete (real values, named context) and demonstrates the story's goal
- [ ] Negative cases mark each boundary the questioning uncovered
- [ ] The set is the refined minimum — each example teaches a distinction the others don't
- [ ] Every example is expert-ruled; open questions are recorded, not assumed away
- [ ] Language is glossary-verbatim, outcome-only, one outcome per example
- [ ] Example volume was checked as a sizing signal — oversized stories went back to `user-stories`
- [ ] The accepted set is committed with the story, queued to become one executable specification each
