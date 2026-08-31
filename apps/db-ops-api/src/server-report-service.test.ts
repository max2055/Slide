import { describe, expect, it } from 'vitest';
import { scoreIo, scoreNetwork, scoreReachability } from './server-report-service.js';

describe('server report health dimensions', () => {
  it('treats missing network evidence as unknown and zero errors as healthy', () => {
    expect(scoreNetwork(null, null)).toBeNull();
    expect(scoreNetwork(0, 0)).toBe(100);
    expect(scoreNetwork(11, 0)).toBe(20);
  });

  it('weights reachability as an explicit degraded dimension', () => {
    expect(scoreReachability('online')).toBe(100);
    expect(scoreReachability('unreachable')).toBe(0);
    expect(scoreReachability('unknown')).toBeNull();
  });

  it('does not award an IO score without either load or IO evidence', () => {
    expect(scoreIo(null, null)).toBeNull();
    expect(scoreIo(0.5, null)).toBe(100);
    expect(scoreIo(null, 2000)).toBe(20);
  });
});
