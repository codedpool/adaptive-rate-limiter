/**
 * Turns a detector classification into a *suggested* limit. Pure and bounded:
 * the suggestion can never escape [base*floorFactor, base*ceilFactor], so the
 * adaptive layer can tighten under attack or relax under genuine load, but can
 * never lock everyone out or open the floodgates.
 */

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * @param {object} args
 * @param {number} args.baseLimit       the configured limit (the anchor)
 * @param {number} args.currentLimit    the limit currently in effect
 * @param {'cold_start'|'organic'|'anomalous'} args.classification
 * @param {number} args.observedRate    the rate that produced the classification
 * @param {number} [args.floorFactor]   lowest allowed = base*floorFactor
 * @param {number} [args.ceilFactor]    highest allowed = base*ceilFactor
 * @param {number} [args.tighten]       multiplier applied on anomaly (<1)
 * @param {number} [args.loosen]        multiplier applied under genuine pressure (>1)
 * @returns {{limit:number, action:'tighten'|'loosen'|'relax'|'hold'}}
 */
export function suggestLimit({
  baseLimit,
  currentLimit,
  classification,
  observedRate,
  floorFactor = 0.25,
  ceilFactor = 4,
  tighten = 0.5,
  loosen = 1.5,
}) {
  const floor = Math.max(1, Math.ceil(baseLimit * floorFactor));
  const ceil = Math.ceil(baseLimit * ceilFactor);
  const cur = currentLimit ?? baseLimit;

  let next = cur;
  let action = 'hold';

  if (classification === 'anomalous') {
    next = Math.floor(cur * tighten);
    action = 'tighten';
  } else if (classification === 'organic') {
    if (observedRate >= cur * 0.9) {
      // Legitimate traffic is pressing against the ceiling — give it room.
      next = Math.ceil(cur * loosen);
      action = 'loosen';
    } else if (cur < baseLimit && observedRate < cur * 0.5) {
      // Calm and below base — drift back toward the configured baseline.
      next = Math.ceil(cur + (baseLimit - cur) * 0.25);
      action = 'relax';
    }
  }

  const limit = clamp(next, floor, ceil);
  if (limit === cur) action = 'hold';
  return { limit, action };
}
