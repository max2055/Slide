import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { randomBytes } from 'node:crypto';

const enabled = process.env.SLIDE_PG_READ_LIMIT_ACCEPTANCE === '1';

const mocks = vi.hoisted(() => ({
  ensureConnectionAlive: vi.fn(async () => true),
  getConnection: vi.fn(),
  auditSql: vi.fn(async () => undefined),
  authorizeApproval: vi.fn(async () => false),
  beginIntent: vi.fn(async () => undefined),
  finishIntent: vi.fn(async () => undefined),
}));

vi.mock('./database-service', () => ({
  databaseService: {
    ensureConnectionAlive: mocks.ensureConnectionAlive,
    getConnection: mocks.getConnection,
  },
}));

vi.mock('./audit/audit-log', () => ({
  auditLogManager: { logSqlExecution: mocks.auditSql },
}));

vi.mock('./db-connection', () => ({
  dbConnection: { getPool: vi.fn(() => ({})) },
}));

vi.mock('./security/approval-execution-authorizer', () => ({
  authorizeApprovedSqlExecution: mocks.authorizeApproval,
}));

vi.mock('./security/security-event-service', () => ({
  securityEventService: { record: async () => undefined },
}));

vi.mock('./audit/sql-execution-intent.js', () => ({
  sqlExecutionIntent: { begin: mocks.beginIntent, finish: mocks.finishIntent },
}));

import { sqlExecutor } from './sql-executor.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`SLIDE_PG_READ_LIMIT_ACCEPTANCE requires ${name}`);
  return value;
}

function redact(secret: string, error: unknown): string {
  return String(error instanceof Error ? error.stack ?? error.message : error).split(secret).join('[redacted]');
}

describe.skipIf(!enabled)('MAX-375 real PostgreSQL read-only wrapping', () => {
  const secret = enabled ? requiredEnv('SLIDE_PG_PASSWORD') : '';
  const config = enabled ? {
    host: requiredEnv('SLIDE_PG_HOST'),
    port: Number(requiredEnv('SLIDE_PG_PORT')),
    user: requiredEnv('SLIDE_PG_USER'),
    password: secret,
    database: requiredEnv('SLIDE_PG_DATABASE'),
    statement_timeout: 8_000,
    query_timeout: 8_000,
  } : undefined;
  const schemas: string[] = [];
  const clients: Client[] = [];

  function quoteIdent(value: string): string {
    if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('schema token is not a safe identifier');
    return `"${value}"`;
  }

  async function open(): Promise<Client> {
    const client = new Client(config);
    clients.push(client);
    try {
      await client.connect();
    } catch (error) {
      throw new Error(redact(secret, error));
    }
    return client;
  }

  function bind(client: Client) {
    mocks.getConnection.mockReturnValue({
      id: 37501,
      name: 'pg-test',
      db_type: 'postgresql',
      pgClient: client,
    });
  }

  async function ownedProbe(): Promise<string> {
    const name = `max375_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const admin = await open();
    await admin.query(`CREATE SCHEMA ${quoteIdent(name)}`);
    schemas.push(name);
    await admin.query(`CREATE TABLE ${quoteIdent(name)}.probe (id integer PRIMARY KEY, note text)`);
    await admin.query(
      `INSERT INTO ${quoteIdent(name)}.probe (id, note) SELECT g, 'row-' || g::text FROM generate_series(1, 1001) AS g`,
    );
    return name;
  }

  beforeEach(() => {
    mocks.ensureConnectionAlive.mockResolvedValue(true);
    mocks.authorizeApproval.mockReset();
    mocks.authorizeApproval.mockResolvedValue(false);
    mocks.auditSql.mockReset();
    mocks.auditSql.mockResolvedValue(undefined);
    mocks.beginIntent.mockReset();
    mocks.beginIntent.mockResolvedValue(undefined);
    mocks.finishIntent.mockReset();
    mocks.finishIntent.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const failures: string[] = [];
    for (const client of clients.splice(0)) {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end().catch((error) => { failures.push(redact(secret, error)); });
    }
    if (schemas.length && config) {
      const admin = new Client(config);
      try {
        await admin.connect();
        for (const name of schemas.splice(0)) {
          await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(name)} CASCADE`);
        }
      } catch (error) {
        failures.push(redact(secret, error));
      } finally {
        await admin.end().catch((error) => { failures.push(redact(secret, error)); });
      }
    }
    if (failures.length) throw new Error(failures.join('\n'));
  });

  async function count(schema: string): Promise<number> {
    const witness = await open();
    const result = await witness.query(`SELECT count(*)::int AS n FROM ${quoteIdent(schema)}.probe`);
    return Number(result.rows[0].n);
  }

  async function backendPid(client: Client): Promise<number> {
    const result = await client.query('SELECT pg_backend_pid() AS pid');
    return Number(result.rows[0].pid);
  }

  async function witnessActivity(pid: number): Promise<{ state: string; openXact: boolean }> {
    const witness = await open();
    const result = await witness.query(
      'SELECT state, xact_start IS NOT NULL AS open_xact FROM pg_stat_activity WHERE pid = $1',
      [pid],
    );
    if (result.rowCount !== 1) throw new Error(`pg_stat_activity returned ${result.rowCount} rows`);
    return { state: String(result.rows[0].state), openXact: result.rows[0].open_xact === true };
  }

  it('runs a trailing line comment, a normal select, and the owned table', async () => {
    const schema = await ownedProbe();
    const client = await open();
    bind(client);
    const pid = await backendPid(client);
    const commented = await sqlExecutor.executeSql(37501, 'SELECT 1 -- note;', { timeoutMs: 5_000 });
    expect(commented).toMatchObject({ success: true, rowCount: 1, truncated: false, rows: [{ '?column?': 1 }] });

    const plain = await sqlExecutor.executeSql(37501, 'SELECT 1;');
    expect(plain).toMatchObject({ success: true, rowCount: 1, truncated: false });

    const owned = await sqlExecutor.executeSql(37501, 'SELECT id FROM probe WHERE id <= 2 ORDER BY id -- note;', {
      database: schema,
      timeoutMs: 5_000,
    });
    expect(owned).toMatchObject({ success: true, truncated: false, rowCount: 2 });
    expect(owned.rows?.map((row) => row.id).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(await witnessActivity(pid)).toEqual({ state: 'idle', openXact: false });
    expect(mocks.auditSql).not.toHaveBeenCalled();
    expect(mocks.beginIntent).not.toHaveBeenCalled();
  });

  it('keeps literals, block comments, and a comment after the real terminator', async () => {
    const client = await open();
    bind(client);
    const pid = await backendPid(client);
    const cases = [
      ['SELECT 1 -- note', 1],
      ['SELECT 1 -- note\n', 1],
      ['SELECT 1 -- note\r', 1],
      ['SELECT 1 -- note\r\n', 1],
      ['SELECT 1 -- note\r;', 1],
      ['SELECT 1 -- note\r\n;', 1],
      ['SELECT 1;\r-- after', 1],
      ['SELECT 1; -- after', 1],
      ['SELECT 1; /* tail */', 1],
      ["SELECT ';'", ';'],
      ["SELECT E';'", ';'],
      ["SELECT 'it'';s;'", "it';s;"],
      ['SELECT 1 /* ; */', 1],
      ['SELECT 1;;', 1],
    ] as const;
    mocks.authorizeApproval.mockResolvedValue(true);
    const postgresOnly = [
      ['SELECT $$;$$', ';'],
      ['SELECT $tag$;$tag$', ';'],
      ['SELECT 1 /* outer /* ; */ still */', 1],
    ] as const;
    for (const [sql, expected] of cases) {
      const result = await sqlExecutor.executeSql(37501, sql, { timeoutMs: 5_000 });
      expect(result.success, result.error).toBe(true);
      expect(result.rowCount).toBe(1);
      expect(Object.values(result.rows?.[0] ?? {})[0]).toEqual(expected);
    }
    for (const [sql, expected] of postgresOnly) {
      const result = await sqlExecutor.executeSql(37501, sql, {
        timeoutMs: 5_000,
        approvalGrant: { approvalRequestId: 375, reviewerId: 2, operationId: `max375-${expected}` },
      });
      expect(result.success, `${sql} :: ${result.error}`).toBe(true);
      expect(result.rowCount).toBe(1);
      expect(Object.values(result.rows?.[0] ?? {})[0]).toEqual(expected);
    }
    expect(mocks.beginIntent).not.toHaveBeenCalled();
    expect(await witnessActivity(pid)).toEqual({ state: 'idle', openXact: false });
  });

  it('sees an intentionally unfinished read-only transaction from another session', async () => {
    const client = await open();
    const pid = await backendPid(client);
    await client.query('BEGIN READ ONLY');
    const weak = await client.query('SELECT txid_current_if_assigned() IS NULL AS released');
    expect(weak.rows[0].released).toBe(true);
    expect(await witnessActivity(pid)).toEqual({ state: 'idle in transaction', openXact: true });
    await client.query('ROLLBACK');
    expect(await witnessActivity(pid)).toEqual({ state: 'idle', openXact: false });
  });

  it('caps an owned table at 1000 rows and reports truncation', async () => {
    const schema = await ownedProbe();
    const client = await open();
    bind(client);
    const pid = await backendPid(client);
    const result = await sqlExecutor.executeSql(37501, 'SELECT id FROM probe ORDER BY id;', {
      database: schema,
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({ success: true, rowCount: 1000, truncated: true });
    const ids = (result.rows ?? []).map((row) => row.id);
    expect(new Set(ids).size).toBe(1000);
    expect(ids.every((id) => id >= 1 && id <= 1001)).toBe(true);
    expect(await count(schema)).toBe(1001);
    expect(await witnessActivity(pid)).toEqual({ state: 'idle', openXact: false });
  });

  it('cancels a long read and leaves the same session idle', async () => {
    const schema = await ownedProbe();
    const client = await open();
    bind(client);
    const pid = await backendPid(client);
    const started = Date.now();
    const timedOut = await sqlExecutor.executeSql(
      37501,
      'SELECT count(*) FROM probe a, probe b, probe c, probe d WHERE a.id <= 100 AND b.id <= 100 AND c.id <= 100 AND d.id <= 100',
      { database: schema, timeoutMs: 200 },
    );
    const elapsed = Date.now() - started;
    expect(timedOut.success).toBe(false);
    expect(timedOut.error).toMatch(/statement timeout/i);
    expect(elapsed).toBeLessThan(5_000);
    expect(await count(schema)).toBe(1001);
    expect(await witnessActivity(pid)).toEqual({ state: 'idle', openXact: false });

    const next = await sqlExecutor.executeSql(37501, 'SELECT count(*) FROM probe;', {
      database: schema,
      timeoutMs: 5_000,
    });
    expect(next).toMatchObject({ success: true, rowCount: 1 });
    expect(Number(Object.values(next.rows?.[0] ?? {})[0])).toBe(1001);
    expect(await witnessActivity(pid)).toEqual({ state: 'idle', openXact: false });
  });

  it('refuses a write and a second statement without changing the owned table', async () => {
    const schema = await ownedProbe();
    const client = await open();
    bind(client);
    const pid = await backendPid(client);
    mocks.authorizeApproval.mockResolvedValue(false);
    const write = await sqlExecutor.executeSql(37501, "DELETE FROM probe WHERE id = 1", {
      database: schema,
      approvalGrant: { approvalRequestId: 375, reviewerId: 2, operationId: 'max375-write' },
    });
    expect(write.success).toBe(false);
    const multi = await sqlExecutor.executeSql(37501, 'SELECT 1; DELETE FROM probe', {
      database: schema,
      approvalGrant: { approvalRequestId: 375, reviewerId: 2, operationId: 'max375-multi' },
    });
    expect(multi).toMatchObject({ success: false, error: 'SQL_STATEMENT_NOT_ALLOWED_MULTI_STATEMENT' });
    const splitByCr = await sqlExecutor.executeSql(37501, 'SELECT 1 -- note\r; DELETE FROM probe', {
      database: schema,
      timeoutMs: 5_000,
    });
    expect(splitByCr).toMatchObject({ success: false, error: 'SQL_STATEMENT_NOT_ALLOWED_MULTI_STATEMENT' });
    const codeAfterCr = await sqlExecutor.executeSql(37501, 'SELECT 1 -- note\r+ 2', { timeoutMs: 5_000 });
    expect(codeAfterCr.success, codeAfterCr.error).toBe(true);
    expect(Number(Object.values(codeAfterCr.rows?.[0] ?? {})[0])).toBe(3);
    expect(await count(schema)).toBe(1001);
    expect(mocks.beginIntent).not.toHaveBeenCalled();
    expect(mocks.auditSql).not.toHaveBeenCalled();
    expect(await witnessActivity(pid)).toEqual({ state: 'idle', openXact: false });
  });
});
