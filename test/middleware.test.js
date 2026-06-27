import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { rateLimitPlugin } from '../src/middleware/fastify.js';

function decision(allowed, over = {}) {
  return {
    allowed,
    remaining: allowed ? 4 : 0,
    limit: 5,
    retryAfterMs: allowed ? 0 : 2000,
    resetMs: 3000,
    strategy: 'hybrid',
    degraded: false,
    ...over,
  };
}

async function buildApp(decisions) {
  let i = 0;
  const limiter = { check: async () => decisions[Math.min(i++, decisions.length - 1)] };
  const app = Fastify();
  await app.register(rateLimitPlugin, {
    limiter,
    resolveRule: (req) => (req.url.startsWith('/api') ? { strategy: 'hybrid', limit: 5, windowMs: 1000 } : null),
  });
  app.get('/api/ping', async () => ({ pong: true }));
  app.get('/health', async () => ({ status: 'ok' }));
  return app;
}

describe('fastify rate-limit middleware', () => {
  it('allows and sets standard headers', async () => {
    const app = await buildApp([decision(true)]);
    const res = await app.inject({ method: 'GET', url: '/api/ping' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('5');
    expect(res.headers['ratelimit-remaining']).toBe('4');
    expect(res.headers['ratelimit-reset']).toBe('3');
    await app.close();
  });

  it('returns 429 with Retry-After when denied', async () => {
    const app = await buildApp([decision(false)]);
    const res = await app.inject({ method: 'GET', url: '/api/ping' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('2');
    expect(res.json().error).toBe('Too Many Requests');
    await app.close();
  });

  it('skips routes the resolver opts out of (null rule)', async () => {
    const app = await buildApp([decision(false)]); // would deny if applied
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['ratelimit-limit']).toBeUndefined();
    await app.close();
  });
});
