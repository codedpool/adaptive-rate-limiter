import { describe, it, expect } from 'vitest';
import { DemoDriver } from '../src/demo/driver.js';

const rule = { strategy: 'hybrid', limit: 10, windowMs: 1000, burst: 5 };
const okLimiter = {
  check: async () => ({ allowed: true, remaining: 4, limit: 10, retryAfterMs: 0, degraded: false }),
};

describe('DemoDriver', () => {
  it('toggles running state and is idempotent', () => {
    const d = new DemoDriver({ limiter: okLimiter, emit: () => {}, rule });
    expect(d.status().running).toBe(false);
    expect(d.start()).toBe(true);
    expect(d.status().running).toBe(true);
    expect(d.start()).toBe(false); // already running
    expect(d.stop()).toBe(true);
    expect(d.status().running).toBe(false);
    expect(d.stop()).toBe(false); // already stopped
  });

  it('emits a normalised decision event for a key', async () => {
    const events = [];
    const d = new DemoDriver({ limiter: okLimiter, emit: (e) => events.push(e), rule });
    await d._fire('ip:1.2.3.4');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: 'ip:1.2.3.4', allowed: true, limit: 10, route: 'GET /api/ping' });
    expect(typeof events[0].ts).toBe('number');
  });

  it('never throws if the limiter rejects', async () => {
    const d = new DemoDriver({
      limiter: { check: async () => { throw new Error('boom'); } },
      emit: () => { throw new Error('should not be reached'); },
      rule,
    });
    await expect(d._fire('ip:x')).resolves.toBeUndefined();
  });
});
