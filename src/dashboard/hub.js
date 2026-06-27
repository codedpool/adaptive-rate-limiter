/**
 * In-process fan-out hub for the live dashboard.
 *
 * The rate-limit middleware calls `onEvent` for every decision (cheap, O(1)).
 * Connected WebSocket clients receive *batched* updates on a short timer, so the
 * message rate to browsers is decoupled from the request rate — a flood of
 * requests doesn't turn into a flood of WebSocket frames.
 *
 * Sockets are duck-typed ({ readyState, send, ... }) so the aggregation logic is
 * unit-testable without a real WebSocket.
 */
export class DashboardHub {
  constructor({ flushMs = 200, recentMax = 100, topN = 50 } = {}) {
    this.flushMs = flushMs;
    this.recentMax = recentMax;
    this.topN = topN;
    /** @type {Set<{readyState:number, send:Function}>} */
    this.clients = new Set();
    /** @type {Map<string, object>} per-key rollup */
    this.stats = new Map();
    /** @type {object[]} rolling recent feed */
    this.recent = [];
    /** @type {object[]} events awaiting the next flush */
    this.pending = [];
    this.totals = { allowed: 0, blocked: 0 };
    this.timer = null;
  }

  /** Record one decision event. */
  onEvent(e) {
    if (e.allowed) this.totals.allowed += 1;
    else this.totals.blocked += 1;

    let s = this.stats.get(e.key);
    if (!s) {
      s = { key: e.key, allowed: 0, blocked: 0, limit: e.limit, remaining: e.remaining, lastSeen: e.ts };
      this.stats.set(e.key, s);
    }
    if (e.allowed) s.allowed += 1;
    else s.blocked += 1;
    s.limit = e.limit;
    s.remaining = e.remaining;
    s.lastSeen = e.ts;

    this.recent.push(e);
    if (this.recent.length > this.recentMax) this.recent.shift();

    if (this.clients.size > 0) {
      this.pending.push(e);
      if (this.pending.length > this.recentMax) this.pending.shift();
    }
  }

  /** Keys most worth looking at: most-blocked first, then most-recent. */
  topStats(n = this.topN) {
    return [...this.stats.values()]
      .sort((a, b) => b.blocked - a.blocked || b.lastSeen - a.lastSeen)
      .slice(0, n);
  }

  /** Full state sent to a client on connect. */
  snapshot() {
    return { type: 'snapshot', totals: this.totals, stats: this.topStats(), recent: this.recent.slice() };
  }

  addClient(socket) {
    this.clients.add(socket);
    this._send(socket, this.snapshot());
    this.start();
  }

  removeClient(socket) {
    this.clients.delete(socket);
    if (this.clients.size === 0) this.stop();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  flush() {
    if (this.clients.size === 0 || this.pending.length === 0) return;
    const msg = { type: 'batch', totals: this.totals, events: this.pending, stats: this.topStats() };
    this.pending = [];
    for (const socket of this.clients) this._send(socket, msg);
  }

  _send(socket, obj) {
    try {
      if (socket.readyState === 1) socket.send(JSON.stringify(obj));
    } catch {
      /* drop broken sockets silently; close handler removes them */
    }
  }
}
