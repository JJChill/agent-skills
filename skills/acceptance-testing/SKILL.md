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

1. **Capture the story in the user's language.** "As a [user], I want [goal], so that [benefit]." No technical stories: behind "add an index" is a user need ("find my orders quickly") — capture that. The upstream pipeline: `event-storming` maps the domain, `user-stories` captures the needs, `story-mapping` organizes them.
2. **Derive one or more concrete examples per story.** Each example demonstrates the need is met. Include negative examples ("delivery is NOT free when..."). Too many examples for one story means the story is too big — split it. The full collaborative process is `specification-by-example`.
3. **Automate at least one test per acceptance criterion, before production code.** These failing specifications are the target the implementation aims at.
4. **Definition of done:** every acceptance criterion has at least one passing automated acceptance test.

### The Feature File Comes First

The examples live in a durable, human-readable spec artifact — a Gherkin `.feature` file or a Markdown feature file (`docs/specs/<feature>.feature.md` with one `## Scenario: <title>` heading per example) — written and agreed **before** any test code. The test then *transcribes* the scenario and declares which one it covers, one tag per scenario:

```kotlin
// Covers: onboarding.feature.md :: Scenario: New user completes onboarding
```

An acceptance test with no feature file behind it is not a specification — it's a test someone will reverse-engineer intent from later. The order is mechanical: scenario heading first, then the test that claims it. The tags make traceability checkable in both directions (every scenario covered, every tag resolving to a real scenario); mark scenarios still being driven outside-in `## Scenario (wip):`. When several projects share one spec repository, give the scenario a stable id (`@id:<slug>`) and claim it with `// Covers: @id:<slug>`, so the title can be reworded without breaking every project's tests. Teams enforcing this with hooks can use the `requireSpecBackedAcceptanceTest` / `enforceSpecTestParity` rules in the Probity templates (`hooks/PROBITY.md`).

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
- Use the ubiquitous language of the domain — glossary terms verbatim, one term per concept (see `ubiquitous-language`; a spec needing a word the glossary lacks means the glossary conversation happens first)
- Each specification asserts a **single outcome**; be skeptical of long, multi-assertion scenarios
- A specification should have only two reasons to fail: a genuine bug, or a translation error in the test plumbing. It changes only when the *user need* changes
- **"How many times did X happen" is still expressible as observable state.** Never assert driver/stub call counts from a spec; find state the domain genuinely exposes that carries the count — an audit trail, a diagnostic/breadcrumb log, a statement listing the transactions. "The system does not charge twice" becomes "the account statement shows one charge," not "the payment stub was called once." If no such state exists, that's a domain conversation (should the system record this?), not a license to count calls

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

Two rules that make the second driver cheap instead of a refactor:

- **Keep scenario bodies in a shared file** (e.g. `*Scenarios.kt` / `*Scenarios.ts`) that each driver-specific spec class calls into. The spec classes hold only the test-framework glue (and coverage tags); the bodies never know which driver runs them.
- **Drivers translate *intent*, not gestures.** When an interface cannot offer an intent at all — the UI removes the Create button while creation is in flight, so "taps create again" is impossible — the driver asserts *why* (the affordance is absent, which is how that interface delivers the guarantee) rather than silently no-oping or teaching the DSL which driver it's talking to. Put such intents in the driver contract explicitly so each implementation's translation is visible and reviewable.

How many drivers a scenario runs through is a **project decision** — one driver is a perfectly valid suite, and the four-layer structure is what keeps adding a second one cheap *if and when* the project wants it. What the suite cannot be is smaller than the deployable unit: taken together, the scenarios that decide releasability must exercise the **whole deployable unit**, with fakes only beyond the system boundary. Drivers ladder up rather than duplicate. The floor is an **application driver**: it builds the app through the **same composition entry point the app ships with** (never a test-only wiring that copies it, or the composition goes untested), so the real use cases, core, adapters and wiring all run, and fakes stand in only at the outbound ports (backend, clock, platform services). It drives the app at its outermost non-UI surface, such as its view models, public facade or CLI, so it needs no UI and stays fast. Below the floor sits an optional **component driver** (drives the presentation layer directly, fakes at the use-case ports): the fast tier where most scenarios live, but a suite of component-tier scenarios alone never makes a release candidate releasable, because the adapters, the wire and the composition never run. Above it sit a **hosted-UI driver** (mounts the real UI components in-process inside an app-hosted test target and drives them through a *semantic seam*) and a **full UI-automation driver** (deployed app, real gestures — slowest, keep it thin). The semantic seam is the key to the hosted-UI rung: production views expose named intent members (`selectNext()`) and named observable values (`displayedTitle`), and the production button/label **must be wired through those same members** — then the driver exercises exactly what the user's tap exercises, without an emulator or simulator. Compose's semantics tree gives you this seam for free; in SwiftUI, declare the members on the view.

**Choosing a scenario's tier.** Ask one question: *would a bug the component tier cannot see change this scenario's outcome?* A scenario goes to the app tier if any of these hold:

1. **The wire decides the outcome.** It passes only if an external system accepts or decodes what we send, or we decode what it returns: signed or sealed requests, encrypted or compressed payloads, a multi-call sequence whose order or chaining matters.
2. **Wiring decides the outcome.** It depends on which adapter, environment, endpoint or store the composition root picks.
3. **A platform service decides the outcome.** It depends on a real key store, crypto or codec round trip, not a fake's echo.
4. **Walking skeleton.** Every feature file whose scenarios reach an external system has at least one app-tier scenario, normally its main success path.
5. **An escaped defect.** A bug the component tier missed earns an app-tier scenario that would have caught it.

Everything else stays at the component tier: domain rules and validation; outcomes the use case decides, including how failures from external systems map to outcomes (arranged through the fake); state transitions; and variations and edge cases of a journey that already has app-level proof. When unsure, choose the component tier, and confirm the feature already meets rule 4. A scenario is claimed at one tier; a second driver for the same scenario is optional, and worth it only when it adds something (a CLI's output formatting, say). If an app-tier scenario needs a stub for an external protocol nobody has documented yet, document the protocol first: the stub translates the documented protocol, it doesn't simulate the service.

**Which drivers run which scenario is itself declarable, per scenario.** An app-tier scenario says so on its heading (`## Scenario [app]: …`); untagged scenarios run at the project's default tier, normally the component tier. A few behaviors deserve end-to-end proof beyond that — money movement, authentication, data loss. Declare it the same way, as a coverage floor on the scenario heading in the feature file: `## Scenario [system]: Payment is retried after a network failure` means "in addition to the default coverage, a system-level driver must cover this." The tag names a *coverage policy*, never a mechanism (no `[xcuitest]`, no tool names), so the spec still passes the least-technical-person test — it composes with the wip marker as `## Scenario (wip) [system]:`. Tags are floors, not ceilings: extra coverage is never wrong, and untagged scenarios keep meaning "default drivers" even when the project adds new ones. Because scenario bodies are shared, honoring a tag is cheap: the system-driver spec class gains one thin method calling the existing body and carrying the `Covers:` tag. Teams enforcing traceability with hooks can make the floor mechanical — the `enforceSpecTestParity` rule's `driverScopes`/`defaultScopes` options check coverage per (scenario, driver scope), not just per scenario (`hooks/PROBITY.md`).

One more driver rule: **observe arrivals positively.** "The user is taken to X" is proven by seeing X, not by no longer seeing where they came from — an absence-only observation ("the old screen is gone", "no error appeared", "still running") is satisfied by a spinner, a crash screen, or a launch state where the absent thing never existed to begin with. Absence can *supplement* a positive observation (arrived at X *and* was not asked to pay), and an absence-of-affordance assertion needs a presence assertion beside it to prove the right screen is even showing. The mutation check catches this family: if breaking the routing leaves the test green, the observation was absence-only.

Whichever rungs a project picks, two rules hold: confine the UI-automation framework (`XCUIApplication`, Espresso, Playwright) to its own driver — if any other layer imports it, the layers have collapsed — and keep shared assets (expected copy strings, fixture values) in one place all drivers import, never duplicated per driver: when marketing rewrites a title, one file changes.

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
5. **Fakes gate in-flight operations.** A driver that owns virtual time can pause the world anywhere; a driver that doesn't (a real UI toolkit with its own clock) cannot. Give port fakes a standard in-flight gate — a latch the test releases — so "the operation is still running" is a controllable fact in every driver, not a race. Build it into the fake once; don't reinvent it per feature.
6. **Preconditions are controlled, not observed.** Every Given is *established by the test* — through a fixture, a programmed stub, or a substituted port — never inherited from whatever the environment happens to do. A scenario whose Given is "signing in will not succeed" is not honestly covered by running in a simulator that has no network: the assertion passes, but the test cannot distinguish the failure it asked for from the failure the machine produced, and on a connected machine the precondition silently inverts. An environmentally satisfied Given also hides a bigger cost: the *opposite* precondition is unreachable (nothing can make sign-in succeed), so the whole success side of the behavior is unspecifiable until the port is controlled.

**When the test itself can't get a red.** The first test for behavior that already exists (characterization coverage — the normal case when retrofitting specs onto a brownfield system) is born green: no red keyed to it can precede it, and a mutation probe can't help yet because a probe only fails tests that already exist. That is legitimate — land the test, then immediately prove it bites with the mutation check (break the behavior, watch *this* test fail on its concluding assertion, restore). Teams enforcing TDD mechanically should sanction this as an explicit round-trip rather than an override (`hooks/PROBITY.md`, characterization round-trip).

**When a control fixture can't get a red.** TDD discipline demands a failing test before fixture code — but a sad-path scenario the environment already satisfies will never go red, so the gate appears to "refuse" the fixture. Do not resolve that by deleting the control. The legitimate red lives in the **inverse scenario**: write the spec for the other side of the same port ("a new user who signs in successfully is taken into the app"), which genuinely fails until the port can be controlled, and let *that* red drive the fixture. Once the fixture exists, move the original scenario onto it explicitly — a refactor under green. And when a scenario cannot be honestly driven at all because a seam is missing, mark it `## Scenario (wip):` (in a spec repository shared with other projects, add it to this project's own wip list instead, with the missing seam as the note) and surface the seam gap to the user as a design decision; never silently weaken the Given, reshape the scenario, or let the environment stand in.

**When the fake itself cannot be written.** Sometimes the port is substitutable but its *signature* defeats the fake: it returns or accepts a vendor type the test cannot construct (an SDK's sealed transaction object, a framework handle with no public initializer). That is not a testing problem to work around — it is the `ports-and-adapters` boundary leak showing up as untestability, and every behavior downstream of that type is unspecifiable until the port speaks a core type the adapter translates to. Record the scenario `(wip)`, and surface the port redesign as the blocking decision; a wrapper struct that still embeds the vendor type inside has not fixed anything.

## Where Acceptance Tests Run

- **Commit stage** (minutes): unit tests from TDD plus tactical integration tests.
- **Acceptance stage** (under an hour): the full executable-specification suite against a production-like deployment, alongside the other releasability tests (performance, security, resilience). Passing means releasable.
- **In-progress features:** a new spec fails until the feature is built, but it is still committed with the code, in small steps. Mark it **expected-to-fail**: it runs on every build and passes only while its scenario still fails, so the pipeline stays green, and the build goes red the moment the feature works, saying to remove the marker. Promotion can't be forgotten. Use the framework's own marker where there is one (Jest `test.failing`, Vitest `test.fails`, Swift Testing `withKnownIssue`, XCTest `XCTExpectFailure`). kotlin.test has none (and no tags, so neither skipping nor tag filtering works in `commonTest`), so own a small helper beside the DSL:

  ```kotlin
  // Expected-to-fail: passes while the scenario fails, fails once it passes.
  inline fun inProgress(scenario: () -> Unit) {
      val failure = runCatching(scenario).exceptionOrNull()
          ?: fail("This scenario now passes: remove inProgress and its scenario's wip marker.")
      println("In progress, failing as expected: ${failure.message}")
  }

  // Covers: invoicing.feature :: Scenario: A submitted invoice awaits authorisation
  @Test
  fun `a submitted invoice awaits authorisation`() = inProgress { … }
  ```

  The scenario stays `(wip)` until the marker comes off: an expected-to-fail test does not cover its scenario. Store acceptance tests in the same repository and commits as the code they specify.
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
| "The environment already makes this happen, so no fixture is needed" | Then the precondition is owned by the environment, not the test — green for reasons the test can't see, flaky the day the environment changes, and the opposite precondition is unspecifiable. Write the inverse scenario; its red drives the fixture, then this scenario adopts it under green. |
| "TDD refused the fixture — no failing test demanded it" | The gate refused *this scenario's* demand, not the design. A tooling verdict is not a design decision: the failing test that demands the control is the inverse scenario on the same port. |
| "Non-technical stakeholders will never read these anyway" | The domain language isn't (only) for stakeholders — it's what makes the specs durable, reusable, and decoupled from the implementation. |

## Red Flags

- Specifications mentioning pages, buttons, fields, URLs, endpoints, JSON, tables, or any named UI element
- Acceptance criteria written after the implementation, or reverse-engineered from it
- Acceptance test code with no feature file behind it — scenarios that exist only as test method names, or `Covers:` tags pointing at scenarios that don't exist
- Test code calling the SUT's internals or HTTP endpoints directly from the test case layer (no DSL/driver layers)
- Logic, assertions, or SUT interaction inside Gherkin step definitions
- `sleep`/fixed waits anywhere in the suite
- Tests sharing accounts, records, or other writable state; a "wipe the database" step between tests
- An automated suite that drives a real external/third-party system
- Scenarios with long chains of When/Then asserting many outcomes
- A UI redesign or API rename that forces edits to test *cases* rather than one driver
- A driver method whose name states a precondition ("startForNewUserWhoseSignInWillFail") but whose body sets no fixture, stub, or launch state — the Given is being inherited from the environment, not established
- A control fixture deleted (or never written) because the scenario passes without it
- A port whose signature carries a vendor type no test can construct — the fake is impossible, so every scenario needing that port's happy path silently goes unwritten

## Verification

After writing or changing acceptance tests, confirm:

- [ ] Every acceptance criterion of the story has at least one automated executable specification
- [ ] Every scenario exists as a heading in a feature file **before** its test, and every test declares the scenario it covers (`Covers:` tag) — traceability holds in both directions
- [ ] Specifications were written (and seen failing) before the production code — or, when a spec is retrofitted onto behavior that already exists (common on brownfield projects), it was **mutation-checked**: temporarily break the behavior it specifies, watch the spec go red, restore, and watch it go green. A retrofitted spec that has never failed proves nothing. Choose the mutation against the *covered* scenario set — and if a probe stays green under every suite, that is a **coverage finding** (the behavior's scenario is unwritten, unclaimed, or sitting in an adoption baseline): record it as such rather than silently switching to a different probe
- [ ] Each spec passes the least-technical-person test — domain language, zero implementation detail
- [ ] Each spec asserts a single outcome
- [ ] Test cases touch only the DSL; only protocol drivers know how to reach the SUT
- [ ] The app tier builds the app through the shipping composition entry point and fakes only outbound ports; scenarios are claimed at the tier the tier rules give them, and every feature file that reaches an external system has an app-tier scenario
- [ ] Scenarios needing more than the default driver set declare it on the heading (`## Scenario [system]: …`), and each declared scope has a covering test in that driver's suite
- [ ] The SUT scope is a deployable unit; all external dependencies are faked at ports, with contract tests pinning the interfaces
- [ ] Each test creates its own isolated data; the suite passes when run in parallel and when run twice in a row
- [ ] Every Given is established by the test (fixture, programmed stub, substituted port) — no precondition is satisfied only by the ambient environment; where a control fixture had no red to drive it, the inverse scenario exists and drove it
- [ ] No sleeps — concluding events are polled with timeouts
- [ ] The suite runs in the pipeline's acceptance stage against a production-like deployment; in-progress specs are committed expected-to-fail with their scenario `(wip)`, and the marker and the wip come off together when they pass
