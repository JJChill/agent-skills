---
name: user-stories
description: Translates wishes, requests, and requirements into small INVEST user stories — user-visible outcomes in the user's own words, with zero solution or implementation content. Use when capturing a requirement or feature request as stories, when a story reads "as a developer" or prescribes a technical task, when a story is too big to finish within a week or two, or when narrowing vague roles and wishes into precise, negotiable story cards. The agent drafts and challenges; the human owns the need.
---

# User Stories

## Overview

A user story captures something a user wants to be able to do but currently can't, expressed **only** as a user-visible outcome — never as a description of the solution. Requirements-as-instructions ("create a table", "add an endpoint") are programming by remote control; they conflate identifying the need with designing the solution, which are two different, difficult problems. Stories keep them separate: product-minded people define the *need*, the development flow (`specification-by-example` → `acceptance-testing`) turns it into something provable, and the team designs the *solution*.

A story is a placeholder for a conversation, not a contract. The written card records the salient points; the shared understanding is the product.

## When to Use

- Turning a stakeholder request, an idea (`idea-refine`), or an event-storm output (`event-storming`) into workable requirements
- A backlog item reads "as a developer…", "as the company…", or names a technical artifact
- A story can't be finished (to releasable) inside a week or two
- Deciding what the "user" and "want" actually are before examples get written

**When NOT to use:** organizing many existing stories (that's `story-mapping`), deriving acceptance criteria (that's `specification-by-example`), or producing a technical PRD (`spec-driven-development`).

## Working With an AI Agent

The agent drafts, sharpens, and challenges; the human owns the need. Concretely:

- The agent may **propose candidate stories** from a request or an event map, but every story is confirmed by the human before it counts — a plausible-sounding invented need is worse than a missing one.
- The agent **challenges violations** even from the requester: a technical story gets "what does the user get when this is done?"; a vague wish gets "who wants this, what do they want it for, and why?"; a huge story gets a proposed split.
- Underspecified request? Run `interview-me` first — one question at a time, until the need is clear.
- Stories live in the repository (or the project tracker) with title + narrative; the agent keeps titles in glossary terms (`ubiquitous-language`).

## Writing the Story

### The template — training wheels, not a cage

```
As a [type of user], I want [some behavior/goal], so that [some benefit/reason].
```

Use it to brainstorm (who? what? why?), drop it when it hinders. The conversation matters more than the format. Alternative frames that work: "Who wants this? What for? Why?" or Given/When/Then sketches.

- **Narrow the role.** "Invoice submitter" beats "accountant" — a precise role keeps the story small and its examples focused. "User" is almost always too broad.
- **Title in domain language**, short enough to say in conversation ("Pay by Credit Card", never "story 1364" — IDs are for tracking, not talking).
- The full narrative can be fleshed out later, close to implementation, when more is known. Early on, a clear title and a one-line need may be enough to plan with.

### INVEST

| Letter | Meaning | The test |
|---|---|---|
| **I**ndependent | Implementable in any order | Could you do this one next, alone? |
| **N**egotiable | Malleable until work starts | Is anything here fixed that didn't need to be? |
| **V**aluable | Of value to a user/stakeholder | Small value counts; zero value doesn't |
| **E**stimable | You can tell how much work it holds | Can the team gauge it without a spike? |
| **S**mall | Days, not weeks — two weeks is the ceiling | Great stories are a day or two |
| **T**estable | Done = its acceptance criteria pass | Can you imagine a concrete example proving it? |

**Small is the load-bearing property.** Small steps limit the cost of every mistake, multiply feedback opportunities, and make progress visible. If examples multiply when you explore a story, it's telling you to split.

### What a story is NOT

- **A technical task.** "Create a table", "make the code more robust" — behind every legitimate technical task is a user need trying to get out; capture *that*. ("As a developer…" is valid only when developers are the product's actual end users.)
- **A solution description.** "Notified via push notification" bakes in a mechanism; "I want to know about pending authorizations" states the need. Include a mechanism only when it's a genuine constraint, and say why.
- **A vague wish.** "Make more money", "as fast as possible" — these steer story *selection*; they are not stories.
- **A huge project.** If it doesn't fit in two weeks, split it before it enters the plan.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The stakeholder literally asked for a database table" | They asked for what they think the solution is. Ask what the user gets when it exists — that's the story; the table is a design choice the team makes later. |
| "It's a purely technical improvement, there's no user" | Then why do it? Performance, resilience, and upgrades all have a "why" that lands on someone. Find them, or question the work. |
| "This story is big but splitting it feels artificial" | Split by narrower role, thinner outcome, or fewer cases — not by architectural layer. A story that's "of value" (a penny counts) beats one that's "valuable" in a month. |
| "We'll pin down exactly what it means now so there's no ambiguity later" | Over-specifying up front kills Negotiable and pre-empts the design. Precise enough to remember the conversation; the examples (`specification-by-example`) add the precision when it's needed. |
| "The AI can generate the backlog from the brief" | Generated stories encode guessed needs. Candidates, yes — confirmed by the human who owns the need, always. |

## Red Flags

- "As a developer / as the team / as the company…" (outside developer-tool products)
- Story text naming tables, endpoints, services, screens, buttons, or vendors
- A role so broad it fits every story ("as a user…")
- A story estimated in weeks, or one nobody can state a concrete example for
- Story IDs used in conversation instead of titles
- Stories whose meaning exists only in someone's head — no captured narrative, no conversation notes
- An agent-written backlog the domain owner never reviewed

## Verification

For each story, confirm:

- [ ] Expressed as a user-visible outcome in the user's language — zero solution/implementation content (or any included mechanism justified as a real constraint)
- [ ] The role is specific; the "so that" states a genuine why
- [ ] It passes INVEST — small enough for a week or two, independently deliverable, testable
- [ ] Title uses glossary terms and works in conversation
- [ ] The human owning the need confirmed it (not agent-invented)
- [ ] At least one concrete example is imaginable — it's ready for `specification-by-example`
