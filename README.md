# Adaptive Rate Limiter

A distributed, Redis-backed HTTP rate limiter for Node.js with an **async adaptive
layer**: an out-of-band worker watches traffic, detects anomalous bursts, and
*suggests* limit adjustments — without ever putting statistics or a model on the
request hot path.

The request path is a single atomic Redis round trip. The "smarts" live entirely
in a separate process, so they can never add latency to a request or take the
limiter down.

---

## Why this design

Most "adaptive" rate limiters put a model inline and pay for it on every request.
This one deliberately doesn't. The guiding decisions:

| Decision | Choice | Rationale |
|---|---|---|
| Hot-path correctness | **Atomic Lua** (one round trip) | No read-then-write race; exact under concurrency |
| Clock | **Redis server `TIME`** | App-node clock skew can't corrupt windows |
| Adaptive placement | **Async worker, off the request path** | Inline inference blows the latency budget |
| Event pipeline | **Redis Streams** (not Kafka) | Same consumer-group semantics, zero extra infra |
| Detector | **EWMA + z-score** (not an LSTM) | Explainable, no training data, bounded behaviour |
| Redis down | **Configurable fail-open / fail-closed** + circuit breaker | A dependency outage is a deliberate decision, not an accident |

Each of these is written up in [docs/adr/](docs/adr/).

---

## Architecture

```
                    ┌─────────────── request path (synchronous) ───────────────┐
                    │                                                           │
  clients ──▶ app node(s) ──▶ rate-limit middleware ──▶ Redis (atomic Lua) ──▶ allow / 429
                    │                  │                                        ▲
                    │                  │ fire-and-forget event                  │ reads suggested
                    │                  ▼                                        │ limits (cached)
                    │            Redis Stream (rl:events)                       │
                    │                  │                                        │
                    └──────────────────┼────────────────────────────────────── ┘
                                       │  (asynchronous — separate process)
                                       ▼
                            adaptive worker  ──▶  detector (EWMA + z-score)
                                       │                 │
                                       │                 ▼
                                       └──▶ suggestion store (rl:suggested + audit)
```

The hot path is `middleware → Redis Lua → decision`. Everything below the dashed
line is advisory and runs in its own process (`npm run worker`).

---

## Quickstart

```bash
# 1. start Redis
docker compose up -d

# 2. install + run
npm install
npm start            # API on :3000
npm run worker       # adaptive worker (separate terminal)

# 3. hit it
curl -i localhost:3000/api/ping
```

You'll see the standard headers:

```
RateLimit-Limit: 100
RateLimit-Remaining: 19
RateLimit-Reset: 60
```

Exceed the limit and you get `429 Too Many Requests` with a `Retry-After` header.

---

## Live dashboard (30-second demo)

A real-time WebSocket dashboard makes the limiter explorable — no AI, just live
decisions you can cause yourself.

```bash
npm start
# open http://localhost:3000
```

The page is a self-contained sandbox (works on the deployed URL, no terminal):

- **Try it yourself** — *Send a request* / *Flood ×40* fire real requests from your
  browser to `/api/ping`; a meter shows "requests left before throttling" ticking
  down to a live 429. The active rule (e.g. `100 req / 60s · burst 20`) is shown so
  the numbers mean something.
- **Simulate other clients** — toggle "Normal users" and "Bot attack" lanes; a
  server-side driver runs them through the real limiter (a browser can't spoof
  client IPs). Watch the attacker IP cross the limit and go red while normal users
  stay green.

Everything streams into the live **scope** (throughput, blocked stacked in red),
a top-keys table sorted by block intensity, and an event feed. It's fed in-process
from the same `emit` hook the adaptive layer uses, **batched** over the socket so
request rate ≠ frame rate, and works even with Redis down. See
[src/dashboard/](src/dashboard/). (Terminal alternative: `npm run demo:traffic`.)

---

## Deploy — one click, no config

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/codedpool/adaptive-rate-limiter)

Click the button (or create a Render **Blueprint** from the repo). The included
[render.yaml](render.yaml) provisions a single Node web service — **no env vars to
set**: Render injects `PORT`, the app binds `0.0.0.0`, the admin token is
auto-generated, and `/health` is the health check. The dashboard, API, metrics,
and WebSocket all run on that one service (UI served from `/`), so there's nothing
separate to host. Open the service URL and the dashboard loads.

Redis is **optional**. With none configured the limiter **fails open** to a
per-instance in-memory limiter and the whole dashboard still works — fine for a
demo. To enable true distributed limits, add a `REDIS_URL` env var (Render Key
Value, Upstash, etc.); to enable adaptive suggestions, run `npm run worker` as a
separate background worker.

---

## Using it in your app

### Fastify

```js
import Fastify from 'fastify';
import { rateLimitPlugin } from './src/middleware/fastify.js';
import { makeRuleResolver } from './src/middleware/rules.js';

const app = Fastify({ trustProxy: true }); // so req.ip is the real client
await app.register(rateLimitPlugin, {
  limiter,                                   // a configured Limiter (see src/server.js)
  resolveRule: makeRuleResolver({
    defaultRule: { strategy: 'hybrid', limit: 100, windowMs: 60_000, burst: 20 },
    routes: { 'POST /login': { strategy: 'sliding_window', limit: 5, windowMs: 60_000 } },
  }),
});
```

### Express

```js
import { expressRateLimit } from './src/middleware/express.js';
app.set('trust proxy', true);
app.use(expressRateLimit({ limiter, resolveRule }));
```

---

## Strategies

- **`token_bucket`** — burst up to a capacity, refill at a sustained rate. O(1).
- **`sliding_window`** — exact log of timestamps; no fixed-window edge burst.
- **`hybrid`** (default) — token bucket for burst smoothing **and** a sliding
  window for the hard per-window ceiling. A request must pass both, and is only
  committed to both on success, so they never drift.

All three are implemented as atomic Lua ([src/core/scripts/](src/core/scripts/))
and mirrored by an in-memory JS implementation
([src/core/memoryLimiter.js](src/core/memoryLimiter.js)) used both as the
Redis-down fallback and as a Redis-free reference for tests.

---

## The adaptive layer

1. The middleware emits each decision to a capped Redis Stream (fire-and-forget).
2. The worker consumes the stream via a consumer group, buckets events into
   per-key request rates, and scores each rate with an EWMA + z-score detector.
3. Anomalous spikes **tighten** the key's limit; sustained genuine pressure
   **loosens** it; calm traffic **relaxes** it back toward the configured base.
4. Suggestions are written to Redis with an **audit trail** and clamped to
   `[base × 0.25, base × 4]` — the model can never lock everyone out or open the
   floodgates.
5. The app reads suggestions from a short-interval in-memory cache, so the hot
   path stays a single Redis call.

New keys get the default limit until enough history accumulates (cold start).

---

## Endpoints

| Route | Purpose |
|---|---|
| `GET /health` | Liveness |
| `GET /ready` | Readiness (Redis reachable) |
| `GET /` | Live dashboard (same as `/dashboard`) |
| `GET /metrics` | Prometheus metrics |
| `GET /dashboard` | Live WebSocket dashboard |
| `GET /ws/feed` | Dashboard event stream (WebSocket) |
| `GET /api/ping` | Demo, rate-limited |
| `GET /admin/limits` | Current suggested/overridden limits |
| `PUT /admin/limits/:key` | Manual override (`{ "limit": 25 }`) |
| `DELETE /admin/limits/:key` | Clear override |
| `GET /admin/audit` | Recent limit changes |

Admin routes require `Authorization: Bearer <RL_ADMIN_TOKEN>` when that env var
is set (open in dev, with a warning, when it isn't).

---

## Configuration

All via env (validated at startup — see [src/config/index.js](src/config/index.js)):

| Var | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP bind |
| `REDIS_URL` | `redis://localhost:6379` | Redis |
| `RL_FAIL_MODE` | `open` | `open` (local fallback) or `closed` (deny) on Redis failure |
| `RL_DEFAULT_LIMIT` | `100` | Default limit |
| `RL_DEFAULT_WINDOW_MS` | `60000` | Default window |
| `RL_DEFAULT_BURST` | `20` | Default burst |
| `RL_ADAPTIVE_ENABLED` | `true` | Toggle the adaptive layer |
| `RL_ADMIN_TOKEN` | _(empty)_ | Admin bearer token |

---

## Testing

```bash
npm test
```

The suite has two tiers:

- **Pure unit tests** (algorithms, detector, policy, aggregator, circuit breaker,
  middleware) run anywhere, no Redis.
- **Redis-backed integration tests** (atomic correctness, the **concurrency
  proof**, streams) auto-skip when Redis isn't reachable and run in CI, which
  spins up a Redis service.

The headline test fires hundreds of concurrent requests at one key and asserts
**exactly** the limit is admitted — the proof that the atomic Lua path has no
over-admit race ([test/redisLimiter.test.js](test/redisLimiter.test.js)).

---

## Benchmarks

```bash
docker compose up -d        # real numbers need Redis
npm run bench               # BENCH_STRATEGY=hybrid BENCH_CONNECTIONS=100 ...
```

The harness benchmarks two identical endpoints — one plain, one behind the
limiter — and reports the **added p99 latency**, which is the limiter's true
overhead. See [bench/run.js](bench/run.js).

Sample run (token bucket, 50 connections, 8s):

| | req/s | p50 | p99 |
|---|---|---|---|
| baseline (no limiter) | ~20,000 | 2 ms | 7 ms |
| limited (Redis path) | ~9,000 | 4 ms | 16 ms |

So the limiter adds roughly **3 ms mean / 9 ms p99** here — but that figure is
inflated by the environment: Redis was running in Docker Desktop on Windows
(WSL2), so every decision crosses the VM boundary. With Redis native/co-located,
the single round trip is typically sub-millisecond. What's invariant regardless of
host is the shape: **one round trip per decision, and zero over-admit** (proven by
the concurrency test).

---

## Project layout

```
src/core/        algorithms, Lua scripts, Redis access, limiter facade, breaker
src/middleware/  fastify plugin, express adapter, key extractors, headers
src/adaptive/    stream producer, detector, policy, aggregator, worker, overrides
src/admin/       control-plane routes
src/observability/ metrics, logging
test/            unit + Redis-gated integration
bench/           autocannon harness
docs/            ADRs + architecture
```

---

## What I'd do next

- Per-tenant fairness (weighted fair queueing across keys sharing a backend).
- Multi-region: per-region Redis with async reconciliation of suggestions.
- A smarter (still explainable) detector: seasonality-aware baselines.
- Worker metrics endpoint + Grafana dashboard JSON in-repo.

See [docs/architecture.md](docs/architecture.md) for the full design discussion.
