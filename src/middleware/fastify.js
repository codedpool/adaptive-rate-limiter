import fp from 'fastify-plugin';
import { rateLimitHeaders } from './headers.js';
import { ipKeyGenerator } from './keys.js';

/**
 * Fastify rate-limit plugin.
 *
 * Register with `app.register(rateLimitPlugin, { limiter, resolveRule, ... })`.
 * Wrapped in `fastify-plugin` so its `onRequest` hook applies to the parent
 * scope's routes (without fp, encapsulation would limit it to this plugin only).
 * Runs as an `onRequest` hook (route is already matched, so route patterns are
 * available) and short-circuits with 429 when the limit is exceeded.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} opts
 * @param {import('../core/limiter.js').Limiter} opts.limiter
 * @param {(req) => (object|null)} opts.resolveRule  return null to skip a route
 * @param {(req) => string} [opts.keyGenerator]
 * @param {(event: object) => void} [opts.emit]  hook for the adaptive event stream
 * @param {boolean} [opts.enabled]
 */
async function rateLimit(app, opts) {
  const { limiter, resolveRule, keyGenerator = ipKeyGenerator, emit, overrides, metrics, enabled = true } = opts;
  if (!enabled) return;
  if (!limiter || !resolveRule) throw new Error('rateLimitPlugin requires { limiter, resolveRule }');

  app.addHook('onRequest', async (req, reply) => {
    const baseRule = resolveRule(req);
    if (!baseRule) return; // route opted out

    const key = keyGenerator(req);
    // Apply any adaptive suggestion for this key (advisory, served from cache).
    const rule = overrides ? overrides.effectiveRule(baseRule, key) : baseRule;
    const start = process.hrtime.bigint();
    const decision = await limiter.check(key, rule);
    if (metrics) metrics.recordDecision(decision, Number(process.hrtime.bigint() - start) / 1e9);

    const headers = rateLimitHeaders(decision);
    for (const [h, v] of Object.entries(headers)) reply.header(h, v);

    if (emit) {
      emit({
        key,
        route: `${req.method} ${req.routeOptions?.url || req.url}`,
        allowed: decision.allowed,
        degraded: decision.degraded,
        ts: Date.now(),
      });
    }

    if (!decision.allowed) {
      // In an async hook, returning the reply stops the lifecycle so the route
      // handler never runs.
      return reply.code(429).send({
        error: 'Too Many Requests',
        retryAfterMs: decision.retryAfterMs,
      });
    }
  });
}

export const rateLimitPlugin = fp(rateLimit, { name: 'rate-limit', fastify: '4.x' });
