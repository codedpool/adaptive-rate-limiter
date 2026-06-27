# Architecture & design notes

This document covers how the pieces fit together and the design problems that
actually matter when you build a rate limiter for real. For the *why* behind the
big choices, see the [ADRs](adr/).

## Components

| Component | File(s) | Responsibility |
|---|---|---|
| Algorithms | `src/core/scripts/*.lua`, `memoryLimiter.js` | Token bucket, sliding window, hybrid |
| Redis limiter | `src/core/redisLimiter.js`, `scripts.js`, `store.js` | Atomic distributed decisions |
| Limiter facade | `src/core/limiter.js`, `circuitBreaker.js` | Degradation policy + fallback |
| Middleware | `src/middleware/*` | Framework glue, headers, key extraction |
| Adaptive | `src/adaptive/*` | Stream, detector, policy, worker, override cache |
| Admin | `src/admin/routes.js` | Inspect/override limits at runtime |
| Observability | `src/observability/*` | Metrics, structured logging |

## Request lifecycle (hot path)

1. `onRequest` hook fires (route already matched, so route patterns are known).
2. Resolve the rule (route-specific or default); `null` ⇒ skip (probes, admin).
3. Extract the key (`ip:…` by default, from `req.ip` which respects `trustProxy`).
4. Apply any cached adaptive suggestion for that key.
5. One atomic Lua call to Redis → decision.
6. Set `RateLimit-*` headers; on denial, `429` + `Retry-After`.
7. Fire-and-forget an event to the Redis Stream (never awaited).
8. Record metrics (decision result + duration).

Steps 5 is the only network call; step 7 cannot block or fail the request.

## The hard problems, and how they're handled

### Concurrency / over-admit race
Read-decide-write across separate commands races. Solved by doing all three in
one atomic Lua script (ADR 0003). Proven by a test that fires hundreds of
concurrent requests at one key and asserts exactly the limit is admitted.

### Clock skew
Windows are anchored to `redis.call('TIME')`, not app-node clocks, so a fleet with
skewed clocks still agrees on window boundaries. The in-memory fallback
necessarily uses the local clock — acceptable because it's per-node and only
active during a Redis outage.

### Fixed-window edge burst
A fixed window allows up to 2× the limit across a boundary (end of one window +
start of the next). The sliding-window-log strategy avoids this by counting the
exact timestamps in the trailing window. The cost is one sorted-set entry per
request within the window; token bucket is the O(1) option when that matters.

### Redis unavailability
A circuit breaker stops calling a dead Redis after N consecutive failures and
retries after a cooldown. While open, the configured fail mode applies:
`fail open` → per-node in-memory limiting; `fail closed` → deny (ADR 0004).

### Cold start (new keys)
The detector treats a key's first `minSamples` observations as `cold_start` and
makes no suggestion, so new keys run on the configured default until there's
enough history to have a baseline.

### Runaway adaptation
Suggestions are clamped to `[base × 0.25, base × 4]`, and anomalous samples are
excluded from the baseline so an attack can't train the limiter into submission.
Every change is written to an audit log queryable via `/admin/audit`.

## Data flow (adaptive)

```
decision ──emit──▶ rl:events (Stream) ──XREADGROUP──▶ worker
                                                        │ bucket per key (Aggregator)
                                                        ▼
                                                   detector (EWMA + z-score)
                                                        │ classify
                                                        ▼
                                                   policy (suggestLimit, clamped)
                                                        │ if changed
                                                        ▼
                                          rl:suggested (hash) + rl:audit (list)
                                                        ▲
              app override cache ──refresh every few seconds──┘
```

## Testing strategy

- **Pure logic** (algorithms, detector, policy, aggregator, breaker, middleware
  with stubs) is tested without Redis, using injected clocks for determinism.
- **Distributed behaviour** (atomicity, concurrency proof, streams, suggestion
  store) is tested against a real Redis and auto-skips when one isn't present.
- The in-memory limiter doubles as a Redis-free reference, so the algorithm
  expectations are exercised on every run.

## Known limitations / future work

- Suggestions are global per key; no per-tenant fairness yet.
- Single-region assumption (one Redis). Multi-region needs suggestion
  reconciliation.
- The detector is rate-only and not seasonality-aware.
- The worker doesn't yet expose its own metrics endpoint.
