import { z } from 'zod';

/**
 * A rate-limit rule and its normalisation.
 *
 * The public shape is intentionally small (limit / windowMs / burst / strategy);
 * the derived fields the algorithms actually need (capacity, refillPerMs, ttlMs)
 * are computed once here so the hot path and the Lua call sites stay simple.
 */

export const RuleSchema = z.object({
  strategy: z.enum(['token_bucket', 'sliding_window', 'hybrid']).default('hybrid'),
  limit: z.number().int().positive(),
  windowMs: z.number().int().positive(),
  burst: z.number().int().nonnegative().default(0),
  cost: z.number().int().positive().default(1),
});

/**
 * @typedef {object} NormalizedRule
 * @property {'token_bucket'|'sliding_window'|'hybrid'} strategy
 * @property {number} limit
 * @property {number} windowMs
 * @property {number} burst
 * @property {number} cost
 * @property {number} capacity     max tokens (burst ceiling)
 * @property {number} refillPerMs  sustained refill rate, tokens/ms
 * @property {number} ttlMs        idle key expiry
 */

/**
 * Validate + derive the fields the algorithms need.
 * @param {unknown} rule
 * @returns {NormalizedRule}
 */
export function normalizeRule(rule) {
  const r = RuleSchema.parse(rule);
  const capacity = r.burst > 0 ? r.burst : r.limit;
  const refillPerMs = r.limit / r.windowMs;
  // Keep a bucket around long enough to be meaningful, then let it self-clean.
  const ttlMs = Math.max(r.windowMs, Math.ceil(capacity / refillPerMs)) * 2;
  return { ...r, capacity, refillPerMs, ttlMs };
}
