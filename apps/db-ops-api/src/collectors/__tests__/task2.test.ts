/**
 * Task 2 tests: CustomSQLProvider + collectorRegistry
 *
 * Plan 106-02 Task 2 TDD — RED phase (tests fail until implementation exists)
 */
import { describe, it, expect } from 'vitest';

describe('CustomSQLProvider', () => {
  it('should exist and extend BaseMetricProvider', async () => {
    const mod = await import('../custom-sql.provider.js');
    const provider = new mod.CustomSQLProvider();
    const { BaseMetricProvider } = await import('../base-provider.js');
    expect(provider).toBeInstanceOf(BaseMetricProvider);
    expect(provider.name).toBe('Custom SQL Provider');
    expect(provider.supportedDbTypes).toContain('mysql');
    expect(provider.supportedDbTypes).toContain('postgresql');
    expect(provider.supportedDbTypes).toContain('oracle');
    expect(provider.supportedDbTypes).toContain('dameng');
  });

  it('should return null for null/empty collection_sql', async () => {
    const mod = await import('../custom-sql.provider.js');
    const provider = new mod.CustomSQLProvider();
    const result = await provider.collect(null as any, { id: 'test', collection_sql: null } as any);
    expect(result).toBeNull();
    const result2 = await provider.collect(null as any, { id: 'test2', collection_sql: '' } as any);
    expect(result2).toBeNull();
  });
});

describe('collectorRegistry singleton', () => {
  it('should be a Registry<MetricProvider> instance', async () => {
    const mod = await import('../registry.js');
    const { collectorRegistry } = mod;
    expect(collectorRegistry).toBeDefined();
    expect(typeof collectorRegistry.register).toBe('function');
    expect(typeof collectorRegistry.getProvidersByDbType).toBe('function');
  });
});
