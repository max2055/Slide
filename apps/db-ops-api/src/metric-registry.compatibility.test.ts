import { afterEach, expect, it, vi } from 'vitest';
import { MetricRegistry } from './metric-registry';
import { metricDatabaseService } from './metric-database-service';
afterEach(() => vi.restoreAllMocks());
it('merges builtin database support on load and refresh while preserving operator settings', async () => {
  const registry = new MetricRegistry();
  const old = { ...registry.getById('connections'), db_types: ['mysql', 'postgresql'], default_interval: 123, is_collected: false, is_builtin: true };
  vi.spyOn(metricDatabaseService, 'getAllMetrics').mockResolvedValue([old] as any);
  for (const reload of [() => registry.initialize(), () => registry.refreshFromDB()]) {
    await reload();
    expect(registry.getByDbType('dameng').map(m => m.id)).toContain('connections');
    expect(registry.getByDbType('oracle').map(m => m.id)).toContain('connections');
    expect(registry.getById('connections')).toMatchObject({ default_interval: 123, is_collected: false });
  }
});

it('keeps the previous snapshot visible throughout an asynchronous refresh', async () => {
  const registry = new MetricRegistry();
  let finish!: (rows: any[]) => void;
  vi.spyOn(metricDatabaseService, 'getAllMetrics').mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const refresh = registry.refreshFromDB();
  expect(registry.getByDbType('dameng').length).toBeGreaterThan(0);
  finish([{ ...new MetricRegistry().getById('connections'), default_interval: 99 }]);
  await refresh;
  expect(registry.getById('connections')?.default_interval).toBe(99);
});

// #334: old incomplete seeds must not replace complete predefined metadata.
it('repairs legacy metadata while retaining settings and explicit overrides across reloads', async () => {
  const registry = new MetricRegistry();
  const cpu = registry.getById('cpu_usage')!;
  const rows = [
    { ...cpu, threshold_template: null, default_interval: 77, is_collected: false, collection_sqls: { mysql: 'SELECT 42' } },
    { id: 'network_rx_errors', target_type: 'server', name: '网络接收错误数', unit: 'count', db_types: [], aggregation: 'last', default_interval: 60,
      is_builtin: true, is_collected: true, value_type: 'gauge', category: null, threshold_template: null },
  ];
  vi.spyOn(metricDatabaseService, 'getAllMetrics').mockResolvedValue(rows as any);
  await registry.initialize();
  expect(registry.getById('cpu_usage')).toMatchObject({ threshold_template: cpu.threshold_template, default_interval: 77, is_collected: false, collection_sqls: { mysql: 'SELECT 42' } });
  expect(registry.getById('network_rx_errors', 'server')).toMatchObject({ value_type: 'counter', category: 'server', higher_is_worse: true });
  Object.assign(rows[0], { threshold_template: null, metadata_overrides: { threshold_template: true }, higher_is_worse: false });
  await registry.refreshFromDB();
  expect(registry.getById('cpu_usage')).toMatchObject({ threshold_template: null, higher_is_worse: false });
});

it('seeds the complete predefined metadata on an empty store', async () => {
  const registry = new MetricRegistry();
  vi.spyOn(metricDatabaseService, 'getAllMetrics').mockResolvedValue([]);
  const create = vi.spyOn(metricDatabaseService, 'createMetric').mockResolvedValue({ success: true });
  await registry.initialize();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: 'cpu_usage', threshold_template: { warning: 80, error: 90, critical: 95 } }), true);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: 'network_rx_errors', target_type: 'server', value_type: 'counter', category: 'server', higher_is_worse: true }), true);
});
