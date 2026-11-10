/**
 * Real MySQL statement timeout for MAX-373 / GitHub #598.
 *
 * Default collection does not read credentials. Opt in with
 * SLIDE_MYSQL_STATEMENT_TIMEOUT_INTEGRATION=1 and set SLIDE_CONNECTION_PROFILES
 * to the credential profile file. An opted-in run without that path fails.
 * The profile's mysql-test entry must be 127.0.0.1:3308. This file never
 * prints the password.
 *
 * The target schema, locks, cancellation and process list are on that MySQL.
 * Approval authorization and the durable intent store are stubbed. The SQL
 * audit row is the in-memory audit manager, not a platform 3306 write.
 * Cleanup drops only the schema this run created.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { afterAll, describe, expect, it, vi } from 'vitest';

const enabled = process.env.SLIDE_MYSQL_STATEMENT_TIMEOUT_INTEGRATION === '1';

export function resolveMysqlTimeoutProfile(env: NodeJS.ProcessEnv): string | null {
  if (env.SLIDE_MYSQL_STATEMENT_TIMEOUT_INTEGRATION !== '1') return null;
  const profilePath = env.SLIDE_CONNECTION_PROFILES;
  if (!profilePath) {
    throw new Error(
      'SLIDE_MYSQL_STATEMENT_TIMEOUT_INTEGRATION=1 requires SLIDE_CONNECTION_PROFILES to name the credential profile file. Default collection does not read credentials.',
    );
  }
  return profilePath;
}

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

import { auditLogManager } from './audit/audit-log.js';
import { databaseService } from './database-service.js';
import { sqlExecutor } from './sql-executor.js';

const instanceId = 3_730_000_000 + (process.pid % 100_000);

function redact(secret: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return secret ? message.split(secret).join('[redacted]') : message;
}

describe('MAX-373 credential injection', () => {
  it('does not resolve a credential path when the integration flag is off', () => {
    expect(resolveMysqlTimeoutProfile({})).toBeNull();
    expect(resolveMysqlTimeoutProfile({ SLIDE_CONNECTION_PROFILES: 'task-owned/profile.json' })).toBeNull();
  });

  it('fails clearly when the integration flag is set without a profile path', () => {
    expect(() => resolveMysqlTimeoutProfile({ SLIDE_MYSQL_STATEMENT_TIMEOUT_INTEGRATION: '1' }))
      .toThrow(/SLIDE_CONNECTION_PROFILES/);
  });

  it('uses only the injected profile path', () => {
    expect(resolveMysqlTimeoutProfile({
      SLIDE_MYSQL_STATEMENT_TIMEOUT_INTEGRATION: '1',
      SLIDE_CONNECTION_PROFILES: 'task-owned/profile.json',
    })).toBe('task-owned/profile.json');
  });
});

describe.skipIf(!enabled)('MAX-373 real MySQL change timeout', () => {
  const schema = `slide_max373_${process.pid}_${randomBytes(3).toString('hex')}`;
  let secret = '';
  let admin: mysql.Connection | null = null;
  let holder: mysql.Connection | null = null;
  let created = false;

  afterAll(async () => {
    try { await holder?.query('ROLLBACK'); } catch { /* The holder may already be closed. */ }
    try { await holder?.query('UNLOCK TABLES'); } catch { /* No metadata lock was held. */ }
    await holder?.end().catch(() => undefined);
    if (created && admin) await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    await admin?.end().catch(() => undefined);
    await databaseService.removeConnection(instanceId).catch(() => undefined);
  });

  async function visibleThreads(marker: string): Promise<number[]> {
    const [rows] = await admin!.query<RowDataPacket[]>(
      'SELECT ID AS id, INFO AS info FROM information_schema.processlist',
    );
    return rows.filter((row) => {
      const info = String(row.info ?? '');
      return info.includes(marker) && !info.includes('information_schema.processlist');
    }).map((row) => Number(row.id));
  }

  async function waitForMarker(marker: string): Promise<number[]> {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const ids = await visibleThreads(marker);
      if (ids.length) return ids;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`timed out waiting for ${marker}`);
  }

  it('cancels row locks, metadata locks and a running write, then serves the next statement', async () => {
    const profilePath = resolveMysqlTimeoutProfile(process.env);
    if (!profilePath) throw new Error('integration started without SLIDE_MYSQL_STATEMENT_TIMEOUT_INTEGRATION=1');
    const profiles = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as {
      'mysql-test'?: { host?: string; port?: number; user?: string; password?: string };
    };
    const profile = profiles['mysql-test'];
    if (!profile?.host || !profile.user || !profile.password) throw new Error('mysql-test profile is incomplete');
    if (profile.host !== '127.0.0.1' || Number(profile.port) !== 3308) {
      throw new Error('mysql-test profile must target 127.0.0.1:3308');
    }
    secret = profile.password;
    const connect = () => mysql.createConnection({
      host: profile.host,
      port: Number(profile.port),
      user: profile.user,
      password: profile.password,
      multipleStatements: false,
    });

    try {
      admin = await connect();
      await admin.query(`CREATE DATABASE \`${schema}\``);
      created = true;
      await admin.query(`CREATE TABLE \`${schema}\`.t (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB`);
      await admin.query(`INSERT INTO \`${schema}\`.t (id, note) VALUES (1, 'original')`);
      const opened = await databaseService.addConnection(instanceId, 'max373-mysql-timeout', {
        host: profile.host,
        port: Number(profile.port),
        user: profile.user,
        password: profile.password,
        database: schema,
        db_type: 'mysql',
      });
      if (!opened) throw new Error('MySQL addConnection failed');
      holder = await connect();
      await holder.query(`USE \`${schema}\``);
    } catch (error) {
      throw new Error(redact(secret, error));
    }

    const rowMarker = 'max373_row_wait';
    const runMarker = 'max373_run_wait';
    const mdlMarker = 'max373_mdl_col';
    const phases: Record<string, unknown> = {};

    await holder!.beginTransaction();
    await holder!.query('SELECT note FROM t WHERE id = 1 FOR UPDATE');
    const rowStarted = Date.now();
    const rowUpdate = sqlExecutor.executeSql(
      instanceId,
      `UPDATE t SET note = '${rowMarker}' WHERE id = 1`,
      { approvalGrant: { approvalRequestId: 598, reviewerId: 9, operationId: 'max373-row' }, timeoutMs: 800, userId: '9', username: 'max373' },
    );
    const rowThreads = await waitForMarker(rowMarker);
    let followFinishedFirst = false;
    const follow = sqlExecutor.executeSql(instanceId, 'SELECT 1 AS ready', { timeoutMs: 2000, userId: '9', username: 'max373' })
      .then((result) => {
        if (rowPending) followFinishedFirst = true;
        return result;
      });
    let rowPending = true;
    const rowResult = await rowUpdate;
    rowPending = false;
    const followResult = await follow;
    phases.row = {
      elapsedMs: Date.now() - rowStarted,
      threads: rowThreads,
      remaining: await visibleThreads(rowMarker),
      error: rowResult.error,
      executionState: rowResult.executionState,
      retryable: rowResult.retryable,
      follow: followResult.success,
      followFinishedFirst,
    };
    expect(rowResult.success).toBe(false);
    expect(rowResult.executionState).toBe('unknown');
    expect(rowResult.retryable).toBe(false);
    expect(rowResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
    expect(rowResult.error).toContain('outcome may be unknown');
    expect(rowResult.error?.toLowerCase()).not.toContain('rolled back');
    expect(phases.row).toMatchObject({ followFinishedFirst: false, remaining: [] });
    expect(rowThreads).toHaveLength(1);
    expect(Date.now() - rowStarted).toBeLessThan(8_000);
    expect(followResult).toMatchObject({ success: true, rows: [{ ready: 1 }] });
    const [held] = await holder!.query<RowDataPacket[]>('SELECT note FROM t WHERE id = 1');
    expect(held[0]?.note).toBe('original');
    await holder!.query('ROLLBACK');

    const runStarted = Date.now();
    const runResult = await sqlExecutor.executeSql(
      instanceId,
      `UPDATE t SET note = '${runMarker}' WHERE id = 1 AND SLEEP(5) = 0`,
      { approvalGrant: { approvalRequestId: 598, reviewerId: 9, operationId: 'max373-run' }, timeoutMs: 800, userId: '9', username: 'max373' },
    );
    const [afterRun] = await admin!.query<RowDataPacket[]>(`SELECT note FROM \`${schema}\`.t WHERE id = 1`);
    phases.run = {
      elapsedMs: Date.now() - runStarted,
      remaining: await visibleThreads(runMarker),
      note: afterRun[0]?.note,
      error: runResult.error,
      executionState: runResult.executionState,
    };
    expect(runResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(runResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
    expect(Date.now() - runStarted).toBeLessThan(8_000);
    expect(afterRun[0]?.note).toBe('original');
    expect(phases.run).toMatchObject({ remaining: [] });

    await holder!.query('LOCK TABLES t WRITE');
    const mdlStarted = Date.now();
    const mdlResult = await sqlExecutor.executeSql(
      instanceId,
      `ALTER TABLE t ADD COLUMN ${mdlMarker} INT NULL`,
      { approvalGrant: { approvalRequestId: 598, reviewerId: 9, operationId: 'max373-mdl' }, timeoutMs: 800, userId: '9', username: 'max373' },
    );
    const mdlThreads = await visibleThreads(mdlMarker);
    const [columns] = await admin!.query<RowDataPacket[]>(
      'SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?',
      [schema, 't', mdlMarker],
    );
    phases.mdl = {
      elapsedMs: Date.now() - mdlStarted,
      remaining: mdlThreads,
      columnAdded: columns.length,
      error: mdlResult.error,
      executionState: mdlResult.executionState,
    };
    expect(mdlResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(mdlResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
    expect(Date.now() - mdlStarted).toBeLessThan(8_000);
    expect(columns).toEqual([]);
    expect(mdlThreads).toEqual([]);
    await holder!.query('UNLOCK TABLES');
    await admin!.query(`CREATE VIEW \`${schema}\`.max373_slow_read AS SELECT SLEEP(5) AS slept`);

    const pool = databaseService.getConnection(instanceId)?.pool;
    if (!pool) throw new Error('MySQL pool missing after timeout');
    const checked = await pool.getConnection();
    try {
      const [limits] = await checked.query<RowDataPacket[]>(
        `SELECT @@SESSION.innodb_lock_wait_timeout AS session_innodb,
                @@GLOBAL.innodb_lock_wait_timeout AS global_innodb,
                @@SESSION.lock_wait_timeout AS session_mdl,
                @@GLOBAL.lock_wait_timeout AS global_mdl,
                @@SESSION.max_execution_time AS session_select`,
      );
      phases.session = limits[0];
      expect(Number(limits[0]?.session_innodb)).toBe(Number(limits[0]?.global_innodb));
      expect(Number(limits[0]?.session_mdl)).toBe(Number(limits[0]?.global_mdl));
      expect(Number(limits[0]?.session_select)).toBe(0);
    } finally {
      checked.release();
    }

    const readStarted = Date.now();
    const slowRead = await sqlExecutor.executeSql(instanceId, 'SELECT slept FROM max373_slow_read', { timeoutMs: 1000, userId: '9', username: 'max373' });
    const nextRead = await sqlExecutor.executeSql(instanceId, 'SELECT note FROM t', { timeoutMs: 2000, userId: '9', username: 'max373' });
    phases.read = {
      elapsedMs: Date.now() - readStarted,
      error: slowRead.error,
      next: nextRead.success,
      remaining: await visibleThreads('max373_slow_read'),
    };
    expect(slowRead.success).toBe(false);
    expect(slowRead.error).not.toContain('MYSQL_STATEMENT_TIMEOUT');
    expect(String(slowRead.error)).toMatch(/maximum statement execution time|Query execution was interrupted/i);
    expect(Date.now() - readStarted).toBeLessThan(8_000);
    expect(nextRead).toMatchObject({ success: true, rows: [{ note: 'original' }] });
    expect(phases.read).toMatchObject({ remaining: [] });

    const audits = await auditLogManager.query({ eventType: 'sql_execution', search: 'max373_', limit: 20 });
    const timeoutAudits = audits.entries.filter((entry) => String(entry.details && (entry.details as { errorMessage?: string }).errorMessage).includes('MYSQL_STATEMENT_TIMEOUT'));
    phases.audit = {
      timeoutRows: timeoutAudits.length,
      results: timeoutAudits.map((entry) => entry.result),
      intents: (mocks.finishIntent.mock.calls as unknown as unknown[][]).map((call) => [call[0], call[1]]),
    };
    expect(timeoutAudits.length).toBeGreaterThanOrEqual(3);
    expect(timeoutAudits.every((entry) => entry.result === 'failure')).toBe(true);
    expect((mocks.finishIntent.mock.calls as unknown as unknown[][]).map((call) => call[1])).toEqual(['unknown', 'unknown', 'unknown']);
    expect(mocks.beginIntent).toHaveBeenCalledTimes(3);

    const [trx] = await admin!.query<RowDataPacket[]>(
      'SELECT trx_mysql_thread_id AS id FROM information_schema.innodb_trx WHERE trx_query LIKE ?',
      ['%max373_%'],
    );
    expect(trx).toEqual([]);
    phases.transactions = trx.length;
    const evidenceDir = process.env.MAX373_EVIDENCE_DIR;
    if (evidenceDir) fs.writeFileSync(`${evidenceDir}/phases.json`, `${JSON.stringify(phases, null, 2)}\n`);
    expect(phases.row).toBeTruthy();
  }, 60_000);

  it('stops a real statement when no killer is available and when KILL has no receipt', async () => {
    const profilePath = resolveMysqlTimeoutProfile(process.env);
    if (!profilePath) throw new Error('integration started without SLIDE_MYSQL_STATEMENT_TIMEOUT_INTEGRATION=1');
    const profiles = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as {
      'mysql-test'?: { host?: string; port?: number; user?: string; password?: string };
    };
    const profile = profiles['mysql-test'];
    if (!profile?.host || !profile.user || !profile.password) throw new Error('mysql-test profile is incomplete');
    if (profile.host !== '127.0.0.1' || Number(profile.port) !== 3308) {
      throw new Error('mysql-test profile must target 127.0.0.1:3308');
    }
    const password = profile.password;
    const isolatedId = instanceId + 50;
    const isolatedSchema = `slide_max373i_${process.pid}_${randomBytes(3).toString('hex')}`;
    const connect = () => mysql.createConnection({
      host: profile.host,
      port: Number(profile.port),
      user: profile.user,
      password,
      multipleStatements: false,
    });
    let localAdmin: mysql.Connection | null = null;
    let localHolder: mysql.Connection | null = null;
    let created = false;
    let small: mysql.Pool | null = null;
    let hanging: mysql.Pool | null = null;
    let restorePool: (() => void) | undefined;
    const phases: Record<string, unknown> = {};
    const grantFor = (operationId: string) => ({
      approvalGrant: { approvalRequestId: 598, reviewerId: 9, operationId },
      timeoutMs: 400,
      userId: '9',
      username: 'max373',
    });

    async function threads(marker: string): Promise<number> {
      const [rows] = await localAdmin!.query<RowDataPacket[]>(
        'SELECT ID AS id, INFO AS info FROM information_schema.processlist',
      );
      return rows.filter((row) => {
        const info = String(row.info ?? '');
        return info.includes(marker) && !info.includes('information_schema.processlist');
      }).length;
    }

    async function waitThread(marker: string): Promise<void> {
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        if (await threads(marker)) return;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      throw new Error(`timed out waiting for ${marker}`);
    }

    async function markerTransactions(marker: string): Promise<number> {
      const [rows] = await localAdmin!.query<RowDataPacket[]>(
        'SELECT trx_mysql_thread_id AS id FROM information_schema.innodb_trx WHERE trx_query LIKE ?',
        [`%${marker}%`],
      );
      return rows.length;
    }

    try {
      localAdmin = await connect();
      await localAdmin.query(`CREATE DATABASE \`${isolatedSchema}\``);
      created = true;
      await localAdmin.query(`CREATE TABLE \`${isolatedSchema}\`.t (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB`);
      await localAdmin.query(`INSERT INTO \`${isolatedSchema}\`.t (id, note) VALUES (1, 'original')`);
      const opened = await databaseService.addConnection(isolatedId, 'max373-mysql-isolate', {
        host: profile.host,
        port: Number(profile.port),
        user: profile.user,
        password,
        database: isolatedSchema,
        db_type: 'mysql',
      });
      if (!opened) throw new Error('MySQL addConnection failed');
      const record = databaseService.getConnection(isolatedId);
      if (!record?.pool) throw new Error('MySQL pool missing');
      const original = record.pool;
      restorePool = () => { record.pool = original; };
      small = mysql.createPool({
        host: profile.host,
        port: Number(profile.port),
        user: profile.user,
        password,
        database: isolatedSchema,
        connectionLimit: 1,
        waitForConnections: true,
      });
      record.pool = small;
      localHolder = await connect();
      await localHolder.query(`USE \`${isolatedSchema}\``);

      const lockMarker = 'max373_iso_lock';
      await localHolder.beginTransaction();
      await localHolder.query('SELECT note FROM t WHERE id = 1 FOR UPDATE');
      const lockStarted = Date.now();
      const lockUpdate = sqlExecutor.executeSql(
        isolatedId,
        `UPDATE t SET note = '${lockMarker}' WHERE id = 1`,
        grantFor('max373-iso-lock'),
      );
      await waitThread(lockMarker);
      let lockFollowFirst = false;
      const lockFollow = sqlExecutor.executeSql(isolatedId, 'SELECT 1 AS ready', { timeoutMs: 2000, userId: '9', username: 'max373' })
        .then((result) => {
          if (!lockDone) lockFollowFirst = true;
          return result;
        });
      let lockDone = false;
      const lockResult = await lockUpdate;
      lockDone = true;
      const lockFollowResult = await lockFollow;
      const [lockedNote] = await localHolder.query<RowDataPacket[]>('SELECT note FROM t WHERE id = 1');
      phases.lock = {
        elapsedMs: Date.now() - lockStarted,
        remaining: await threads(lockMarker),
        transactions: await markerTransactions(lockMarker),
        note: lockedNote[0]?.note,
        error: lockResult.error,
        executionState: lockResult.executionState,
        retryable: lockResult.retryable,
        followFinishedFirst: lockFollowFirst,
        follow: lockFollowResult.success,
      };
      expect(lockResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
      expect(lockResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
      expect(lockResult.error).toContain('outcome may be unknown');
      expect(lockFollowFirst).toBe(false);
      expect(lockFollowResult).toMatchObject({ success: true, rows: [{ ready: 1 }] });
      expect(lockedNote[0]?.note).toBe('original');
      expect(phases.lock).toMatchObject({ remaining: 0, transactions: 0 });
      expect(Date.now() - lockStarted).toBeLessThan(8_000);
      await localHolder.query('ROLLBACK');

      const runMarker = 'max373_iso_run';
      const runStarted = Date.now();
      const runUpdate = sqlExecutor.executeSql(
        isolatedId,
        `UPDATE t SET note = '${runMarker}' WHERE id = 1 AND SLEEP(15) = 0`,
        grantFor('max373-iso-run'),
      );
      await waitThread(runMarker);
      let runFollowFirst = false;
      const runFollow = sqlExecutor.executeSql(isolatedId, 'SELECT 1 AS ready', { timeoutMs: 2000, userId: '9', username: 'max373' })
        .then((result) => {
          if (!runDone) runFollowFirst = true;
          return result;
        });
      let runDone = false;
      const runResult = await runUpdate;
      runDone = true;
      const runFollowResult = await runFollow;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const [runNote] = await localAdmin.query<RowDataPacket[]>(`SELECT note FROM \`${isolatedSchema}\`.t WHERE id = 1`);
      phases.run = {
        elapsedMs: Date.now() - runStarted,
        remaining: await threads(runMarker),
        transactions: await markerTransactions(runMarker),
        note: runNote[0]?.note,
        error: runResult.error,
        executionState: runResult.executionState,
        retryable: runResult.retryable,
        followFinishedFirst: runFollowFirst,
        follow: runFollowResult.success,
      };
      expect(runResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
      expect(runResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
      expect(runResult.error).not.toContain('server stop was not confirmed');
      expect(Date.now() - runStarted).toBeGreaterThanOrEqual(1_200);
      expect(Date.now() - runStarted).toBeLessThan(8_000);
      expect(runFollowFirst).toBe(false);
      expect(runFollowResult.success).toBe(true);
      expect(runNote[0]?.note).toBe('original');
      expect(phases.run).toMatchObject({ remaining: 0, transactions: 0 });

      await small.end();
      small = null;
      hanging = mysql.createPool({
        host: profile.host,
        port: Number(profile.port),
        user: profile.user,
        password,
        database: isolatedSchema,
        connectionLimit: 2,
        waitForConnections: true,
      });
      record.pool = {
        pool: hanging.pool,
        async getConnection() {
          const conn = await hanging!.getConnection();
          return {
            get threadId() { return conn.threadId; },
            query(sql: string, values?: unknown[]) {
              if (String(sql).startsWith('KILL ')) return new Promise(() => undefined);
              return values === undefined ? conn.query(sql) : conn.query(sql, values);
            },
            ping: () => conn.ping(),
            release: () => conn.release(),
            destroy: () => conn.destroy(),
          };
        },
      } as unknown as typeof record.pool;

      const killMarker = 'max373_iso_kill';
      const killStarted = Date.now();
      const killUpdate = sqlExecutor.executeSql(
        isolatedId,
        `UPDATE t SET note = '${killMarker}' WHERE id = 1 AND SLEEP(15) = 0`,
        grantFor('max373-iso-kill'),
      );
      await waitThread(killMarker);
      let killFollowFirst = false;
      const killFollow = sqlExecutor.executeSql(isolatedId, 'SELECT 1 AS ready', { timeoutMs: 2000, userId: '9', username: 'max373' })
        .then((result) => {
          if (!killDone) killFollowFirst = true;
          return result;
        });
      let killDone = false;
      const killResult = await killUpdate;
      killDone = true;
      const killFollowResult = await killFollow;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const [killNote] = await localAdmin.query<RowDataPacket[]>(`SELECT note FROM \`${isolatedSchema}\`.t WHERE id = 1`);
      phases.kill = {
        elapsedMs: Date.now() - killStarted,
        remaining: await threads(killMarker),
        transactions: await markerTransactions(killMarker),
        note: killNote[0]?.note,
        error: killResult.error,
        executionState: killResult.executionState,
        retryable: killResult.retryable,
        followFinishedFirst: killFollowFirst,
        follow: killFollowResult.success,
      };
      expect(killResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
      expect(killResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
      expect(killResult.error).not.toContain('server stop was not confirmed');
      expect(Date.now() - killStarted).toBeGreaterThanOrEqual(1_200);
      expect(Date.now() - killStarted).toBeLessThan(8_000);
      expect(killFollowFirst).toBe(false);
      expect(killFollowResult.success).toBe(true);
      expect(killNote[0]?.note).toBe('original');
      expect(phases.kill).toMatchObject({ remaining: 0, transactions: 0 });

      record.pool = original;
      const evidenceDir = process.env.MAX373_EVIDENCE_DIR;
      if (evidenceDir) fs.writeFileSync(`${evidenceDir}/isolate-phases.json`, `${JSON.stringify(phases, null, 2)}\n`);
    } catch (error) {
      throw new Error(redact(password, error));
    } finally {
      restorePool?.();
      try { await localHolder?.query('ROLLBACK'); } catch { /* The holder may already be closed. */ }
      await localHolder?.end().catch(() => undefined);
      if (created && localAdmin) await localAdmin.query(`DROP DATABASE IF EXISTS \`${isolatedSchema}\``).catch(() => undefined);
      await localAdmin?.end().catch(() => undefined);
      await small?.end().catch(() => undefined);
      await hanging?.end().catch(() => undefined);
      await databaseService.removeConnection(isolatedId).catch(() => undefined);
    }
  }, 45_000);
});
