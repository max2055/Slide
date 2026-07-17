import { describe, expect, it } from 'vitest';
import { dueMetricIds, recordCollectionResult } from '../src/collection-scheduler.js';

describe('due-only collection scheduler', () => {
  const definitions = [
    { id: 'cpu_usage', default_interval: 30 },
    { id: 'connections', default_interval: 60 },
    { id: 'disk_usage', default_interval: 300 },
  ];

  it('selects only metrics due at 30s, 60s, and 300s boundaries', () => {
    const state = new Map<string, number>();
    expect(dueMetricIds(definitions, state, 0)).toEqual(['cpu_usage', 'connections', 'disk_usage']);
    state.set('cpu_usage', 0); state.set('connections', 0); state.set('disk_usage', 0);
    expect(dueMetricIds(definitions, state, 30_000)).toEqual(['cpu_usage']);
    expect(dueMetricIds(definitions, state, 60_000)).toEqual(['cpu_usage', 'connections']);
    expect(dueMetricIds(definitions, state, 300_000)).toEqual(['cpu_usage', 'connections', 'disk_usage']);
  });

  it('only advances a metric schedule after a successful collection', () => {
    const state = new Map<string, number>();
    recordCollectionResult(state, 'cpu_usage', 0, false);
    expect(dueMetricIds(definitions, state, 1)).toContain('cpu_usage');
    recordCollectionResult(state, 'cpu_usage', 1, true);
    expect(dueMetricIds(definitions, state, 30_000)).not.toContain('cpu_usage');
  });
});
