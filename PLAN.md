# Adaptive Rate Limiter — Build Plan

A distributed, Redis-backed rate limiter for Node.js with an **async, lightweight adaptive layer**
that detects anomalous traffic and *suggests* limit adjustments — without ever putting a model in
the request hot path.

> **Design north star:** depth over breadth. A provably-correct, benchmarked limiter with a clean
> writeup beats a sprawling system that "does more" but proves nothing. Every phase ends with
> something demonstrable.

---

## Scope decisions (and why — these *are* the interview story)

| Decision | Choice | Why |
|---|---|---|
| Language | **Node.js (JavaScript, ESM)** | Plain JS, no build step. Lean on JSDoc + schema validation for safety at the edges. |
| Hot-path algo | **Token bucket + sliding window hybrid**, atomic via **Lua** | One round-trip, no TOCTOU race. The thing interviewers poke at. |
| State store | **Redis** (`ioredis`) | Atomic ops, `TIME` for clock authority, Streams for the async pipeline. |
| Event pipeline | **Redis Streams** (NOT Kafka) | Same consumer-group semantics, zero extra infra. Defend this explicitly. |
| Adaptive model | **EWMA + z-score** (NOT LSTM) | Explainable, no labeled data needed, runs out-of-band. |
| Adaptive placement | **Async sidecar worker** (NOT inline) | ML/stats never gate a request → latency budget intact. The senior move. |
| Web layer | **Fastify** (Express adapter too) | Higher throughput → better benchmark numbers. |

**Cut from the original idea:** Kafka, LSTM, "distributed counter subsystem" (replaced by atomic Lua).

---

## Tech stack

- **Runtime:** Node.js 20+, JavaScript (ESM). JSDoc type annotations for editor hints (optional)
- **Redis client:** `ioredis`
- **Web:** Fastify (with a thin Express middleware adapter)
- **Metrics:** `prom-client` (Prometheus) + optional Grafana
- **Logging:** `pino`
- **Tests:** `vitest`, `testcontainers` (real Redis in CI)
- **Load/bench:** `k6` (or `autocannon`)
- **Local stack:** Docker Compose (app + Redis + Prometheus + Grafana)
- **CI:** GitHub Actions

---

## Target repo structure

```
rate-limiter/
├── src/
│   ├── core/            # algorithms, Lua scripts, Redis access
│   │   ├── scripts/     # *.lua (token-bucket, sliding-window, hybrid)
│   │   ├── limiter.js   # public Limiter API
│   │   ├── strategies/  # tokenBucket, slidingWindow, hybrid
│   │   └── store.js     # Redis wrapper, script loading (EVALSHA)
│   ├── middleware/      # fastify plugin + express adapter
│   ├── adaptive/        # stream producer + anomaly worker (sidecar)
│   ├── admin/           # admin/control API
│   ├── observability/   # metrics, logging
│   └── config/          # schema-validated config
├── test/                # unit, integration, concurrency
├── bench/               # k6 scripts + results
├── docker/              # compose, dashboards
├── docs/                # ADRs, architecture, benchmark report
└── PLAN.md
```

---

# Phase 0 — Foundation & Setup
*Goal: a runnable skeleton with CI green and Redis up.*

### Stage 0.1 — Repo & tooling
- [ ] `git init`, add `.gitignore`, `LICENSE`, `README.md` skeleton
- [ ] `npm init` + ESM setup (`"type": "module"` in package.json)
- [ ] ESLint + Prettier configured and wired to `npm run lint`
- [ ] (Optional) `jsconfig.json` + JSDoc so the editor still type-checks JS
- [ ] Scripts: `dev`, `test`, `lint`, `bench`

### Stage 0.2 — Local infrastructure
- [ ] `docker-compose.yml` with Redis (pinned version)
- [ ] Schema-validated config loader (env → typed config, fails fast on bad input)
- [ ] Redis connection wrapper with health check + retry/backoff

### Stage 0.3 — CI & quality gates
- [ ] GitHub Actions: install → lint → test on push/PR
- [ ] `/health` and `/ready` endpoints (ready = Redis reachable)
- [ ] First commit, branch protection / PR workflow established

**Exit criteria:** `docker compose up` runs; CI is green; `/health` returns 200.

---

# Phase 1 — Core rate-limiting engine
*Goal: correct algorithms behind a clean, testable API (single instance).*

### Stage 1.1 — Contracts
- [ ] Define the `RateLimitResult` shape (`allowed`, `remaining`, `limit`, `resetAt`, `retryAfter`) — document via JSDoc
- [ ] Define the `Limiter` API + per-rule config (`key`, `limit`, `windowMs`, `burst`)
- [ ] Define key-strategy abstraction (per-IP, per-user, per-route, composite)
- [ ] Validate all rule/config objects at the boundary with a schema (e.g. `zod`) since there's no compiler

### Stage 1.2 — Token bucket (atomic Lua)
- [ ] Lua script: refill + consume in one atomic op
- [ ] Use Redis `TIME` as the clock source (no client-clock dependency)
- [ ] Unit tests: burst allowance, steady-state refill, exhaustion, boundary ticks

### Stage 1.3 — Sliding window (atomic Lua)
- [ ] Lua script: sliding-window counter (or sorted-set log) atomic eval
- [ ] Unit tests: window edges, rollover, no double-count

### Stage 1.4 — Hybrid strategy
- [ ] Compose token bucket (burst) + sliding window (sustained rate)
- [ ] Document the decision rule (which one rejects when)
- [ ] Unit tests for the combined behavior

**Exit criteria:** all three strategies pass unit tests; clock is Redis-authoritative.

---

# Phase 2 — Distributed correctness & atomicity
*Goal: prove it's correct under concurrency across many clients/instances.*

### Stage 2.1 — Atomic delivery
- [ ] Load Lua via `SCRIPT LOAD` + `EVALSHA`, with `NOSCRIPT` reload fallback
- [ ] Single round-trip per decision (verify: no read-then-write race)

### Stage 2.2 — Concurrency proof (the headline test)
- [ ] Test harness firing N concurrent requests at one key from M workers
- [ ] Assert exact admit count == limit (zero over-admit, zero deadlock)
- [ ] Run across **multiple app instances** sharing one Redis

### Stage 2.3 — Edge cases
- [ ] Clock-skew test: instances with skewed local clocks → still correct (server time)
- [ ] TTL/expiry correctness (keys self-clean, no leak)
- [ ] Composite keys (per-IP + per-route) isolation test

**Exit criteria:** concurrency test green at high contention; documented "why no race."

---

# Phase 3 — API / middleware integration
*Goal: actually usable by a real service, with correct HTTP semantics & graceful failure.*

### Stage 3.1 — Middleware
- [ ] Fastify plugin: per-route limits, pluggable key extractor
- [ ] Express adapter wrapping the same core
- [ ] Trusted-proxy / `X-Forwarded-For` handling (anti-spoof, configurable)

### Stage 3.2 — HTTP correctness
- [ ] `429` responses with `Retry-After`
- [ ] `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers (IETF draft)
- [ ] Per-route + global + tiered (per-plan) rule resolution

### Stage 3.3 — Graceful degradation (a real design decision)
- [ ] **Fail-open vs fail-closed** policy, configurable, default documented
- [ ] Circuit breaker around Redis; short-lived in-memory fallback
- [ ] Chaos test: kill Redis mid-traffic → behavior matches the chosen policy

**Exit criteria:** sample app protected by middleware; Redis-down behavior is deliberate & tested.

---

# Phase 4 — Adaptive layer (async, out-of-band)
*Goal: "adaptive" in the name, honestly — stats suggest limits; the request path stays untouched.*

### Stage 4.1 — Event pipeline
- [ ] Emit request-decision events to a **Redis Stream** (non-blocking, fire-and-forget)
- [ ] Anomaly **worker** consuming via a consumer group (separate process)
- [ ] Backpressure / trim policy on the stream (capped length)

### Stage 4.2 — Detection (explainable)
- [ ] Per-key **EWMA** of request rate + **z-score** spike detection
- [ ] Classify burst: `organic` vs `anomalous` (transparent thresholds, no black box)
- [ ] Cold-start: new keys get a safe default tier until enough history

### Stage 4.3 — Adjustment (safe by construction)
- [ ] Worker writes *suggested* limits to Redis (read by the hot path on next decision)
- [ ] Hard floor/ceiling clamps so the model can never lock out all traffic
- [ ] Bounded auto-apply + manual override; **audit log** of every change
- [ ] Tests: synthetic organic ramp vs synthetic attack burst → correct classification

**Exit criteria:** replaying a burst log makes the worker adjust limits; hot-path latency unchanged.

---

# Phase 5 — Observability & operations
*Goal: you can see what it's doing and operate it.*

### Stage 5.1 — Metrics & logs
- [ ] Prometheus metrics: allowed/blocked counts, decision latency, Redis RTT, active limits
- [ ] Structured `pino` logs with request/key context
- [ ] Grafana dashboard (allow/block rate, p99 added latency, anomalies)

### Stage 5.2 — Control plane
- [ ] Admin API: view/edit rules, view current vs suggested limits, view anomaly events
- [ ] AuthN on admin endpoints
- [ ] Graceful shutdown (drain, close Redis, flush stream)

**Exit criteria:** dashboard shows live traffic; limits editable at runtime.

---

# Phase 6 — Testing, benchmarks & hardening
*Goal: the numbers and the proof that make reviewers trust it.*

### Stage 6.1 — Test depth
- [ ] Integration tests against **real Redis** via testcontainers in CI
- [ ] Coverage on core algorithms + failure paths
- [ ] Property/fuzz test on key extraction & config parsing

### Stage 6.2 — Benchmarks (put numbers in the README)
- [ ] `k6` scripts: throughput (req/s) and **added p50/p99 latency** of the limiter
- [ ] Compare hybrid vs token-bucket vs sliding-window cost
- [ ] Record results + methodology in `docs/benchmarks.md`

### Stage 6.3 — Security & hardening
- [ ] Spoofed `X-Forwarded-For` test; trusted-proxy enforcement
- [ ] Resource limits (max keys, stream cap, memory) verified under load
- [ ] Dependency audit clean

**Exit criteria:** published benchmark numbers; chaos + security tests green.

---

# Phase 7 — Docs & polish (the interview multiplier)
*Goal: make the work legible in 5 minutes. This is half the value.*

### Stage 7.1 — Writeup
- [ ] README: problem, architecture diagram, quickstart, benchmark numbers, demo GIF
- [ ] **ADRs** in `docs/`: why no Kafka, why no LSTM, why Lua-atomic, fail-open choice, async adaptive
- [ ] Design doc: tradeoffs, clock-skew handling, cold-start, failure modes

### Stage 7.2 — Demo & closeout
- [ ] One-command demo (`docker compose up` → hit it → watch dashboard adapt)
- [ ] "What I'd do next" section (multi-region, per-tenant fairness, smarter detector)
- [ ] Final pass: lint, types, tests, dead code removed

**Exit criteria:** a stranger can clone, run, and understand the design in minutes.

---

## Suggested milestones

- **M1 — Works (Phases 0–1):** correct algorithms, tested locally.
- **M2 — Distributed & usable (Phases 2–3):** concurrency-proven, real middleware, graceful failure. *(Strong portfolio piece already.)*
- **M3 — Adaptive & observable (Phases 4–5):** the differentiator + dashboards.
- **M4 — Proven & presented (Phases 6–7):** benchmarks, docs, demo. *(Interview-ready.)*

> If time is short, **M2 alone is a great project.** M3–M4 are what make you stand out.

## Interview talking points this plan earns you

- "I made the hot-path decision atomic with a Lua script to avoid the read-then-write race." (Phase 1–2)
- "I proved zero over-admit under concurrency across instances." (Phase 2)
- "I used Redis server time so client clock skew can't corrupt windows." (Phase 1–2)
- "I kept the anomaly model off the request path — async worker, Redis Streams, not Kafka — because the latency budget didn't allow synchronous inference." (Phase 4)
- "Redis-down is a deliberate fail-open/closed decision, with a circuit breaker." (Phase 3)
- "Here are the p99-added-latency numbers." (Phase 6)
