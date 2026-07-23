---
name: acceptance-testing
description: Drives features from executable specifications — acceptance criteria written in the language of the problem domain, automated before production code, and used as the definition of done. Use when starting a user story or feature, when defining what "done" means, when writing or reviewing acceptance/BDD/Gherkin scenarios, when specs are brittle or coupled to the UI, or when deciding what belongs in the acceptance stage of a deployment pipeline.
---

# Acceptance Testing

## Overview

An acceptance test is an **executable specification**: a concrete example, written in the language of the problem domain, that demonstrates a user's need is met. Specifications are written *before* the production code and together form the automated definition of done — when every acceptance criterion of every story has at least one passing automated test, the work is done and the change is releasable.

Acceptance tests specify **what** the system does from the perspective of an external user. They say *nothing* about how the system works — no screens, buttons, URLs, endpoints, tables, or payloads. All knowledge of "how" is hidden in layered test infrastructure so the specification stays true even when the implementation changes completely.

This is the outer loop of development. The inner loop is `test-driven-development`; the seams that make the infrastructure possible come from `ports-and-adapters`.

## When to Use

- Starting work on a user story or feature — write the executable specifications first
- Turning acceptance criteria, examples, or Given-When-Then scenarios into automated tests
- Reviewing existing acceptance/E2E/BDD tests for brittleness or implementation leakage
- Deciding the scope and structure of the acceptance stage in a deployment pipeline
- Diagnosing flaky, slow, or unmaintainable high-level test suites

**When NOT to use:** exhaustive input-variation coverage (unit tests via `test-driven-development` are the right tool), exploratory/manual usability evaluation, or testing third-party systems you don't deploy.

## From Story to Executable Specification

```
User story ──▶ Concrete examples ──▶ Executable specifications ──▶ Development ──▶ Done
 (the wish)   (acceptance criteria)   (automated, failing)          (make them pass)
```

1. **Capture the story in the user's language.** "As a [user], I want [goal], so that [benefit]." No technical stories: behind "add an index" is a user need ("find my orders quickly") — capture that.
2. **Derive one or more concrete examples per story.** Each example demonstrates the need is met. Include negative examples ("delivery is NOT free when..."). Too many examples for one story means the story is too big — split it.
3. **Automate at least one test per acceptance criterion, before production code.** These failing specifications are the target the implementation aims at.
4. **Definition of done:** every acceptance criterion has at least one passing automated acceptance test.

### The Language Test

Apply the **least-technical-person test**: the least technical person who understands the problem domain must be able to read the specification and confirm it says what they want. If the spec mentions clicking, pages, fields, JSON, tables, or services, it fails.

```gherkin
# BAD — a UI script pretending to be a specification
Given I am on the login page
And I enter "Dave" into the username field
When I click the "Login" button
Then I should be taken to the home page

# GOOD — behavior, durable across any implementation
Given I am a registered user
When I provide valid credentials
Then I am granted access to my account
```

The bad version breaks when the UI changes to fingerprint auth; the good version stays correct forever, because the *need* hasn't changed.

**Rules of thumb:**
- Start specifications with "should" or express them as outcomes
- Use the ubiquitous language of the domain, one term per concept, consistently
- Each specification asserts a **single outcome**; be skeptical of long, multi-assertion scenarios
- A specification should have only two reasons to fail: a genuine bug, or a translation error in the test plumbing. It changes only when the *user need* changes

## The Four-Layer Model

All knowledge of *how* the system works is pushed down and out of the test cases:

```
┌─────────────────────────────┐
│ 1. Test Cases (Specs)       │  WHAT the system does. Domain language only.
├─────────────────────────────┤
│ 2. DSL                      │  Reusable domain vocabulary. Defaults, aliasing,
│                             │  functional + temporal isolation.
├─────────────────────────────┤
│ 3. Protocol Drivers         │  HOW to talk to the system. UI automation, API
│                             │  calls, message queues, stub programming.
├─────────────────────────────┤
│ 4. System Under Test        │  Deployed production-like, external systems
│    (+ stubs at its ports)   │  faked at the ports (see ports-and-adapters).
└─────────────────────────────┘
```

**Layer 1 — Test cases** read like the refined examples:

```typescript
it('acknowledges a submitted invoice to its submitter', async () => {
  await invoices.createAuthorizedAccount('submitter1');
  await invoices.submitInvoice('submitter1', 'invoice1');
  await invoices.confirmInvoiceAcknowledged('submitter1', 'invoice1');
});
```

**Layer 2 — DSL** supplies defaults and isolation. If you're saying the same thing in two specs, say it the same way — reuse is the sign you're thinking in the domain language. Gherkin users: step definitions are *parsing only*; they delegate to this same DSL. Logic in step definitions is the classic anti-pattern.

**Layer 3 — Protocol drivers** translate DSL concepts into real interactions. Each driver step passes or fails atomically; assertions live here. One DSL, many drivers: the same `placeOrder` spec can run against the web UI, the mobile app, or the public API by swapping drivers. When the SUT's interface changes, the fix is in one driver — not in hundreds of specs.

**Layer 4 — SUT** is deployed the same way production is deployed, into a production-like environment. Stubs standing in for external systems are programmed *through the DSL* like any other driver ("when asked to validate this customer, reject them").

## Scope: What Is the System Under Test?

**The right scope for an acceptance test suite is a deployable/releasable unit of software** — the set of components built, tested, and released together.

- **Never run automated end-to-end tests across team or deployment boundaries.** They are slow, fragile, uncontrollable, and hard to diagnose.
- **Fake everything beyond the boundary** — other teams' services, third-party APIs, anything deployed on someone else's schedule. Substitute the fakes at the system's ports (`ports-and-adapters`), never by reaching inside your own code.
- **If you deploy and configure it, include it** (your database, your web server). You're not testing that the database is a database — you're testing your deployment and configuration of it.
- **Protect the boundary with contract tests**: verify your assumptions about each external interface, and share those tests with the owning team so their pipeline breaks when they break the contract.

## Test Isolation

Trustworthy tests control all the variables.

1. **Functional isolation:** every test creates its own data through the system's natural functions (its own account, its own hospital, its own order) and operates only within that bubble. No shared writable data, no cleanup step, safe parallelism.
2. **Temporal isolation:** the DSL aliases names so the same test can run twice, or in parallel with itself, against one SUT instance. The spec says `"invoice1"`; the SUT sees `invoice1-8f3a`.
3. **Controlling time:** systems that care about time read it from a clock port, never the OS clock. The test clock is a stub the DSL can set and advance — a week-long scenario runs in milliseconds, and daylight-saving boundaries become testable. Tag such tests (e.g. `@TimeTravel`) and run them on dedicated instances, not the shared parallel pool.
4. **No sleeps, ever.** A fixed delay is a race condition postponed plus wasted time on every run. Protocol drivers poll for the **concluding event** with a generous timeout: fast when the system is fast, resilient when it's slow.

## Where Acceptance Tests Run

- **Commit stage** (minutes): unit tests from TDD plus tactical integration tests.
- **Acceptance stage** (under an hour): the full executable-specification suite against a production-like deployment, alongside the other releasability tests (performance, security, resilience). Passing means releasable.
- **In-progress features:** a new spec fails until the feature is built. Keep it out of the main pipeline (tagged/quarantined) while it drives development; enable it the moment it passes. Store acceptance tests in the same repository and commits as the code they specify.
- A failing acceptance test means a bug in the code or the test infrastructure — developers own the infrastructure and the fix. The specification itself changes only when the need changes.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "We'll write the acceptance tests once the feature works" | Then they're not specifications and can't act as the definition of done. Written after, they encode the implementation you happened to build, not the need. |
| "The scenario has to click through the UI — that's what the user does" | The user's *goal* is not clicking. Put UI interaction in a protocol driver; the spec states the outcome. When the UI changes, your specs survive. |
| "One big end-to-end test covering the whole journey is more realistic" | It's also unfocused, undiagnosable, and breaks for a dozen unrelated reasons. Many small single-outcome specs, each in its own data bubble. |
| "We need the real payment provider / partner system in the test" | You don't control it, so the test can't control its variables. Fake it at the port and pin the interface with a contract test. |
| "Just add a 2-second sleep, it's flaky under load" | That's a race condition with a timer on it. Poll for the concluding event in the protocol driver. |
| "Testing variations of this input is easiest to add here" | Input variation is unit-test territory. One acceptance spec per behavior; push permutations down to the TDD inner loop. |
| "Non-technical stakeholders will never read these anyway" | The domain language isn't (only) for stakeholders — it's what makes the specs durable, reusable, and decoupled from the implementation. |

## Red Flags

- Specifications mentioning pages, buttons, fields, URLs, endpoints, JSON, tables, or any named UI element
- Acceptance criteria written after the implementation, or reverse-engineered from it
- Test code calling the SUT's internals or HTTP endpoints directly from the test case layer (no DSL/driver layers)
- Logic, assertions, or SUT interaction inside Gherkin step definitions
- `sleep`/fixed waits anywhere in the suite
- Tests sharing accounts, records, or other writable state; a "wipe the database" step between tests
- An automated suite that drives a real external/third-party system
- Scenarios with long chains of When/Then asserting many outcomes
- A UI redesign or API rename that forces edits to test *cases* rather than one driver

## Verification

After writing or changing acceptance tests, confirm:

- [ ] Every acceptance criterion of the story has at least one automated executable specification
- [ ] Specifications were written (and seen failing) before the production code
- [ ] Each spec passes the least-technical-person test — domain language, zero implementation detail
- [ ] Each spec asserts a single outcome
- [ ] Test cases touch only the DSL; only protocol drivers know how to reach the SUT
- [ ] The SUT scope is a deployable unit; all external dependencies are faked at ports, with contract tests pinning the interfaces
- [ ] Each test creates its own isolated data; the suite passes when run in parallel and when run twice in a row
- [ ] No sleeps — concluding events are polled with timeouts
- [ ] The suite runs in the pipeline's acceptance stage against a production-like deployment; in-progress specs are quarantined, completed ones enabled
