import { describe, expect, it } from 'vitest';
import { dueMetricIds, dueStoredMetricIds, recordCollectionResult } from '../src/collection-scheduler.js';

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

  it('uses persisted next-due state for each resource/provider/metric tuple', async () => {
    const calls: unknown[] = [];
    const store = { list: async () => [{ metricId: 'cpu_usage', nextDueMs: 31_000 }], record: async (...args: unknown[]) => { calls.push(args); } };
    await expect(dueStoredMetricIds(store, 'instance', 9, 'unified', definitions, 30_000)).resolves.toEqual(['connections', 'disk_usage']);
    expect(calls).toEqual([]);
  });

  it('recomputes due time from the current metric interval after configuration changes', async () => {
    const store = {
      list: async () => [{
        metricId: 'cpu_usage',
        lastSuccessMs: 1_000,
        nextDueMs: 301_000,
        lastResult: 'success' as const,
      }],
      record: async () => undefined,
    };
    await expect(dueStoredMetricIds(
      store,
      'server',
      9,
      'ssh',
      [{ id: 'cpu_usage', default_interval: 30 }],
      31_000,
    )).resolves.toEqual(['cpu_usage']);
  });

  it('supports persisted schedules for network devices', async () => {
    const calls: unknown[][] = [];
    const store = {
      list: async (...args: unknown[]) => { calls.push(args); return []; },
      record: async () => undefined,
    };
    await expect(dueStoredMetricIds(
      store,
      'network_device',
      7,
      'huawei-snmp',
      [{ id: 'device_cpu_percent', default_interval: 60 }],
      1_000,
    )).resolves.toEqual(['device_cpu_percent']);
    expect(calls).toEqual([['network_device', 7, 'huawei-snmp']]);
  });
});
