# ADR 0003 — Atomic Lua scripts for the decision, with Redis server time

**Status:** accepted

## Context

A rate-limit decision reads counters/tokens, decides, and writes the new state.
Done as separate Redis commands, two concurrent requests can both read the old
value and both be admitted — a classic time-of-check/time-of-use race. Naive
`INCR`-based approaches share this flaw under bursts.

## Decision

Implement each strategy as a **single Lua script** that does read + decide +
write atomically, loaded via `EVALSHA` (with `NOSCRIPT` fallback handled by
ioredis `defineCommand`). The script reads the clock from **`redis.call('TIME')`**
rather than any app-node clock.

## Rationale

- Redis executes a script atomically: nothing else runs against that key set
  mid-script, so there is no read-then-write window. The
  [concurrency proof test](../../test/redisLimiter.test.js) fires hundreds of
  simultaneous requests at one key and asserts exactly the limit is admitted.
- One network round trip per decision (good for the latency budget).
- Using Redis server time means a fleet of app nodes with skewed clocks all see
  one authoritative clock; windows can't be corrupted by a misconfigured node.

## Consequences

- Logic lives in Lua, which is less ergonomic than JS and must be kept in sync
  with the in-memory reference implementation. The shared test expectations guard
  against drift.
- Scripts must remain deterministic w.r.t. the keys they touch; `TIME` is allowed
  because modern Redis replicates script *effects*, not the script itself.
