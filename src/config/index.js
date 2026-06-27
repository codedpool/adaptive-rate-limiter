import { z } from 'zod';

/**
 * Centralised, schema-validated config. Reads from process.env once at startup
 * and fails fast (process exits) on invalid values. There is no compiler here,
 * so this is the boundary where we guarantee types/shape for the rest of the app.
 */

const boolish = (def) =>
  z
    .union([z.boolean(), z.string()])
    .default(def)
    .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  host: z.string().default('0.0.0.0'),
  redisUrl: z.string().url().default('redis://localhost:6379'),

  failMode: z.enum(['open', 'closed']).default('open'),

  defaultRule: z.object({
    limit: z.coerce.number().int().positive().default(100),
    windowMs: z.coerce.number().int().positive().default(60_000),
    burst: z.coerce.number().int().nonnegative().default(20),
  }),

  streamKey: z.string().default('rl:events'),
  streamMaxLen: z.coerce.number().int().positive().default(100_000),
  adaptiveEnabled: boolish(true),

  // If set, admin endpoints require `Authorization: Bearer <token>`. Empty in
  // dev leaves them open (a warning is logged).
  adminToken: z.string().default(''),

  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

function build(env = process.env) {
  const parsed = ConfigSchema.safeParse({
    port: env.PORT,
    host: env.HOST,
    redisUrl: env.REDIS_URL,
    failMode: env.RL_FAIL_MODE,
    defaultRule: {
      limit: env.RL_DEFAULT_LIMIT,
      windowMs: env.RL_DEFAULT_WINDOW_MS,
      burst: env.RL_DEFAULT_BURST,
    },
    streamKey: env.RL_STREAM_KEY,
    streamMaxLen: env.RL_STREAM_MAXLEN,
    adaptiveEnabled: env.RL_ADAPTIVE_ENABLED,
    adminToken: env.RL_ADMIN_TOKEN,
    logLevel: env.LOG_LEVEL,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const config = build();
export { ConfigSchema, build as buildConfig };
