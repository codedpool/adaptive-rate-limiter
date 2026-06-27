/**
 * Persists the adaptive layer's suggested limits and an audit trail of every
 * change. Suggestions live in a hash (key -> limit); the audit log is a capped
 * list of JSON entries so you can always answer "why did this key's limit move?".
 */
export class SuggestionStore {
  constructor(client, { hashKey = 'rl:suggested', auditKey = 'rl:audit', auditMax = 1000 } = {}) {
    this.client = client;
    this.hashKey = hashKey;
    this.auditKey = auditKey;
    this.auditMax = auditMax;
  }

  /** Record a suggested limit for a key and append an audit entry. */
  async set(key, limit, meta = {}) {
    const entry = JSON.stringify({ key, limit, ...meta });
    await this.client
      .multi()
      .hset(this.hashKey, key, String(limit))
      .lpush(this.auditKey, entry)
      .ltrim(this.auditKey, 0, this.auditMax - 1)
      .exec();
  }

  /** @returns {Promise<number|null>} */
  async get(key) {
    const v = await this.client.hget(this.hashKey, key);
    return v == null ? null : Number(v);
  }

  /** @returns {Promise<Record<string, number>>} */
  async all() {
    const h = await this.client.hgetall(this.hashKey);
    const out = {};
    for (const [k, v] of Object.entries(h)) out[k] = Number(v);
    return out;
  }

  /** Most recent audit entries (newest first). */
  async audit(n = 50) {
    const items = await this.client.lrange(this.auditKey, 0, n - 1);
    return items.map((s) => JSON.parse(s));
  }

  /** Remove a suggestion (manual override / reset to base). */
  async clear(key) {
    await this.client.hdel(this.hashKey, key);
  }
}
