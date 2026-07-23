---
name: ubiquitous-language
description: Enforces one shared language of the problem domain — a maintained glossary that names, code, tests, specs, and conversation all draw from, with one term per concept and no synonyms. Use when naming any domain concept (class, function, port, event, field, story), when a glossary needs creating or updating, when the same idea appears under different words (customer/client/user), when a term is ambiguous or overloaded, or when reviewing whether code and specs speak the domain's language.
---

# Ubiquitous Language

## Overview

The ubiquitous language is the single, shared vocabulary of the problem domain — grown from the words domain experts already use, made a little more precise, and then used **relentlessly** in all communication: requirements, stories, executable specifications, code, diagrams, commit messages, and speech. One term per concept; one concept per term.

Its source of truth is a **maintained glossary in the repository**. Every domain concept in the system traces to a glossary entry; every glossary change lands in the same commit as the code or spec that needed it. This eliminates whole classes of misunderstanding: a small change in the domain expert's words becomes a small, findable change in the code.

## When to Use

- Naming anything that represents a domain concept: modules, classes, functions, ports, events, fields, test steps, story titles
- Writing or refining user stories and executable specifications (`acceptance-testing`)
- Defining ports (`ports-and-adapters`) — port names and signatures come from the glossary
- Encountering two words for one idea, one word for two ideas, or a vague term ("process", "manage", "handle", "data")
- Starting work in a new area of the domain, or onboarding into an existing one
- Reviewing a change that introduces new domain vocabulary

**When NOT to use:** purely technical vocabulary inside adapters and infrastructure (HTTP, retries, sockets, pixels) — technical terms are correct there. The rule governs the *domain*: the core, its ports, the specs, and the conversation.

## The Glossary

Keep a glossary file at the repository root or docs directory (`GLOSSARY.md` by convention; follow the project's existing location if one exists).

```markdown
# Glossary

Terms are the ubiquitous language of this system. One term per concept.
Code, tests, specs, and conversation use these words exactly.

## Invoice
A request for payment submitted by an **Invoice Submitter** for review.
States: submitted → pending authorization → authorized | rejected.
NOT: "bill", "claim", "document".

## Invoice Submitter
An authorized account that submits Invoices. A narrower role than
"accountant" — an accountant may hold other roles too.
NOT: "user", "accountant" (broader), "client".

## Pending Authorization
The state of an Invoice awaiting a decision by an **Authorizing
Supervisor**. This is the domain experts' own term — keep it.
```

**Entry rules:**
- **Definition in domain language**, one or two sentences, written so a domain expert would nod
- **State the rejected synonyms** (`NOT: ...`) — this is what makes drift detectable and correctable
- **Bold cross-references** to other glossary terms used in the definition
- **Scope by bounded context** when one word legitimately means different things in different parts of the domain ("Order" in purchasing vs. shipping): section the glossary per context and name which context code lives in, rather than inventing artificial compound names

## Building and Growing the Language

1. **Start from the experts' words.** Capture the terms domain experts actually use (event storming and story conversations are where they surface). Don't invent vocabulary they'll have to learn back.
2. **Raise the precision slightly.** Where experts use two terms for one concept — or one term for two — agree on a single, clear version with them and record it. The glossary term should stay close enough to natural usage that experts read it without translation.
3. **Grow it as you go.** Define terms for the parts of the domain you're working on now — not the whole system upfront. A story that introduces a new concept adds its glossary entry in the same change.
4. **Evolve it deliberately.** When understanding deepens and a term changes, that's a real change: update the glossary, rename the code (`deprecation-and-migration` for externally visible names), and update the specs — in one coordinated change, not by letting old and new terms coexist.

## Enforcement

The language is only ubiquitous if deviation gets corrected everywhere it appears:

- **In conversation and writing:** when someone (including you) says "client" and the glossary says "Customer", correct it — "did you mean Customer?" — and use the glossary term in your own output, always.
- **In code:** domain concepts in the core are named with glossary terms, exactly — classes, functions, ports, events, fields, enum values. `SubmitInvoice`, not `processDocument`. A term absent from the glossary is either a missing entry (add it in this change) or the wrong word (use the right one).
- **In specs and stories:** executable specifications, DSL vocabulary, and story titles use glossary terms verbatim. If a spec needs a word the glossary lacks, the conversation with the domain expert happens *before* the word is coined.
- **In review:** a diff introducing a synonym for an existing term, or a new domain term with no glossary entry, is a Required finding, not a nit.
- **One direction of translation:** adapters translate between vendor/technical vocabulary and the glossary at the boundary. Vendor terms never leak inward; glossary terms may appear in adapters, technical terms stay out of the core.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Everyone knows client and customer mean the same thing here" | Until the day they don't — one grows a billing meaning, the other an auth meaning, and the bug lives in the gap. One term per concept. |
| "A glossary is documentation overhead; the code is the truth" | The code can't tell you which of its three words for one concept is right. A ten-line glossary entry settles arguments the codebase restarts weekly. |
| "I'll add the glossary entry in a follow-up" | The entry exists to shape the names in *this* change. After merge, the wrong name is precedent and the follow-up never comes. |
| "Renaming across the codebase isn't worth the churn" | Leaving two names is permanent comprehension tax on every future reader; the rename is paid once. Mechanical renames are cheap — do them when the term changes. |
| "The domain experts' term is clunky; ours is cleaner" | Then every conversation with the people who define correctness requires translation, and translation is where requirements die. Keep their word; sharpen its definition. |
| "This is just an internal helper, the name doesn't matter" | Internal names get read, copied, and imitated. If it touches a domain concept, it uses the domain's word. |

## Red Flags

- Two identifiers in the core for one domain concept (`Customer` and `Client`; `submitInvoice` and `sendBill`)
- A domain term in code, a spec, or a story that has no glossary entry
- A glossary that exists but hasn't changed while domain code has (stale = dead)
- Generic names on domain concepts: `Manager`, `Processor`, `Handler`, `DataService`, `doWork`, `item`, `record`
- Vendor or framework vocabulary inside the core (`StripeCustomer`, `Row`, `Document` for something the domain calls an Invoice)
- Specs or DSL steps paraphrasing a concept differently from the code that implements it
- Conversations (or PR descriptions) using different words than the code they describe
- A rename that updates code but not the glossary and specs, or vice versa

## Verification

After a change that touches domain concepts, confirm:

- [ ] Every domain concept introduced or renamed has a glossary entry (definition + rejected synonyms), updated in the same change
- [ ] Names in core code, ports, events, and fields match glossary terms exactly
- [ ] Executable specifications and DSL vocabulary use glossary terms verbatim
- [ ] No new synonym coexists with an established term anywhere in the diff
- [ ] Vendor/technical vocabulary appears only in adapters; translation to glossary terms happens at the boundary
- [ ] If a term evolved, the glossary, code, and specs changed together in one coordinated change
