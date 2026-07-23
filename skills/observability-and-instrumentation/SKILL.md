---
name: observability-and-instrumentation
description: Instruments code so production behavior is visible and diagnosable. Use when adding logging, metrics, tracing, or alerting. Use when defining SLIs, SLOs, or error budgets, or tuning noisy alerts to burn rate. Use when shipping any feature that runs in production and you need evidence it works. Use when production issues are reported but you can't tell what happened from the available data.
---

# Observability and Instrumentation

## Overview

Code you can't observe is code you can't operate. Observability is the ability to answer "what is the system doing and why?" from the outside, using the telemetry the code emits. Instrumentation is not a post-launch add-on — it's written alongside the feature, the same way tests are. If a feature ships without telemetry, the first user-reported bug becomes archaeology instead of a query.

## When to Use

- Building any feature that will run in production
- Adding a new service, endpoint, background job, or external integration
- A production incident took too long to diagnose ("we couldn't tell what happened")
- Defining or reviewing SLIs, SLOs, and error budgets for a service
- Setting up or reviewing alerting rules
- Reviewing a PR that adds I/O, retries, queues, or cross-service calls

**NOT for:**
- Diagnosing a failure happening right now — use the `debugging-and-error-recovery` skill (observability is what makes that skill fast next time)
- Profiling and optimizing measured slowness — use the `performance-optimization` skill
- Launch-day monitoring checklists and rollback triggers — see the `shipping-and-launch` skill; this skill covers the instrumentation that feeds them

## Process

### 1. Define "working" before instrumenting

Telemetry without a question is noise. Before adding any instrumentation, write down 2–4 questions an on-call engineer will ask about this feature:

```
FEATURE: checkout payment retry
QUESTIONS ON-CALL WILL ASK:
1. What fraction of payments succeed on first attempt vs after retry?
2. When a payment fails permanently, why? (provider error? timeout? validation?)
3. Is the payment provider slower than usual?
→ Every signal below must help answer one of these.
```

If you can't name the questions, you're not ready to instrument — you'll log everything and learn nothing.

### 2. Define SLIs, SLOs, and the error budget

The on-call questions quantify into **Service Level Indicators** — measurements of what users experience, taken from user journeys, not from infrastructure:

```
SLI:  fraction of checkout requests that complete successfully in < 2s
SLO:  99.5% over a rolling 30 days
Error budget: the 0.5% you're allowed to fail — 3.6 hours/month
```

- **SLIs come from the user's side of the boundary.** "Payments succeed quickly" is an SLI; "CPU below 80%" is not. Express each SLI as good events / total events so it yields a ratio.
- **SLOs are targets you defend, not aspirations.** Pick them from what users actually need and what the service has historically achieved — a target no one will act on is decoration. 100% is never the target; the gap *is* the error budget.
- **The error budget arbitrates ship vs. stabilize.** Budget remaining → ship features, take risk. Budget exhausted → reliability work takes priority over new features. This turns "is it reliable enough?" from an argument into arithmetic.
- Name SLIs in the ubiquitous language of the domain (`checkout`, `invoice submission`) so the SLO dashboard reads like the product, not like the infrastructure.

Every service (or deployable unit) should have a small number of SLOs — one to three user journeys — written down where on-call can find them. The alerting section below is driven by these.

### 3. Pick the right signal for each question

| Signal | Answers | Cost profile | Example |
|---|---|---|---|
| **Structured log** | "What happened in this specific case?" | Per-event; grows with traffic | `payment_failed` with provider error code |
| **Metric** | "How often / how fast, in aggregate?" | Fixed per series; cheap to query | p99 latency of provider calls |
| **Trace** | "Where did time go across services?" | Per-request; usually sampled | One slow checkout, broken down by hop |

Rule of thumb: metrics tell you **that** something is wrong, traces tell you **where**, logs tell you **why**.

### 4. Emit telemetry through a port, named from the glossary

Telemetry SDKs (loggers, metrics clients, OpenTelemetry) are unowned dependencies — by the `ports-and-adapters` rule, core code never calls them directly. The core emits **domain observations** through a telemetry port it defines; a thin adapter maps them onto the SDK. OpenTelemetry then serves as the vendor-neutral seam between the adapter and whatever backend is in use.

```typescript
// core/ports/telemetry.ts — the port, in domain language
export interface Telemetry {
  emit(observation: DomainObservation): void;  // e.g. { event: 'payment_failed', ... }
}

// adapters/otel-telemetry.ts — thin: map observation → log record + span event + counter
```

This buys two things:

- **Telemetry becomes testable behavior.** Tests wire a fake `Telemetry` collector and assert on emissions: *"when a payment fails permanently, a `payment_failed` observation carrying the provider error code is emitted."* If it matters to on-call, it's specified — instrumentation stops regressing silently. Acceptance-stage checks do the same against the deployed system (see `acceptance-testing`): induce a failure, locate it by correlation ID via telemetry alone.
- **Names stay ubiquitous.** Event names, span names, SLI names, and attributes come from the project glossary (`ubiquitous-language`): `payment_failed`, not `txn_err`. Anyone who knows the domain can query the telemetry during an incident. For the technical layer (HTTP, DB, runtime attributes), follow OpenTelemetry's semantic conventions — the same one-term-per-concept idea, standardized.

Purely technical telemetry (HTTP server spans, DB client metrics, runtime stats) lives in adapters and auto-instrumentation, where SDK calls are already legal — no port needed there.

### 5. Structured logging — wide events over scattered lines

Log events, not prose. Every log line is a JSON object with a stable event name and machine-readable fields:

```typescript
// BAD: string interpolation — unqueryable, inconsistent
logger.info(`Payment ${id} failed for user ${userId} after ${n} retries`);

// GOOD: stable event name + structured fields
logger.warn({
  event: 'payment_failed',
  paymentId: id,
  provider: 'stripe',
  errorCode: err.code,
  attempt: n,
}, 'payment failed');
```

**Log levels — use them consistently:**

| Level | Meaning | On-call action |
|---|---|---|
| `error` | Invariant broken; someone may need to act | Investigate |
| `warn` | Degraded but handled (retry succeeded, fallback used) | Watch for trends |
| `info` | Significant business event (order placed, job finished) | None |
| `debug` | Diagnostic detail | Off in production by default |

**Correlation IDs are mandatory.** Generate (or accept) a request ID at the system boundary and attach it to every log line, span, and outbound call. Without it, you cannot reconstruct a single request from interleaved logs:

```typescript
// Express: child logger per request, ID propagated downstream
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] ?? crypto.randomUUID();
  req.log = logger.child({ requestId: req.id });
  res.setHeader('x-request-id', req.id);
  next();
});
```

**Never log secrets, tokens, passwords, or full PII.** This is a hard rule from the `security-and-hardening` skill — telemetry pipelines are a classic data-leak path. Allowlist fields; don't log whole request bodies.

**Prefer one wide event per request over many narrow lines.** Accumulate context as the request executes — user tier, feature flags, retry counts, cache hits, durations, the decisions taken — and emit a single context-rich event at the end (per service hop), alongside only the notable mid-flight events (errors, degradations). High cardinality is *welcome* in events (unlike metric labels): `customerId` in a wide event is what lets you answer the unknown-unknown question — "is this only happening to enterprise customers on the new pricing flag?" — that no pre-aggregated dashboard anticipated. Ten scattered `info` lines that each carry one field answer nothing; one event carrying all ten fields answers questions you haven't thought of yet.

### 6. Metrics

For request-driven services, instrument **RED** on every endpoint and every external dependency: **R**ate (requests/sec), **E**rrors (failure rate), **D**uration (latency histogram, not average). For resources (queues, pools, hosts), use **USE**: **U**tilization, **S**aturation, **E**rrors.

As with tracing, the vendor-neutral path is the OpenTelemetry metrics API (same SDK and context as step 7). The example below uses Prometheus' `prom-client` — one common backend choice, not the only one; the RED/USE and cardinality rules are identical either way.

```typescript
import { Histogram } from 'prom-client';

const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status_class'],  // '2xx', not '200'
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});
```

**Cardinality is the failure mode.** Every unique label combination is a separate time series. Labels must come from small, fixed sets (route template, status class, provider name). Never use user IDs, raw URLs, error messages, or other unbounded values as labels — that belongs in logs and traces.

```
OK as label:    route="/api/tasks/:id"   status_class="5xx"   provider="stripe"
NEVER a label:  user_id, email, request_id, full URL, error message text
```

Track averages never, percentiles always: an average hides the 1% of users having a terrible time. Use histograms and read p50/p95/p99.

### 7. Distributed tracing

Use OpenTelemetry — it's the vendor-neutral standard, and auto-instrumentation covers HTTP, gRPC, and common DB clients with near-zero code:

```typescript
// tracing.ts — must be imported before anything else
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  serviceName: 'checkout-service',
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();
```

Add manual spans only around meaningful internal units of work (e.g., `applyDiscounts`, `chargeProvider`) and attach the attributes on-call will filter by. Propagate context across every async boundary — HTTP headers, queue message metadata — or the trace dies at the gap. Sample head-based at a low rate by default; keep 100% of errors if your backend supports tail sampling.

**Sampling and retention are cost decisions — make them deliberately.** Wide events and traces are per-request data; decide what fraction to keep (and for how long) based on traffic and the questions you need answered, and write the decision down. Never let a default "keep everything forever" (or a silent "we dropped 99%") be discovered during an incident.

### 8. Alerting on the error budget

Alert on **symptoms users feel**, not on causes:

```
SYMPTOM (page-worthy):           CAUSE (dashboard, not a page):
error rate > 1% for 5 min        CPU at 85%
p99 latency > 2s                 one pod restarted
queue age > 10 min               disk at 70%
```

Cause-based alerts fire when nothing is wrong and miss failures you didn't predict. Symptom-based alerts fire exactly when users are hurt, regardless of the cause.

**The best symptom alert is error-budget burn rate.** Instead of a raw threshold ("error rate > 1%"), alert on how fast the SLO's budget is being consumed, at multiple windows:

```
Page:    14x burn over 1h   (exhausts a 30-day budget in ~2 days — act now)
Page:     6x burn over 6h   (sustained serious burn)
Ticket:   1x burn over 3d   (slow leak — fix this week)
```

Multi-window burn-rate alerts page for fast outages in minutes, catch slow degradation raw thresholds miss, and stay silent when a brief blip poses no threat to the SLO — which is precisely the noise/coverage trade a static threshold can't make.

Rules for every alert you create:

1. **It must be actionable.** If the response is "ignore it, it self-heals", delete the alert.
2. **It links to a runbook** — even three lines: what it means, first query to run, escalation path.
3. **It has a threshold and duration** derived from the SLO (burn rate) or historical data, not a guess.
4. Use two severities only: **page** (user-facing, act now) and **ticket** (degradation, act this week). A third tier becomes noise that trains people to ignore everything.

### 9. Health checks and synthetic probes

Telemetry shows what traffic experienced; it's silent when there is no traffic. Cover the outside view:

- **Liveness** ("restart me") and **readiness** ("route to me") endpoints, kept honest: readiness checks the service's *own* critical dependencies only — a readiness check that fans out to every downstream turns one dependency's blip into a cascading outage.
- **Synthetic probes** exercise each critical user journey from outside the boundary on a schedule (a scripted checkout every minute), so a 3 a.m. breakage pages you, not your first morning customer. Probe through the real entry point, tag synthetic traffic so it's excludable from SLIs, and never let probes create real side effects (use test accounts — functional isolation, as in `acceptance-testing`).

### 10. Verify the telemetry itself

Instrumentation is code; it can be wrong. Domain observations emitted through the telemetry port are asserted in unit tests against the fake collector (see step 4) — that's the regression guard. Then, before calling the work done, trigger the paths and look at the actual output:

- Force an error in staging → find it in the logs by `requestId`, confirm fields are structured (not `[object Object]`)
- Send test traffic → confirm metric series appear with the expected labels and sane values
- Follow one request across services in the tracing UI → no broken spans
- Fire each new alert once (lower the threshold temporarily) → confirm it reaches the right channel and the runbook link works

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll add logging after it works" | "After" becomes "after the first incident", which is the most expensive moment to discover you're blind. Instrument as you build. |
| "More logs = more observability" | Unstructured noise makes incidents slower, not faster. Three queryable events beat three hundred prose lines. |
| "console.log is fine for now" | Unstructured output can't be filtered, correlated, or alerted on. The structured logger costs five extra minutes once. |
| "We can just look at the dashboards when something breaks" | Dashboards built without defined questions show you everything except the answer. Start from on-call questions. |
| "Alert on everything important, we'll tune later" | A noisy pager trains people to ignore it. The tuning never happens; the missed real page does. |
| "User ID as a metric label makes debugging easier" | It also makes your metrics backend fall over. High-cardinality lookups belong in logs and traces. |
| "Tracing is overkill for our two services" | Two services already means cross-service latency questions logs can't answer. Auto-instrumentation makes the cost trivial. |
| "We don't need SLOs, we just fix things when they break" | Without a budget, every blip is an argument about whether it matters. An SLO turns "reliable enough?" into arithmetic and tells you when to stop shipping and stabilize. |
| "100% uptime is the goal" | A 100% target means a zero error budget: no releases, no maintenance, no experiments. Pick the reliability users actually need and spend the rest. |
| "The core can log directly, it's just a logger call" | The logger is an unowned dependency like any other — behind a port. Direct calls make the core's most operationally important behavior (its telemetry) the one thing no test covers. |
| "Telemetry doesn't need tests, we'd notice if it broke" | You notice during an incident — the most expensive possible moment. Assert emissions against the fake collector like any other behavior. |
| "We can name the events whatever, we'll grep for them" | Incident responders query by the domain's words. An event the glossary calls `payment_failed` but the code calls `txn_err` is invisible at 3 a.m. |

## Red Flags

- A feature PR with retries, queues, or external calls and zero new telemetry
- Log lines built by string interpolation instead of structured fields
- No correlation/request ID — each log line is an orphan
- Metrics labeled with user IDs, raw URLs, or error message text (cardinality bomb)
- Latency tracked as an average with no percentiles
- Alerts that fire daily and get acknowledged without action
- Alerts on causes (CPU, memory) paging humans while user-facing error rate is unmonitored
- A service with no written SLOs, or SLO breaches that never affect what the team ships next
- Alert thresholds picked by guesswork instead of derived from the error budget or history
- Core/domain code importing a logger, metrics client, or tracing SDK directly instead of emitting through the telemetry port
- Domain events named outside the glossary (`txn_err` where the domain says `payment_failed`)
- No test asserts on emitted telemetry — instrumentation can silently regress
- Many narrow log lines per request, each carrying one field, instead of one wide context-rich event
- A readiness check that fans out to every downstream dependency
- Critical user journeys with no synthetic probe — zero traffic means zero telemetry means silent downtime
- Secrets, tokens, or full request bodies appearing in logs
- "It works on my machine" as the only evidence a production feature is healthy

## Verification

After instrumenting a feature, confirm:

- [ ] The on-call questions for this feature are written down, and each signal maps to one
- [ ] The affected user journey has an SLI/SLO (new or existing), written down where on-call can find it
- [ ] Domain observations are emitted through the telemetry port, with at least one test asserting the emissions on the fake collector
- [ ] Event, span, and SLI names use glossary terms (`ubiquitous-language`); technical attributes follow OpenTelemetry semantic conventions
- [ ] Each request produces one wide, context-rich event per service hop (plus notable mid-flight events), not a scatter of one-field lines
- [ ] All log output is structured (JSON), with stable event names and a correlation ID on every line
- [ ] No secrets, tokens, or unredacted PII in any log line (spot-check actual output)
- [ ] RED metrics exist for every new endpoint and every external dependency, with bounded label sets
- [ ] Latency is a histogram; p95/p99 are queryable
- [ ] A single request can be followed end-to-end in the tracing UI without broken spans
- [ ] Every new alert is symptom-based — burn-rate against the SLO where one exists — has a runbook link, and was test-fired once
- [ ] Critical user journeys have synthetic probes using isolated test data, tagged and excluded from SLIs
- [ ] An induced failure in staging was located via telemetry alone, without reading the source

For the at-a-glance version of this list, including the pre-launch instrumentation gate, see `references/observability-checklist.md`.
