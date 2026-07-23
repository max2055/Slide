import { describe, expect, it } from 'vitest';
import { MetricRegistry } from '../src/metric-registry.js';
import { normalizeMetricIdentity } from '../src/resources/observation-service.js';

describe('canonical metric identity', () => {
  it('uses resource type rather than a server prefix to disambiguate cpu and disk metrics', () => {
    const registry = new MetricRegistry();
    expect(registry.getById('cpu_usage', 'instance')).toMatchObject({ id: 'cpu_usage' });
    expect(registry.getById('cpu_usage', 'server')).toMatchObject({ id: 'cpu_usage', target_type: 'server' });
    expect(registry.getById('server_cpu_usage', 'server')).toBeNull();
  });

  it('normalizes historical disk suffixes into a canonical id and mount dimension', () => {
    expect(normalizeMetricIdentity('disk_usage_/var/lib/mysql')).toEqual({
      metricId: 'disk_usage', dimensions: { mount: '/var/lib/mysql' },
    });
    expect(normalizeMetricIdentity('server_memory_usage')).toEqual({ metricId: 'memory_usage' });
  });
});
