import { normalizeRule } from './rule.js';

/**
 * In-process JavaScript implementation of the same three algorithms as the Lua
 * scripts, behind the same `check(key, rule)` contract.
 *
 * Two jobs:
 *  1. Local fallback when Redis is unreachable (see middleware circuit breaker) —
 *     a single node can still enforce *some* limit instead of failing fully open.
 *  2. A Redis-free reference for unit-testing the algorithm logic.
 *
 * Note: state is per-process, so as a fallback it is best-effort (each node
 * limits independently). That is the deliberate trade-off when Redis is down.
 */
export class MemoryLimiter {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, {tokens:number, ts:number}>} */
    this.buckets = new Map();
    /** @type {Map<string, number[]>} */
    this.windows = new Map();
  }

  _tokenBucket(key, r) {
    const now = this.now();
    let b = this.buckets.get(key);
    if (!b) b = { tokens: r.capacity, ts: now };
    const elapsed = Math.max(0, now - b.ts);
    let tokens = Math.min(r.capacity, b.tokens + elapsed * r.refillPerMs);
    let allowed = false;
    if (tokens >= r.cost) {
      allowed = true;
      tokens -= r.cost;
    }
    this.buckets.set(key, { tokens, ts: now });
    const retryAfterMs = allowed || r.refillPerMs <= 0 ? 0 : Math.ceil((r.cost - tokens) / r.refillPerMs);
    const resetMs = r.refillPerMs > 0 ? Math.ceil((r.capacity - tokens) / r.refillPerMs) : 0;
    return { allowed, remaining: Math.floor(tokens), retryAfterMs, resetMs };
  }

  _slidingWindow(key, r) {
    const now = this.now();
    const windowStart = now - r.windowMs;
    const hits = (this.windows.get(key) || []).filter((t) => t > windowStart);
    let allowed = false;
    if (hits.length + r.cost <= r.limit) {
      allowed = true;
      for (let i = 0; i < r.cost; i++) hits.push(now);
    }
    this.windows.set(key, hits);
    const remaining = Math.max(0, r.limit - hits.length);
    let resetMs = r.windowMs;
    let retryAfterMs = 0;
    if (hits.length > 0) {
      resetMs = Math.max(0, hits[0] + r.windowMs - now);
      if (!allowed) retryAfterMs = resetMs;
    }
    return { allowed, remaining, retryAfterMs, resetMs };
  }

  /**
   * @param {string} key
   * @param {object} rule
   * @returns {import('./redisLimiter.js').Decision}
   */
  check(key, rule) {
    const r = normalizeRule(rule);

    if (r.strategy === 'token_bucket') {
      return { ...this._tokenBucket(`${key}:tb`, r), limit: r.capacity, strategy: r.strategy };
    }
    if (r.strategy === 'sliding_window') {
      return { ...this._slidingWindow(`${key}:sw`, r), limit: r.limit, strategy: r.strategy };
    }

    // hybrid: evaluate both, allow only if both allow, commit only on success.
    const now = this.now();
    let b = this.buckets.get(`${key}:tb`);
    if (!b) b = { tokens: r.capacity, ts: now };
    const elapsed = Math.max(0, now - b.ts);
    let tokens = Math.min(r.capacity, b.tokens + elapsed * r.refillPerMs);
    const tbAllowed = tokens >= r.cost;

    const windowStart = now - r.windowMs;
    const hits = (this.windows.get(`${key}:sw`) || []).filter((t) => t > windowStart);
    const swAllowed = hits.length + r.cost <= r.limit;

    const allowed = tbAllowed && swAllowed;
    if (allowed) {
      tokens -= r.cost;
      for (let i = 0; i < r.cost; i++) hits.push(now);
    }
    this.buckets.set(`${key}:tb`, { tokens, ts: now });
    this.windows.set(`${key}:sw`, hits);

    const remaining = Math.min(Math.floor(tokens), Math.max(0, r.limit - hits.length));
    let retryAfterMs = 0;
    const resetMs = r.windowMs;
    if (!allowed) {
      if (!tbAllowed && r.refillPerMs > 0) retryAfterMs = Math.ceil((r.cost - tokens) / r.refillPerMs);
      if (!swAllowed && hits.length > 0) {
        retryAfterMs = Math.max(retryAfterMs, hits[0] + r.windowMs - now);
      }
      retryAfterMs = Math.max(0, retryAfterMs);
    }
    return { allowed, remaining, limit: r.limit, retryAfterMs, resetMs, strategy: r.strategy };
  }
}
