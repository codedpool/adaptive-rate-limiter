/**
 * Key extractors decide *what* gets rate limited (per-IP, per-user, per-route…).
 *
 * IMPORTANT on client IP and spoofing: trusting `X-Forwarded-For` blindly lets a
 * client forge its IP and dodge per-IP limits. Don't parse XFF here yourself.
 * Instead configure the framework's trusted-proxy setting (Fastify `trustProxy`,
 * Express `app.set('trust proxy', ...)`) so `req.ip` is the real, vetted client
 * address, and key off that.
 */

/** `ip:<client-ip>` — the default. Relies on a correctly configured trustProxy. */
export function ipKeyGenerator(req) {
  return `ip:${req.ip || 'unknown'}`;
}

/** Key by authenticated user when present, else fall back to IP. */
export function userOrIpKeyGenerator(getUserId) {
  return (req) => {
    const id = getUserId(req);
    return id ? `user:${id}` : ipKeyGenerator(req);
  };
}

/** Compose IP + route so different endpoints have independent budgets. */
export function ipRouteKeyGenerator(req) {
  const route = req.routeOptions?.url || req.url || '';
  return `ip:${req.ip || 'unknown'}:${req.method}:${route}`;
}
