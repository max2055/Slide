/**
 * Real Oracle transaction receipts for GitHub #284 and #1018.
 * Opt in with SLIDE_ORACLE_DML_INTEGRATION=1 and the private test resource manifest.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadTestResource } from '../../../scripts/qualification/test-resource-manifest.mjs';

const enabled = process.env.SLIDE_ORACLE_DML_INTEGRATION === '1';

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
vi.mock('./audit/audit-log', () => ({ auditLogManager: { logSqlExecution: mocks.auditSql } }));
vi.mock('./db-connection', () => ({ dbConnection: { getPool: () => ({}) } }));
vi.mock('./security/approval-execution-authorizer', () => ({
  authorizeApprovedSqlExecution: mocks.authorizeApproval,
}));
vi.mock('./security/security-event-service', () => ({ securityEventService: { record: async () => undefined } }));
vi.mock('./audit/sql-execution-intent.js', () => ({
  sqlExecutionIntent: { begin: mocks.beginIntent, finish: mocks.finishIntent },
}));

import oracledb from 'oracledb';
import { sqlExecutor } from './sql-executor.js';

const grant = { approvalRequestId: 284, reviewerId: 2, operationId: 'max361-oracle-visibility' };

function redact(password: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return password ? message.split(password).join('[redacted]') : message;
}

describe.skipIf(!enabled)('MAX-361 real Oracle DML visibility', () => {
  const suffix = randomBytes(6).toString('hex').toUpperCase();
  const dmlTable = `SLIDE_1018_DML_${suffix}`;
  const ddlTable = `SLIDE_1018_DDL_${suffix}`;
  let password = '';
  let pool: oracledb.Pool;
  let witness: oracledb.Connection;

  async function witnessNote(id: number): Promise<string | null> {
    const result = await witness.execute(
      `SELECT NOTE FROM ${dmlTable} WHERE ID = :id`,
      { id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const row = (result.rows ?? [])[0] as { NOTE?: string } | undefined;
    return row?.NOTE ?? null;
  }

  const executedSql: string[] = [];

  function usePool(mode: 'normal' | 'commit-fails' | 'connection-break' | 'commit-ack-lost' = 'normal') {
    mocks.getConnection.mockReturnValue({
      id: 361,
      name: 'oracle19c',
      db_type: 'oracle',
      oracleConnection: {},
      oraclePool: {
        getConnection: async () => {
          const connection = await pool.getConnection();
          const execute = connection.execute.bind(connection);
          connection.execute = (async (...args: Parameters<oracledb.Connection['execute']>) => {
            executedSql.push(String(args[0] ?? ''));
            return execute(...args);
          }) as oracledb.Connection['execute'];
          if (mode === 'commit-fails') {
            connection.commit = async () => {
              throw Object.assign(new Error('ORA-03113: end-of-file on communication channel'), { errorNum: 3113 });
            };
          } else if (mode === 'connection-break') {
            // Fault injection: call break(), then throw a synthetic NJS-500.
            // The TCP session is not cut, so this is not a real network partition.
            const close = connection.close.bind(connection);
            connection.close = () => close({ drop: true });
            connection.commit = async () => {
              if (typeof connection.break === 'function') await connection.break().catch(() => undefined);
              throw Object.assign(new Error('NJS-500: connection to the Oracle Database was broken'), { code: 'NJS-500' });
            };
          } else if (mode === 'commit-ack-lost') {
            // The real COMMIT finishes, then the driver acknowledgement is discarded.
            const commit = connection.commit.bind(connection);
            connection.commit = async () => {
              await commit();
              throw Object.assign(new Error('synthetic lost commit acknowledgement'), { code: 'SYNTHETIC_LOST_ACK' });
            };
          }
          return connection;
        },
      },
    });
  }

  async function readCommittedNote(): Promise<{ NOTE?: string }[]> {
    const deadline = Date.now() + 20_000;
    let attempts = 0;
    while (true) {
      attempts += 1;
      const readTable = await sqlExecutor.executeSql(361, `SELECT NOTE FROM ${dmlTable} WHERE ID = 1`);
      expect(pool.connectionsInUse).toBe(0);
      if (readTable.success) {
        if (attempts > 1) console.log(`ORA-01466 settled after ${attempts} read-only attempts`);
        return (readTable.rows ?? []) as { NOTE?: string }[];
      }
      const error = String(readTable.error ?? '');
      if (!error.includes('ORA-01466')) throw new Error(`read-only query failed: ${error}`);
      if (Date.now() >= deadline) throw new Error(`ORA-01466 remained after ${attempts} read-only attempts: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  it('checks Oracle DML receipts against visibility from a second session', async () => {
    const profile = loadTestResource({ enabled: true, resource: 'oracle-test' }).connection;
    if (typeof profile.service !== 'string' || !profile.service) throw new Error('ORACLE_TEST_SERVICE_REQUIRED');
    password = profile.password;
    const connectString = `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${profile.host})(PORT=${profile.port}))(CONNECT_DATA=(SERVICE_NAME=${profile.service})))`;
    try {
      pool = await oracledb.createPool({
        user: profile.user,
        password: profile.password,
        connectString,
        poolMin: 0,
        poolMax: 4,
      });
      witness = await oracledb.getConnection({ user: profile.user, password: profile.password, connectString });
      const setup = await pool.getConnection();
      try {
        await setup.execute(`CREATE TABLE ${dmlTable} (
          ID NUMBER PRIMARY KEY,
          NOTE VARCHAR2(64) CHECK (NOTE <> 'reject')
        )`);
        await setup.execute(`INSERT INTO ${dmlTable} (ID, NOTE) VALUES (1, 'before')`);
        await setup.commit();
      } finally {
        await setup.close();
      }
    } catch (error) {
      throw new Error(redact(password, error));
    }

    usePool();
    const updated = await sqlExecutor.executeSql(361, `UPDATE ${dmlTable} SET NOTE = 'after' WHERE ID = 1`, {
      approvalGrant: { ...grant, operationId: 'max361-update' },
    });
    expect(updated).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
    expect(await witnessNote(1)).toBe('after');
    expect(pool.connectionsInUse).toBe(0);

    usePool('commit-fails');
    const commitFailed = await sqlExecutor.executeSql(361, `UPDATE ${dmlTable} SET NOTE = 'invisible' WHERE ID = 1`, {
      approvalGrant: { ...grant, operationId: 'max361-commit-fail' },
    });
    expect(commitFailed).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(await witnessNote(1)).toBe('after');
    expect(pool.connectionsInUse).toBe(0);

    usePool('connection-break');
    const broken = await sqlExecutor.executeSql(361, `UPDATE ${dmlTable} SET NOTE = 'broken' WHERE ID = 1`, {
      approvalGrant: { ...grant, operationId: 'max361-break' },
    });
    expect(broken).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(await witnessNote(1)).toBe('after');
    expect(pool.connectionsInUse).toBe(0);

    const ackSql = `UPDATE ${dmlTable} SET NOTE = 'ack-lost-visible' WHERE ID = 1`;
    const ackMark = executedSql.length;
    const auditCallsBeforeLostAck = mocks.auditSql.mock.calls.length;
    usePool('commit-ack-lost');
    const lostAck = await sqlExecutor.executeSql(361, ackSql, {
      approvalGrant: { ...grant, operationId: 'max361-ack-lost' },
    });
    expect(executedSql.slice(ackMark).filter((sql) => sql === ackSql)).toHaveLength(1);
    expect(lostAck).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(mocks.finishIntent).toHaveBeenCalledWith(
      'max361-ack-lost',
      'unknown',
      expect.objectContaining({ targetAcknowledged: false, error: 'SQL_EXECUTION_OR_AUDIT_FAILED' }),
    );
    expect(mocks.auditSql.mock.calls.length).toBe(auditCallsBeforeLostAck);
    expect(await witnessNote(1)).toBe('ack-lost-visible');
    expect(pool.connectionsInUse).toBe(0);

    usePool();
    const restored = await sqlExecutor.executeSql(361, `UPDATE ${dmlTable} SET NOTE = 'after' WHERE ID = 1`, {
      approvalGrant: { ...grant, operationId: 'max361-restore' },
    });
    expect(restored).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
    expect(await witnessNote(1)).toBe('after');
    expect(pool.connectionsInUse).toBe(0);

    const rejected = await sqlExecutor.executeSql(361, `UPDATE ${dmlTable} SET NOTE = 'reject' WHERE ID = 1`, {
      approvalGrant: { ...grant, operationId: 'max361-reject' },
    });
    expect(rejected).toMatchObject({
      success: false, executionState: 'rolled_back', retryable: true, error: expect.stringContaining('ORA-02290'),
    });
    expect(mocks.finishIntent).toHaveBeenCalledWith('max361-reject', 'rolled_back', {
      targetAcknowledged: false, receipt: 'rolled_back',
    });
    expect(await witnessNote(1)).toBe('after');
    expect(pool.connectionsInUse).toBe(0);
    usePool();

    // DUAL has a stable definition, so it checks the read-only transaction and
    // pool release without the new-table dictionary race.
    const read = await sqlExecutor.executeSql(361, 'SELECT 1 AS ID FROM DUAL');
    expect(read).toMatchObject({ success: true, rowCount: 1 });
    expect(read.executionState).toBeUndefined();
    expect(pool.connectionsInUse).toBe(0);
    // SET TRANSACTION READ ONLY can raise ORA-01466 until Oracle can see the
    // new table's definition. Retry only that read; each attempt ends its own
    // transaction inside the executor. Any other error fails immediately.
    expect(await readCommittedNote()).toEqual([{ NOTE: 'after' }]);

    const created = await sqlExecutor.executeSql(361, `CREATE TABLE ${ddlTable} (ID INT)`, {
      approvalGrant: { ...grant, operationId: 'max361-ddl' },
    });
    expect(created).toMatchObject({ success: true, executionState: 'succeeded' });
    const ddl = await witness.execute(
      'SELECT COUNT(*) AS N FROM USER_TABLES WHERE TABLE_NAME = :name',
      { name: ddlTable },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    expect((ddl.rows?.[0] as { N?: string | number } | undefined)?.N).toEqual(expect.anything());
    const count = Number((ddl.rows?.[0] as { N: string | number }).N);
    expect(count).toBe(1);
  }, 90_000);

  afterAll(async () => {
    if (!enabled || !pool) return;
    try {
      const cleanup = await pool.getConnection();
      try {
        for (const table of [dmlTable, ddlTable]) {
          try {
            await cleanup.execute(`DROP TABLE ${table} PURGE`);
          } catch (error) {
            if ((error as { errorNum?: number }).errorNum !== 942) throw error;
          }
        }
      } finally {
        await cleanup.close();
      }
    } finally {
      try {
        await witness?.close();
      } finally {
        await pool.close(0);
      }
    }
  });
});
