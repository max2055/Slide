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
