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
import serverMetricProvider from '../server-metric-provider';

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

    it('health_score is computed outside metric providers', () => {
      expect(metricRegistry.getById('health_score')).toMatchObject({ is_collected: false });
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

describe('MetricRegistry server producer parity', () => {
  it('registers every metric name persisted by the Linux server collector', () => {
    const providerNames = serverMetricProvider.getDefinitions('RHEL 8')
      .map((definition) => definition.name)
      .filter((name) => name !== 'disk_detail' && name !== 'disk_usage');
    const persistedNames = [...providerNames, 'disk_usage'];
    const registeredNames = new Set(
      metricRegistry.getByTargetType('server').map((definition) => definition.id),
    );

    expect(persistedNames.filter((name) => !registeredNames.has(name))).toEqual([]);
  });
});

describe('MetricRegistry network-device support', () => {
  it('registers the bounded Huawei device and interface metric set under network_device', () => {
    const expected = [
      'device_uptime_seconds',
      'device_cpu_percent',
      'device_memory_percent',
      'device_temperature_celsius',
      'interface_oper_status',
      'interface_error_rate',
      'interface_drop_rate',
      'interface_in_bps',
      'interface_out_bps',
    ];
    expect(metricRegistry.getByTargetType('network_device').map((metric) => metric.id)).toEqual(expect.arrayContaining(expected));
    for (const id of expected) {
      expect(metricRegistry.getById(id, 'network_device')).toMatchObject({ id, target_type: 'network_device' });
    }
  });

  it('keeps same-named instance and network metrics distinct', () => {
    expect(metricRegistry.getById('cpu_usage', 'instance')?.target_type).toBeUndefined();
    expect(metricRegistry.getById('device_cpu_percent', 'instance')).toBeNull();
    expect(metricRegistry.getById('device_cpu_percent', 'network_device')).toBeTruthy();
  });
});
