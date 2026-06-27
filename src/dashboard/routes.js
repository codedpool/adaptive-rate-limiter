import websocket from '@fastify/websocket';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(here, 'index.html'), 'utf8');

/**
 * Serves the live dashboard:
 *  - GET /dashboard   the single-page UI
 *  - GET /ws/feed     WebSocket the page subscribes to
 *
 * Registered as a normal (encapsulated) plugin. The hub is fed by the rate-limit
 * middleware's emit hook (see server.js), so the feed reflects real decisions.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} opts
 * @param {import('./hub.js').DashboardHub} opts.hub
 */
export async function dashboardPlugin(app, opts) {
  const { hub } = opts;
  if (!hub) throw new Error('dashboardPlugin requires { hub }');

  await app.register(websocket);

  app.get('/ws/feed', { websocket: true }, (connection) => {
    // @fastify/websocket v8 passes { socket }; newer versions pass the socket.
    const socket = connection.socket || connection;
    hub.addClient(socket);
    socket.on('close', () => hub.removeClient(socket));
    socket.on('error', () => hub.removeClient(socket));
  });

  app.get('/dashboard', async (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return HTML;
  });
}
