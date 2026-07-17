import { describe, expect, it } from 'vitest';
import { aggregateHealth } from '../src/health-truth.js';

describe('four-dimensional health truth', () => {
  it('caps overall health when managed resources are critical or freshness is unknown', () => {
    const health = aggregateHealth({
      controlPlane: { status: 'healthy', numerator: 5, denominator: 5 },
      managedAvailability: { status: 'critical', numerator: 1, denominator: 5 },
      dataFreshness: { status: 'unknown', numerator: 0, denominator: 5 },
      workflow: { status: 'healthy', numerator: 2, denominator: 2 },
    });
    expect(health.overall).toBe('critical');
    expect(health.managedAvailability).toMatchObject({ numerator: 1, denominator: 5 });
  });
});
