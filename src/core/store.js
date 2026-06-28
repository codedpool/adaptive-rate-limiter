import Redis from 'ioredis';
import { logger } from '../observability/logger.js';

/**
 * Thin wrapper around an ioredis connection.
 *
 * Responsibilities:
 *  - own a single shared connection with sane retry/backoff
 *  - expose a cheap health check (PING)
 *  - expose Redis server time (used by the limiter so client clock skew never
 *    corrupts windows — see core/clock.js)
 *
 * Lua script registration lives in core/scripts.js and is attached onto this
 * client via `defineCommand`.
 */
export class Store {
  /** @param {string} url @param {object} [opts] */
  constructor(url, opts = {}) {
    this.url = url;
    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 200, 2000),
      ...opts,
    });
    // Log a connection error once, not on every reconnect attempt — so a
    // deliberately Redis-less deploy (fail-open mode) doesn't spam the logs.
    this._errorLogged = false;
    this.client.on('error', (err) => {
      if (this._errorLogged) return;
      this._errorLogged = true;
      logger.warn({ err: err.message }, 'redis unreachable — running in fail-open mode until it recovers');
    });
    this.client.on('ready', () => {
      this._errorLogged = false;
      logger.info('redis ready');
    });
  }

  async connect() {
    if (this.client.status === 'ready' || this.client.status === 'connecting') return;
    await this.client.connect();
  }

  /** @returns {Promise<boolean>} true if Redis answers PING */
  async ping() {
    try {
      const res = await this.client.ping();
      return res === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Redis server time as epoch milliseconds. The limiter uses this as the single
   * clock source so that skewed client/app-node clocks cannot corrupt windows.
   * @returns {Promise<number>}
   */
  async serverTimeMs() {
    const [sec, micros] = await this.client.time();
    return Number(sec) * 1000 + Math.floor(Number(micros) / 1000);
  }

  async close() {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
