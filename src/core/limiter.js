import { CircuitBreaker } from './circuitBreaker.js';
import { MemoryLimiter } from './memoryLimiter.js';

/**
 * The facade the rest of the app uses. It hides the difference between the
 * distributed Redis limiter and what happens when Redis is unavailable.
 *
 * Degradation policy (`failMode`):
 *  - 'open'   : on Redis failure, fall back to a per-node in-memory limiter.
 *               This is "fail open" but NOT unconditional allow — each node still
 *               enforces a best-effort local limit. The trade-off: limits are no
 *               longer global while Redis is down.
 *  - 'closed' : on Redis failure, deny everything (protect the backend at the
 *               cost of availability).
 */
export class Limiter {
  /**
   * @param {object} opts
   * @param {import('./redisLimiter.js').RedisLimiter} opts.redisLimiter
   * @param {'open'|'closed'} [opts.failMode]
   * @param {MemoryLimiter} [opts.memoryLimiter]
   * @param {CircuitBreaker} [opts.breaker]
   * @param {(info: object) => void} [opts.onDegraded] called when a request is served degraded
   */
  constructor({ redisLimiter, failMode = 'open', memoryLimiter, breaker, onDegraded } = {}) {
    this.redisLimiter = redisLimiter;
    this.failMode = failMode;
    this.memoryLimiter = memoryLimiter || new MemoryLimiter();
    this.breaker = breaker || new CircuitBreaker();
    this.onDegraded = onDegraded;
  }

  /**
   * @param {string} key
   * @param {object} rule
   * @returns {Promise<import('./redisLimiter.js').Decision & {degraded:boolean, source:string}>}
   */
  async check(key, rule) {
    if (this.redisLimiter && this.breaker.allowsAttempt()) {
      try {
        const d = await this.redisLimiter.check(key, rule);
        this.breaker.onSuccess();
        return { ...d, degraded: false, source: 'redis' };
      } catch (err) {
        this.breaker.onFailure();
        if (this.onDegraded) this.onDegraded({ key, error: err.message, failMode: this.failMode });
      }
    }
    return this._fallback(key, rule);
  }

  _fallback(key, rule) {
    if (this.failMode === 'closed') {
      return {
        allowed: false,
        remaining: 0,
        limit: rule.limit ?? 0,
        retryAfterMs: rule.windowMs ?? 1000,
        resetMs: rule.windowMs ?? 1000,
        strategy: rule.strategy ?? 'hybrid',
        degraded: true,
        source: 'fail_closed',
      };
    }
    // fail open: best-effort local limit
    const d = this.memoryLimiter.check(key, rule);
    return { ...d, degraded: true, source: 'memory' };
  }
}
