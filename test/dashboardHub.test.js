import { describe, it, expect } from 'vitest';
import { DashboardHub } from '../src/dashboard/hub.js';

const ev = (key, allowed, over = {}) => ({
  key,
  route: 'GET /api/ping',
  allowed,
  degraded: false,
  limit: 100,
  remaining: allowed ? 50 : 0,
  retryAfterMs: allowed ? 0 : 2000,
  ts: 1000,
  ...over,
});

/** Fake WebSocket capturing what the hub sends. */
function fakeSocket() {
  return { readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); } };
}

describe('DashboardHub', () => {
  it('aggregates totals and per-key counts', () => {
    const hub = new DashboardHub();
    hub.onEvent(ev('ip:1', true));
    hub.onEvent(ev('ip:1', false));
    hub.onEvent(ev('ip:2', true));
    expect(hub.totals).toEqual({ allowed: 2, blocked: 1 });
    const s1 = hub.stats.get('ip:1');
    expect(s1).toMatchObject({ allowed: 1, blocked: 1 });
  });

  it('orders top keys by blocked count', () => {
    const hub = new DashboardHub();
    for (let i = 0; i < 5; i++) hub.onEvent(ev('ip:attacker', false));
    hub.onEvent(ev('ip:quiet', true));
    expect(hub.topStats()[0].key).toBe('ip:attacker');
  });

  it('keeps the recent feed bounded', () => {
    const hub = new DashboardHub({ recentMax: 10 });
    for (let i = 0; i < 25; i++) hub.onEvent(ev('ip:1', true));
    expect(hub.recent.length).toBe(10);
  });

  it('sends a snapshot to a newly connected client', () => {
    const hub = new DashboardHub();
    hub.onEvent(ev('ip:1', false));
    const sock = fakeSocket();
    hub.addClient(sock);
    expect(sock.sent[0].type).toBe('snapshot');
    expect(sock.sent[0].totals.blocked).toBe(1);
    hub.stop();
  });

  it('flushes batched events to connected clients', () => {
    const hub = new DashboardHub();
    const sock = fakeSocket();
    hub.addClient(sock); // snapshot is sent[0]
    hub.onEvent(ev('ip:1', false));
    hub.onEvent(ev('ip:1', true));
    hub.flush();
    const batch = sock.sent.find((m) => m.type === 'batch');
    expect(batch.events).toHaveLength(2);
    hub.stop();
  });

  it('does not buffer pending events when nobody is connected', () => {
    const hub = new DashboardHub();
    hub.onEvent(ev('ip:1', true));
    expect(hub.pending).toHaveLength(0);
  });
});
