import pino from 'pino';
import { config } from '../config/index.js';

/**
 * Single shared structured logger. Child loggers (with request/key context)
 * are created at the call sites via `logger.child({...})`.
 */
export const logger = pino({
  level: config.logLevel,
  base: { service: 'rate-limiter' },
  timestamp: pino.stdTimeFunctions.isoTime,
});
