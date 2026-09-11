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
