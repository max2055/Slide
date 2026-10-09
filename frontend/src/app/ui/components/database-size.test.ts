import { expect, it } from 'vitest';
import { databaseSizeSummary, formatDatabaseBytes } from './resource-metric-summary.js';
import type { SemanticResult } from './semantic-metrics.js';
const result = (value: unknown = '8192', state = 'available', freshness = 'fresh'): SemanticResult => ({
  profile: { columns: [{ key: 'database_size', label: '数据库大小', metric: { id: 'mysql.tables.estimated_allocated_bytes' } }] },
  window: { from: '2026-10-09T00:00:00Z', to: '2026-10-09T00:01:00Z' },
  metrics: [{ definition: { id: 'mysql.tables.estimated_allocated_bytes', category: 'extension', meaning: 'estimate', unit: 'By' },
    state, capability: null, observed_at: '2026-10-09T00:00:30Z',
    series: [{ dimensions: {}, buckets: [{ value: value === null ? null : { encoding: 'uint64', value: value as string },
      unit: 'By', coverage: 1, quality: { status: 'good', reason: 'none' }, freshness, accuracy: 'estimated', sources: [],
      window: { from: '2026-10-09T00:00:30Z', to: '2026-10-09T00:00:30.001Z' } }] }] }],
});
it.each([['0', '0 B'], ['1', '1 B'], ['1023', '1,023 B'], ['1024', '1.00 KiB'], ['8192', '8.00 KiB'],
  ['1048576', '1.00 MiB'], ['1073741824', '1.00 GiB'], ['18446744073709551615', '17,179,869,184.00 GiB']])('formats exact bytes %s as %s', (input, expected) => {
  expect(formatDatabaseBytes(input)).toBe(expected);
});
it.each([null, undefined, '', '-1', '1.5', 'NaN', 9007199254740992, '18446744073709551616'])('rejects missing/invalid/overflow %s', value => {
  expect(formatDatabaseBytes(value)).toBeNull();
});
it('preserves small values, estimates and stale evidence', () => {
  expect(databaseSizeSummary(result())).toBe('8.00 KiB · 估算');
  expect(databaseSizeSummary(result('8192', 'available', 'stale'))).toContain('已过期');
  expect(databaseSizeSummary(result(null))).toBe('暂无有效值');
  expect(databaseSizeSummary(result('0'))).toBe('0 B · 估算');
});
it.each([['disabled', '已停用'], ['not_configured', '未配置'], ['permission_denied', '采集权限不足'], ['unsupported', '不支持']])('does not expose a cached value for %s', (state, label) => {
  expect(databaseSizeSummary(result('8192', state))).toBe(label);
});
it('labels a previous value after failed collection and does not fabricate an unsupported value', () => {
  expect(databaseSizeSummary(result('8192', 'temporary_failure', 'stale'))).toBe('采集失败 · 上次 8.00 KiB · 估算 · 已过期');
  expect(databaseSizeSummary({ ...result(), metrics: [], profile: { columns: [] } })).toBe('暂不支持');
});
