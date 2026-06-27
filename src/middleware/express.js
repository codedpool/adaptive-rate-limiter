import { rateLimitHeaders } from './headers.js';

/**
 * Express adapter over the same core Limiter. Returns standard `(req, res, next)`
 * middleware.
 *
 * Note: configure `app.set('trust proxy', ...)` so `req.ip` reflects the real
 * client (see keys.js on spoofing).
 *
 * @param {object} opts
 * @param {import('../core/limiter.js').Limiter} opts.limiter
 * @param {(req) => (object|null)} opts.resolveRule
 * @param {(req) => string} [opts.keyGenerator]
 * @param {(event: object) => void} [opts.emit]
 */
export function expressRateLimit(opts) {
  const { limiter, resolveRule, keyGenerator, emit } = opts;
  if (!limiter || !resolveRule) throw new Error('expressRateLimit requires { limiter, resolveRule }');

  return async (req, res, next) => {
    try {
      const rule = resolveRule(req);
      if (!rule) return next();

      const key = keyGenerator ? keyGenerator(req) : `ip:${req.ip || 'unknown'}`;
      const decision = await limiter.check(key, rule);

      for (const [h, v] of Object.entries(rateLimitHeaders(decision))) res.setHeader(h, v);

      if (emit) {
        emit({ key, route: `${req.method} ${req.baseUrl || ''}${req.path}`, allowed: decision.allowed, ts: Date.now() });
      }

      if (!decision.allowed) {
        return res.status(429).json({ error: 'Too Many Requests', retryAfterMs: decision.retryAfterMs });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
