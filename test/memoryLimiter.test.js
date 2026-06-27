import { describe, it, expect } from 'vitest';
import { MemoryLimiter } from '../src/core/memoryLimiter.js';

/** A limiter with a clock we control, so time-based behaviour is deterministic. */
function makeLimiter(startMs = 1_000_000) {
  const clock = { t: startMs };
  const limiter = new MemoryLimiter({ now: () => clock.t });
  return { limiter, clock, advance: (ms) => (clock.t += ms) };
}

describe('token bucket', () => {
  const rule = { strategy: 'token_bucket', limit: 60, windowMs: 60_000, burst: 10 };

  it('allows up to capacity then denies', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 10; i++) expect(limiter.check('k', rule).allowed).toBe(true);
    const denied = limiter.check('k', rule);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills at the sustained rate over time', () => {
    const { limiter, advance } = makeLimiter();
    for (let i = 0; i < 10; i++) limiter.check('k', rule); // drain
    expect(limiter.check('k', rule).allowed).toBe(false);
    advance(1000); // 60/60000 = 1 token/sec -> 1 token back
    expect(limiter.check('k', rule).allowed).toBe(true);
    expect(limiter.check('k', rule).allowed).toBe(false);
  });

  it('never exceeds capacity no matter how long it idles', () => {
    const { limiter, advance } = makeLimiter();
    advance(10_000_000);
    let allowed = 0;
    for (let i = 0; i < 50; i++) if (limiter.check('k', rule).allowed) allowed++;
    expect(allowed).toBe(10);
  });
});

describe('sliding window', () => {
  const rule = { strategy: 'sliding_window', limit: 5, windowMs: 1000 };

  it('allows exactly `limit` per window', () => {
    const { limiter } = makeLimiter();
    let allowed = 0;
    for (let i = 0; i < 8; i++) if (limiter.check('k', rule).allowed) allowed++;
    expect(allowed).toBe(5);
  });

  it('frees capacity as entries age out (no fixed-window edge burst)', () => {
    const { limiter, advance } = makeLimiter();
    for (let i = 0; i < 5; i++) limiter.check('k', rule);
    expect(limiter.check('k', rule).allowed).toBe(false);
    advance(1001); // whole window passes
    let allowed = 0;
    for (let i = 0; i < 5; i++) if (limiter.check('k', rule).allowed) allowed++;
    expect(allowed).toBe(5);
  });

  it('partially refills as individual entries expire', () => {
    const { limiter, advance } = makeLimiter();
    limiter.check('k', rule); // t0
    advance(600);
    for (let i = 0; i < 4; i++) limiter.check('k', rule); // t600 x4 -> 5 total
    expect(limiter.check('k', rule).allowed).toBe(false);
    advance(401); // first entry (t0) now older than 1000ms -> frees 1 slot
    expect(limiter.check('k', rule).allowed).toBe(true);
  });
});

describe('hybrid', () => {
  const rule = { strategy: 'hybrid', limit: 20, windowMs: 60_000, burst: 5 };

  it('burst is capped by the token bucket even when the window has room', () => {
    const { limiter } = makeLimiter();
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (limiter.check('k', rule).allowed) allowed++;
    expect(allowed).toBe(5); // bucket capacity, not the window limit of 20
  });

  it('window ceiling caps sustained traffic even as the bucket refills', () => {
    const { limiter, advance } = makeLimiter();
    let allowed = 0;
    for (let round = 0; round < 60; round++) {
      if (limiter.check('k', rule).allowed) allowed++;
      advance(1000); // let the bucket drip-refill between attempts
    }
    expect(allowed).toBe(20); // hard window ceiling
  });

  it('keys are isolated from each other', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 5; i++) limiter.check('a', rule);
    expect(limiter.check('a', rule).allowed).toBe(false);
    expect(limiter.check('b', rule).allowed).toBe(true);
  });
});
