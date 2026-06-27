import Fastify from 'fastify';
import { config } from './config/index.js';
import { logger } from './observability/logger.js';
import { Store } from './core/store.js';

/**
 * Application entrypoint. Phase 0 wires up the HTTP server with liveness/readiness
 * probes and a Redis connection. Later phases attach the rate-limit middleware,
 * metrics, and admin routes onto this same instance.
 */
export async function buildServer() {
  const app = Fastify({ logger: false });
  const store = new Store(config.redisUrl);

  app.decorate('store', store);

  // Liveness: process is up.
  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness: dependencies (Redis) are reachable.
  app.get('/ready', async (_req, reply) => {
    const redisOk = await store.ping();
    if (!redisOk) return reply.code(503).send({ status: 'not_ready', redis: false });
    return { status: 'ready', redis: true };
  });

  app.addHook('onClose', async () => {
    await store.close();
  });

  return { app, store };
}

async function main() {
  const { app, store } = await buildServer();
  try {
    await store.connect();
  } catch (err) {
    logger.warn({ err: err.message }, 'redis not reachable at startup (continuing)');
  }

  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port, host: config.host }, 'server listening');

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.js')) {
  main().catch((err) => {
    logger.error({ err: err.message }, 'fatal startup error');
    process.exit(1);
  });
}
