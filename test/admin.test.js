import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { adminRoutes } from '../src/admin/routes.js';

/** Minimal in-memory stand-in for SuggestionStore. */
function fakeStore() {
  const map = new Map();
  const log = [];
  return {
    async all() {
      return Object.fromEntries(map);
    },
    async get(k) {
      return map.has(k) ? map.get(k) : null;
    },
    async set(k, v, meta) {
      map.set(k, v);
      log.unshift({ key: k, limit: v, ...meta });
    },
    async clear(k) {
      map.delete(k);
    },
    async audit(n) {
      return log.slice(0, n);
    },
  };
}

async function build({ adminToken = '' } = {}) {
  const app = Fastify();
  await app.register(adminRoutes, { prefix: '/admin', suggestions: fakeStore(), adminToken });
  return app;
}

describe('admin routes', () => {
  it('lists, sets, gets and clears overrides', async () => {
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/admin/limits' })).json()).toEqual({ limits: {} });

    const put = await app.inject({ method: 'PUT', url: '/admin/limits/ip:1', payload: { limit: 25 } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ key: 'ip:1', limit: 25, action: 'manual' });

    expect((await app.inject({ method: 'GET', url: '/admin/limits/ip:1' })).json().limit).toBe(25);

    const audit = (await app.inject({ method: 'GET', url: '/admin/audit' })).json().audit;
    expect(audit[0]).toMatchObject({ key: 'ip:1', limit: 25, action: 'manual' });

    await app.inject({ method: 'DELETE', url: '/admin/limits/ip:1' });
    expect((await app.inject({ method: 'GET', url: '/admin/limits/ip:1' })).json().limit).toBeNull();
    await app.close();
  });

  it('rejects an invalid limit', async () => {
    const app = await build();
    const res = await app.inject({ method: 'PUT', url: '/admin/limits/ip:1', payload: { limit: -5 } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('enforces bearer auth when a token is configured', async () => {
    const app = await build({ adminToken: 'secret' });
    expect((await app.inject({ method: 'GET', url: '/admin/limits' })).statusCode).toBe(401);
    const ok = await app.inject({
      method: 'GET',
      url: '/admin/limits',
      headers: { authorization: 'Bearer secret' },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });
});
