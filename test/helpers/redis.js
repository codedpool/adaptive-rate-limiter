import Redis from 'ioredis';

const URL = process.env.REDIS_URL || 'redis://localhost:6379';

/**
 * Probe whether a Redis is reachable, so Redis-backed suites can skip cleanly
 * when one isn't available (e.g. local dev without Docker) instead of failing.
 * @returns {Promise<boolean>}
 */
export async function redisAvailable() {
  const c = new Redis(URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    reconnectOnError: () => false,
  });
  c.on('error', () => {}); // swallow connection errors; we only care about the probe result
  try {
    await c.connect();
    await c.ping();
    return true;
  } catch {
    return false;
  } finally {
    c.disconnect();
  }
}

/** A connected client for a test (caller is responsible for closing it). */
export function makeClient() {
  return new Redis(URL, { maxRetriesPerRequest: 2 });
}
