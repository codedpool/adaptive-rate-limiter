import Fastify from 'fastify';
import { config } from './config/index.js';
import { logger } from './observability/logger.js';
import { Store } from './core/store.js';
import { RedisLimiter } from './core/redisLimiter.js';
import { Limiter } from './core/limiter.js';
import { CircuitBreaker } from './core/circuitBreaker.js';
import { rateLimitPlugin } from './middleware/fastify.js';
import { makeRuleResolver, defaultRuleFromConfig } from './middleware/rules.js';
import { StreamProducer } from './adaptive/producer.js';
import { SuggestionStore } from './adaptive/suggestionStore.js';
import { AdaptiveOverrides } from './adaptive/overrides.js';

/**
 * Application entrypoint. Wires the HTTP server, Redis-backed limiter (with
 * in-memory fallback behind a circuit breaker), and the rate-limit middleware.
 */
export async function buildServer() {
  // trustProxy must be set so req.ip is the real client when behind a proxy/LB.
  const app = Fastify({ logger: false, trustProxy: true });
  const store = new Store(config.redisUrl);

  const redisLimiter = new RedisLimiter(store.client);
  const limiter = new Limiter({
    redisLimiter,
    failMode: config.failMode,
    breaker: new CircuitBreaker({ failureThreshold: 5, cooldownMs: 5000 }),
    onDegraded: (info) => logger.warn(info, 'rate limiter degraded to fallback'),
  });

  // Adaptive layer (advisory, off the hot path): emit events to a stream and
  // serve worker-produced limit suggestions from an in-memory cache.
  const producer = new StreamProducer(store.client, {
    streamKey: config.streamKey,
    maxLen: config.streamMaxLen,
  });
  const suggestions = new SuggestionStore(store.client);
  const overrides = new AdaptiveOverrides(suggestions, {
    onError: (info) => logger.debug(info, 'overrides refresh failed'),
  });
  if (config.adaptiveEnabled) overrides.start();

  app.decorate('store', store);
  app.decorate('limiter', limiter);
  app.decorate('suggestions', suggestions);

  // Probes must never be rate limited.
  const resolveRule = makeRuleResolver({
    defaultRule: defaultRuleFromConfig(config.defaultRule),
    routes: {
      'GET /health': null,
      'GET /ready': null,
    },
  });

  await app.register(rateLimitPlugin, {
    limiter,
    resolveRule,
    overrides: config.adaptiveEnabled ? overrides : undefined,
    emit: config.adaptiveEnabled ? (event) => producer.emit(event) : undefined,
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    const redisOk = await store.ping();
    if (!redisOk) return reply.code(503).send({ status: 'not_ready', redis: false });
    return { status: 'ready', redis: true };
  });

  // Demo endpoint that exercises the limiter.
  app.get('/api/ping', async () => ({ pong: true }));

  app.addHook('onClose', async () => {
    overrides.stop();
    await store.close();
  });

  return { app, store, limiter, overrides };
}

async function main() {
  const { app, store } = await buildServer();
  try {
    await store.connect();
  } catch (err) {
    logger.warn({ err: err.message }, 'redis not reachable at startup (continuing degraded)');
  }

  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port, host: config.host, failMode: config.failMode }, 'server listening');

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.js')) {
  main().catch((err) => {
    logger.error({ err: err.message }, 'fatal startup error');
    process.exit(1);
  });
}
