/**
 * MetricRegistry -- Oracle extension tests (GAP-01 / D-01, GAP-02 / D-02)
 *
 * Verifies:
 * - 8 built-in metrics include 'oracle' in their db_types (D-01)
 * - buffer_pool_hit_rate does NOT include 'oracle' (MySQL-specific)
 * - 3 new Oracle-specific metrics registered with correct config (D-02)
 */
import { describe, it, expect } from 'vitest';
import { metricRegistry } from '../metric-registry';

describe('MetricRegistry Oracle support', () => {
  describe('D-01: Oracle in 8 built-in metric db_types', () => {
    const oracleMetrics = metricRegistry.getByDbType('oracle');
    const oracleMetricIds = oracleMetrics.map((m) => m.id);

    const expectedBuiltinIds = [
      'cpu_usage',
      'memory_usage',
      'disk_usage',
      'connections',
      'qps',
      'tps',
      'slow_queries',
      'health_score',
    ];

    it.each(expectedBuiltinIds)('getByDbType("oracle") 应包含 %s', (id) => {
      expect(oracleMetricIds).toContain(id);
    });

    it('buffer_pool_hit_rate 不应包含 oracle (MySQL-specific)', () => {
      const bp = metricRegistry.getById('buffer_pool_hit_rate');
      expect(bp).not.toBeNull();
      expect(bp!.db_types).not.toContain('oracle');
    });
  });

  describe('D-02: 3 new Oracle-specific metrics', () => {
    it('tablespace_usage 指标配置正确', () => {
      const m = metricRegistry.getById('tablespace_usage');
      expect(m).not.toBeNull();
      expect(m!.unit).toBe('%');
      expect(m!.db_types).toEqual(['oracle']);
      expect(m!.aggregation).toBe('last');
    });

    it('sga_hit_rate 指标配置正确', () => {
      const m = metricRegistry.getById('sga_hit_rate');
      expect(m).not.toBeNull();
      expect(m!.unit).toBe('%');
      expect(m!.db_types).toEqual(['oracle']);
      expect(m!.aggregation).toBe('avg');
    });

    it('deadlock_count 指标配置正确', () => {
      const m = metricRegistry.getById('deadlock_count');
      expect(m).not.toBeNull();
      expect(m!.unit).toBe('count');
      expect(m!.db_types).toEqual(['oracle']);
      expect(m!.aggregation).toBe('max');
    });
  });
});
