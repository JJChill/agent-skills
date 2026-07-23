---
name: event-storming
description: Facilitates collaborative exploration of a business domain by mapping domain events along a timeline, then layering in commands, actors, aggregates, and bounded contexts. Use when starting a new project or unfamiliar feature area, when the team lacks a shared big picture of the problem, when requirements conversations keep stalling on ambiguity, or when seeding the glossary and bounded contexts for a domain. The agent facilitates and scribes; the human is the domain expert.
---

# Event Storming

## Overview

Event storming is a workshop format for collaboratively exploring a problem domain by telling its story as **domain events on a timeline** — things that *happen* and matter to a domain expert, written in past tense ("Invoice Submitted", "Payment Rejected"). From the events emerge commands, actors, aggregates, and bounded contexts: the high-level shape of the problem, and consequently sensible shapes for a solution.

The map is not the product. The real outputs are the **shared understanding**, the **seed of the ubiquitous language** (`ubiquitous-language`), and the raw material for user stories (`user-stories`). The exercise says *nothing* about how any system works — it explores the problem, never designs the solution.

## When to Use

- Kicking off a new project, product area, or unfamiliar bounded context
- Requirements conversations stall on ambiguity or the team keeps discovering "that's not how the business works"
- Before decomposing a large initiative into stories — get the big picture first
- Establishing or challenging bounded context boundaries; seeding the glossary

**When NOT to use:** the domain is already well-mapped and you're adding an increment (go to `user-stories`), or the question is technical design rather than problem understanding.

## Working With an AI Facilitator

When an agent runs this skill with a human, the roles are fixed:

- **The human is the domain expert.** Domain facts come from them. The agent never invents events, policies, or terminology — it proposes candidates *as questions* ("does something happen between Order Placed and Order Shipped — a payment, an approval?") and lets the expert confirm, correct, or reject.
- **The agent facilitates and scribes.** It asks one thing at a time (the `interview-me` discipline), keeps the session moving, reflects the emerging model back, and maintains the artifact — a markdown event map in the repository (e.g., `docs/event-storm-<context>.md`) that survives the session.
- **The agent enforces the rules below** — especially "no technical detail" — even when the human drifts into solution design.

### AI personas in the working group

The minimum working group is domain experts, a product owner, and a technical lead — and collaborating too little is a more common failure than too much. When humans can't fill every seat, personas stand in, **each as a distinct pass with its own charter** (one blended read averages the perspectives instead of colliding them):

- **Domain seat** → the [domain-expert-proxy](../../agents/domain-expert-proxy.md) persona: proposes events and policies *only* from recorded sources (briefs, prior maps, glossary, domain docs), cites them, and turns everything unrecorded into hot spots for the human expert
- **Product seat** → the [product-owner-proxy](../../agents/product-owner-proxy.md) persona: marks which parts of the map carry the value and where exploration should go deeper, from recorded goals only — novel value judgments become open questions
- **Technical seat** → the [code-reviewer](../../agents/code-reviewer.md) persona, confined to the feasibility sanity-check: "can we imagine one way to build this part?" — never solution design, never technical vocabulary in the map

Run the seats over the emerging map, merge their contributions, and keep the labels honest: everything a persona added that a human hasn't confirmed stays **candidate**, and the map says so. A fully persona-staffed session produces a good *draft* map and a sharp question list — it never replaces the session with the humans; it prepares it.

## The Process

### 1. Set the goal and cast

State what the session is for: a shared big picture, exploring one business area, designing work for a new capability, or challenging a proposed solution by modeling the domain. Identify who's contributing domain knowledge. Be inclusive — collaborating too little is far more common than collaborating too much.

### 2. Storm the events

Tell the story of the domain as events along a timeline:

- **Past tense, domain language:** "Book Added to Cart", "Delivery Charged", "Authorization Expired"
- An event is something a **domain expert cares that it happened** — not a log line, not a function call
- Stuck going forward? **Reverse the narrative:** "what must have happened before this event could occur?"
- Capture disagreement as hot-spot markers rather than resolving everything inline; disagreements are discoveries

### 3. Structure: aggregates and bounded contexts

- **Aggregates:** cluster events that operate on the same thing ("Searching / Choosing / Carting books" vs. "Going to the store")
- **Bounded contexts:** parts of the domain where a distinct model and vocabulary apply ("Book Shopping" vs. "Inventory Management"). Contexts are where one word may legitimately mean two things — section the glossary accordingly (`ubiquitous-language`), and expect context boundaries to become system/team boundaries (`ports-and-adapters` seams live here)

### 4. Add commands and actors

- **Commands:** the requests that cause events ("Submit Invoice" → "Invoice Submitted")
- **Actors:** the people or external systems issuing commands
- Run concrete scenarios through the map end-to-end to test everyone's thinking — walking a real example exposes missing events fast

### 5. Harvest the outputs

- **Glossary entries** for every term the session settled — same change, not later (`ubiquitous-language`)
- **Candidate user stories** from actor+command+event triples, taken forward with `user-stories`
- **Hot spots and open questions** as an explicit list — these are the next conversations
- The event map itself, committed to the repository

## Rules of the Room

1. **No technical detail in the model.** No services, tables, queues, or APIs. Feasibility gets a sanity check only — if the technicians can imagine *one* way to solve a part, move on; this is not the time to pick the best way.
2. **Domain experts do the modeling.** The facilitator guides the process and never overrides the expert's words.
3. **Simple language.** Jargon only when it *is* the domain's language — then the expert defines it and it enters the glossary.
4. **Everyone contributes.** In a live session, all participants write events; an agent-run session preserves this by asking rather than asserting.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "We already know the domain, storming is ceremony" | Every storming session surfaces events half the room didn't know about. The cost is an hour; the misunderstanding it removes costs a sprint. |
| "Let's note the API/table we'll need while we're here" | The moment the model turns technical, the experts disengage and the map stops describing the problem. Feasibility check, then back to events. |
| "The agent can generate the event map from the brief" | A generated map encodes the agent's guesses, which is exactly the disconnect this practice exists to remove. Generate *candidate questions*, not confirmed facts. |
| "We'll skip the messy timeline and go straight to stories" | Stories without the big picture inherit hidden gaps; the timeline is how you *see* the missing steps before they become missing features. |
| "One expert's view is enough" | The most valuable output is often two experts discovering they disagree. If only one is available, mark their view as one perspective and list the confirmation as an open question. |

## Red Flags

- Events in present/imperative tense or system vocabulary ("insert row", "call endpoint")
- The map contains services, databases, screens, or protocols
- The agent asserting domain facts the human never stated
- A persona-staffed session's output treated as confirmed instead of candidate + question list
- No open-questions/hot-spot list at the end (a session that found no ambiguity didn't look)
- Settled terms that never reach the glossary
- The session's output is only in the conversation — no committed artifact

## Verification

After a session, confirm:

- [ ] The event map is a committed artifact: timeline of past-tense domain events, with commands, actors, aggregates, and bounded contexts marked
- [ ] Every event and term is expert-confirmed, not agent-invented
- [ ] Zero technical/implementation vocabulary in the model
- [ ] New or sharpened terms landed in the glossary in the same change
- [ ] Hot spots and open questions are listed with owners
- [ ] Candidate stories (actor + command + event) are queued for `user-stories`
