---
name: ports-and-adapters
description: Enforces the ports and adapters (hexagonal) architecture — every dependency the team doesn't own or doesn't deploy with the code sits behind a port, reached through the thinnest possible adapter, and tests swap fakes only at ports. Use when adding any external dependency (database, HTTP client, SDK, framework, UI, OS clock/filesystem/env), when structuring a new service or module, when core code imports framework or vendor types, or when tests are mocking internal classes instead of substituting at an architectural boundary.
---

# Ports and Adapters

## Overview

The core of the system — all business logic, all decisions, all state transitions — depends only on **ports**: interfaces the team defines, named in the language of the problem domain. **Adapters** implement those ports by translating to the outside world. The rule in this codebase is strict:

> **An adapter is required for every dependency we don't own, and every dependency that isn't deployed and released together with our code.** That includes UI toolkits, web and application frameworks, databases, third-party APIs and SDKs, message brokers, other teams' services — and the operating system itself (clock, filesystem, environment, randomness, network).

Adapters are **as thin as possible**: pure translation, no logic. Ports — and only ports — are where tests substitute fakes, so every test exercises the maximum amount of our own code with complete control over its state.

## When to Use

- Introducing any new dependency: a library, SDK, HTTP API, database, queue, or OS facility
- Structuring a new service, module, or feature
- Code review: core code importing framework, vendor, or `node:`/stdlib I/O types
- Tests that mock internal classes/functions, or that can't control time, randomness, or external responses
- Designing the test seams for `acceptance-testing` stubs and `test-driven-development` fakes

**When NOT to use:** dependencies you own and deploy atomically with the calling code (a sibling module in the same deployable unit needs no port), or pure computation libraries with no external effects where wrapping adds nothing (see the decision guide — but when in doubt, add the port).

## The Decision Guide

For every dependency, ask in order:

```
Do we own its source and change it at will?
 ├─ NO ──────────────────────────────▶ PORT + ADAPTER required
 └─ YES ─▶ Is it deployed & released in the same unit as this code?
            ├─ NO ─────────────────── ▶ PORT + ADAPTER required
            └─ YES ─▶ Direct call is fine (it's just our code)
```

This test has no exemption for "infrastructure everyone uses":

| Dependency | Verdict |
|---|---|
| Another team's REST service | Adapter |
| Postgres / Redis / S3 | Adapter |
| Payment / email / auth SDK | Adapter |
| Web framework (Express, Spring, Rails…) | Adapter — the framework calls an inbound adapter; core never sees request/response types |
| UI framework (React, SwiftUI…) | Adapter — views render core state and forward intents through a port |
| OS: `Date.now()`, `fs`, `process.env`, `Math.random()`, sockets | Adapter — clock, storage, config, randomness are ports |
| A module in the same repo, same deployable | No port needed |
| A "shared library" another team releases on their own schedule | Adapter |

## The Dependency Rule

Source dependencies point inward only:

```
        inbound adapters                    outbound adapters
  ┌────────────────────────┐   ┌─────────────────────────────────┐
  │ HTTP route handlers    │   │ PostgresOrderStore              │
  │ CLI parsing            │──▶│ StripePaymentGateway            │
  │ UI event handlers      │   │ SystemClock, EnvConfig          │
  └──────────┬─────────────┘   └───────────────▲─────────────────┘
             │ calls                           │ implements
             ▼                                 │
  ┌─────────────────────────────────────────────────────────────┐
  │  CORE: use cases + domain                                   │
  │  defines inbound ports (use-case interfaces)                │
  │  defines outbound ports (OrderStore, PaymentGateway, Clock) │
  │  imports NOTHING from adapters, frameworks, or vendors      │
  └─────────────────────────────────────────────────────────────┘
```

- Ports are declared **in the core**, named for the domain (`OrderStore`, not `PostgresClient`; `Clock`, not `DateNowWrapper`), and shaped by what the core *needs*, never by what the vendor offers. Port and core names come from the glossary — see `ubiquitous-language`.
- Port signatures use only core types. If a vendor type (a Stripe object, an ORM entity, an HTTP request) appears in a port, the boundary has leaked.
- Enforce mechanically where possible: lint/arch rules forbidding core packages from importing adapter, framework, and vendor modules.

```typescript
// core/ports/clock.ts — the port, owned by the core
export interface Clock { now(): Date; }

// core/orders/place-order.ts — core logic, framework-free
export class PlaceOrder {
  constructor(private orders: OrderStore, private payments: PaymentGateway,
              private clock: Clock) {}
  async execute(cmd: PlaceOrderCommand): Promise<OrderPlaced> { /* all logic here */ }
}

// adapters/system-clock.ts — a complete adapter
export const systemClock: Clock = { now: () => new Date() };
```

## Adapters Must Be Thin

An adapter's only job is translation: port call → vendor call, vendor result/error → core type. The test for thinness: **an adapter contains no conditional that expresses a business rule.** Mapping a vendor error code to a domain error is translation; deciding *what to do about it* is core logic.

```typescript
// GOOD — thin: translate, delegate, translate back
export class StripePaymentGateway implements PaymentGateway {
  constructor(private stripe: Stripe) {}
  async charge(p: Payment): Promise<PaymentResult> {
    try {
      const intent = await this.stripe.paymentIntents.create(toStripeParams(p));
      return toPaymentResult(intent);
    } catch (e) { return toPaymentFailure(e); }  // classify, don't decide
  }
}

// BAD — business logic hiding in the adapter
async charge(p: Payment): Promise<PaymentResult> {
  if (p.amount > 10_000 && !p.customer.verified) {  // ← a business rule!
    return PaymentResult.requiresReview();           //   move it into the core
  }
  ...
}
```

If an adapter grows retry policies, fallback decisions, caching rules, or validation, extract that into the core behind the port — logic in adapters is logic that fakes silently skip and tests never exercise.

**Inbound adapters are equally thin.** A route handler parses/deserializes, calls one use-case port, and serializes the result. A UI component renders core-supplied state and forwards user intent. If you can't unit-test a behavior without the framework, the behavior is trapped in an adapter.

## Ports Are the Only Test Seam

Fakes, stubs, and mocks are substituted **at ports and nowhere else**. Never monkey-patch modules, mock internal classes, or stub your own functions — that couples tests to implementation and shrinks the amount of real code under test.

This is the payoff of the strict rule: with every uncontrolled dependency behind a port, a test can wire the *entire* core — every use case, every domain rule, real wiring — to in-memory fakes, gaining total control of state (including time) while exercising the maximum amount of our own code.

```typescript
// One reusable fake per outbound port — a real, if simple, implementation
export class InMemoryOrderStore implements OrderStore {
  private orders = new Map<OrderId, Order>();
  async save(o: Order) { this.orders.set(o.id, o); }
  async byId(id: OrderId) { return this.orders.get(id) ?? null; }
}
export class ControlledClock implements Clock {
  constructor(private t: Date) {}
  now() { return this.t; }
  advance(ms: number) { this.t = new Date(this.t.getTime() + ms); }
}

// Tests assemble the real core with fakes at the edges
const clock = new ControlledClock(new Date('2026-07-01T09:00:00Z'));
const app = new PlaceOrder(new InMemoryOrderStore(), approvingGateway(), clock);
```

- Prefer **fakes** (working in-memory implementations, shared across the suite) over per-test stubs; prefer stubs over interaction-verifying mocks.
- Run the outbound-port **contract test suite** against both the fake and the real adapter, so the fake can't drift from reality.
- The thin adapters themselves get a few focused integration tests against the real dependency (or its official emulator) — that's all they need, because they contain no logic.
- Acceptance tests (`acceptance-testing`) use these same ports to stub external systems around the deployed SUT; unit tests (`test-driven-development`) use them in-process. One set of seams serves every level.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It's just a call to `Date.now()` / `fs` / `process.env`" | That's an unowned dependency (the OS) and the top cause of untestable, nondeterministic code. Clock, storage, and config are ports. |
| "Wrapping the framework is fighting the framework" | The framework keeps doing what it's good at — in the adapter. The core stays portable and testable. Frameworks churn on their schedule, not yours. |
| "An interface with one implementation is over-engineering" | Every port has at least two implementations from day one: the real adapter and the fake the tests use. |
| "It's faster to mock the internal service class in this test" | Mocking internals welds the test to today's structure and removes your own code from the test. Substitute at the port; let the real core run. |
| "The adapter can just handle the retry/fallback logic" | Then that behavior is invisible to every test that uses the fake. Decisions go in the core; adapters translate. |
| "This vendor type is basically our domain type anyway" | Until their next major version. Port signatures use core types only. |
| "We own that other service too, so no adapter needed" | Owning the code isn't the test — deploying together is. If it releases separately, it can change independently, so it sits behind a port. |
| "We'll extract the interface later once we need a second implementation" | You need the second implementation (the fake) with the first test you write — which is before the production code. |

## Red Flags

- Core/domain/use-case files importing framework, vendor SDK, ORM, or OS I/O modules
- `new Date()`, `Date.now()`, `Math.random()`, `process.env`, or filesystem calls anywhere outside an adapter
- Port interfaces exposing vendor types, HTTP notions, or SQL fragments
- An adapter containing `if`/`switch` on domain concepts, retries with fallback decisions, caching policy, or validation rules
- Tests using module-mocking (`jest.mock('./our-own-module')`), patching internals, or spying on private methods
- Business behavior only testable by spinning up the framework, a browser, or a real database
- A dependency owned by another team (or released on another schedule) called directly "because it's internal"
- A port with no fake implementation, or a fake with no contract test tying it to the real adapter

## Verification

After introducing or reviewing a dependency boundary, confirm:

- [ ] Every dependency that is unowned or separately deployed is reached only through a port defined in the core
- [ ] Port names and signatures use domain language and core types exclusively — no vendor or framework types
- [ ] Each adapter is translation-only: no business conditionals, policies, or validation (spot-check the diffs)
- [ ] Core modules have zero imports from adapters, frameworks, vendors, or OS I/O (verified by lint/arch rule if available, otherwise by inspection)
- [ ] Every outbound port has an in-memory fake, and a contract test suite runs against both fake and real adapter
- [ ] All test doubles in the suite are substituted at ports — no internal mocking or module patching anywhere
- [ ] Time, randomness, environment, and filesystem access used by tested behavior are controllable through ports
