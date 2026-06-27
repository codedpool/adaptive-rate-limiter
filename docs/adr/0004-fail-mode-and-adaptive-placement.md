# ADR 0004 — Redis-down behaviour and adaptive placement

**Status:** accepted

## Context

Two related questions that are easy to get wrong by default:

1. What happens to requests when Redis is unreachable?
2. Where does the adaptive analysis run relative to the request path?

## Decision

1. **Configurable fail mode behind a circuit breaker.** On Redis failure the
   limiter either falls back to a per-node in-memory limiter (`fail open`) or
   denies (`fail closed`). A circuit breaker stops hammering a dead Redis after a
   few failures and retries after a cooldown.
2. **The adaptive layer runs in a separate process, off the request path.** The
   hot path only does a fire-and-forget stream write; all analysis and limit
   suggestion happens in the worker, read back via a cached suggestion set.

## Rationale

- **Fail mode is a real trade-off, not a default to stumble into.** `fail open`
  favours availability (a Redis blip doesn't take down the API) and is the right
  default for most APIs; `fail closed` favours protecting a fragile backend. Note
  that "fail open" here still enforces a *local* best-effort limit per node rather
  than blanket-allowing — strictly better than ignoring limits entirely.
- **Inline inference blows the latency budget.** Putting any statistics — let
  alone a model — synchronously in front of every request adds latency and a
  failure mode to the hot path. Keeping it async means the worst the adaptive
  layer can do is be slightly stale or be down, neither of which affects a single
  request.

## Consequences

- While Redis is down in `fail open`, limits are enforced per node, not globally —
  an acceptable, documented degradation.
- A suggestion takes up to one cache-refresh interval to take effect. Fine,
  because suggestions are advisory, not a synchronous gate.
- Limit suggestions are clamped to `[base × 0.25, base × 4]`, so even a wrong
  classification cannot lock everyone out or remove protection entirely.
