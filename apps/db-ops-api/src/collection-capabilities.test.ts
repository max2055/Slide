/**
 * collection-capabilities 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { collectionCapabilityTracker } from './collection-capabilities.js';

// Mock metric-registry
vi.mock('./metric-registry.js', () => ({
  metricRegistry: {
    getByDbType: vi.fn(),
  },
}));

import { metricRegistry } from './metric-registry.js';

describe('CollectionCapabilityTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return expected-but-uncollected metrics as unavailable for new instance', () => {
    (metricRegistry.getByDbType as any).mockReturnValue([
      { id: 'cpu_usage', name: 'CPU 使用率（估算）', db_types: ['mysql'] },
      { id: 'memory_usage', name: '内存使用率（估算）', db_types: ['mysql'] },
      { id: 'connections', name: '活跃连接数', db_types: ['mysql'] },
    ]);

    const capabilities = collectionCapabilityTracker.getCapabilities(1, 'mysql');

    expect(capabilities).toHaveLength(3);
    for (const cap of capabilities) {
      expect(cap.available).toBe(false);
      expect(cap.lastAttempt).toBeUndefined();
    }
  });

  it('should show metric as available after successful collection', () => {
    (metricRegistry.getByDbType as any).mockReturnValue([
      { id: 'cpu_usage', name: 'CPU 使用率（估算）', db_types: ['mysql'] },
    ]);

    collectionCapabilityTracker.recordMetricAttempt(1, 'CPU 使用率（估算）', true);

    const capabilities = collectionCapabilityTracker.getCapabilities(1, 'mysql');
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0].available).toBe(true);
    expect(capabilities[0].lastAttempt).toBeDefined();
  });

  it('should remain unavailable after failed metric collection (never succeeded)', () => {
    (metricRegistry.getByDbType as any).mockReturnValue([
      { id: 'cpu_usage', name: 'CPU 使用率（估算）', db_types: ['mysql'] },
    ]);

    collectionCapabilityTracker.recordMetricAttempt(99, 'CPU 使用率（估算）', false);

    const capabilities = collectionCapabilityTracker.getCapabilities(99, 'mysql');
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0].available).toBe(false);
    expect(capabilities[0].lastAttempt).toBeDefined();
  });

  it('should filter capabilities by db_type (MySQL metrics not shown for PostgreSQL instance)', () => {
    (metricRegistry.getByDbType as any).mockImplementation((dbType: string) => {
      if (dbType === 'mysql') {
        return [{ id: 'buffer_pool_hit_rate', name: '缓冲池命中率', db_types: ['mysql'] }];
      }
      if (dbType === 'postgresql') {
        return [{ id: 'cache_hit_ratio', name: '缓冲命中率', db_types: ['postgresql'] }];
      }
      return [];
    });

    const mysqlCaps = collectionCapabilityTracker.getCapabilities(1, 'mysql');
    const pgCaps = collectionCapabilityTracker.getCapabilities(1, 'postgresql');

    expect(mysqlCaps).toHaveLength(1);
    expect(mysqlCaps[0].metricId).toBe('buffer_pool_hit_rate');

    expect(pgCaps).toHaveLength(1);
    expect(pgCaps[0].metricId).toBe('cache_hit_ratio');
  });

  it('should track separate attempt states for different instances', () => {
    (metricRegistry.getByDbType as any).mockReturnValue([
      { id: 'cpu_usage', name: 'CPU 使用率（估算）', db_types: ['mysql'] },
    ]);

    collectionCapabilityTracker.recordMetricAttempt(1, 'CPU 使用率（估算）', true);
    collectionCapabilityTracker.recordMetricAttempt(2, 'CPU 使用率（估算）', false);

    const instance1Caps = collectionCapabilityTracker.getCapabilities(1, 'mysql');
    const instance2Caps = collectionCapabilityTracker.getCapabilities(2, 'mysql');

    expect(instance1Caps[0].available).toBe(true);
    expect(instance2Caps[0].available).toBe(false);
  });
});
