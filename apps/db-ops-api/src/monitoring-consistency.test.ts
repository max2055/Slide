import { afterEach, expect, it, vi } from 'vitest';
import { MetricRegistry } from './metric-registry';
import { metricDatabaseService } from './metric-database-service';
import { HuaweiAdapter } from './network-devices/huawei-adapter';
import { databaseService } from './database-service';

afterEach(() => vi.restoreAllMocks());
it('prevents cross-device counter contamination', async () => {
  let now = 100000;
  const client = { get: async () => [], table: async (config: any) => [{ index: '1', values: { '2': 'eth0', '7': 1, '8': 1, ifHCInOctets: config.host === '192.0.2.1' ? '1000' : '9000' } }] };
  const adapter = new HuaweiAdapter(client as any, undefined, () => new Date(now));
  await adapter.collectInterfaces({ host: '192.0.2.1' } as any, ['interface_in_bps']);
  now += 10000;
  const secondDeviceFirstSample = await adapter.collectInterfaces({ host: '192.0.2.2' } as any, ['interface_in_bps']);
  expect(secondDeviceFirstSample.observations[0]).toMatchObject({ value: null, quality: 'unknown' });
});
it('prevents fallback replacing disabled operator settings', async () => {
  const registry = new MetricRegistry();
  const get = vi.spyOn(metricDatabaseService, 'getAllMetrics');
  get.mockResolvedValue([{ ...registry.getById('connections'), is_builtin: true, is_collected: false, default_interval: 123 }] as any);
  await registry.initialize();
  expect(registry.getById('connections')?.is_collected).toBe(false);
  get.mockRejectedValue(new Error('database unavailable'));
  await registry.refreshFromDB();
  expect(registry.getById('connections')?.is_collected).toBe(false);
  expect(registry.getById('connections')?.default_interval).toBe(123);
});
it('prevents old auto-seeded nonbuiltin rows missing the compatibility merge', async () => {
  const registry = new MetricRegistry();
  vi.spyOn(metricDatabaseService, 'getAllMetrics').mockResolvedValue([{ ...registry.getById('connections'), is_builtin: false, db_types: ['mysql', 'postgresql'] }] as any);
  await registry.initialize();
  expect(registry.getByDbType('dameng').map(m => m.id)).toContain('connections');
});
it('prevents Oracle missing permission and real zero cache hit both scored as healthy', async () => {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('DBA_')) throw new Error('insufficient privileges');
    if (sql.includes('V$LIBRARYCACHE')) return { rows: [[0]] };
    return { rows: [[1]] };
  });
  const result = await (databaseService as any).checkOracleHealth({ id: 1, oracleConnection: { execute } });
  expect(result.checks.find((c: any) => c.name === '库缓存命中率')).toMatchObject({ score: 40, status: 'critical' });
  expect(result.checks.find((c: any) => c.name === '表空间使用率')).toMatchObject({ status: 'unknown' });
});

it('marks every unavailable Oracle health metric unknown while keeping connectivity evidence', async () => {
  const execute = async (sql: string) => {
    if (sql === 'SELECT 1 FROM DUAL') return { rows: [[1]] };
    throw new Error('permission denied');
  };
  const result = await (databaseService as any).checkOracleHealth({ id: 1, oracleConnection: { execute } });
  expect(result.checks.find((c: any) => c.name === '连接状态')).toMatchObject({ status: 'ok', score: 100 });
  for (const name of ['连接数使用率', '表空间使用率', '库缓存命中率', '死锁检测']) {
    expect(result.checks.find((c: any) => c.name === name)).toMatchObject({ status: 'unknown', score: 0 });
  }
});
it('preserves zero Dameng cache hit and marks inaccessible lock metrics unknown', async () => {
  const execute = async (sql: string) => {
    if (sql.includes('V$LOCK') || sql.includes('V$DEADLOCK_HISTORY')) throw new Error('permission denied');
    if (sql.includes('V$BUFFERPOOL')) return { rows: [[0]] };
    return { rows: [[100]] };
  };
  const result = await (databaseService as any).checkDamengHealth({ id: 1, dmConnection: { execute } });
  expect(result.checks.find((c: any) => c.name === '缓冲池命中率')).toMatchObject({ status: 'critical', score: 40 });
  for (const name of ['锁等待检测', '死锁检测']) {
    expect(result.checks.find((c: any) => c.name === name)).toMatchObject({ status: 'unknown', score: 0 });
  }
});
it('does not infer a reboot from another device with a lower uptime', async () => {
  const client = { get: async (config: any, oids: string[]) => oids.map(oid => ({ oid, type: 'TimeTicks', value: config.host === '192.0.2.1' ? 100000 : 1000 })), table: async () => [] };
  const adapter = new HuaweiAdapter(client as any);
  await adapter.collectSystemMetrics({ host: '192.0.2.1' } as any, undefined, ['device_uptime_seconds']);
  const second = await adapter.collectSystemMetrics({ host: '192.0.2.2' } as any, undefined, ['device_uptime_seconds']);
  expect(second[0].reason).not.toBe('device_rebooted');
});
