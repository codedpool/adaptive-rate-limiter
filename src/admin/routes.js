import { z } from 'zod';

/**
 * Admin / control-plane routes for inspecting and overriding limits at runtime.
 *
 * Registered as a normal (encapsulated) plugin under a prefix, so its auth
 * preHandler applies only to admin routes. If `adminToken` is set, every request
 * needs `Authorization: Bearer <token>`; if not set, the routes are open (dev
 * only) and a warning is logged.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} opts
 * @param {import('../adaptive/suggestionStore.js').SuggestionStore} opts.suggestions
 * @param {string} [opts.adminToken]
 * @param {{warn: Function}} [opts.logger]
 */
export async function adminRoutes(app, opts) {
  const { suggestions, adminToken = '', logger } = opts;
  if (!suggestions) throw new Error('adminRoutes requires { suggestions }');

  // Admin reads/writes go to Redis; if it's unavailable, surface 503 (not 500).
  // Scoped to this plugin only (encapsulated), so app routes are unaffected.
  app.setErrorHandler((err, _req, reply) => {
    reply.code(503).send({ error: 'admin backend unavailable', detail: err.message });
  });

  if (adminToken) {
    app.addHook('preHandler', async (req, reply) => {
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (token !== adminToken) return reply.code(401).send({ error: 'unauthorized' });
    });
  } else if (logger) {
    logger.warn('admin API is unauthenticated (RL_ADMIN_TOKEN not set)');
  }

  app.get('/limits', async () => ({ limits: await suggestions.all() }));

  app.get('/limits/:key', async (req) => {
    const limit = await suggestions.get(req.params.key);
    return { key: req.params.key, limit };
  });

  const PutBody = z.object({ limit: z.number().int().positive() });
  app.put('/limits/:key', async (req, reply) => {
    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'limit must be a positive integer' });
    await suggestions.set(req.params.key, parsed.data.limit, { action: 'manual', ts: Date.now() });
    return { key: req.params.key, limit: parsed.data.limit, action: 'manual' };
  });

  app.delete('/limits/:key', async (req) => {
    await suggestions.clear(req.params.key);
    return { key: req.params.key, cleared: true };
  });

  app.get('/audit', async (req) => {
    const n = Math.min(Number(req.query.n) || 50, 500);
    return { audit: await suggestions.audit(n) };
  });
}
