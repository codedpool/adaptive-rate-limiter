import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RedisLimiter } from '../src/core/redisLimiter.js';
import { Store } from '../src/core/store.js';
import { redisAvailable, makeClient } from './helpers/redis.js';

const REDIS_UP = await redisAvailable();
const suite = REDIS_UP ? describe : describe.skip;
if (!REDIS_UP) {
  // eslint-disable-next-line no-console
  console.warn('[redisLimiter.test] Redis not reachable — skipping Redis-backed suite');
}

const freshKey = (label) => `test:${label}:${randomUUID()}`;

suite('RedisLimiter (atomic Lua, distributed)', () => {
  /** @type {import('ioredis').Redis} */
  let client;
  /** @type {RedisLimiter} */
  let limiter;

  beforeAll(() => {
    client = makeClient();
    limiter = new RedisLimiter(client);
  });
  afterAll(async () => {
    await client.quit();
  });

  describe('basic semantics match the in-memory reference', () => {
    it('sliding window admits exactly `limit` in a burst', async () => {
      const key = freshKey('sw');
      const rule = { strategy: 'sliding_window', limit: 10, windowMs: 60_000 };
      const results = [];
      for (let i = 0; i < 15; i++) results.push(await limiter.check(key, rule));
      expect(results.filter((r) => r.allowed).length).toBe(10);
      expect(results.at(-1).allowed).toBe(false);
      expect(results.at(-1).retryAfterMs).toBeGreaterThan(0);
    });

    it('token bucket admits up to capacity then denies', async () => {
      const key = freshKey('tb');
      const rule = { strategy: 'token_bucket', limit: 60, windowMs: 60_000, burst: 8 };
      let allowed = 0;
      for (let i = 0; i < 20; i++) if ((await limiter.check(key, rule)).allowed) allowed++;
      expect(allowed).toBe(8);
    });

    it('hybrid is capped by the smaller of bucket and window', async () => {
      const key = freshKey('hy');
      const rule = { strategy: 'hybrid', limit: 50, windowMs: 60_000, burst: 6 };
      let allowed = 0;
      for (let i = 0; i < 20; i++) if ((await limiter.check(key, rule)).allowed) allowed++;
      expect(allowed).toBe(6); // bucket burst is the binding constraint here
    });
  });

  // The headline guarantee: atomic Lua means no over-admit even when a flood of
  // requests hits the same key simultaneously.
  describe('concurrency proof — zero over-admit', () => {
    it('sliding window: 500 concurrent requests admit exactly the limit', async () => {
      const key = freshKey('conc-sw');
      const rule = { strategy: 'sliding_window', limit: 100, windowMs: 60_000 };
      const results = await Promise.all(Array.from({ length: 500 }, () => limiter.check(key, rule)));
      expect(results.filter((r) => r.allowed).length).toBe(100);
    });

    it('token bucket: 500 concurrent requests admit exactly the capacity', async () => {
      const key = freshKey('conc-tb');
      const rule = { strategy: 'token_bucket', limit: 100, windowMs: 600_000, burst: 100 };
      const results = await Promise.all(Array.from({ length: 500 }, () => limiter.check(key, rule)));
      expect(results.filter((r) => r.allowed).length).toBe(100);
    });

    it('hybrid: 500 concurrent requests admit exactly the binding limit', async () => {
      const key = freshKey('conc-hy');
      const rule = { strategy: 'hybrid', limit: 100, windowMs: 600_000, burst: 100 };
      const results = await Promise.all(Array.from({ length: 500 }, () => limiter.check(key, rule)));
      expect(results.filter((r) => r.allowed).length).toBe(100);
    });
  });

  // Simulates multiple app nodes (separate connections) sharing one Redis.
  describe('multi-instance — correctness across separate connections', () => {
    it('two limiters on two connections still admit exactly the limit', async () => {
      const a = new RedisLimiter(makeClient());
      const b = new RedisLimiter(makeClient());
      const key = freshKey('multi');
      const rule = { strategy: 'sliding_window', limit: 100, windowMs: 60_000 };
      const fromA = Array.from({ length: 300 }, () => a.check(key, rule));
      const fromB = Array.from({ length: 300 }, () => b.check(key, rule));
      const results = await Promise.all([...fromA, ...fromB]);
      expect(results.filter((r) => r.allowed).length).toBe(100);
      await a.client.quit();
      await b.client.quit();
    });
  });

  // Windows are anchored to Redis server time, not any app-node clock, so skewed
  // node clocks cannot corrupt them. Here we just confirm we can read that clock.
  describe('clock authority', () => {
    it('reads Redis server time within a sane delta of wall clock', async () => {
      const store = new Store(process.env.REDIS_URL || 'redis://localhost:6379');
      await store.connect();
      const serverMs = await store.serverTimeMs();
      expect(Math.abs(serverMs - Date.now())).toBeLessThan(5000);
      await store.close();
    });
  });
});
