Adaptive Rate Limiter with Anomaly Detection
Build a rate limiting service (like what Stripe or Cloudflare runs internally), but instead of static rules like "100 req/min", the limits adapt dynamically based on ML-detected traffic patterns. The core backend: a sliding window + token bucket hybrid stored in Redis, with a distributed counter strategy to avoid race conditions across nodes — directly extends your load balancer work.

The AI layer: Train a lightweight time-series anomaly detection model (Isolation Forest or LSTM) that classifies traffic bursts as "organic spike" vs "bot attack" and adjusts thresholds in real-time. The model runs as a sidecar service, consuming a Kafka stream of request logs.

Why you can discuss it deeply: Token bucket math, Redis INCR atomicity, distributed clock skew, Kafka consumer groups, model inference latency budget, cold-start problem for new IPs. This is exactly the kind of system you'd build at Stripe, Cloudflare, or any API-heavy company.
