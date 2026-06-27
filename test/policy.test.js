import { describe, it, expect } from 'vitest';
import { suggestLimit, clamp } from '../src/adaptive/policy.js';

describe('clamp', () => {
  it('bounds a value', () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-1, 1, 10)).toBe(1);
    expect(clamp(99, 1, 10)).toBe(10);
  });
});

describe('suggestLimit', () => {
  const base = { baseLimit: 100, observedRate: 50 };

  it('tightens on anomaly', () => {
    const r = suggestLimit({ ...base, currentLimit: 100, classification: 'anomalous' });
    expect(r.action).toBe('tighten');
    expect(r.limit).toBeLessThan(100);
  });

  it('never tightens below the floor', () => {
    const r = suggestLimit({ baseLimit: 100, currentLimit: 26, classification: 'anomalous', observedRate: 5 });
    expect(r.limit).toBeGreaterThanOrEqual(25); // floor = base*0.25
  });

  it('loosens when organic traffic presses the ceiling', () => {
    const r = suggestLimit({ baseLimit: 100, currentLimit: 100, classification: 'organic', observedRate: 95 });
    expect(r.action).toBe('loosen');
    expect(r.limit).toBeGreaterThan(100);
  });

  it('never loosens above the ceiling', () => {
    const r = suggestLimit({ baseLimit: 100, currentLimit: 400, classification: 'organic', observedRate: 395 });
    expect(r.limit).toBeLessThanOrEqual(400); // ceil = base*4
  });

  it('relaxes back toward base when calm and previously tightened', () => {
    const r = suggestLimit({ baseLimit: 100, currentLimit: 40, classification: 'organic', observedRate: 5 });
    expect(r.action).toBe('relax');
    expect(r.limit).toBeGreaterThan(40);
    expect(r.limit).toBeLessThanOrEqual(100);
  });

  it('holds during cold start', () => {
    const r = suggestLimit({ baseLimit: 100, currentLimit: 100, classification: 'cold_start', observedRate: 999 });
    expect(r.action).toBe('hold');
    expect(r.limit).toBe(100);
  });
});
