# ADR 0001 — Redis Streams for the event pipeline, not Kafka

**Status:** accepted

## Context

The adaptive layer needs a stream of request-decision events flowing from the app
nodes to a consumer that analyses traffic. The original concept called for Kafka.

## Decision

Use **Redis Streams** with a consumer group, not Kafka.

## Rationale

- We already run Redis for the limiter itself. Adding Kafka means a second
  distributed system to deploy, secure, monitor, and reason about — for a single
  low-stakes, advisory data flow.
- Redis Streams give us the properties we actually need: append-only log,
  consumer groups with at-least-once delivery and acks, and `MAXLEN` trimming so
  the stream is self-bounding.
- The events are advisory. We are not building an audit-grade, multi-consumer,
  infinite-retention event bus; we're feeding one analyser. Kafka's durability
  and throughput guarantees are real, but they're not requirements here.

## Consequences

- One fewer moving part; the whole system runs on `docker compose up` with just
  Redis.
- If the event volume or the number of independent consumers grows by orders of
  magnitude, Kafka (or Redpanda) becomes justified. The producer/consumer
  boundary is small and isolated, so that swap is localised to `src/adaptive/`.
