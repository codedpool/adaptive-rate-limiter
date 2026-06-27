/**
 * Server-side traffic simulator for the dashboard's "Start" button.
 *
 * A browser can't forge per-client IPs (X-Forwarded-For is a forbidden header),
 * so the multi-IP demo runs here: it drives synthetic keys through the *real*
 * limiter and feeds every decision into the same emit hook the live dashboard
 * reads. So clicking Start shows genuine throttling, no terminal needed — which
 * is what makes the deployed (Render) URL a self-contained demo.
 */
const NORMAL = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '203.0.113.7', '198.51.100.4'];
const ATTACKER = '45.155.205.99';

export class DemoDriver {
  /**
   * @param {object} opts
   * @param {import('../core/limiter.js').Limiter} opts.limiter
   * @param {(event: object) => void} opts.emit
   * @param {object} opts.rule
   * @param {number} [opts.maxMs]  auto-stop after this long, so it never runs forever
   */
  constructor({ limiter, emit, rule, maxMs = 120_000 }) {
    this.limiter = limiter;
    this.emit = emit;
    this.rule = rule;
    this.maxMs = maxMs;
    this.running = false;
    this.timers = [];
    this.stopTimer = null;
  }

  start() {
    if (this.running) return false;
    this.running = true;
    this.timers = [
      // steady, well-behaved traffic from several IPs
      setInterval(() => {
        for (const ip of NORMAL) this._fire(`ip:${ip}`);
      }, 250),
      // one IP hammering — this is what gets throttled
      setInterval(() => {
        for (let i = 0; i < 40; i++) this._fire(`ip:${ATTACKER}`);
      }, 1000),
    ];
    this.stopTimer = setTimeout(() => this.stop(), this.maxMs);
    if (this.stopTimer.unref) this.stopTimer.unref();
    return true;
  }

  stop() {
    if (!this.running) return false;
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    return true;
  }

  status() {
    return { running: this.running };
  }

  async _fire(key) {
    try {
      const d = await this.limiter.check(key, this.rule);
      this.emit({
        key,
        route: 'GET /api/ping',
        allowed: d.allowed,
        degraded: d.degraded,
        limit: d.limit,
        remaining: Math.max(0, d.remaining),
        retryAfterMs: d.retryAfterMs,
        ts: Date.now(),
      });
    } catch {
      /* demo traffic must never throw */
    }
  }
}
