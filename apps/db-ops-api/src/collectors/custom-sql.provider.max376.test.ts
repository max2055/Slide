/**
 * MAX-376 CustomSQLProvider uses the instance dialect before opening a query.
 * Connections here are fakes. Real PostgreSQL and MySQL evidence lives in
 * custom-sql-provider.max376.acceptance.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseConnection } from '../database-service.js';
import type { MetricDefinition } from '../metric-registry.js';
import { CustomSQLProvider } from './custom-sql.provider.js';

function metric(sql: string, dbType = 'postgresql', legacy = false): MetricDefinition & { collection_sql?: string } {
  const base: MetricDefinition & { collection_sql?: string } = {
    id: 'max376.custom',
    name: 'max376',
    description: '',
    unit: 'count',
    db_types: [dbType || 'mysql'],
    aggregation: 'last',
    default_interval: 60,
    is_collected: true,
    is_builtin: false,
  };
  if (legacy) base.collection_sql = sql;
  else base.collection_sqls = { [dbType]: sql };
  return base;
}

function connection(dbType: string, query: (sql: string) => Promise<unknown>): DatabaseConnection {
  return {
    id: 376,
    name: 'max376',
    config: { host: '127.0.0.1', port: 1, user: 'injected', password: 'injected', db_type: dbType },
    pool: dbType === 'mysql' ? { query } : null,
    pgClient: dbType === 'postgresql' ? { query } : null,
    oracleConnection: dbType === 'oracle' ? { execute: query } : null,
    oraclePool: null,
    dmConnection: dbType === 'dameng' ? { execute: query } : null,
    connected: true,
    db_type: dbType,
  } as DatabaseConnection & { calls?: string[] } as DatabaseConnection;
}

describe('MAX-376 CustomSQLProvider dialect', () => {
  let calls: string[];
  const provider = new CustomSQLProvider();

  beforeEach(() => {
    calls = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  function record(dbType: string) {
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (dbType === 'oracle' || dbType === 'dameng') return { rows: [[7]] };
      if (sql.startsWith('SET ')) return dbType === 'mysql' ? [[], []] : { rows: [] };
      return dbType === 'mysql' ? [[{ val: 7 }], []] : { rows: [{ val: 7 }] };
    });
    return { query, instance: connection(dbType, query) };
  }

  it('collects PostgreSQL syntax through the production provider entry', async () => {
    const { instance } = record('postgresql');
    const value = await provider.collect(instance, metric("SELECT COUNT(*) FROM samples WHERE name ILIKE 'a%'"));
    expect(value).toBe(7);
    expect(calls.some((sql) => sql.includes('ILIKE'))).toBe(true);
    expect(calls.some((sql) => sql.includes("statement_timeout"))).toBe(true);
  });

  it('prefers collection_sqls for the instance type and still accepts legacy collection_sql', async () => {
    const { instance } = record('postgresql');
    const definition = metric('SELECT 1', 'postgresql', true);
    definition.collection_sqls = { postgresql: "SELECT '42'::int" };
    await provider.collect(instance, definition);
    expect(calls.some((sql) => sql.includes("'42'::int"))).toBe(true);

    calls.length = 0;
    const legacy = metric('SELECT DISTINCT ON (id) id FROM samples', 'postgresql', true);
    await provider.collect(instance, legacy);
    expect(calls.some((sql) => sql.includes('DISTINCT ON'))).toBe(true);
  });

  it.each([
    'WITH x AS (INSERT INTO samples(id) VALUES (1) RETURNING id) SELECT id FROM x',
    'SELECT 1; INSERT INTO samples(id) VALUES (9)',
    'SELECT id FROM samples FOR UPDATE',
    'INSERT INTO samples(id) VALUES (9)',
  ])('does not send a rejected PostgreSQL statement: %s', async (sql) => {
    const { query, instance } = record('postgresql');
    await expect(provider.collect(instance, metric(sql))).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('does not execute when the instance type is missing or unknown', async () => {
    const { query, instance } = record('postgresql');
    const untyped = { ...instance, db_type: undefined } as unknown as DatabaseConnection;
    await expect(provider.collect(untyped, metric('SELECT 1', 'postgresql', true))).resolves.toBeNull();
    const unknown = { ...instance, db_type: 'mongodb' } as DatabaseConnection;
    await expect(provider.collect(unknown, metric('SELECT 1', 'mongodb', true))).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('still refuses a MySQL write and a backslash escape bypass before execution', async () => {
    const { query, instance } = record('mysql');
    await expect(provider.collect(instance, metric('INSERT INTO samples(id) VALUES (9)', 'mysql'))).resolves.toBeNull();
    await expect(provider.collect(instance, metric("SELECT 'a\\' , SLEEP(0) AS executed -- '", 'mysql'))).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['oracle', 'dameng'] as const)('does not execute PostgreSQL-only syntax on %s', async (dbType) => {
    const { query, instance } = record(dbType);
    await expect(provider.collect(instance, metric("SELECT * FROM t WHERE name ILIKE 'a%'", dbType))).resolves.toBeNull();
    await expect(provider.collect(instance, metric('UPDATE t SET id = 1', dbType))).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
