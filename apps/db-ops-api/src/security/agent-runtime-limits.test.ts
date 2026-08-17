import { describe, expect, it } from 'vitest';
import { ActorConcurrencyLimiter, FixedWindowRateLimiter } from './agent-runtime-limits.js';

describe('Agent runtime guards', () => {
  it('bounds frames in a fixed window and resets only after the window', () => {
    const limiter = new FixedWindowRateLimiter(2, 1000, 0);
    expect(limiter.allow(1)).toBe(true);
    expect(limiter.allow(2)).toBe(true);
    expect(limiter.allow(3)).toBe(false);
    expect(limiter.allow(1000)).toBe(true);
  });

  it('limits concurrent runs independently per actor', () => {
    const limiter = new ActorConcurrencyLimiter(1);
    expect(limiter.acquire(7)).toBe(true);
    expect(limiter.acquire(7)).toBe(false);
    expect(limiter.acquire(8)).toBe(true);
    limiter.release(7);
    expect(limiter.acquire(7)).toBe(true);
  });
});
