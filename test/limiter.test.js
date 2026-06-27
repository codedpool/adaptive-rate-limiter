import { describe, it, expect } from 'vitest';
import { Limiter } from '../src/core/limiter.js';
import { CircuitBreaker } from '../src/core/circuitBreaker.js';

const rule = { strategy: 'sliding_window', limit: 2, windowMs: 60_000 };

const okDecision = {
  check: async () => ({ allowed: true, remaining: 9, limit: 10, retryAfterMs: 0, resetMs: 1000, strategy: 'hybrid' }),
};
const throwing = {
  check: async () => {
    throw new Error('redis down');
  },
};

describe('Limiter facade', () => {
  it('uses Redis when healthy', async () => {
    const l = new Limiter({ redisLimiter: okDecision });
    const d = await l.check('k', rule);
    expect(d.source).toBe('redis');
    expect(d.degraded).toBe(false);
    expect(d.allowed).toBe(true);
  });

  it('fail-open: degrades to the in-memory limiter when Redis errors', async () => {
    const l = new Limiter({ redisLimiter: throwing, failMode: 'open' });
    const d = await l.check('k', rule);
    expect(d.source).toBe('memory');
    expect(d.degraded).toBe(true);
    expect(d.allowed).toBe(true); // first request still allowed locally
  });

  it('fail-open local limiter still enforces a limit', async () => {
    const l = new Limiter({ redisLimiter: throwing, failMode: 'open' });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await l.check('k', rule));
    expect(results.filter((r) => r.allowed).length).toBe(2); // local best-effort still caps
  });

  it('fail-closed: denies when Redis errors', async () => {
    const l = new Limiter({ redisLimiter: throwing, failMode: 'closed' });
    const d = await l.check('k', rule);
    expect(d.source).toBe('fail_closed');
    expect(d.allowed).toBe(false);
  });

  it('stops hammering Redis once the breaker opens', async () => {
    const clock = { t: 0 };
    let calls = 0;
    const counted = {
      check: async () => {
        calls++;
        throw new Error('down');
      },
    };
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => clock.t });
    const l = new Limiter({ redisLimiter: counted, failMode: 'open', breaker });

    await l.check('k', rule);
    await l.check('k', rule); // 2 failures -> open
    const afterOpen = calls;
    await l.check('k', rule); // breaker open: should NOT call Redis
    expect(calls).toBe(afterOpen);

    clock.t = 1000; // cooldown elapsed -> half-open trial calls Redis again
    await l.check('k', rule);
    expect(calls).toBe(afterOpen + 1);
  });
});
