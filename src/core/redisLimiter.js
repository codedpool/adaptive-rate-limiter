import { randomUUID } from 'node:crypto';
import { normalizeRule } from './rule.js';
import { registerScripts } from './scripts.js';

/**
 * @typedef {object} Decision
 * @property {boolean} allowed
 * @property {number} remaining     requests left before the limit
 * @property {number} limit         the effective limit
 * @property {number} retryAfterMs  when denied, ms until a retry could succeed
 * @property {number} resetMs       ms until the window/bucket fully resets
 * @property {'token_bucket'|'sliding_window'|'hybrid'} strategy
 */

/**
 * Distributed limiter backed by Redis + atomic Lua. All strategies are a single
 * round trip and safe across any number of app nodes sharing one Redis.
 */
export class RedisLimiter {
  /** @param {import('ioredis').Redis} client */
  constructor(client) {
    this.client = registerScripts(client);
  }

  /**
   * @param {string} key  the bucket key (e.g. `ip:1.2.3.4` or `user:42:/api`)
   * @param {object} rule a rate-limit rule (see RuleSchema)
   * @returns {Promise<Decision>}
   */
  async check(key, rule) {
    const r = normalizeRule(rule);
    let raw;

    if (r.strategy === 'token_bucket') {
      raw = await this.client.rlTokenBucket(`${key}:tb`, r.capacity, r.refillPerMs, r.cost, r.ttlMs);
    } else if (r.strategy === 'sliding_window') {
      raw = await this.client.rlSlidingWindow(`${key}:sw`, r.limit, r.windowMs, r.cost, randomUUID());
    } else {
      raw = await this.client.rlHybrid(
        `${key}:tb`,
        `${key}:sw`,
        r.capacity,
        r.refillPerMs,
        r.limit,
        r.windowMs,
        r.cost,
        r.ttlMs,
        randomUUID(),
      );
    }

    const [allowed, remaining, retryAfterMs, resetMs] = raw;
    return {
      allowed: allowed === 1,
      remaining: Number(remaining),
      limit: r.strategy === 'token_bucket' ? r.capacity : r.limit,
      retryAfterMs: Number(retryAfterMs),
      resetMs: Number(resetMs),
      strategy: r.strategy,
    };
  }
}
