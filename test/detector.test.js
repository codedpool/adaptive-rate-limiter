import { describe, it, expect } from 'vitest';
import { EwmaZScoreDetector } from '../src/adaptive/detector.js';

describe('EwmaZScoreDetector', () => {
  it('treats the first samples as cold start', () => {
    const d = new EwmaZScoreDetector({ minSamples: 5 });
    for (let i = 0; i < 5; i++) {
      expect(d.observe('k', 100).classification).toBe('cold_start');
    }
  });

  it('classifies steady traffic as organic', () => {
    const d = new EwmaZScoreDetector({ minSamples: 3, zThreshold: 3 });
    for (let i = 0; i < 3; i++) d.observe('k', 100);
    const r = d.observe('k', 105);
    expect(r.classification).toBe('organic');
  });

  it('flags a large spike as anomalous', () => {
    const d = new EwmaZScoreDetector({ minSamples: 5, zThreshold: 3, alpha: 0.3 });
    // build a stable baseline around 100 with small noise
    for (const v of [100, 102, 98, 101, 99, 100, 103, 97]) d.observe('k', v);
    const r = d.observe('k', 1000);
    expect(r.classification).toBe('anomalous');
    expect(r.z).toBeGreaterThan(3);
  });

  it('does not let a spike poison the baseline', () => {
    const d = new EwmaZScoreDetector({ minSamples: 5, zThreshold: 3 });
    for (const v of [100, 100, 100, 100, 100, 100]) d.observe('k', v);
    const meanBefore = d.state.get('k').mean;
    d.observe('k', 5000); // anomalous -> must be excluded from baseline
    const meanAfter = d.state.get('k').mean;
    expect(meanAfter).toBe(meanBefore);
  });

  it('keys are independent', () => {
    const d = new EwmaZScoreDetector({ minSamples: 2 });
    d.observe('a', 100);
    d.observe('a', 100);
    expect(d.observe('b', 50).classification).toBe('cold_start');
  });
});
