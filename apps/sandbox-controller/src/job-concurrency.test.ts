import { describe, expect, it } from 'vitest';
import { JobConcurrencyLimiter } from './job-concurrency.js';

describe('Sandbox job concurrency admission', () => {
  it('admits no more than the configured number of concurrent jobs', async () => {
    const limiter = new JobConcurrencyLimiter(2);
    const admitted = await Promise.all(Array.from({ length: 8 }, async () => limiter.tryAcquire()));

    expect(admitted.filter(Boolean)).toHaveLength(2);
    expect(limiter.active).toBe(2);

    admitted.forEach((lease) => lease?.release());
    expect(limiter.active).toBe(0);
  });

  it('releases a lease exactly once', () => {
    const limiter = new JobConcurrencyLimiter(1);
    const lease = limiter.tryAcquire();

    expect(lease).toBeTruthy();
    lease?.release();
    lease?.release();

    expect(limiter.active).toBe(0);
    expect(limiter.tryAcquire()).toBeTruthy();
  });
});
