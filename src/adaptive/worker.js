import Redis from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { Aggregator } from './aggregator.js';
import { EwmaZScoreDetector } from './detector.js';
import { SuggestionStore } from './suggestionStore.js';
import { suggestLimit } from './policy.js';

/**
 * The adaptive sidecar. Runs as its OWN process (`npm run worker`), entirely off
 * the request path. It consumes the request-event stream via a consumer group,
 * buckets events into per-key rates, scores each rate with the detector, and
 * writes bounded limit suggestions (with an audit trail) back to Redis.
 */
export class AdaptiveWorker {
  constructor({
    client,
    streamKey,
    group = 'rl-adaptive',
    consumer = `worker-${process.pid}`,
    baseLimit,
    bucketMs = 10_000,
    detector = new EwmaZScoreDetector(),
    store,
    blockMs = 2000,
    batch = 500,
  }) {
    this.client = client;
    this.streamKey = streamKey;
    this.group = group;
    this.consumer = consumer;
    this.baseLimit = baseLimit;
    this.aggregator = new Aggregator({ bucketMs });
    this.detector = detector;
    this.store = store || new SuggestionStore(client);
    this.blockMs = blockMs;
    this.batch = batch;
    this.running = false;
  }

  /** Create the consumer group (idempotent), starting from new messages. */
  async ensureGroup() {
    try {
      await this.client.xgroup('CREATE', this.streamKey, this.group, '$', 'MKSTREAM');
    } catch (err) {
      if (!String(err.message).includes('BUSYGROUP')) throw err;
    }
  }

  /** Read one batch, fold into the aggregator, ack, then process closed buckets. */
  async tick(now = Date.now()) {
    const res = await this.client.xreadgroup(
      'GROUP',
      this.group,
      this.consumer,
      'COUNT',
      this.batch,
      'BLOCK',
      this.blockMs,
      'STREAMS',
      this.streamKey,
      '>',
    );

    if (res) {
      const [, entries] = res[0];
      const ids = [];
      for (const [id, fields] of entries) {
        const e = parseFields(fields);
        const ts = Number(e.ts) || now;
        this.aggregator.add(e.key, ts);
        ids.push(id);
      }
      if (ids.length) await this.client.xack(this.streamKey, this.group, ...ids);
    }

    const closed = this.aggregator.flushClosed(now);
    for (const { key, rate } of closed) {
      await this.processBucket(key, rate);
    }
    return closed.length;
  }

  async processBucket(key, rate) {
    const analysis = this.detector.observe(key, rate);
    const currentLimit = (await this.store.get(key)) ?? this.baseLimit;
    const { limit, action } = suggestLimit({
      baseLimit: this.baseLimit,
      currentLimit,
      classification: analysis.classification,
      observedRate: rate,
    });

    if (action !== 'hold') {
      await this.store.set(key, limit, {
        action,
        classification: analysis.classification,
        z: Number(analysis.z.toFixed(2)),
        rate,
        from: currentLimit,
        ts: Date.now(),
      });
      logger.info({ key, from: currentLimit, to: limit, action, rate, z: analysis.z }, 'adaptive adjustment');
    }
  }

  async run() {
    this.running = true;
    await this.ensureGroup();
    logger.info({ stream: this.streamKey, group: this.group }, 'adaptive worker started');
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        logger.error({ err: err.message }, 'adaptive worker tick failed');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  stop() {
    this.running = false;
  }
}

/** Flat [f, v, f, v, ...] -> { f: v }. */
function parseFields(fields) {
  const o = {};
  for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
  return o;
}

async function main() {
  const client = new Redis(config.redisUrl);
  const worker = new AdaptiveWorker({
    client,
    streamKey: config.streamKey,
    baseLimit: config.defaultRule.limit,
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'adaptive worker shutting down');
    worker.stop();
    await client.quit();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await worker.run();
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('worker.js')) {
  main().catch((err) => {
    logger.error({ err: err.message }, 'adaptive worker fatal error');
    process.exit(1);
  });
}
