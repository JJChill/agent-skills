---
name: story-mapping
description: Organizes user stories into a story map — a left-to-right narrative backbone of the user journey, activities above it, story cards below — instead of epics or a flat backlog. Use when a backlog is too long to navigate, when choosing a release cut or trading scope, when hunting for gaps in a user journey, or when different stakeholders need the plan at different levels of detail. Deliberately avoids epic hierarchies that make scope hard to change.
---

# Story Mapping

## Overview

A story map (Jeff Patton's technique) arranges stories in two dimensions: a **narrative backbone** telling the user's journey left-to-right, **activities** grouping it at a higher altitude, and **story cards** decomposing each step below. It replaces both the unnavigably long flat backlog and the epic hierarchy.

The case against epics is behavioral: a rigid story hierarchy fixes itself in plans and minds. Remove one story from a five-story epic and the epic feels "incomplete", so teams complete epics instead of shipping what matters — working on features they know are unimportant while urgent work waits. Stories are guesses about needs; epics are guesses about how guesses cluster. A map keeps both easy to change.

## When to Use

- The story list has outgrown a single prioritized queue
- Planning a release: choosing the thinnest end-to-end slice that works
- Checking a journey for gaps before development starts
- Executives need the activity view while the team needs the card view — same artifact, different altitude
- Scope must shrink and the impact needs to be visible to discuss

**When NOT to use:** writing the stories themselves (`user-stories`), deriving their acceptance criteria (`specification-by-example`), or sequencing engineering tasks within a story (`planning-and-task-breakdown`).

## The Map's Three Layers

```
ACTIVITIES:      [ Start Game ]      [      Play Game      ]     [ Wrap Up ]
                       │                       │                     │
BACKBONE:  Create Game → Place Ships → Take Shot → See Hit/Miss → See Who Won → See Scores
                              │             │
STORIES:               Place Carrier   Shot Hits Ship
                       Place Battleship Shot Misses
                       Place Submarine  Shot Repeated (rejected)
                       …
```

1. **Backbone (narrative flow):** tell the user's journey at a comfortable altitude, left to right. This captures intent without detail — and its left-to-right order surfaces natural dependencies.
2. **Activities:** step up a level; group backbone steps into named phases. This is the vocabulary for high-level conversations ("'Start Game' is done; 'Play Game' is next; online features are future").
3. **Story cards:** decompose each backbone step into `user-stories`-grade cards, ordered top-to-bottom by priority under their step.

Keep it in the repository as a living artifact (e.g., `docs/story-map-<product>.md`, table or nested-list form) so agents and humans revise the same map.

## Using the Map

- **Spot gaps:** a backbone read end-to-end exposes missing steps ("we place ships and shoot — where's *receiving* fire?"). Under each step, sparse cards expose missing cases ("we only place two ship types"). Walk the journey as a specific user with a specific goal; note every step the map skips.
- **Slice releases horizontally:** draw a line across the map — everything above is the release. The first slice is the thinnest path through *every* backbone step (a walking skeleton), not a perfect version of the first two steps. Later slices deepen steps.
- **Trade scope visibly:** cutting a card shows exactly which part of which step thins out — a discussion, not a mystery. Nothing "breaks" the way an epic does; the map has no completion anxiety.
- **Converse at the right altitude:** activities for sponsors, backbone for adjacent teams, cards for the delivery team. Same map, three audiences.

An agent working with a human on a map proposes backbone steps and candidate cards *as questions*, walks scenarios to test for gaps, and drafts release slices for the human to adjust — the human owns priorities and scope decisions, always. If no human owner is available, the [product-owner-proxy](../../agents/product-owner-proxy.md) persona may propose a cut from recorded product goals (source-cited, thin-end-to-end tiebreak), marked provisional until the human owner confirms.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Our tracker only supports epics, so we'll use epics" | Use the tool's grouping as dumb storage if you must, but plan on the map. The failure mode isn't the noun — it's letting a hierarchy make scope changes feel like breakage. |
| "We'll finish this epic first since we're in the area" | That's the epic-completion trap in one sentence. The question is never "what completes the group?" — it's "what's the most valuable card on the whole map?" |
| "Release 1 is the first three backbone steps, done properly" | A perfect two-thirds of a journey serves no one. Slice thin across *all* steps first — the skeleton walks, then it fattens. |
| "The map is stale, but rebuilding it is overhead" | A stale map quietly reasserts last quarter's guesses. Updating it is minutes per story; planning against a stale one costs a mis-built feature. |
| "We can skip mapping — the backlog is prioritized" | A queue can't show gaps, journeys, or what a cut does to the experience. One dimension is exactly the limitation the map exists to fix. |

## Red Flags

- Stories organized in fixed epic hierarchies that make removal feel like breakage
- A backbone that's a feature list instead of a user journey told in order
- Release slices that deep-dive early steps and skip later ones entirely
- Cards under a step that no persona's walk-through would ever touch (orphaned scope)
- Scope cuts negotiated in a spreadsheet with no view of the journey
- A map that lives in one person's head or a whiteboard photo instead of the repository
- Backbone or activity names outside the glossary (`ubiquitous-language`)

## Verification

After mapping (or revising a map), confirm:

- [ ] The backbone reads as one user's journey, left to right, in domain language
- [ ] Activities group the backbone and support a two-minute executive walkthrough
- [ ] Every card is an INVEST story under the step it serves; every step has its cards or an explicit gap marker
- [ ] At least one scenario was walked end-to-end to hunt gaps; findings became cards or open questions
- [ ] The next release is a thin slice across the whole backbone, agreed by the human owner
- [ ] The map is a committed, current artifact — updated as stories are added, cut, or reprioritized
