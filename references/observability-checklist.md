# Observability Checklist

Quick reference for instrumenting production code. Use alongside the `observability-and-instrumentation` skill.

## Table of Contents

- [On-Call Questions (Start Here)](#on-call-questions-start-here)
- [SLIs, SLOs, and Error Budget](#slis-slos-and-error-budget)
- [Telemetry Port and Naming](#telemetry-port-and-naming)
- [Structured Logging](#structured-logging)
- [Metrics](#metrics)
- [Distributed Tracing](#distributed-tracing)
- [Alerting](#alerting)
- [Health Checks and Synthetic Probes](#health-checks-and-synthetic-probes)
- [Dashboards](#dashboards)
- [Verify the Telemetry](#verify-the-telemetry)
- [Pre-Launch Gate](#pre-launch-gate)

## On-Call Questions (Start Here)

Telemetry without a question is noise. Before instrumenting anything:

- [ ] 2–4 questions an on-call engineer will ask about this feature are written down
- [ ] Every signal below maps to one of those questions
- [ ] Each question is matched to the right signal type: metrics say **that** something is wrong, traces say **where**, logs say **why**

## SLIs, SLOs, and Error Budget

- [ ] Each critical user journey has an SLI expressed as good events / total events, measured from the user's side of the boundary
- [ ] Each SLI has an SLO target picked from user needs and historical performance — never 100%
- [ ] SLOs (one to three per service) are written down where on-call can find them
- [ ] SLI names use the domain's glossary terms (`ubiquitous-language`)
- [ ] The error budget has teeth: budget exhausted → reliability work outranks new features

## Telemetry Port and Naming

- [ ] Core code emits domain observations through a telemetry port — no direct logger/metrics/tracing SDK imports in the core (`ports-and-adapters`)
- [ ] At least one test asserts on emitted observations via the fake collector — telemetry is specified behavior
- [ ] Event and span names come from the glossary; technical attributes follow OpenTelemetry semantic conventions
- [ ] Purely technical telemetry (HTTP, DB, runtime) lives in adapters and auto-instrumentation

## Structured Logging

- [ ] Logs are structured (JSON) with stable event names — not free-form strings
- [ ] One wide, context-rich event per request per service hop (flags, tier, retries, durations, decisions) — high cardinality welcome in events; mid-flight lines reserved for errors and degradations
- [ ] Every log line carries a correlation/request ID, generated or accepted at the system boundary
- [ ] Correlation ID is propagated on every outbound call and async boundary (HTTP headers, queue metadata)
- [ ] Log levels are consistent: `error` = invariant broken, someone may act; `warn` = degraded but handled; `info` = significant business event; `debug` = off in production
- [ ] No secrets, tokens, passwords, or unredacted PII in any log line (hard rule from `security-and-hardening`)
- [ ] Fields are allowlisted — no whole request/response bodies, no auth headers
- [ ] External service calls logged with metadata only: endpoint, status, latency, attempt count, sanitized identifiers
- [ ] Actual log output spot-checked: structured fields, not `[object Object]`

## Metrics

- [ ] **RED** instrumented for every endpoint and every external dependency: Rate, Errors, Duration
- [ ] **USE** instrumented for every resource (queues, pools, hosts): Utilization, Saturation, Errors
- [ ] Latency is a histogram; p50/p95/p99 queryable — never an average
- [ ] All labels come from small, fixed sets (route template, status class, provider name)
- [ ] No unbounded label values: no user IDs, tenant IDs, emails, raw URLs, request IDs, or error message text
- [ ] Status codes grouped by class (`5xx`, not `503`)
- [ ] Queue depth and processing duration tracked for every worker/queue

## Distributed Tracing

- [ ] OpenTelemetry (or equivalent) initialized at service startup, before other imports
- [ ] Auto-instrumentation enabled for HTTP, gRPC, and DB clients
- [ ] Trace context propagated on every outbound call (W3C `traceparent`/`tracestate`) and extracted from every inbound request
- [ ] Context survives async boundaries — queue messages carry trace metadata
- [ ] Manual spans only around meaningful internal units of work, with the attributes on-call will filter by
- [ ] No secrets or PII as span attributes
- [ ] Head-based sampling at a low default rate; 100% of errors kept if tail sampling is available
- [ ] Sampling rate and retention are written-down decisions, not defaults discovered during an incident

## Alerting

- [ ] Every alert is symptom-based (error rate, p99 latency, queue age) — causes (CPU, disk, restarts) go to dashboards, not pagers
- [ ] Where an SLO exists, paging alerts are multi-window error-budget burn rate (fast burn pages, slow burn tickets), not raw thresholds
- [ ] Every alert is actionable; "ignore it, it self-heals" alerts are deleted
- [ ] Every alert links to a runbook — minimum three lines: what it means, first query to run, escalation path
- [ ] Thresholds and durations justified by an SLO or historical data, not guesses
- [ ] Two severities only: **page** (user-facing, act now) and **ticket** (degradation, act this week)
- [ ] Each new alert test-fired once: it reached the right channel and the runbook link works
- [ ] No alerts that fire daily and get acknowledged without action

## Health Checks and Synthetic Probes

- [ ] Liveness ("restart me") and readiness ("route to me") endpoints exist and are distinct
- [ ] Readiness checks the service's own critical dependencies only — no fan-out to every downstream
- [ ] Each critical user journey has a scheduled synthetic probe through the real entry point
- [ ] Synthetic traffic uses isolated test data, is tagged, and is excluded from SLIs

## Dashboards

- [ ] Service health dashboard exists: error rate, latency p99, traffic, saturation
- [ ] Dependency health panel shows per-service error rates and latency
- [ ] Dashboard answers the on-call questions from the top of this checklist — not "everything except the answer"
- [ ] Default time range is sensible (1h–6h, not 30d)

## Verify the Telemetry

Instrumentation is code; it can be wrong:

- [ ] Unit tests assert domain observations against the fake telemetry collector
- [ ] Forced an error in staging → found it in the logs by correlation ID
- [ ] Sent test traffic → metric series appear with expected labels and sane values
- [ ] Followed one request end-to-end in the tracing UI → no broken spans
- [ ] An induced failure was diagnosed from telemetry alone, without reading the source

## Pre-Launch Gate

Before a feature ships to production, all of the following are true:

- [ ] Structured logs flowing to the log aggregator
- [ ] The affected user journey's SLI/SLO is defined and its dashboard live
- [ ] RED metrics visible in dashboards for every new endpoint and dependency
- [ ] At least one symptom-based alert configured (burn-rate where an SLO exists), with runbook, test-fired
- [ ] A request can be traced across every service it touches
- [ ] Synthetic probe covering the journey, green in production
- [ ] On-call knows where the runbooks are

For launch-day monitoring sequence and rollback triggers, see the `shipping-and-launch` skill.
