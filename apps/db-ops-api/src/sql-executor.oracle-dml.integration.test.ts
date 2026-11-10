/**
 * Real Oracle visibility for MAX-361 / GitHub #284.
 * Opt in with SLIDE_ORACLE_DML_INTEGRATION=1. Credentials stay in the local
 * profile and are never written to assertions or logs.
 */
import fs from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

const enabled = process.env.SLIDE_ORACLE_DML_INTEGRATION === '1';
const profilePath = process.env.SLIDE_ORACLE_PROFILE
  ?? '/Users/max/.config/slide-test-access/connection-profiles.json';

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
  let password = '';
  let pool: oracledb.Pool;
  let witness: oracledb.Connection;

  async function witnessNote(id: number): Promise<string | null> {
    const result = await witness.execute(
      'SELECT NOTE FROM SLIDE_MAX361_DML WHERE ID = :id',
      { id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const row = (result.rows ?? [])[0] as { NOTE?: string } | undefined;
    return row?.NOTE ?? null;
  }

  function usePool(mode: 'normal' | 'commit-fails' | 'connection-break' = 'normal') {
    mocks.getConnection.mockReturnValue({
      id: 361,
      name: 'oracle19c',
      db_type: 'oracle',
      oracleConnection: {},
      oraclePool: {
        getConnection: async () => {
          const connection = await pool.getConnection();
          if (mode === 'commit-fails') {
            connection.commit = async () => {
              throw Object.assign(new Error('ORA-03113: end-of-file on communication channel'), { errorNum: 3113 });
            };
          } else if (mode === 'connection-break') {
            const close = connection.close.bind(connection);
            connection.close = () => close({ drop: true });
            connection.commit = async () => {
              if (typeof connection.break === 'function') await connection.break().catch(() => undefined);
              throw Object.assign(new Error('NJS-500: connection to the Oracle Database was broken'), { code: 'NJS-500' });
            };
          }
          return connection;
        },
      },
    });
  }

  it('commits an approved UPDATE that another Oracle session can read', async () => {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'))['oracle-test'] as {
      host: string; port: number; user: string; password: string; service: string;
    };
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
        await setup.execute(`
          BEGIN
            EXECUTE IMMEDIATE 'DROP TABLE SLIDE_MAX361_DML PURGE';
          EXCEPTION WHEN OTHERS THEN
            IF SQLCODE != -942 THEN RAISE; END IF;
          END;`);
        await setup.execute(`
          BEGIN
            EXECUTE IMMEDIATE 'DROP TABLE SLIDE_MAX361_DDL PURGE';
          EXCEPTION WHEN OTHERS THEN
            IF SQLCODE != -942 THEN RAISE; END IF;
          END;`);
        await setup.execute(`CREATE TABLE SLIDE_MAX361_DML (
          ID NUMBER PRIMARY KEY,
          NOTE VARCHAR2(64),
          CONSTRAINT SLIDE_MAX361_NOTE_CK CHECK (NOTE <> 'reject')
        )`);
        await setup.execute(`INSERT INTO SLIDE_MAX361_DML (ID, NOTE) VALUES (1, 'before')`);
        await setup.commit();
      } finally {
        await setup.close();
      }
    } catch (error) {
      throw new Error(redact(password, error));
    }

    usePool();
    const updated = await sqlExecutor.executeSql(361, `UPDATE SLIDE_MAX361_DML SET NOTE = 'after' WHERE ID = 1`, {
      approvalGrant: { ...grant, operationId: 'max361-update' },
    });
    expect(updated).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
    expect(await witnessNote(1)).toBe('after');
    expect(pool.connectionsInUse).toBe(0);

    usePool('commit-fails');
    const commitFailed = await sqlExecutor.executeSql(361, `UPDATE SLIDE_MAX361_DML SET NOTE = 'invisible' WHERE ID = 1`, {
      approvalGrant: { ...grant, operationId: 'max361-commit-fail' },
    });
    expect(commitFailed).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(await witnessNote(1)).toBe('after');
    expect(pool.connectionsInUse).toBe(0);

    usePool('connection-break');
    const broken = await sqlExecutor.executeSql(361, `UPDATE SLIDE_MAX361_DML SET NOTE = 'broken' WHERE ID = 1`, {
      approvalGrant: { ...grant, operationId: 'max361-break' },
    });
    expect(broken).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(await witnessNote(1)).toBe('after');

    let statementError = '';
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
            try {
              return await execute(...args);
            } catch (error) {
              statementError = redact(password, error);
              throw error;
            }
          }) as oracledb.Connection['execute'];
          return connection;
        },
      },
    });
    const rejected = await sqlExecutor.executeSql(361, `UPDATE SLIDE_MAX361_DML SET NOTE = 'reject' WHERE ID = 1`, {
      approvalGrant: { ...grant, operationId: 'max361-reject' },
    });
    expect(statementError).toContain('ORA-02290');
    expect(rejected).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(await witnessNote(1)).toBe('after');
    usePool();

    // A table created moments earlier raises ORA-01466 inside SET TRANSACTION
    // READ ONLY. DUAL has a stable definition, so it checks the real read-only
    // transaction and pool release without that dictionary race.
    const read = await sqlExecutor.executeSql(361, 'SELECT 1 AS ID FROM DUAL');
    expect(read).toMatchObject({ success: true, rowCount: 1 });
    expect(read.executionState).toBeUndefined();
    expect(pool.connectionsInUse).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const readTable = await sqlExecutor.executeSql(361, 'SELECT NOTE FROM SLIDE_MAX361_DML WHERE ID = 1');
    expect(readTable).toMatchObject({ success: true, rows: [{ NOTE: 'after' }] });
    expect(pool.connectionsInUse).toBe(0);

    const created = await sqlExecutor.executeSql(361, 'CREATE TABLE SLIDE_MAX361_DDL (ID INT)', {
      approvalGrant: { ...grant, operationId: 'max361-ddl' },
    });
    expect(created).toMatchObject({ success: true, executionState: 'succeeded' });
    const ddl = await witness.execute(
      `SELECT COUNT(*) AS N FROM USER_TABLES WHERE TABLE_NAME = 'SLIDE_MAX361_DDL'`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    expect((ddl.rows?.[0] as { N?: string | number } | undefined)?.N).toEqual(expect.anything());
    const count = Number((ddl.rows?.[0] as { N: string | number }).N);
    expect(count).toBe(1);
  }, 60_000);

  afterAll(async () => {
    if (!enabled || !pool) return;
    const cleanup = await pool.getConnection().catch(() => null);
    if (cleanup) {
      for (const table of ['SLIDE_MAX361_DML', 'SLIDE_MAX361_DDL']) {
        await cleanup.execute(`
          BEGIN
            EXECUTE IMMEDIATE 'DROP TABLE ${table} PURGE';
          EXCEPTION WHEN OTHERS THEN
            IF SQLCODE != -942 THEN RAISE; END IF;
          END;`).catch(() => undefined);
      }
      await cleanup.close().catch(() => undefined);
    }
    await witness?.close().catch(() => undefined);
    await pool.close(0).catch(() => undefined);
  });
});
