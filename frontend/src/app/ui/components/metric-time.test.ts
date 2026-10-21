import { expect, it } from 'vitest';
import { formatMetricTime } from './metric-time.js';
import { metricDisplayName } from './metric-display.js';
import { templateName } from './metric-package-directory.js';

it('formats ISO timestamps in the local zone without changing non-ISO labels', () => {
  const iso = '2026-10-21T23:45:00.000Z';
  expect(formatMetricTime(iso)).toBe(new Date(iso).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  expect(formatMetricTime(iso, true)).toContain(new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit' }));
  expect(formatMetricTime('14:05')).toBe('14:05');
  expect(formatMetricTime('not a time')).toBe('not a time');
  expect(formatMetricTime('2026-10-21T14:05:00')).toBe('2026-10-21T14:05:00');
});
it('distinguishes known diagnostic names and reviewed extensions, retaining unknown IDs', () => {
  expect(metricDisplayName('mysql.key_cache.used_percent')).toBe('键缓存使用率');
  expect(metricDisplayName('mysql.slow_queries.total')).toContain('累计');
  expect(metricDisplayName('vendor.real_metric')).toBe('vendor.real_metric');
  expect(templateName('mysql-custom-processlist-connections')).toContain('会话');
  expect(templateName('mysql-custom-slow-query-snapshot')).toContain('慢查询');
  expect(templateName('vendor-real-package')).toBe('vendor-real-package');
});
