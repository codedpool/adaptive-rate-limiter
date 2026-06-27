import { describe, it, expect, afterEach } from 'vitest';
import { DemoDriver } from '../src/demo/driver.js';

const rule = { strategy: 'hybrid', limit: 10, windowMs: 1000, burst: 5 };
const okLimiter = {
  check: async () => ({ allowed: true, remaining: 4, limit: 10, retryAfterMs: 0, degraded: false }),
};

let active;
afterEach(() => active?.stop());

describe('DemoDriver', () => {
  it('toggles individual lanes and reports status', () => {
    const d = (active = new DemoDriver({ limiter: okLimiter, emit: () => {}, rule }));
    expect(d.status()).toEqual({ running: false, lanes: { normal: false, attacker: false } });

    d.setLane('normal', true);
    expect(d.status().lanes).toEqual({ normal: true, attacker: false });
    expect(d.running).toBe(true);

    d.setLane('normal', true); // idempotent
    expect(d.status().lanes.normal).toBe(true);

    d.setLane('attacker', true);
    expect(d.status().lanes).toEqual({ normal: true, attacker: true });

    d.setLane('normal', false);
    expect(d.status().lanes).toEqual({ normal: false, attacker: true });
    expect(d.running).toBe(true);
  });

  it('start enables all lanes, stop disables all', () => {
    const d = (active = new DemoDriver({ limiter: okLimiter, emit: () => {}, rule }));
    expect(d.start().running).toBe(true);
    expect(d.status().lanes).toEqual({ normal: true, attacker: true });
    expect(d.stop().running).toBe(false);
    expect(d.status().lanes).toEqual({ normal: false, attacker: false });
  });

  it('ignores unknown lanes', () => {
    const d = (active = new DemoDriver({ limiter: okLimiter, emit: () => {}, rule }));
    d.setLane('nope', true);
    expect(d.running).toBe(false);
  });

  it('emits a normalised decision event for a key', async () => {
    const events = [];
    const d = (active = new DemoDriver({ limiter: okLimiter, emit: (e) => events.push(e), rule }));
    await d._fire('ip:1.2.3.4');
    expect(events[0]).toMatchObject({ key: 'ip:1.2.3.4', allowed: true, limit: 10, route: 'GET /api/ping' });
    expect(typeof events[0].ts).toBe('number');
  });

  it('never throws if the limiter rejects', async () => {
    const d = (active = new DemoDriver({
      limiter: { check: async () => { throw new Error('boom'); } },
      emit: () => { throw new Error('should not be reached'); },
      rule,
    }));
    await expect(d._fire('ip:x')).resolves.toBeUndefined();
  });
});
