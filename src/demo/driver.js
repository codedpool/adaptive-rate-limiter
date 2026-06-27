/**
 * Server-side traffic simulator for the dashboard's controls.
 *
 * A browser can't forge per-client IPs (X-Forwarded-For is a forbidden header),
 * so multi-client traffic is generated here: each "lane" drives synthetic keys
 * through the *real* limiter and feeds every decision into the same emit hook the
 * live dashboard reads. So the toggles show genuine throttling, no terminal
 * needed — which makes the deployed (Render) URL a self-contained demo.
 *
 * Lanes are independent so a visitor can build a scenario: normal users alone
 * stay green; flip on the bot attack and watch that one key go red.
 */
const LANES = {
  // several well-behaved IPs at a modest rate — stay under the limit
  normal: { ips: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '203.0.113.7', '198.51.100.4'], everyMs: 250, perTick: 1 },
  // one IP hammering — crosses the limit and gets throttled
  attacker: { ips: ['45.155.205.99'], everyMs: 1000, perTick: 40 },
};

export class DemoDriver {
  /**
   * @param {object} opts
   * @param {import('../core/limiter.js').Limiter} opts.limiter
   * @param {(event: object) => void} opts.emit
   * @param {object} opts.rule
   * @param {number} [opts.maxMs] auto-stop everything after this long
   */
  constructor({ limiter, emit, rule, maxMs = 300_000 }) {
    this.limiter = limiter;
    this.emit = emit;
    this.rule = rule;
    this.maxMs = maxMs;
    /** @type {Record<string, ReturnType<typeof setInterval>|null>} */
    this.lanes = { normal: null, attacker: null };
    this.stopTimer = null;
  }

  get running() {
    return Object.values(this.lanes).some(Boolean);
  }

  /** Turn a single lane on or off. Returns the new status. */
  setLane(name, on) {
    if (!(name in LANES)) return this.status();
    const active = Boolean(this.lanes[name]);
    if (on && !active) {
      const cfg = LANES[name];
      const fireTick = () => {
        for (const ip of cfg.ips) for (let i = 0; i < cfg.perTick; i++) this._fire(`ip:${ip}`);
      };
      fireTick(); // fire one tick immediately so toggling feels instant
      this.lanes[name] = setInterval(fireTick, cfg.everyMs);
      this._armAutoStop();
    } else if (!on && active) {
      clearInterval(this.lanes[name]);
      this.lanes[name] = null;
      if (!this.running) this._clearAutoStop();
    }
    return this.status();
  }

  /** Turn every lane on (back-compat with the old single button). */
  start() {
    for (const name of Object.keys(LANES)) this.setLane(name, true);
    return this.status();
  }

  /** Turn every lane off. */
  stop() {
    for (const name of Object.keys(this.lanes)) this.setLane(name, false);
    this._clearAutoStop();
    return this.status();
  }

  status() {
    return {
      running: this.running,
      lanes: { normal: Boolean(this.lanes.normal), attacker: Boolean(this.lanes.attacker) },
    };
  }

  _armAutoStop() {
    if (this.stopTimer) return;
    this.stopTimer = setTimeout(() => this.stop(), this.maxMs);
    if (this.stopTimer.unref) this.stopTimer.unref();
  }

  _clearAutoStop() {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
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
