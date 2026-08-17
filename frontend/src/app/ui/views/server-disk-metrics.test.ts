import { describe, expect, it } from 'vitest';
import './server-detail.js';
import './servers-page.js';
import { aggregateServerDiskUsage } from './server-metric-utils.js';

type Metric = {
  server_id: number;
  metric_name: string;
  metric_value: number;
  recorded_at: string;
  dimensions?: Record<string, string> | null;
};

function consumerValues(metrics: Metric[]): [number | null, number | null] {
  const detail = document.createElement('server-detail') as any;
  detail.metrics = metrics;
  const page = document.createElement('servers-page') as any;
  page._metricSummary = {
    servers: { 9: { metrics, recorded_at: '2026-08-10T00:00:00.000Z' } },
    recorded_at: '2026-08-10T00:00:00.000Z',
  };
  return [detail._aggregateDiskUsage(), page._getAggregateDiskMetric(9)?.metric_value ?? null];
}

const metric = (
  metricName: string,
  value: number,
  dimensions?: Record<string, string>,
): Metric => ({
  server_id: 9,
  metric_name: metricName,
  metric_value: value,
  recorded_at: '2026-08-10T00:00:00.000Z',
  dimensions,
});

describe('server disk metric consumers', () => {
  it('aggregates exact disk_usage rows by their mount dimensions', () => {
    const metrics = [
      metric('disk_usage', 40, { mount: '/', device: '/dev/sda1', fs_type: 'xfs' }),
      metric('disk_usage', 80, { mount: '/data', device: '/dev/sdb1', fs_type: 'xfs' }),
      metric('filesystem_inode_usage', 99, { mount: '/' }),
    ];
    expect(aggregateServerDiskUsage(metrics)).toBe(60);
    expect(consumerValues(metrics)).toEqual([60, 60]);
  });

  it('preserves legacy disk_usage_* rows as a fallback', () => {
    const metrics = [
      metric('disk_usage_root', 50),
      metric('disk_usage_var_log', 70),
    ];
    expect(aggregateServerDiskUsage(metrics)).toBe(60);
    expect(consumerValues(metrics)).toEqual([60, 60]);
  });

  it('prefers canonical rows when canonical and legacy values coexist', () => {
    const metrics = [
      metric('disk_usage', 30, { mount: '/' }),
      metric('disk_usage', 50, { mount: '/data' }),
      metric('disk_usage_root', 95),
    ];
    expect(aggregateServerDiskUsage(metrics)).toBe(40);
    expect(consumerValues(metrics)).toEqual([40, 40]);
  });
});
