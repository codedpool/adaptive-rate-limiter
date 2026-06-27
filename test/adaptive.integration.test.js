import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { StreamProducer } from '../src/adaptive/producer.js';
import { SuggestionStore } from '../src/adaptive/suggestionStore.js';
import { AdaptiveWorker } from '../src/adaptive/worker.js';
import { EwmaZScoreDetector } from '../src/adaptive/detector.js';
import { redisAvailable, makeClient } from './helpers/redis.js';

const REDIS_UP = await redisAvailable();
const suite = REDIS_UP ? describe : describe.skip;

suite('adaptive layer (Redis Streams)', () => {
  /** @type {import('ioredis').Redis} */
  let client;
  beforeAll(() => {
    client = makeClient();
  });
  afterAll(async () => {
    await client.quit();
  });

  it('SuggestionStore round-trips suggestions and audit entries', async () => {
    const store = new SuggestionStore(client, {
      hashKey: `test:sug:${randomUUID()}`,
      auditKey: `test:aud:${randomUUID()}`,
    });
    expect(await store.get('k')).toBeNull();
    await store.set('k', 42, { action: 'tighten', classification: 'anomalous' });
    expect(await store.get('k')).toBe(42);
    expect((await store.all()).k).toBe(42);
    const audit = await store.audit(10);
    expect(audit[0]).toMatchObject({ key: 'k', limit: 42, action: 'tighten' });
    await store.clear('k');
    expect(await store.get('k')).toBeNull();
  });

  it('producer -> worker consumer group round trip consumes and acks events', async () => {
    const streamKey = `test:stream:${randomUUID()}`;
    const producer = new StreamProducer(client, { streamKey, maxLen: 1000 });
    for (let i = 0; i < 5; i++) producer.emit({ key: 'ip:1.2.3.4', allowed: true, route: 'GET /x', ts: 100 + i });

    const worker = new AdaptiveWorker({
      client: makeClient(),
      streamKey,
      baseLimit: 100,
      bucketMs: 1000,
      blockMs: 200,
      store: new SuggestionStore(client, { hashKey: `test:sug:${randomUUID()}` }),
    });
    await worker.ensureGroup();

    // events were at ts ~100 (bucket 0); advance now to bucket 2 so bucket 0 closes
    const processed = await worker.tick(2000);
    expect(processed).toBe(1); // one closed bucket for the one key

    const pending = await client.xpending(streamKey, worker.group);
    expect(pending[0]).toBe(0); // all acked
    await worker.client.quit();
  });

  it('worker tightens a key when the detector flags an anomaly', async () => {
    const streamKey = `test:stream:${randomUUID()}`;
    const store = new SuggestionStore(client, {
      hashKey: `test:sug:${randomUUID()}`,
      auditKey: `test:aud:${randomUUID()}`,
    });
    const worker = new AdaptiveWorker({
      client,
      streamKey,
      baseLimit: 100,
      detector: new EwmaZScoreDetector({ minSamples: 4, zThreshold: 3 }),
      store,
    });

    // Establish a calm baseline, then a spike.
    for (const rate of [100, 100, 100, 100, 100]) await worker.processBucket('ip:9', rate);
    await worker.processBucket('ip:9', 5000); // anomalous

    const suggested = await store.get('ip:9');
    expect(suggested).not.toBeNull();
    expect(suggested).toBeLessThan(100); // tightened
    expect(suggested).toBeGreaterThanOrEqual(25); // but not below floor
  });
});
