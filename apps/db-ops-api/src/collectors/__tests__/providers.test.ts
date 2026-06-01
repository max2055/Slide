/**
 * Provider unit tests — structural contract verification
 *
 * Covers all 4 DB-specific providers from Plan 106-02 Task 1.
 * Cannot execute real DB queries; validates contract and structure.
 */
import { describe, it, expect } from 'vitest';
import { BaseMetricProvider } from '../base-provider.js';

describe('MySQLProvider', () => {
  it('should exist and extend BaseMetricProvider', async () => {
    const mod = await import('../mysql.provider.js');
    const provider = new mod.MySQLProvider();
    expect(provider).toBeInstanceOf(BaseMetricProvider);
    expect(provider.name).toBe('MySQL Provider');
    expect(provider.supportedDbTypes).toEqual(['mysql']);
    expect(typeof provider.collect).toBe('function');

    // collect returns number | null (call with null connection to test contract)
    const result = await provider.collect(null as any, { id: 'cpu_usage' } as any);
    // null pool → returns null gracefully
    expect(result).toBeNull();
  });

  it('should return null for unsupported metric IDs', async () => {
    const mod = await import('../mysql.provider.js');
    const provider = new mod.MySQLProvider();
    const result = await provider.collect(null as any, { id: 'nonexistent' } as any);
    expect(result).toBeNull();
  });

  it('should have describeSchema returning empty string', async () => {
    const mod = await import('../mysql.provider.js');
    const provider = new mod.MySQLProvider();
    const desc = await provider.describeSchema(1);
    expect(desc).toBe('');
  });
});

describe('PostgreSQLProvider', () => {
  it('should exist and extend BaseMetricProvider', async () => {
    const mod = await import('../postgresql.provider.js');
    const provider = new mod.PostgreSQLProvider();
    expect(provider).toBeInstanceOf(BaseMetricProvider);
    expect(provider.supportedDbTypes).toEqual(['postgresql']);
    expect(typeof provider.collect).toBe('function');

    const result = await provider.collect(null as any, { id: 'cpu_usage' } as any);
    expect(result).toBeNull();
  });
});

describe('OracleProvider', () => {
  it('should exist and extend BaseMetricProvider', async () => {
    const mod = await import('../oracle.provider.js');
    const provider = new mod.OracleProvider();
    expect(provider).toBeInstanceOf(BaseMetricProvider);
    expect(provider.supportedDbTypes).toEqual(['oracle']);
    expect(typeof provider.collect).toBe('function');

    const result = await provider.collect(null as any, { id: 'cpu_usage' } as any);
    expect(result).toBeNull();
  });
});

describe('DamengProvider', () => {
  it('should exist and extend BaseMetricProvider', async () => {
    const mod = await import('../dameng.provider.js');
    const provider = new mod.DamengProvider();
    expect(provider).toBeInstanceOf(BaseMetricProvider);
    expect(provider.supportedDbTypes).toEqual(['dameng']);
    expect(typeof provider.collect).toBe('function');

    const result = await provider.collect(null as any, { id: 'cpu_usage' } as any);
    expect(result).toBeNull();
  });
});
