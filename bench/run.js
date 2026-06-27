import autocannon from 'autocannon';
import Fastify from 'fastify';
import Redis from 'ioredis';
import { RedisLimiter } from '../src/core/redisLimiter.js';
import { Limiter } from '../src/core/limiter.js';
import { rateLimitPlugin } from '../src/middleware/fastify.js';

/**
 * Measures the *overhead the limiter adds* by benchmarking two otherwise
 * identical endpoints: one plain, one behind the rate-limit middleware. The
 * difference in p99 latency is the number that matters.
 *
 * Defaults to the token-bucket strategy because it is O(1) per call, so the
 * measurement reflects the round-trip + Lua cost rather than data-structure
 * growth. Set BENCH_STRATEGY=hybrid|sliding_window to measure the others.
 *
 * Env: BENCH_DURATION (s), BENCH_CONNECTIONS, BENCH_STRATEGY, REDIS_URL.
 * Run Redis first for the real distributed number; without it, the script falls
 * back to the in-memory path and says so.
 */
const DURATION = Number(process.env.BENCH_DURATION || 10);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS || 50);
const STRATEGY = process.env.BENCH_STRATEGY || 'token_bucket';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// A limit large enough that nothing is ever blocked — we measure the allow path.
const HUGE = 1_000_000_000;

async function buildBaseline() {
  const app = Fastify({ logger: false });
  app.get('/api/ping', async () => ({ pong: true }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  return app;
}

async function buildLimited() {
  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true, retryStrategy: () => null });
  client.on('error', () => {});
  let usingRedis = false;
  try {
    await client.connect();
    usingRedis = (await client.ping()) === 'PONG';
  } catch {
    usingRedis = false;
  }

  const app = Fastify({ logger: false, trustProxy: true });
  const limiter = new Limiter({ redisLimiter: new RedisLimiter(client), failMode: 'open' });
  const rule = { strategy: STRATEGY, limit: HUGE, windowMs: 60_000, burst: HUGE };
  await app.register(rateLimitPlugin, {
    limiter,
    resolveRule: () => rule,
    keyGenerator: () => 'bench:fixed',
  });
  app.get('/api/ping', async () => ({ pong: true }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, usingRedis, client };
}

const portOf = (app) => app.server.address().port;

function bench(url) {
  return new Promise((resolve, reject) => {
    autocannon({ url, connections: CONNECTIONS, duration: DURATION }, (err, result) =>
      err ? reject(err) : resolve(result),
    );
  });
}

async function main() {
  const baseApp = await buildBaseline();
  const { app: limApp, usingRedis, client } = await buildLimited();

  // eslint-disable-next-line no-console
  console.log(
    `\nbenchmark  strategy=${STRATEGY}  connections=${CONNECTIONS}  duration=${DURATION}s  ` +
      `path=${usingRedis ? 'redis (distributed)' : 'IN-MEMORY FALLBACK — start Redis for the real number'}\n`,
  );

  const base = await bench(`http://127.0.0.1:${portOf(baseApp)}/api/ping`);
  const lim = await bench(`http://127.0.0.1:${portOf(limApp)}/api/ping`);

  const row = (name, r) =>
    `${name.padEnd(10)} req/s=${String(Math.round(r.requests.average)).padEnd(9)} ` +
    `p50=${String(r.latency.p50).padEnd(5)}ms  p99=${String(r.latency.p99).padEnd(5)}ms`;

  // eslint-disable-next-line no-console
  console.log(row('baseline', base));
  // eslint-disable-next-line no-console
  console.log(row('limited', lim));
  // eslint-disable-next-line no-console
  console.log(`\nadded p99 latency: ${(lim.latency.p99 - base.latency.p99).toFixed(2)} ms`);
  // eslint-disable-next-line no-console
  console.log(`added mean latency: ${(lim.latency.average - base.latency.average).toFixed(2)} ms\n`);

  await baseApp.close();
  await limApp.close();
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
  process.exit(0);
}

main();
