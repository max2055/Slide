/**
 * Provider unit tests — structural contract verification
 *
 * Covers all 4 DB-specific providers from Plan 106-02 Task 1.
 * Cannot execute real DB queries; validates contract and structure.
 */
import { describe, it, expect, vi } from 'vitest';
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

  it('uses an independent baseline for handler scan rate', async () => {
    const { MySQLProvider } = await import('../mysql.provider.js');
    const provider = new MySQLProvider();
    let queries = 1_000;
    let handlerReads = 50_000_000;
    const instance = {
      pool: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("Variable_name IN ('Queries'")) return [[{ Variable_name: 'Queries', Value: String(queries) }]];
          return [[{ Variable_name: 'Handler_read_rnd_next', Value: String(handlerReads) }]];
        }),
      },
    } as any;
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(1_000);
    await provider.collect(instance, { id: 'qps' } as any);
    now.mockReturnValue(1_001);
    await expect(provider.collect(instance, { id: 'handler_read_rnd_next_rate' } as any)).resolves.toBe(0);

    queries += 60;
    now.mockReturnValue(60_000);
    await provider.collect(instance, { id: 'qps' } as any);
    handlerReads += 120;
    now.mockReturnValue(61_001);
    await expect(provider.collect(instance, { id: 'handler_read_rnd_next_rate' } as any)).resolves.toBe(2);
    now.mockRestore();
  });

  it('keeps QPS and TPS rate baselines independent', async () => {
    const { MySQLProvider } = await import('../mysql.provider.js');
    const provider = new MySQLProvider();
    let queries = 1_000;
    let commits = 2_000;
    let rollbacks = 100;
    const instance = {
      pool: {
        query: vi.fn(async (sql: string) => sql.includes("'Queries'")
          ? [[{ Variable_name: 'Queries', Value: String(queries) }]]
          : [[
              { Variable_name: 'Com_commit', Value: String(commits) },
              { Variable_name: 'Com_rollback', Value: String(rollbacks) },
            ]]),
      },
    } as any;
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(1_000);
    await expect(provider.collect(instance, { id: 'qps' } as any)).resolves.toBe(0);
    now.mockReturnValue(1_001);
    await expect(provider.collect(instance, { id: 'tps' } as any)).resolves.toBe(0);
    queries += 60;
    commits += 100;
    rollbacks += 20;
    now.mockReturnValue(61_000);
    await expect(provider.collect(instance, { id: 'qps' } as any)).resolves.toBe(1);
    now.mockReturnValue(61_001);
    await expect(provider.collect(instance, { id: 'tps' } as any)).resolves.toBe(2);
    now.mockRestore();
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
