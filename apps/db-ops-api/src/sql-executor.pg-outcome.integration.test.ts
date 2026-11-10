import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { randomBytes } from 'node:crypto';

const enabled = process.env.SLIDE_PG_OUTCOME_ACCEPTANCE === '1';

const mocks = vi.hoisted(() => ({
  ensureConnectionAlive: vi.fn(async () => true),
  getConnection: vi.fn(),
  auditSql: vi.fn(async () => undefined),
  authorizeApproval: vi.fn(async () => true),
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
  if (!value) throw new Error(`SLIDE_PG_OUTCOME_ACCEPTANCE requires ${name}`);
  return value;
}

function redact(secret: string, error: unknown): string {
  return String(error instanceof Error ? error.stack ?? error.message : error).split(secret).join('[redacted]');
}

describe.skipIf(!enabled)('MAX-374 real PostgreSQL outcome receipts', () => {
  const secret = enabled ? requiredEnv('SLIDE_PG_PASSWORD') : '';
  const config = enabled ? {
    host: requiredEnv('SLIDE_PG_HOST'),
    port: Number(requiredEnv('SLIDE_PG_PORT')),
    user: requiredEnv('SLIDE_PG_USER'),
    password: secret,
    database: requiredEnv('SLIDE_PG_DATABASE'),
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

  async function ownedSchema(): Promise<string> {
    const name = `max374_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const admin = await open();
    await admin.query(`CREATE SCHEMA ${quoteIdent(name)}`);
    schemas.push(name);
    await admin.query(`CREATE TABLE ${quoteIdent(name)}.probe (id integer PRIMARY KEY, note text)`);
    return name;
  }

  function bind(client: Client) {
    mocks.getConnection.mockReturnValue({
      id: 3740, name: 'pg-test', db_type: 'postgresql', pgClient: client,
    });
  }

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
    mocks.auditSql.mockReset();
    mocks.auditSql.mockResolvedValue(undefined);
    mocks.beginIntent.mockReset();
    mocks.beginIntent.mockResolvedValue(undefined);
    mocks.finishIntent.mockReset();
    mocks.finishIntent.mockResolvedValue(undefined);
    if (failures.length) throw new Error(failures.join('\n'));
  });

  async function count(schema: string): Promise<number> {
    const witness = await open();
    const result = await witness.query(`SELECT count(*)::int AS n FROM ${quoteIdent(schema)}.probe`);
    return Number(result.rows[0].n);
  }

  it('leaves no row when a statement fails and ROLLBACK completes', async () => {
    const schema = await ownedSchema();
    const client = await open();
    bind(client);
    const sql = "INSERT INTO probe (id, note) VALUES (1, 'a'), (1, 'b')";
    const result = await sqlExecutor.executeSql(3740, sql, {
      approvalGrant: { approvalRequestId: 374, reviewerId: 2, operationId: 'max374-rollback' },
      database: schema,
    });

    expect(result).toMatchObject({
      success: false,
      executionState: 'rolled_back',
      retryable: true,
      operationId: 'max374-rollback',
    });
    expect(result.error).not.toContain('SQL_OUTCOME_REQUIRES_RECONCILIATION');
    expect(await count(schema)).toBe(0);
    await expect(client.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    expect(mocks.finishIntent).toHaveBeenCalledWith('max374-rollback', 'rolled_back', expect.anything());
  });

  it('keeps a committed row visible after the audit log fails', async () => {
    const schema = await ownedSchema();
    const client = await open();
    bind(client);
    mocks.auditSql.mockRejectedValue(new Error('injected audit outage'));
    const sql = "INSERT INTO probe (id, note) VALUES (1, 'kept')";
    const result = await sqlExecutor.executeSql(3740, sql, {
      approvalGrant: { approvalRequestId: 374, reviewerId: 2, operationId: 'max374-commit' },
      database: schema,
    });

    expect(result).toMatchObject({
      success: true,
      executionState: 'succeeded',
      retryable: false,
      auditStatus: 'failed',
      auditError: 'AUDIT_LOG_FAILED',
    });
    expect(await count(schema)).toBe(1);
    mocks.beginIntent.mockRejectedValue(new Error('SQL_OPERATION_ALREADY_RECORDED_RECONCILE_DO_NOT_RETRY'));
    const replay = await sqlExecutor.executeSql(3740, "INSERT INTO probe (id, note) VALUES (2, 'replay')", {
      approvalGrant: { approvalRequestId: 374, reviewerId: 2, operationId: 'max374-commit' },
      database: schema,
    });
    expect(replay).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(await count(schema)).toBe(1);
  });

  it('stays unknown when the COMMIT or ROLLBACK receipt is lost', async () => {
    const schema = await ownedSchema();
    const commitClient = await open();
    const realCommitQuery = commitClient.query.bind(commitClient);
    let commitForwarded = false;
    commitClient.query = (async (sql: string, values?: unknown[]) => {
      if (sql === 'COMMIT') throw new Error('EPIPE');
      commitForwarded ||= sql.startsWith('INSERT');
      return realCommitQuery(sql, values as never);
    }) as typeof commitClient.query;
    bind(commitClient);
    const committed = await sqlExecutor.executeSql(3740, "INSERT INTO probe (id, note) VALUES (1, 'hidden')", {
      approvalGrant: { approvalRequestId: 374, reviewerId: 2, operationId: 'max374-commit-unknown' },
      database: schema,
    });
    expect(commitForwarded).toBe(true);
    expect(committed).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(committed.error).toContain('do not retry');
    expect(mocks.finishIntent).toHaveBeenCalledWith('max374-commit-unknown', 'unknown', expect.anything());
    expect(await count(schema)).toBe(0);

    const rollbackClient = await open();
    const realRollbackQuery = rollbackClient.query.bind(rollbackClient);
    rollbackClient.query = (async (sql: string, values?: unknown[]) => {
      if (sql === 'ROLLBACK') throw new Error('EPIPE');
      return realRollbackQuery(sql, values as never);
    }) as typeof rollbackClient.query;
    bind(rollbackClient);
    const rolled = await sqlExecutor.executeSql(3740, "INSERT INTO probe (id, note) VALUES (1, 'a'), (1, 'b')", {
      approvalGrant: { approvalRequestId: 374, reviewerId: 2, operationId: 'max374-rollback-unknown' },
      database: schema,
    });
    expect(rolled).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(mocks.finishIntent).toHaveBeenCalledWith('max374-rollback-unknown', 'unknown', expect.anything());
    await rollbackClient.end().catch(() => undefined);
    expect(await count(schema)).toBe(0);
  });

  it('does not send the user statement when BEGIN fails, and the session stays usable', async () => {
    const schema = await ownedSchema();
    const client = await open();
    const realQuery = client.query.bind(client);
    const calls: string[] = [];
    client.query = (async (sql: string, values?: unknown[]) => {
      calls.push(sql);
      if (sql === 'BEGIN') throw new Error('ECONNREFUSED');
      return realQuery(sql, values as never);
    }) as typeof client.query;
    bind(client);
    const result = await sqlExecutor.executeSql(3740, "INSERT INTO probe (id, note) VALUES (1, 'early')", {
      approvalGrant: { approvalRequestId: 374, reviewerId: 2, operationId: 'max374-before' },
      database: schema,
    });

    expect(calls).toEqual(['BEGIN']);
    expect(result).toMatchObject({
      success: false,
      executionState: 'not_executed',
      retryable: true,
      error: 'ECONNREFUSED',
    });
    expect(await count(schema)).toBe(0);
    client.query = realQuery;
    await expect(client.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });
});
