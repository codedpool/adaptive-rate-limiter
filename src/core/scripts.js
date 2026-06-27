import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, 'scripts', name), 'utf8');

const SCRIPTS = {
  rlTokenBucket: { numberOfKeys: 1, lua: read('tokenBucket.lua') },
  rlSlidingWindow: { numberOfKeys: 1, lua: read('slidingWindow.lua') },
  rlHybrid: { numberOfKeys: 2, lua: read('hybrid.lua') },
};

/**
 * Register the Lua scripts as custom commands on an ioredis client.
 *
 * ioredis `defineCommand` runs them via EVALSHA and transparently falls back to
 * EVAL + reload on NOSCRIPT (e.g. after a Redis restart or FLUSH), so we get the
 * single-round-trip atomic path without managing SHA caching by hand.
 *
 * @param {import('ioredis').Redis} client
 */
export function registerScripts(client) {
  for (const [name, def] of Object.entries(SCRIPTS)) {
    if (typeof client[name] !== 'function') {
      client.defineCommand(name, { numberOfKeys: def.numberOfKeys, lua: def.lua });
    }
  }
  return client;
}
