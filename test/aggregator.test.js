import { describe, it, expect } from 'vitest';
import { Aggregator } from '../src/adaptive/aggregator.js';

describe('Aggregator', () => {
  it('counts events within a bucket and only flushes closed buckets', () => {
    const agg = new Aggregator({ bucketMs: 1000 });
    // bucket 0: [0, 1000)
    agg.add('k', 100);
    agg.add('k', 200);
    agg.add('k', 999);
    // still inside bucket 0 -> nothing closed yet
    expect(agg.flushClosed(500)).toEqual([]);
    // now at t=1500 (bucket 1) -> bucket 0 is closed
    const closed = agg.flushClosed(1500);
    expect(closed).toEqual([{ key: 'k', bucketIndex: 0, rate: 3 }]);
  });

  it('keeps separate counts per key', () => {
    const agg = new Aggregator({ bucketMs: 1000 });
    agg.add('a', 100);
    agg.add('a', 200);
    agg.add('b', 300);
    const closed = agg.flushClosed(2000).sort((x, y) => x.key.localeCompare(y.key));
    expect(closed).toEqual([
      { key: 'a', bucketIndex: 0, rate: 2 },
      { key: 'b', bucketIndex: 0, rate: 1 },
    ]);
  });

  it('does not double-flush a bucket', () => {
    const agg = new Aggregator({ bucketMs: 1000 });
    agg.add('k', 100);
    expect(agg.flushClosed(2000)).toHaveLength(1);
    expect(agg.flushClosed(3000)).toHaveLength(0);
  });
});
