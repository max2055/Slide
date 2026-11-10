/**
 * Real Dameng ownership for MAX-367 / GitHub #385.
 * Opt in with SLIDE_DAMENG_OWNERSHIP_INTEGRATION=1.
 *
 * The Dameng session, server timeout (-608) and schema switch are real.
 * Approval authorization and the durable intent store are stubbed and labeled
 * below; they still belong to the platform MySQL path and are not re-proven here.
 * sql_execution_history uses the real audit manager and, when 3306 accepts the
 * writer, the real DatabaseAuditLogStore. Credentials are never asserted or logged.
 */
import fs from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

const enabled = process.env.SLIDE_DAMENG_OWNERSHIP_INTEGRATION === '1';
const profilePath = process.env.SLIDE_CONNECTION_PROFILES
  ?? '/Users/max/.config/slide-test-access/connection-profiles.json';

const mocks = vi.hoisted(() => ({
  ensureConnectionAlive: vi.fn(async () => true),
  getConnection: vi.fn(),
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
vi.mock('./db-connection', () => ({ dbConnection: { getPool: () => ({}) } }));
vi.mock('./security/approval-execution-authorizer', () => ({
  authorizeApprovedSqlExecution: mocks.authorizeApproval,
}));
vi.mock('./security/security-event-service', () => ({ securityEventService: { record: async () => undefined } }));
vi.mock('./audit/sql-execution-intent.js', () => ({
  sqlExecutionIntent: { begin: mocks.beginIntent, finish: mocks.finishIntent },
}));

import dmdb from 'dmdb';
import mysql from 'mysql2/promise';
import { auditLogManager, DatabaseAuditLogStore, memoryAuditLogStore } from './audit/audit-log.js';
import { sqlExecutor } from './sql-executor.js';

const grant = { approvalRequestId: 385, reviewerId: 2, operationId: 'max367-dameng-visibility' };
const instanceId = 36701;

function redact(secret: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return secret ? message.split(secret).join('[redacted]') : message;
}

describe.skipIf(!enabled)('MAX-367 real Dameng execution ownership', () => {
  let secret = '';
  let session: dmdb.Connection;
  let witness: dmdb.Connection;
  const marks: { sql: string; at: number }[] = [];
  const startedAt = Date.now();

  async function witnessRows(sql: string): Promise<unknown[][]> {
    const result = await witness.execute(sql, [], { maxRows: 20, autoCommit: true });
    return (result.rows ?? []) as unknown[][];
  }

  afterAll(async () => {
    if (!session) return;
    for (const sql of [
      'DROP VIEW SLIDE_MAX367_HOLD',
      'DROP VIEW SLIDE_MAX367_HOLD_B',
      'DROP VIEW SLIDE_MAX367_SLOW',
      'DROP TABLE SLIDE_MAX367_DML',
      'DROP TABLE SLIDE_MAX367_R1',
      'DROP TABLE SLIDE_MAX367.SLIDE_MAX367_VIS',
      'DROP SCHEMA SLIDE_MAX367',
      'DROP FUNCTION SLIDE_MAX367_BURN',
    ]) {
      await session.execute(sql).catch(() => undefined);
    }
    await session.close().catch(() => undefined);
    await witness?.close().catch(() => undefined);
  });

  it('serializes one session, cancels by the driver session timeout, and does not replay a timed-out write', async () => {
    const profiles = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const dameng = profiles['dameng-test'];
    secret = String(dameng.password);
    const connect = () => dmdb.getConnection({
      user: dameng.user,
      password: dameng.password,
      connectString: `${dameng.host}:${dameng.port}`,
      connectTimeout: 5000,
      loginEncrypt: false,
      sessionTimeout: 15,
      socketTimeout: 30_000,
    });
    try {
      session = await connect();
      witness = await connect();
    } catch (error) {
      throw new Error(redact(secret, error));
    }
    const driverSession = session as dmdb.Connection & { conn_prop_sessionTimeout?: number; conn_prop_socketTimeout?: number };
    expect(driverSession.conn_prop_sessionTimeout).toBe(15);

    const execute = session.execute.bind(session);
    const rollback = session.rollback.bind(session);
    let pauseAfterSql = '';
    let pausedSql = '';
    let releasePause: (() => void) | null = null;
    session.execute = (async (...args: Parameters<dmdb.Connection['execute']>) => {
      const text = String(args[0] ?? '');
      marks.push({ sql: text.slice(0, 120), at: Date.now() - startedAt });
      const result = await execute(...args);
      if (pauseAfterSql && text === pauseAfterSql) {
        pausedSql = text;
        await new Promise<void>((resolve) => { releasePause = resolve; });
      }
      return result;
    }) as dmdb.Connection['execute'];
    session.rollback = (async () => {
      marks.push({ sql: 'rollback', at: Date.now() - startedAt });
      return rollback();
    }) as dmdb.Connection['rollback'];
    mocks.getConnection.mockReturnValue({
      id: instanceId, name: 'dameng-test', db_type: 'dameng', dmConnection: session, connected: true,
    });
    // Production checkConnectionAlive uses this exact call, including default autoCommit.
    mocks.ensureConnectionAlive.mockImplementation(async () => {
      await session.execute('SELECT 1 FROM DUAL');
      return true;
    });

    for (const sql of [
      'DROP VIEW SLIDE_MAX367_HOLD',
      'DROP VIEW SLIDE_MAX367_HOLD_B',
      'DROP VIEW SLIDE_MAX367_SLOW',
      'DROP TABLE SLIDE_MAX367_DML',
      'DROP TABLE SLIDE_MAX367_R1',
      'DROP TABLE SLIDE_MAX367.SLIDE_MAX367_VIS',
      'DROP SCHEMA SLIDE_MAX367',
      'DROP FUNCTION SLIDE_MAX367_BURN',
    ]) {
      await session.execute(sql).catch(() => undefined);
    }
    await session.execute(`
      CREATE OR REPLACE FUNCTION SLIDE_MAX367_BURN(N INT) RETURN INT IS
        I INT := 0;
        X INT := 0;
      BEGIN
        WHILE I < N LOOP
          X := X + 1;
          I := I + 1;
        END LOOP;
        RETURN X;
      END`);
    await session.execute('CREATE VIEW SLIDE_MAX367_HOLD AS SELECT SLIDE_MAX367_BURN(12000000) AS ID FROM DUAL');
    await session.execute('CREATE VIEW SLIDE_MAX367_HOLD_B AS SELECT SLIDE_MAX367_BURN(12000000) AS ID FROM DUAL');
    await session.execute('CREATE VIEW SLIDE_MAX367_SLOW AS SELECT SLIDE_MAX367_BURN(40000000) AS ID FROM DUAL');
    await session.execute('CREATE TABLE SLIDE_MAX367_DML(ID INT, NOTE VARCHAR(40))');
    await session.execute('CREATE SCHEMA SLIDE_MAX367');
    await session.execute('CREATE TABLE SLIDE_MAX367.SLIDE_MAX367_VIS(ID INT)');
    await session.execute('INSERT INTO SLIDE_MAX367.SLIDE_MAX367_VIS(ID) VALUES (7)');

    const slow = 'SELECT ID FROM SLIDE_MAX367_HOLD';
    const slowNext = 'SELECT ID FROM SLIDE_MAX367_HOLD_B';
    const first = sqlExecutor.executeSql(instanceId, slow, { timeoutMs: 15_000, userId: '367', username: 'max367-audit' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = sqlExecutor.executeSql(instanceId, slowNext, { timeoutMs: 15_000, userId: '367', username: 'max367-audit' });
    const queued = await Promise.all([first, second]);
    expect(queued.map((item) => item.success)).toEqual([true, true]);
    const firstSql = marks.findIndex((mark) => mark.sql === slow);
    const firstRollback = marks.findIndex((mark, index) => index > firstSql && mark.sql === 'rollback');
    const secondSql = marks.findIndex((mark) => mark.sql === slowNext);
    expect(firstSql).toBeGreaterThanOrEqual(0);
    expect(firstRollback).toBeGreaterThan(firstSql);
    expect(secondSql).toBeGreaterThan(firstRollback);
    expect(marks[secondSql].at).toBeGreaterThanOrEqual(marks[firstRollback].at);
    expect(marks.some((mark) => mark.sql === 'SET TRANSACTION READ ONLY')).toBe(true);
    const probeAt = marks
      .map((mark, index) => mark.sql === 'SELECT 1 FROM DUAL' ? index : -1)
      .filter((index) => index >= 0);
    expect(probeAt.length).toBeGreaterThanOrEqual(2);
    expect(probeAt[1]).toBeGreaterThan(firstRollback);

    const timed = Date.now();
    const timeout = await sqlExecutor.executeSql(
      instanceId,
      'SELECT ID FROM SLIDE_MAX367_SLOW',
      { timeoutMs: 1000, userId: '367', username: 'max367-audit' },
    );
    expect(timeout.success).toBe(false);
    expect(timeout.error).toContain('请求执行超时');
    expect(Date.now() - timed).toBeLessThan(8_000);
    expect(driverSession.conn_prop_sessionTimeout).toBe(15);
    const alive = await sqlExecutor.executeSql(instanceId, 'SELECT 1 AS MAX367_AUDIT FROM DUAL', {
      timeoutMs: 15_000, userId: '367', username: 'max367-audit',
    });
    expect(alive).toMatchObject({ success: true, rowCount: 1 });

    const missing = await sqlExecutor.executeSql(instanceId, 'SELECT ID FROM SLIDE_MAX367_MISSING', {
      timeoutMs: 1000, userId: '367', username: 'max367-audit',
    });
    expect(missing.success).toBe(false);
    const recovered = await sqlExecutor.executeSql(instanceId, 'SELECT 2 FROM DUAL', { timeoutMs: 1000 });
    expect(recovered.success).toBe(true);

    const committed = await sqlExecutor.executeSql(
      instanceId,
      "INSERT INTO SLIDE_MAX367_DML(ID, NOTE) SELECT 1, 'committed' FROM DUAL",
      { approvalGrant: grant, timeoutMs: 15_000, userId: '367', username: 'max367-audit' },
    );
    expect(committed).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
    expect(await witnessRows("SELECT NOTE FROM SLIDE_MAX367_DML WHERE NOTE = 'committed'")).toEqual([['committed']]);

    const lost = await sqlExecutor.executeSql(
      instanceId,
      "INSERT INTO SLIDE_MAX367_DML(ID, NOTE) SELECT SLIDE_MAX367_BURN(40000000), 'slow' FROM DUAL",
      { approvalGrant: { ...grant, operationId: 'max367-timeout' }, timeoutMs: 1000, userId: '367', username: 'max367-audit' },
    );
    expect(lost).toMatchObject({ success: false, executionState: 'unknown', retryable: false, operationId: 'max367-timeout' });
    expect(lost.executionState).not.toBe('not_started');
    expect(mocks.finishIntent).toHaveBeenCalledWith('max367-timeout', 'unknown', expect.objectContaining({ targetAcknowledged: false }));
    expect(await witnessRows("SELECT NOTE FROM SLIDE_MAX367_DML WHERE NOTE = 'slow'")).toEqual([]);
    const userStatements = marks.filter((mark) => mark.sql.includes("'slow'"));
    expect(userStatements).toHaveLength(1);

    const visible = await sqlExecutor.executeSql(instanceId, 'SELECT ID FROM SLIDE_MAX367_VIS', {
      database: 'SLIDE_MAX367', timeoutMs: 5000,
    });
    expect(visible).toMatchObject({ success: true, rows: [{ ID: 7 }] });
    const restored = await sqlExecutor.executeSql(instanceId, 'SELECT ID FROM SLIDE_MAX367_VIS', { timeoutMs: 5000 });
    expect(restored.success).toBe(false);
    expect(driverSession.conn_prop_sessionTimeout).toBe(15);
    expect(driverSession.conn_prop_socketTimeout).toBe(30_000);

    await session.execute('CREATE TABLE SLIDE_MAX367_R1(ID INT)');
    await session.execute('INSERT INTO SLIDE_MAX367_R1(ID) VALUES (1)', [], { autoCommit: true });
    expect(await witnessRows('SELECT ID FROM SLIDE_MAX367_R1')).toEqual([[1]]);
    const updateSql = 'UPDATE SLIDE_MAX367_R1 SET ID = 2';
    pauseAfterSql = updateSql;
    const probeBaseline = marks.filter((mark) => mark.sql === 'SELECT 1 FROM DUAL').length;
    const updating = sqlExecutor.executeSql(instanceId, updateSql, {
      approvalGrant: { ...grant, operationId: 'max367-r1-visibility' }, timeoutMs: 15_000,
    });
    let overlapping: ReturnType<typeof sqlExecutor.executeSql> | undefined;
    try {
      const updateStarted = Date.now();
      while (pausedSql !== updateSql && Date.now() - updateStarted < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(pausedSql).toBe(updateSql);
      expect(await witnessRows('SELECT ID FROM SLIDE_MAX367_R1')).toEqual([[1]]);
      overlapping = sqlExecutor.executeSql(instanceId, 'SELECT ID FROM SLIDE_MAX367_R1', { timeoutMs: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(marks.filter((mark) => mark.sql === 'SELECT 1 FROM DUAL')).toHaveLength(probeBaseline + 1);
      expect(await witnessRows('SELECT ID FROM SLIDE_MAX367_R1')).toEqual([[1]]);
    } finally {
      releasePause?.();
      releasePause = null;
      pauseAfterSql = '';
    }
    const updated = await updating;
    expect(updated).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
    expect(await witnessRows('SELECT ID FROM SLIDE_MAX367_R1')).toEqual([[2]]);
    if (!overlapping) throw new Error('overlapping read did not start');
    const overlapped = await overlapping;
    expect(overlapped.success).toBe(true);
    expect(marks.filter((mark) => mark.sql === 'SELECT 1 FROM DUAL').length).toBeGreaterThan(probeBaseline + 1);

    const audited = await auditLogManager.query({ eventType: 'sql_execution', userId: '367', limit: 50 });
    expect(audited.entries.some((entry) => String(entry.details?.sql ?? '').includes('MAX367_AUDIT') && entry.result === 'success')).toBe(true);
    expect(audited.entries.some((entry) => String(entry.details?.sql ?? '').includes('SLIDE_MAX367_MISSING') && entry.result === 'failure')).toBe(true);

    const platform = profiles['slide-platform'];
    const pool = mysql.createPool({
      host: platform.host,
      port: platform.port,
      user: platform.user,
      password: platform.password,
      database: platform.database,
      connectionLimit: 1,
    });
    auditLogManager.setPersistentStore(new DatabaseAuditLogStore(pool));
    try {
      const recorded = await sqlExecutor.executeSql(instanceId, 'SELECT 3 AS MAX367_PLATFORM_AUDIT FROM DUAL', {
        timeoutMs: 5000, userId: '367', username: 'max367-audit',
      });
      expect(recorded.success).toBe(true);
      const [rows] = await pool.query(
        `SELECT id, db_type, status FROM sql_execution_history
         WHERE username = ? AND sql_text LIKE ?`,
        ['max367-audit', '%MAX367_PLATFORM_AUDIT%'],
      );
      const found = rows as Array<{ id: number; db_type: string; status: string }>;
      expect(found.length).toBeGreaterThan(0);
      expect(found[0]).toMatchObject({ db_type: 'dameng', status: 'success' });
      await pool.query('DELETE FROM sql_execution_history WHERE id = ? AND username = ?', [found[0].id, 'max367-audit']);
      const [left] = await pool.query('SELECT id FROM sql_execution_history WHERE id = ?', [found[0].id]);
      expect(left as unknown[]).toEqual([]);
    } finally {
      auditLogManager.setPersistentStore(memoryAuditLogStore);
      await pool.end();
    }
  }, 60_000);
});
