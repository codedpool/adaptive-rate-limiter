/**
 * A minimal circuit breaker.
 *
 * Wraps an unreliable dependency (here: Redis). After `failureThreshold`
 * consecutive failures it "opens" and stops attempting for `cooldownMs`, so a
 * dead/slow Redis doesn't add latency to every request. After the cooldown it
 * goes "half-open" and allows a single trial; success closes it, failure
 * re-opens it.
 */
export class CircuitBreaker {
  constructor({ failureThreshold = 5, cooldownMs = 5000, now = () => Date.now() } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
  }

  /** Whether a call should be attempted against the real dependency now. */
  allowsAttempt() {
    if (this.state === 'open') {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half_open';
        return true;
      }
      return false;
    }
    return true; // closed or half_open
  }

  onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  onFailure() {
    this.failures += 1;
    if (this.state === 'half_open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}
