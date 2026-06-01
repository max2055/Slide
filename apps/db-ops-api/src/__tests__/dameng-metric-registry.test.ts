/**
 * MetricRegistry -- Dameng extension tests
 *
 * Verifies:
 * - 7 built-in metrics include 'dameng' in their db_types
 * - slow_queries does NOT include 'dameng' (out of scope per D-06)
 * - buffer_pool_hit_rate does NOT include 'dameng' (MySQL-specific)
 */
import { describe, it, expect } from 'vitest';
import { metricRegistry } from '../metric-registry';

describe('MetricRegistry Dameng support', () => {
  const damengMetrics = metricRegistry.getByDbType('dameng');
  const damengMetricIds = damengMetrics.map((m) => m.id);

  const expectedDamengIds = [
    'cpu_usage',
    'memory_usage',
    'disk_usage',
    'connections',
    'qps',
    'tps',
    'health_score',
  ];

  it.each(expectedDamengIds)('getByDbType("dameng") 应包含 %s', (id) => {
    expect(damengMetricIds).toContain(id);
  });

  it('getByDbType("dameng") 应返回至少 7 个指标', () => {
    expect(damengMetrics.length).toBeGreaterThanOrEqual(7);
  });

  it('slow_queries 不应包含 dameng (per D-06)', () => {
    const sq = metricRegistry.getById('slow_queries');
    expect(sq).not.toBeNull();
    expect(sq!.db_types).not.toContain('dameng');
  });

  it('buffer_pool_hit_rate 不应包含 dameng (MySQL-specific)', () => {
    const bp = metricRegistry.getById('buffer_pool_hit_rate');
    expect(bp).not.toBeNull();
    expect(bp!.db_types).not.toContain('dameng');
  });
});
