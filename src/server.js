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
import { adminRoutes } from './admin/routes.js';
import * as metrics from './observability/metrics.js';
import { DashboardHub } from './dashboard/hub.js';
import { dashboardPlugin } from './dashboard/routes.js';
import { DemoDriver } from './demo/driver.js';

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

  // Live dashboard fan-out hub, fed in-process by the middleware emit hook.
  const hub = new DashboardHub();

  app.decorate('store', store);
  app.decorate('limiter', limiter);
  app.decorate('suggestions', suggestions);
  app.decorate('hub', hub);

  // Control-plane and probe routes must never be rate limited.
  const baseResolve = makeRuleResolver({ defaultRule: defaultRuleFromConfig(config.defaultRule) });
  const resolveRule = (req) => {
    const url = req.routeOptions?.url || req.url;
    if (
      url === '/' ||
      url === '/health' ||
      url === '/ready' ||
      url === '/metrics' ||
      url === '/dashboard' ||
      url.startsWith('/ws') ||
      url.startsWith('/demo') ||
      url.startsWith('/admin')
    ) {
      return null;
    }
    return baseResolve(req);
  };

  // One emit hook feeds both the adaptive stream and the live dashboard hub.
  const emit = (event) => {
    if (config.adaptiveEnabled) producer.emit(event);
    hub.onEvent(event);
  };

  // Server-side traffic simulator for the dashboard's Start button.
  const demo = new DemoDriver({ limiter, emit, rule: defaultRuleFromConfig(config.defaultRule) });
  app.decorate('demo', demo);

  await app.register(rateLimitPlugin, {
    limiter,
    resolveRule,
    metrics,
    overrides: config.adaptiveEnabled ? overrides : undefined,
    emit,
  });

  await app.register(adminRoutes, {
    prefix: '/admin',
    suggestions,
    adminToken: config.adminToken,
    logger,
  });

  await app.register(dashboardPlugin, { hub });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    const redisOk = await store.ping();
    metrics.redisUp.set(redisOk ? 1 : 0);
    if (!redisOk) return reply.code(503).send({ status: 'not_ready', redis: false });
    return { status: 'ready', redis: true };
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', metrics.metricsContentType);
    return metrics.metricsText();
  });

  // Demo endpoint that exercises the limiter.
  app.get('/api/ping', async () => ({ pong: true }));

  // Dashboard "Start" button controls the server-side traffic simulator.
  app.post('/demo/start', async () => {
    demo.start();
    return demo.status();
  });
  app.post('/demo/stop', async () => {
    demo.stop();
    return demo.status();
  });
  app.get('/demo/status', async () => demo.status());

  app.addHook('onClose', async () => {
    demo.stop();
    overrides.stop();
    hub.closeAll(); // terminate dashboard WebSockets so close doesn't hang
    await store.close();
  });

  return { app, store, limiter, overrides, hub };
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

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    // Backstop: never let a stuck close keep the process alive.
    const force = setTimeout(() => {
      logger.error('forced exit after shutdown timeout');
      process.exit(1);
    }, 5000);
    force.unref();
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
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
