/**
 * Standard rate-limit response headers, following the IETF draft
 * (draft-ietf-httpapi-ratelimit-headers): RateLimit-Limit / -Remaining / -Reset
 * (seconds), plus Retry-After (seconds) on a 429.
 *
 * `set` is the framework-agnostic setter: Fastify `reply.header`, Express
 * `res.setHeader`.
 */
export function rateLimitHeaders(decision) {
  const headers = {
    'RateLimit-Limit': String(decision.limit),
    'RateLimit-Remaining': String(Math.max(0, decision.remaining)),
    'RateLimit-Reset': String(Math.ceil(decision.resetMs / 1000)),
  };
  if (!decision.allowed) {
    headers['Retry-After'] = String(Math.ceil(decision.retryAfterMs / 1000));
  }
  return headers;
}
