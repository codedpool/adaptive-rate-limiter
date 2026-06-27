import client from 'prom-client';

/**
 * Prometheus metrics for the request path. The decision-duration histogram is
 * what backs the "added p99 latency" benchmark claim — it measures the limiter
 * overhead itself, not the downstream handler.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const requestsTotal = new client.Counter({
  name: 'rl_requests_total',
  help: 'Rate-limit decisions made',
  labelNames: ['result', 'degraded'],
  registers: [registry],
});

export const decisionDuration = new client.Histogram({
  name: 'rl_decision_duration_seconds',
  help: 'Time spent making a rate-limit decision',
  buckets: [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [registry],
});

export const redisUp = new client.Gauge({
  name: 'rl_redis_up',
  help: 'Whether Redis was reachable at the last health check (1/0)',
  registers: [registry],
});

/** Record a single decision and how long it took. */
export function recordDecision(decision, durationSeconds) {
  requestsTotal.inc({
    result: decision.allowed ? 'allowed' : 'blocked',
    degraded: decision.degraded ? '1' : '0',
  });
  decisionDuration.observe(durationSeconds);
}

export async function metricsText() {
  return registry.metrics();
}

export const metricsContentType = registry.contentType;
