/**
 * Online anomaly detector: per-key EWMA mean + EWMA variance, scored with a
 * z-score. Deliberately simple and *explainable* — there is no black-box model,
 * no training step, and no labelled data required. Every decision reduces to
 * "how many standard deviations above its own recent baseline is this key's
 * request rate right now?".
 *
 * Design choices worth defending:
 *  - The new point is scored against the baseline BEFORE it is folded in, so a
 *    spike is judged against history, not against itself.
 *  - Points classified anomalous are NOT folded into the baseline, so a sustained
 *    attack cannot slowly "train" the limiter into accepting it as normal.
 */
export class EwmaZScoreDetector {
  /**
   * @param {object} [opts]
   * @param {number} [opts.alpha]       EWMA smoothing (0..1); higher = reacts faster
   * @param {number} [opts.zThreshold]  z-score at/above which a rate is anomalous
   * @param {number} [opts.minSamples]  samples before we trust the baseline (cold start)
   */
  constructor({ alpha = 0.3, zThreshold = 3, minSamples = 5 } = {}) {
    this.alpha = alpha;
    this.zThreshold = zThreshold;
    this.minSamples = minSamples;
    /** @type {Map<string,{mean:number,variance:number,count:number}>} */
    this.state = new Map();
  }

  /**
   * Score and record one observation (a request rate for a key in a time bucket).
   * @param {string} key
   * @param {number} value  observed rate
   * @returns {{key:string,value:number,mean:number,std:number,z:number,classification:'cold_start'|'organic'|'anomalous',count:number}}
   */
  observe(key, value) {
    const s = this.state.get(key) || { mean: 0, variance: 0, count: 0 };
    const std = Math.sqrt(s.variance);

    let classification;
    let z = 0;
    if (s.count < this.minSamples) {
      classification = 'cold_start';
    } else if (std > 1e-9) {
      z = (value - s.mean) / std;
      classification = z >= this.zThreshold ? 'anomalous' : 'organic';
    } else {
      // Perfectly flat baseline (zero variance): a z-score is undefined, so fall
      // back to a relative-change test — a doubling or more is anomalous.
      const rel = s.mean > 0 ? (value - s.mean) / s.mean : 0;
      if (rel >= 1) {
        classification = 'anomalous';
        z = this.zThreshold + rel;
      } else {
        classification = 'organic';
      }
    }

    // Fold the point into the baseline unless it looks like an attack.
    if (classification !== 'anomalous') {
      if (s.count === 0) {
        s.mean = value;
        s.variance = 0;
      } else {
        const diff = value - s.mean;
        const incr = this.alpha * diff;
        s.mean += incr;
        s.variance = (1 - this.alpha) * (s.variance + diff * incr);
      }
      s.count += 1;
      this.state.set(key, s);
    }

    return { key, value, mean: s.mean, std: Math.sqrt(s.variance), z, classification, count: s.count };
  }

  reset(key) {
    if (key === undefined) this.state.clear();
    else this.state.delete(key);
  }
}
