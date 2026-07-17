import { describe, expect, it } from 'vitest';
import { latestObservation } from './observation-service.js';

describe('Observation freshness', () => {
  const resource = { type: 'instance' as const, id: 1 };
  it('marks stale and missing values unknown instead of healthy', () => {
    expect(latestObservation({ resource, metricId: 'cpu_usage', value: 10, observedAt: new Date(0), validForMs: 1, now: new Date(2), source: 'collector' })).toMatchObject({ quality: 'unknown', reason: 'stale_observation' });
    expect(latestObservation({ resource, metricId: 'cpu_usage', validForMs: 1, source: 'collector' })).toMatchObject({ quality: 'unknown', reason: 'missing_observation' });
  });
});
