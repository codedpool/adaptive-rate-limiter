import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../src/core/circuitBreaker.js';

describe('CircuitBreaker', () => {
  it('opens after the failure threshold and blocks attempts', () => {
    const clock = { t: 0 };
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => clock.t });
    expect(cb.allowsAttempt()).toBe(true);
    cb.onFailure();
    cb.onFailure();
    expect(cb.state).toBe('closed');
    cb.onFailure(); // 3rd -> open
    expect(cb.state).toBe('open');
    expect(cb.allowsAttempt()).toBe(false);
  });

  it('goes half-open after cooldown and closes on success', () => {
    const clock = { t: 0 };
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => clock.t });
    cb.onFailure(); // open
    expect(cb.allowsAttempt()).toBe(false);
    clock.t = 1000;
    expect(cb.allowsAttempt()).toBe(true); // half-open trial
    expect(cb.state).toBe('half_open');
    cb.onSuccess();
    expect(cb.state).toBe('closed');
  });

  it('re-opens if the half-open trial fails', () => {
    const clock = { t: 0 };
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: () => clock.t });
    cb.onFailure();
    clock.t = 500;
    cb.allowsAttempt(); // -> half_open
    cb.onFailure(); // -> open again
    expect(cb.state).toBe('open');
    expect(cb.allowsAttempt()).toBe(false);
  });
});
