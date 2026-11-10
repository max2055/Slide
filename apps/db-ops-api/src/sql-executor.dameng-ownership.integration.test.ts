/**
 * Real Dameng ownership for MAX-367 / GitHub #385.
 * Opt in with SLIDE_DAMENG_OWNERSHIP_INTEGRATION=1.
 *
 * The Dameng session, server timeout (-608) and schema switch are real.
 * executeSql uses the production databaseService ensure/check/reconnect path.
 * Approval authorization and the durable intent store are stubbed and labeled
 * below; they still belong to the platform MySQL path and are not re-proven here.
 * sql_execution_history uses the real audit manager and, when 3306 accepts the
 * writer, the real DatabaseAuditLogStore. Credentials are never asserted or logged.
 *
 * Each run uses its own identifier. Cleanup drops only objects and audit rows
 * this run recorded after a successful create. A pre-existing sentinel is not
 * in that list. A failed drop is reported; it is not swallowed as success.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

const enabled = process.env.SLIDE_DAMENG_OWNERSHIP_INTEGRATION === '1';
const profilePath = process.env.SLIDE_CONNECTION_PROFILES
  ?? '/Users/max/.config/slide-test-access/connection-profiles.json';

const mocks = vi.hoisted(() => ({
  authorizeApproval: vi.fn(async () => true),
  beginIntent: vi.fn(async () => undefined),
  finishIntent: vi.fn(async () => undefined),
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
import { databaseService } from './database-service.js';
import { sqlExecutor } from './sql-executor.js';

const grant = { approvalRequestId: 385, reviewerId: 2, operationId: 'max367-dameng-visibility' };
const instanceId = 36701;

export type OwnedObject = { drop: string; existsSql: string };

export function registeredDropStatements(created: readonly OwnedObject[]): string[] {
  return [...created].reverse().map((item) => item.drop);
}

export async function dropRegisteredStatements(
  statements: readonly string[],
  execute: (sql: string) => Promise<void>,
): Promise<void> {
  const failures: string[] = [];
  for (const sql of statements) {
    try {
      await execute(sql);
    } catch (error) {
      failures.push(`${sql}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
}

function roundToken(): string {
  return `M367${Date.now().toString(36)}${randomBytes(3).toString('hex')}`.toUpperCase();
}

describe('MAX-367 cleanup ownership', () => {
  it('reports a drop failure and does not drop an unregistered sentinel', async () => {
    const created: OwnedObject[] = [
      { drop: 'DROP TABLE OWNED_A', existsSql: '' },
      { drop: 'DROP TABLE OWNED_B', existsSql: '' },
    ];
    const dropped: string[] = [];
    await expect(dropRegisteredStatements(registeredDropStatements(created), async (sql) => {
      dropped.push(sql);
      if (sql === 'DROP TABLE OWNED_B') throw new Error('controlled drop failure');
    })).rejects.toThrow(/controlled drop failure/);
    expect(dropped).toEqual(['DROP TABLE OWNED_B', 'DROP TABLE OWNED_A']);
    expect(dropped).not.toContain('DROP TABLE SENTINEL');
  });

  it('omits an object whose create did not succeed', () => {
    const created: OwnedObject[] = [];
    const record = (ok: boolean, drop: string) => {
      if (ok) created.push({ drop, existsSql: '' });
    };
    record(true, 'DROP TABLE OWNED');
    record(false, 'DROP TABLE NOT_CREATED');
    expect(registeredDropStatements(created)).toEqual(['DROP TABLE OWNED']);
    expect(registeredDropStatements(created)).not.toContain('DROP TABLE SENTINEL');
  });
});

function redact(secret: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return secret ? message.split(secret).join('[redacted]') : message;
}

describe.skipIf(!enabled)('MAX-367 real Dameng execution ownership', () => {
  let secret = '';
  let session: dmdb.Connection;
  let witness: dmdb.Connection;

  afterAll(async () => {
    await session?.close().catch(() => undefined);
    await witness?.close().catch(() => undefined);
    await databaseService.removeConnection(instanceId).catch(() => undefined);
  });

  it('serializes one session, cancels by the driver session timeout, and does not replay a timed-out write', async () => {
    const token = roundToken();
    const burn = `${token}_BURN`;
    const hold = `${token}_HOLD`;
    const holdB = `${token}_HOLD_B`;
    const slowView = `${token}_SLOW`;
    const dml = `${token}_DML`;
    const r1 = `${token}_R1`;
    const rebuild = `${token}_REBUILD`;
    const schema = `${token}_SCH`;
    const vis = `${token}_VIS`;
    const sentinel = `${token}_SENTINEL`;
    const auditUser = `u${token.toLowerCase()}`;
    const auditMark = `${token}_AUDIT`;
    const auditSql = `SELECT 3 AS ${auditMark} FROM DUAL`;
    const owner = `(SELECT USER FROM DUAL)`;
    const created: OwnedObject[] = [];
    const inflight: Promise<unknown>[] = [];
    const track = <T>(promise: Promise<T>): Promise<T> => {
      inflight.push(promise);
      return promise;
    };
    let pauseAfterSql = '';
    let releasePause: (() => void) | null = null;
    let platformPool: mysql.Pool | null = null;
    let sentinelHistoryId = 0;
    const ownedHistoryIds: number[] = [];
    let sentinelReady = false;
    const marks: { sql: string; at: number }[] = [];
    const startedAt = Date.now();
    const releaseHeldPause = () => {
      const release = releasePause;
      releasePause = null;
      pauseAfterSql = '';
      release?.();
    };

    async function witnessRows(sql: string): Promise<unknown[][]> {
      const result = await witness.execute(sql, [], { maxRows: 20, autoCommit: true });
      return (result.rows ?? []) as unknown[][];
    }

    async function createOwned(createSql: string, object: OwnedObject) {
      await session.execute(createSql);
      created.push(object);
    }

    async function cleanupOwned() {
      await dropRegisteredStatements(registeredDropStatements(created), async (sql) => {
        await witness.execute(sql, [], { autoCommit: true });
      });
      for (const item of created) {
        const rows = await witnessRows(item.existsSql);
        if (rows.length) throw new Error(`cleanup left ${item.drop}`);
      }
    }

    async function releaseAudit() {
      if (!platformPool) return;
      const pool = platformPool;
      try {
        for (const id of ownedHistoryIds) {
          await pool.query('DELETE FROM sql_execution_history WHERE id = ? AND username = ?', [id, auditUser]);
        }
        if (ownedHistoryIds.length) {
          const [left] = await pool.query(
            `SELECT id FROM sql_execution_history WHERE id IN (${ownedHistoryIds.map(() => '?').join(',')})`,
            ownedHistoryIds,
          );
          if ((left as unknown[]).length) throw new Error('owned audit rows remain');
        }
        if (sentinelHistoryId) {
          const [still] = await pool.query('SELECT id FROM sql_execution_history WHERE id = ?', [sentinelHistoryId]);
          if ((still as unknown[]).length !== 1) throw new Error('sentinel audit row was deleted');
          await pool.query('DELETE FROM sql_execution_history WHERE id = ? AND username = ?', [sentinelHistoryId, auditUser]);
          const [gone] = await pool.query('SELECT id FROM sql_execution_history WHERE id = ?', [sentinelHistoryId]);
          if ((gone as unknown[]).length) throw new Error('sentinel audit cleanup failed');
        }
      } finally {
        auditLogManager.setPersistentStore(memoryAuditLogStore);
        await pool.end();
        platformPool = null;
      }
    }

    let bodyError: unknown;
    try {
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
        witness = await connect();
        const opened = await databaseService.addConnection(instanceId, 'max367-dameng', {
          host: dameng.host,
          port: Number(dameng.port),
          user: dameng.user,
          password: dameng.password,
          db_type: 'dameng',
        });
        const stored = databaseService.getConnection(instanceId);
        if (!opened || !stored?.dmConnection) throw new Error('Dameng addConnection failed');
        session = stored.dmConnection;
      } catch (error) {
        throw new Error(redact(secret, error));
      }
      const driverSession = session as dmdb.Connection & { conn_prop_sessionTimeout?: number; conn_prop_socketTimeout?: number };
      expect(driverSession.conn_prop_sessionTimeout).toBe(15);

      const execute = session.execute.bind(session);
      const rollback = session.rollback.bind(session);
      const commit = session.commit.bind(session);
      const close = session.close.bind(session);
      let pausedSql = '';
      session.execute = (async (...args: Parameters<dmdb.Connection['execute']>) => {
        const text = String(args[0] ?? '');
        marks.push({ sql: text.slice(0, 160), at: Date.now() - startedAt });
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
      session.commit = (async () => {
        marks.push({ sql: 'commit', at: Date.now() - startedAt });
        return commit();
      }) as dmdb.Connection['commit'];
      session.close = (async () => {
        marks.push({ sql: 'close', at: Date.now() - startedAt });
        return close();
      }) as dmdb.Connection['close'];

      await witness.execute(`CREATE TABLE ${sentinel}(ID INT)`);
      sentinelReady = true;
      await witness.execute(`INSERT INTO ${sentinel}(ID) VALUES (1)`, [], { autoCommit: true });
      expect(await witnessRows(`SELECT ID FROM ${sentinel}`)).toEqual([[1]]);

      const owned = (name: string, ownerSql = owner) =>
        `SELECT OBJECT_NAME FROM ALL_OBJECTS WHERE OBJECT_NAME = '${name}' AND OWNER = ${ownerSql}`;
      await createOwned(`
        CREATE OR REPLACE FUNCTION ${burn}(N INT) RETURN INT IS
          I INT := 0;
          X INT := 0;
        BEGIN
          WHILE I < N LOOP
            X := X + 1;
            I := I + 1;
          END LOOP;
          RETURN X;
        END`, {
        drop: `DROP FUNCTION ${burn}`,
        existsSql: owned(burn),
      });
      await createOwned(`CREATE VIEW ${hold} AS SELECT ${burn}(12000000) AS ID FROM DUAL`, {
        drop: `DROP VIEW ${hold}`,
        existsSql: owned(hold),
      });
      await createOwned(`CREATE VIEW ${holdB} AS SELECT ${burn}(12000000) AS ID FROM DUAL`, {
        drop: `DROP VIEW ${holdB}`,
        existsSql: owned(holdB),
      });
      await createOwned(`CREATE VIEW ${slowView} AS SELECT ${burn}(40000000) AS ID FROM DUAL`, {
        drop: `DROP VIEW ${slowView}`,
        existsSql: owned(slowView),
      });
      await createOwned(`CREATE TABLE ${dml}(ID INT, NOTE VARCHAR(40))`, {
        drop: `DROP TABLE ${dml}`,
        existsSql: owned(dml),
      });
      await createOwned(`CREATE SCHEMA ${schema}`, {
        drop: `DROP SCHEMA ${schema}`,
        existsSql: `SELECT USERNAME FROM ALL_USERS WHERE USERNAME = '${schema}'`,
      });
      await createOwned(`CREATE TABLE ${schema}.${vis}(ID INT)`, {
        drop: `DROP TABLE ${schema}.${vis}`,
        existsSql: owned(vis, `'${schema}'`),
      });
      await session.execute(`INSERT INTO ${schema}.${vis}(ID) VALUES (7)`);

      const slow = `SELECT ID FROM ${hold}`;
      const slowNext = `SELECT ID FROM ${holdB}`;
      const first = track(sqlExecutor.executeSql(instanceId, slow, { timeoutMs: 15_000, userId: '367', username: auditUser }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = track(sqlExecutor.executeSql(instanceId, slowNext, { timeoutMs: 15_000, userId: '367', username: auditUser }));
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
      const timeout = await track(sqlExecutor.executeSql(
        instanceId,
        `SELECT ID FROM ${slowView}`,
        { timeoutMs: 1000, userId: '367', username: auditUser },
      ));
      expect(timeout.success).toBe(false);
      expect(timeout.error).toContain('请求执行超时');
      expect(Date.now() - timed).toBeLessThan(8_000);
      expect(driverSession.conn_prop_sessionTimeout).toBe(15);
      const alive = await track(sqlExecutor.executeSql(instanceId, `SELECT 1 AS ${auditMark} FROM DUAL`, {
        timeoutMs: 15_000, userId: '367', username: auditUser,
      }));
      expect(alive).toMatchObject({ success: true, rowCount: 1 });

      const missing = await track(sqlExecutor.executeSql(instanceId, `SELECT ID FROM ${token}_MISSING`, {
        timeoutMs: 1000, userId: '367', username: auditUser,
      }));
      expect(missing.success).toBe(false);
      const recovered = await track(sqlExecutor.executeSql(instanceId, 'SELECT 2 FROM DUAL', { timeoutMs: 1000 }));
      expect(recovered.success).toBe(true);

      const committed = await track(sqlExecutor.executeSql(
        instanceId,
        `INSERT INTO ${dml}(ID, NOTE) SELECT 1, 'committed' FROM DUAL`,
        { approvalGrant: { ...grant, operationId: `${token}-committed` }, timeoutMs: 15_000, userId: '367', username: auditUser },
      ));
      expect(committed).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
      expect(await witnessRows(`SELECT NOTE FROM ${dml} WHERE NOTE = 'committed'`)).toEqual([['committed']]);

      const lost = await track(sqlExecutor.executeSql(
        instanceId,
        `INSERT INTO ${dml}(ID, NOTE) SELECT ${burn}(40000000), 'slow' FROM DUAL`,
        { approvalGrant: { ...grant, operationId: `${token}-timeout` }, timeoutMs: 1000, userId: '367', username: auditUser },
      ));
      expect(lost).toMatchObject({ success: false, executionState: 'unknown', retryable: false, operationId: `${token}-timeout` });
      expect(lost.executionState).not.toBe('not_started');
      expect(mocks.finishIntent).toHaveBeenCalledWith(`${token}-timeout`, 'unknown', expect.objectContaining({ targetAcknowledged: false }));
      expect(await witnessRows(`SELECT NOTE FROM ${dml} WHERE NOTE = 'slow'`)).toEqual([]);
      const userStatements = marks.filter((mark) => mark.sql.includes("'slow'"));
      expect(userStatements).toHaveLength(1);

      const visible = await track(sqlExecutor.executeSql(instanceId, `SELECT ID FROM ${vis}`, {
        database: schema, timeoutMs: 5000,
      }));
      expect(visible).toMatchObject({ success: true, rows: [{ ID: 7 }] });
      const restored = await track(sqlExecutor.executeSql(instanceId, `SELECT ID FROM ${vis}`, { timeoutMs: 5000 }));
      expect(restored.success).toBe(false);
      expect(driverSession.conn_prop_sessionTimeout).toBe(15);
      expect(driverSession.conn_prop_socketTimeout).toBe(30_000);

      await createOwned(`CREATE TABLE ${r1}(ID INT)`, {
        drop: `DROP TABLE ${r1}`,
        existsSql: owned(r1),
      });
      await session.execute(`INSERT INTO ${r1}(ID) VALUES (1)`, [], { autoCommit: true });
      expect(await witnessRows(`SELECT ID FROM ${r1}`)).toEqual([[1]]);
      const updateSql = `UPDATE ${r1} SET ID = 2`;
      pauseAfterSql = updateSql;
      const probeBaseline = marks.filter((mark) => mark.sql === 'SELECT 1 FROM DUAL').length;
      const updating = track(sqlExecutor.executeSql(instanceId, updateSql, {
        approvalGrant: { ...grant, operationId: `${token}-r1` }, timeoutMs: 15_000,
      }));
      let overlapping: Promise<unknown> | undefined;
      try {
        const updateStarted = Date.now();
        while (pausedSql !== updateSql && Date.now() - updateStarted < 5_000) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(pausedSql).toBe(updateSql);
        expect(await witnessRows(`SELECT ID FROM ${r1}`)).toEqual([[1]]);
        overlapping = track(sqlExecutor.executeSql(instanceId, `SELECT ID FROM ${r1}`, { timeoutMs: 15_000 }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(marks.filter((mark) => mark.sql === 'SELECT 1 FROM DUAL')).toHaveLength(probeBaseline + 1);
        expect(await witnessRows(`SELECT ID FROM ${r1}`)).toEqual([[1]]);
      } finally {
        releaseHeldPause();
      }
      const updated = await updating;
      expect(updated).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
      expect(await witnessRows(`SELECT ID FROM ${r1}`)).toEqual([[2]]);
      if (!overlapping) throw new Error('overlapping read did not start');
      const overlapped = await overlapping;
      expect(overlapped).toMatchObject({ success: true });
      expect(marks.filter((mark) => mark.sql === 'SELECT 1 FROM DUAL').length).toBeGreaterThan(probeBaseline + 1);

      const audited = await auditLogManager.query({ eventType: 'sql_execution', userId: '367', limit: 50 });
      expect(audited.entries.some((entry) => String(entry.details?.sql ?? '').includes(auditMark) && entry.result === 'success')).toBe(true);
      expect(audited.entries.some((entry) => String(entry.details?.sql ?? '').includes(`${token}_MISSING`) && entry.result === 'failure')).toBe(true);

      const platform = profiles['slide-platform'];
      platformPool = mysql.createPool({
        host: platform.host,
        port: platform.port,
        user: platform.user,
        password: platform.password,
        database: platform.database,
        connectionLimit: 1,
      });
      const [sentinelInsert] = await platformPool.query(
        `INSERT INTO sql_execution_history
         (user_id, username, instance_id, instance_name, db_type, sql_text, status, duration_ms, row_count)
         VALUES (?, ?, ?, ?, 'dameng', ?, 'success', 0, 0)`,
        [367, auditUser, instanceId, 'max367-dameng', `${auditSql} -- sentinel`],
      );
      sentinelHistoryId = Number((sentinelInsert as { insertId?: number }).insertId);
      if (!sentinelHistoryId) throw new Error('sentinel audit insert returned no id');
      auditLogManager.setPersistentStore(new DatabaseAuditLogStore(platformPool));
      try {
        const recorded = await track(sqlExecutor.executeSql(instanceId, auditSql, {
          timeoutMs: 5000, userId: '367', username: auditUser,
        }));
        expect(recorded.success).toBe(true);
        const [rows] = await platformPool.query(
          `SELECT id, db_type, status, sql_text FROM sql_execution_history
           WHERE username = ? AND sql_text = ?`,
          [auditUser, auditSql],
        );
        const found = rows as Array<{ id: number; db_type: string; status: string; sql_text: string }>;
        expect(found.length).toBeGreaterThan(0);
        expect(found.every((row) => row.id !== sentinelHistoryId)).toBe(true);
        expect(found[0]).toMatchObject({ db_type: 'dameng', status: 'success', sql_text: auditSql });
        for (const row of found) ownedHistoryIds.push(row.id);
      } finally {
        auditLogManager.setPersistentStore(memoryAuditLogStore);
      }

      await createOwned(`CREATE TABLE ${rebuild}(ID INT)`, {
        drop: `DROP TABLE ${rebuild}`,
        existsSql: owned(rebuild),
      });
      await session.execute(`INSERT INTO ${rebuild}(ID) VALUES (1)`, [], { autoCommit: true });
      expect(await witnessRows(`SELECT ID FROM ${rebuild}`)).toEqual([[1]]);
      const rebuildSql = `UPDATE ${rebuild} SET ID = 2`;
      pauseAfterSql = rebuildSql;
      const rebuilding = track(sqlExecutor.executeSql(instanceId, rebuildSql, {
        approvalGrant: { ...grant, operationId: `${token}-rebuild` }, timeoutMs: 15_000,
      }));
      let ensured: Promise<boolean> | undefined;
      let checked: Promise<boolean> | undefined;
      let reconnected: Promise<boolean> | undefined;
      try {
        const rebuildStarted = Date.now();
        while (pausedSql !== rebuildSql && Date.now() - rebuildStarted < 5_000) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(pausedSql).toBe(rebuildSql);
        const closesAtPause = marks.filter((mark) => mark.sql === 'close').length;
        const probesAtPause = marks.filter((mark) => mark.sql === 'SELECT 1 FROM DUAL').length;
        const held = databaseService.getConnection(instanceId);
        if (!held) throw new Error('Dameng session missing while the owner is running');
        held.connected = false;
        ensured = track(databaseService.ensureConnectionAlive(instanceId));
        checked = track(databaseService.checkConnectionAlive(instanceId));
        reconnected = track(databaseService.reconnect(instanceId));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(marks.filter((mark) => mark.sql === 'close')).toHaveLength(closesAtPause);
        expect(marks.filter((mark) => mark.sql === 'SELECT 1 FROM DUAL')).toHaveLength(probesAtPause);
        expect(await witnessRows(`SELECT ID FROM ${rebuild}`)).toEqual([[1]]);
      } finally {
        releaseHeldPause();
      }
      const rebuilt = await rebuilding;
      expect(rebuilt).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
      expect(await witnessRows(`SELECT ID FROM ${rebuild}`)).toEqual([[2]]);
      if (!ensured || !checked || !reconnected) throw new Error('production reconnect probes did not start');
      expect(await ensured).toBe(true);
      expect(await checked).toBe(true);
      expect(await reconnected).toBe(true);
      const commitAt = marks.map((mark) => mark.sql).lastIndexOf('commit');
      const closeAt = marks.findIndex((mark) => mark.sql === 'close');
      expect(commitAt).toBeGreaterThanOrEqual(0);
      expect(closeAt).toBeGreaterThan(commitAt);
      expect(await witnessRows(`SELECT ID FROM ${sentinel}`)).toEqual([[1]]);
    } catch (error) {
      bodyError = error;
    } finally {
      releaseHeldPause();
      await Promise.allSettled(inflight);
      const problems: string[] = [];
      try {
        if (witness) await cleanupOwned();
        if (sentinelReady) {
          let sentinelError = '';
          try {
            const sentinelRows = await witnessRows(`SELECT ID FROM ${sentinel}`);
            if (sentinelRows.length !== 1 || String(sentinelRows[0][0]) !== '1') {
              throw new Error('sentinel table was removed');
            }
          } catch (error) {
            sentinelError = redact(secret, error);
          }
          await witness.execute(`DROP TABLE ${sentinel}`, [], { autoCommit: true });
          const left = await witnessRows(
            `SELECT OBJECT_NAME FROM ALL_OBJECTS WHERE OBJECT_NAME = '${sentinel}' AND OWNER = (SELECT USER FROM DUAL)`,
          );
          if (left.length) throw new Error('sentinel table cleanup failed');
          if (sentinelError) throw new Error(sentinelError);
        }
      } catch (error) {
        problems.push(redact(secret, error));
      }
      try {
        await releaseAudit();
      } catch (error) {
        problems.push(redact(secret, error));
      }
      if (bodyError || problems.length) {
        const body = bodyError ? redact(secret, bodyError) : '';
        const extra = problems.length ? `cleanup: ${problems.join('; ')}` : '';
        throw new Error([body, extra].filter(Boolean).join(' | '));
      }
    }
  }, 90_000);
});
