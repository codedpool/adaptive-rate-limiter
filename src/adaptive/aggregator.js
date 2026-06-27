/**
 * Buckets a stream of per-key request events into fixed time windows and yields
 * a request *rate* (count per window) once a window has closed. Kept separate
 * from the worker so the bucketing maths is unit-testable without Redis.
 */
export class Aggregator {
  /** @param {object} opts @param {number} opts.bucketMs window size */
  constructor({ bucketMs = 10_000 } = {}) {
    this.bucketMs = bucketMs;
    /** @type {Map<string, Map<number, number>>} key -> (bucketIndex -> count) */
    this.counts = new Map();
  }

  /** Record one (or `n`) events for `key` at time `ts`. */
  add(key, ts, n = 1) {
    const idx = Math.floor(ts / this.bucketMs);
    let perBucket = this.counts.get(key);
    if (!perBucket) {
      perBucket = new Map();
      this.counts.set(key, perBucket);
    }
    perBucket.set(idx, (perBucket.get(idx) || 0) + n);
  }

  /**
   * Return and remove every bucket that has fully closed as of `nowTs`
   * (i.e. its index is strictly less than the current bucket index).
   * @returns {Array<{key:string, bucketIndex:number, rate:number}>}
   */
  flushClosed(nowTs) {
    const currentIdx = Math.floor(nowTs / this.bucketMs);
    const out = [];
    for (const [key, perBucket] of this.counts) {
      for (const [idx, count] of perBucket) {
        if (idx < currentIdx) {
          out.push({ key, bucketIndex: idx, rate: count });
          perBucket.delete(idx);
        }
      }
      if (perBucket.size === 0) this.counts.delete(key);
    }
    return out;
  }
}
