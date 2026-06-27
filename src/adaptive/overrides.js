/**
 * Hot-path view of the adaptive suggestions.
 *
 * The request path must stay fast, so it does NOT read suggestions from Redis on
 * every request. Instead this cache refreshes the whole suggestion set on a short
 * interval and serves it from memory. Worst case, a suggestion takes one refresh
 * interval to take effect — fine, because the adaptive layer is advisory, not a
 * synchronous gate.
 */
export class AdaptiveOverrides {
  /**
   * @param {import('./suggestionStore.js').SuggestionStore} store
   * @param {object} [opts]
   * @param {number} [opts.refreshMs]
   * @param {(info:object)=>void} [opts.onError]
   */
  constructor(store, { refreshMs = 3000, onError } = {}) {
    this.store = store;
    this.refreshMs = refreshMs;
    this.onError = onError;
    /** @type {Record<string, number>} */
    this.map = {};
    this.timer = null;
  }

  async refresh() {
    try {
      this.map = await this.store.all();
    } catch (err) {
      if (this.onError) this.onError({ err: err.message });
    }
  }

  start() {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.refreshMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Apply any suggested limit for `key` on top of the base rule. */
  effectiveRule(rule, key) {
    const override = this.map[key];
    if (override == null || override === rule.limit) return rule;
    return { ...rule, limit: override };
  }
}
