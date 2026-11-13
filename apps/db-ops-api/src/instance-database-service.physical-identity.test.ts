import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { splitSqlStatements } from './migrations/runner.js';

const migrationSql = readFileSync(
  resolve(import.meta.dirname, '../sql/migrations/153_instance_physical_occupancy.sql'),
  'utf8',
);

type SqlCall = { sql: string; params: unknown[] };

function duplicateEntry(key: string): Error {
  const error = new Error(`Duplicate entry '192.0.2.10' for key '${key}'`);
  Object.assign(error, { code: 'ER_DUP_ENTRY', errno: 1062, sqlMessage: error.message });
  return error;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    name: 'alpha',
    environment: 'development',
    db_type: 'mysql',
    host: '192.0.2.10',
    port: 33061,
    username: 'reader',
    password: 'secret',
    database_name: 'sales',
    ...overrides,
  };
}

function currentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: 'alpha',
    environment: 'development',
    db_type: 'mysql',
    host: '192.0.2.10',
    port: 33061,
    username: 'reader',
    password_encrypted: 'cipher',
    database_name: 'sales',
    connection_string: null,
    max_connections: 100,
    connection_timeout_ms: 30000,
    status: 'active',
    lifecycle_state: 'available',
    health_score: 0,
    health_status: 'unknown',
    last_health_check_at: null,
    db_version: null,
    data_size_gb: null,
    tags: null,
    description: 'stay',
    created_by: null,
    created_at: new Date('2026-11-10T00:00:00Z'),
    updated_at: new Date('2026-11-10T00:00:00Z'),
    ...overrides,
  };
}

describe('instance physical identity service rules', () => {
  let calls: SqlCall[];
  let occupants: Array<Record<string, unknown>>;
  let namesTaken: Array<Record<string, unknown>>;
  let current: Array<Record<string, unknown>>;
  let insertError: Error | null;
  let updateError: Error | null;

  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
    vi.stubEnv('NODE_ENV', 'test');
    calls = [];
    occupants = [];
    namesTaken = [];
    current = [currentRow()];
    insertError = null;
    updateError = null;
    const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const compact = sql.replace(/\s+/g, ' ');
      if (compact.includes('lifecycle_state <>')) return [occupants];
      if (compact.includes('WHERE name = ?')) return [namesTaken];
      if (compact.includes('WHERE id = ?') && compact.startsWith('SELECT')) return [current];
      if (compact.startsWith('INSERT')) {
        if (insertError) throw insertError;
        return [{ insertId: 42 }];
      }
      if (compact.startsWith('UPDATE')) {
        if (updateError) throw updateError;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected sql: ${compact}`);
    });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function statements(kind: 'occupant' | 'insert' | 'update'): SqlCall[] {
    return calls.filter((call) => {
      const compact = call.sql.replace(/\s+/g, ' ');
      if (kind === 'occupant') return compact.includes('lifecycle_state <>');
      if (kind === 'insert') return compact.startsWith('INSERT');
      return compact.startsWith('UPDATE');
    });
  }

  it('blocks an available occupant and keeps the duplicate key text off the client', async () => {
    occupants = [{ id: 3, name: 'holder', lifecycle_state: 'available' }];

    const result = await instanceDatabaseService.createInstance(input({ name: 'other', environment: 'testing' }));

    expect(result).toMatchObject({ success: false, instanceId: 3 });
    expect(result.error).toContain('ID: 3');
    expect(result.error).toContain('纳管');
    expect(result.error).not.toMatch(/Duplicate entry|ER_DUP_ENTRY/);
    expect(statements('insert')).toHaveLength(0);
  });

  it('blocks a deleting occupant without returning its id', async () => {
    occupants = [{ id: 4, name: 'going', lifecycle_state: 'deleting' }];

    const created = await instanceDatabaseService.createInstance(input({ name: 'while-deleting', environment: 'testing' }));
    expect(created.success).toBe(false);
    expect(created.instanceId).toBeUndefined();
    expect(created.error).toContain('正在删除');

    const updated = await instanceDatabaseService.updateInstance(7, { host: '192.0.2.11', database_name: 'sales' });
    expect(updated).toEqual({ success: false, error: expect.stringContaining('正在删除') });
    expect(statements('update')).toHaveLength(0);
  });

  it('asks for non-deleted occupants and passes a trailing space through unchanged', async () => {
    const created = await instanceDatabaseService.createInstance(input({ database_name: 'sales ' }));

    expect(created).toEqual({ success: true, instanceId: 42 });
    const lookup = statements('occupant')[0];
    expect(lookup.sql).toContain("lifecycle_state <> 'deleted'");
    expect(lookup.params).toEqual(['192.0.2.10', 33061, 'sales ']);
    expect(statements('insert')[0].params).toContain('sales ');
  });

  it('maps a lost create race to the business conflict', async () => {
    insertError = duplicateEntry('uk_instance_physical_occupancy');
    occupants = [];
    const execute = dbConnection.getPool()!.execute as ReturnType<typeof vi.fn>;
    execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const compact = sql.replace(/\s+/g, ' ');
      if (compact.includes('lifecycle_state <>')) {
        return [calls.filter((call) => call.sql.includes('lifecycle_state <>')).length === 1
          ? []
          : [{ id: 9, name: 'winner', lifecycle_state: 'available' }]];
      }
      if (compact.includes('WHERE name = ?')) return [[]];
      if (compact.startsWith('INSERT')) throw insertError;
      throw new Error(`unexpected sql: ${compact}`);
    });

    const created = await instanceDatabaseService.createInstance(input({ name: 'racer', environment: 'testing' }));
    expect(created).toMatchObject({ success: false, instanceId: 9 });
    expect(created.error).not.toMatch(/Duplicate entry|ER_DUP_ENTRY|SQL/);
  });

  it('excludes the row being updated when it keeps its own address', async () => {
    const updated = await instanceDatabaseService.updateInstance(7, { host: '192.0.2.10', database_name: 'sales' });

    expect(updated).toEqual({ success: true });
    const lookup = statements('occupant')[0];
    expect(lookup.sql).toContain('id <> ?');
    expect(lookup.sql).toContain("lifecycle_state <> 'deleted'");
    expect(lookup.params).toEqual(['192.0.2.10', 33061, 'sales', 7]);
  });

  it('maps a name collision without treating it as a physical address conflict', async () => {
    insertError = duplicateEntry('idx_name_environment');

    const result = await instanceDatabaseService.createInstance(input());

    expect(result).toEqual({ success: false, error: '该环境下实例名称已存在' });
  });

  it('rejects an update onto an occupied address before writing', async () => {
    occupants = [{ id: 3, name: 'holder', lifecycle_state: 'available' }];

    const result = await instanceDatabaseService.updateInstance(7, {
      host: '192.0.2.11',
      database_name: 'HELD',
      description: 'changed',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ID: 3');
    expect(result.error).not.toMatch(/Duplicate entry/);
    expect(statements('update')).toHaveLength(0);
    expect(statements('occupant')[0].params).toEqual(['192.0.2.11', 33061, 'HELD', 7]);
  });

  it('keeps the migration as one statement and bounds explicit repair', () => {
    const text = migrationSql.replace(/\s+/g, ' ');
    expect(splitSqlStatements(migrationSql)).toHaveLength(1);
    expect(text).not.toMatch(/remove only the duplicate occupying rows/i);
    expect(text).toMatch(/Do not delete historical rows, credentials, or references/);
    expect(text).toMatch(/approved identity or lifecycle change/);
    expect(text).toMatch(/Explicit repair is allowed only after the approved correction/);
    expect(text).toMatch(/neither generated column nor the unique index remains/);
    expect(text).toMatch(/Do not mark it completed and do not replay while it is failed/);
    expect(text).toMatch(/trailing spaces compare equal/);
  });
});
