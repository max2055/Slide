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

type StatementWatch = {
  overlap: number;
  samples: number;
  originalSeenAtMs: number | null;
  stopEvidenceAtMs: number | null;
  successorSeenAtMs: number | null;
  transitions: Array<{ atMs: number; original: boolean; successor: boolean; originalTrx: boolean }>;
  statementTimers: {
    originalEnd: string;
    successorStart: string;
    ordered: boolean;
  } | { unavailable: string } | null;
};

function successorSql(marker: string): string {
  return `UPDATE s SET note = '${marker}' WHERE id = 1`;
}

function successorContext(operationId: string) {
  return {
    approvalGrant: { approvalRequestId: 598, reviewerId: 9, operationId },
    timeoutMs: 5000,
    userId: '9',
    username: 'max373',
  };
}

async function holdSideRow(conn: mysql.Connection): Promise<void> {
  await conn.query('ROLLBACK').catch(() => undefined);
  await conn.beginTransaction();
  await conn.query('SELECT note FROM s WHERE id = 1 FOR UPDATE');
}

async function watchStatementOrder<T>(
  watcher: mysql.Connection,
  originalMarker: string,
  successorMarker: string,
  work: Promise<T>,
  onSuccessorVisible?: () => Promise<void>,
): Promise<StatementWatch & { value: T }> {
  const started = Date.now();
  const transitions: StatementWatch['transitions'] = [];
  let overlap = 0;
  let samples = 0;
  let originalSeenAtMs: number | null = null;
  let stopEvidenceAtMs: number | null = null;
  let successorSeenAtMs: number | null = null;
  let closed = false;
  let released = false;
  let previous = '';
  const loop = (async () => {
    while (!closed) {
      let releaseNow = false;
      try {
        const [rows] = await watcher.query<RowDataPacket[]>('SELECT INFO AS info FROM information_schema.processlist');
        const atMs = Date.now() - started;
        const infos = rows.map((row) => String(row.info ?? ''));
        const original = infos.some((info) => info.includes(originalMarker) && !info.includes('information_schema.processlist'));
        const successor = infos.some((info) => info.includes(successorMarker) && !info.includes('information_schema.processlist'));
        const originalTrx = false;
        samples += 1;
        if (original && originalSeenAtMs === null) originalSeenAtMs = atMs;
        if (successor && successorSeenAtMs === null) successorSeenAtMs = atMs;
        if (original && successor) overlap += 1;
        if (originalSeenAtMs !== null && !original && stopEvidenceAtMs === null) stopEvidenceAtMs = atMs;
        if (successor && !released) {
          released = true;
          releaseNow = true;
        }
        const key = `${original}:${successor}`;
        if (key !== previous) {
          transitions.push({ atMs, original, successor, originalTrx });
          previous = key;
        }
      } catch {
        // The watcher can lose one sample while the test is closing it.
      }
      if (releaseNow && onSuccessorVisible) await onSuccessorVisible();
      if (!closed) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  let value: T;
  try {
    value = await work;
  } finally {
    closed = true;
    await loop;
  }
  let statementTimers: StatementWatch['statementTimers'] = null;
  try {
    const [history] = await watcher.query<RowDataPacket[]>(
      `SELECT SQL_TEXT AS sqlText, TIMER_START AS timerStart, TIMER_END AS timerEnd
       FROM performance_schema.events_statements_history_long
       WHERE SQL_TEXT LIKE ? OR SQL_TEXT LIKE ?
       ORDER BY TIMER_START`,
      [`%${originalMarker}%`, `%${successorMarker}%`],
    );
    const usable = history.filter((row) => {
      const text = String(row.sqlText ?? '');
      return !text.includes('events_statements_history') && !text.includes('information_schema.processlist');
    });
    const original = usable.filter((row) => String(row.sqlText).includes(originalMarker) && !String(row.sqlText).includes(successorMarker));
    const successor = usable.filter((row) => String(row.sqlText).includes(successorMarker));
    if (!original.length || !successor.length) {
      statementTimers = { unavailable: `history rows original=${original.length} successor=${successor.length}` };
    } else {
      const originalEnd = BigInt(String(original[original.length - 1]?.timerEnd ?? '0'));
      const successorStart = BigInt(String(successor[successor.length - 1]?.timerStart ?? '0'));
      statementTimers = {
        originalEnd: originalEnd.toString(),
        successorStart: successorStart.toString(),
        ordered: successorStart > originalEnd,
      };
    }
  } catch (error) {
    statementTimers = { unavailable: error instanceof Error ? error.message : String(error) };
  }
  return {
    value,
    overlap,
    samples,
    originalSeenAtMs,
    stopEvidenceAtMs,
    successorSeenAtMs,
    transitions,
    statementTimers,
  };
}

const statementConsumers = ['events_statements_current', 'events_statements_history', 'events_statements_history_long'];

async function enableStatementHistory(conn: mysql.Connection): Promise<() => Promise<void>> {
  const [consumers] = await conn.query<RowDataPacket[]>(
    `SELECT NAME AS name, ENABLED AS enabled FROM performance_schema.setup_consumers WHERE NAME IN (${statementConsumers.map(() => '?').join(',')})`,
    statementConsumers,
  );
  const [instruments] = await conn.query<RowDataPacket[]>(
    `SELECT NAME AS name, ENABLED AS enabled, TIMED AS timed
     FROM performance_schema.setup_instruments
     WHERE NAME LIKE 'statement/%' AND (ENABLED <> 'YES' OR TIMED <> 'YES')`,
  );
  await conn.query(
    `UPDATE performance_schema.setup_consumers SET ENABLED = 'YES' WHERE NAME IN (${statementConsumers.map(() => '?').join(',')})`,
    statementConsumers,
  );
  await conn.query("UPDATE performance_schema.setup_instruments SET ENABLED = 'YES', TIMED = 'YES' WHERE NAME LIKE 'statement/%'");
  return async () => {
    for (const row of consumers) {
      await conn.query('UPDATE performance_schema.setup_consumers SET ENABLED = ? WHERE NAME = ?', [row.enabled, row.name]);
    }
    for (const row of instruments) {
      await conn.query(
        'UPDATE performance_schema.setup_instruments SET ENABLED = ?, TIMED = ? WHERE NAME = ?',
        [row.enabled, row.timed, row.name],
      );
    }
  };
}

function expectStopBeforeSuccessor(order: StatementWatch): void {
  expect(order.overlap, JSON.stringify(order.transitions)).toBe(0);
  expect(order.samples).toBeGreaterThan(0);
  expect(order.originalSeenAtMs).not.toBeNull();
  expect(order.stopEvidenceAtMs).not.toBeNull();
  expect(order.successorSeenAtMs).not.toBeNull();
  expect(order.successorSeenAtMs!).toBeGreaterThanOrEqual(order.stopEvidenceAtMs!);
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
  let gate: mysql.Connection | null = null;
  let watcher: mysql.Connection | null = null;
  let restoreHistory: (() => Promise<void>) | null = null;
  let created = false;

  afterAll(async () => {
    try { await holder?.query('ROLLBACK'); } catch { /* The holder may already be closed. */ }
    try { await holder?.query('UNLOCK TABLES'); } catch { /* No metadata lock was held. */ }
    try { await gate?.query('ROLLBACK'); } catch { /* The side-row gate may already be closed. */ }
    await holder?.end().catch(() => undefined);
    await gate?.end().catch(() => undefined);
    await watcher?.end().catch(() => undefined);
    if (restoreHistory && admin) await restoreHistory().catch(() => undefined);
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
      await admin.query(`CREATE TABLE \`${schema}\`.s (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB`);
      await admin.query(`INSERT INTO \`${schema}\`.s (id, note) VALUES (1, 'side')`);
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
      gate = await connect();
      await gate.query(`USE \`${schema}\``);
      watcher = await connect();
      restoreHistory = await enableStatementHistory(admin);
    } catch (error) {
      if (error instanceof Error) error.message = redact(secret, error);
      throw error;
    }

    const rowMarker = 'max373_row_wait';
    const runMarker = 'max373_run_wait';
    const mdlMarker = 'max373_mdl_col';
    const phases: Record<string, unknown> = {};

    await holder!.beginTransaction();
    await holder!.query('SELECT note FROM t WHERE id = 1 FOR UPDATE');
    await holdSideRow(gate!);
    const rowStarted = Date.now();
    const rowUpdate = sqlExecutor.executeSql(
      instanceId,
      `UPDATE t SET note = '${rowMarker}' WHERE id = 1`,
      { approvalGrant: { approvalRequestId: 598, reviewerId: 9, operationId: 'max373-row' }, timeoutMs: 800, userId: '9', username: 'max373' },
    );
    const rowThreads = await waitForMarker(rowMarker);
    const watchedRow = await watchStatementOrder(watcher!, rowMarker, 'max373_follow_row', (async () => {
      let followFinishedFirst = false;
      const follow = sqlExecutor.executeSql(instanceId, successorSql('max373_follow_row'), successorContext('max373-follow-row'))
        .then((result) => {
          if (rowPending) followFinishedFirst = true;
          return result;
        });
      let rowPending = true;
      const rowResult = await rowUpdate;
      rowPending = false;
      const followResult = await follow;
      return { rowResult, followResult, followFinishedFirst };
    })(), async () => {
      await gate!.query('ROLLBACK');
    });
    const { rowResult, followResult, followFinishedFirst } = watchedRow.value;
    phases.row = {
      elapsedMs: Date.now() - rowStarted,
      threads: rowThreads,
      remaining: await visibleThreads(rowMarker),
      error: rowResult.error,
      executionState: rowResult.executionState,
      retryable: rowResult.retryable,
      follow: followResult.success,
      followFinishedFirst,
      overlap: watchedRow.overlap,
      originalSeenAtMs: watchedRow.originalSeenAtMs,
      stopEvidenceAtMs: watchedRow.stopEvidenceAtMs,
      successorSeenAtMs: watchedRow.successorSeenAtMs,
      transitions: watchedRow.transitions,
      statementTimers: watchedRow.statementTimers,
    };
    expectStopBeforeSuccessor(watchedRow);
    expect(rowResult.success).toBe(false);
    expect(rowResult.executionState).toBe('unknown');
    expect(rowResult.retryable).toBe(false);
    expect(rowResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
    expect(rowResult.error).toContain('outcome may be unknown');
    expect(rowResult.error?.toLowerCase()).not.toContain('rolled back');
    expect(phases.row).toMatchObject({ followFinishedFirst: false, remaining: [] });
    expect(rowThreads).toHaveLength(1);
    expect(Date.now() - rowStarted).toBeLessThan(8_000);
    expect(followResult).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
    const [side] = await admin!.query<RowDataPacket[]>(`SELECT note FROM \`${schema}\`.s WHERE id = 1`);
    expect(side[0]?.note).toBe('max373_follow_row');
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
    expect((mocks.finishIntent.mock.calls as unknown as unknown[][]).map((call) => call[1])).toEqual(['unknown', 'succeeded', 'unknown', 'unknown']);
    expect(mocks.beginIntent).toHaveBeenCalledTimes(4);

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
    let localGate: mysql.Connection | null = null;
    let orderWatcher: mysql.Connection | null = null;
    let restoreIsolateHistory: (() => Promise<void>) | undefined;
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
      await localAdmin.query(`CREATE TABLE \`${isolatedSchema}\`.s (id INT PRIMARY KEY, note VARCHAR(64)) ENGINE=InnoDB`);
      await localAdmin.query(`INSERT INTO \`${isolatedSchema}\`.s (id, note) VALUES (1, 'side')`);
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
      localGate = await connect();
      await localGate.query(`USE \`${isolatedSchema}\``);
      orderWatcher = await connect();
      restoreIsolateHistory = await enableStatementHistory(localAdmin);

      const lockMarker = 'max373_iso_lock';
      await localHolder.beginTransaction();
      await localHolder.query('SELECT note FROM t WHERE id = 1 FOR UPDATE');
      await holdSideRow(localGate!);
      const lockStarted = Date.now();
      const lockUpdate = sqlExecutor.executeSql(
        isolatedId,
        `UPDATE t SET note = '${lockMarker}' WHERE id = 1`,
        grantFor('max373-iso-lock'),
      );
      await waitThread(lockMarker);
      const watchedLock = await watchStatementOrder(orderWatcher!, lockMarker, 'max373_follow_iso_lock', (async () => {
        let followFinishedFirst = false;
        const follow = sqlExecutor.executeSql(isolatedId, successorSql('max373_follow_iso_lock'), successorContext('max373-follow-iso-lock'))
          .then((result) => {
            if (!lockDone) followFinishedFirst = true;
            return result;
          });
        let lockDone = false;
        const result = await lockUpdate;
        lockDone = true;
        return { result, follow: await follow, followFinishedFirst };
      })(), async () => {
        await localGate!.query('ROLLBACK');
      });
      expectStopBeforeSuccessor(watchedLock);
      const lockResult = watchedLock.value.result;
      const lockFollowResult = watchedLock.value.follow;
      const lockFollowFirst = watchedLock.value.followFinishedFirst;
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
        overlap: watchedLock.overlap,
        originalSeenAtMs: watchedLock.originalSeenAtMs,
        stopEvidenceAtMs: watchedLock.stopEvidenceAtMs,
        successorSeenAtMs: watchedLock.successorSeenAtMs,
        transitions: watchedLock.transitions,
        statementTimers: watchedLock.statementTimers,
      };
      expect(lockResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
      expect(lockResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
      expect(lockResult.error).toContain('outcome may be unknown');
      expect(lockFollowFirst).toBe(false);
      expect(lockFollowResult).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
      const [lockSide] = await localAdmin.query<RowDataPacket[]>(`SELECT note FROM \`${isolatedSchema}\`.s WHERE id = 1`);
      expect(lockSide[0]?.note).toBe('max373_follow_iso_lock');
      expect(lockedNote[0]?.note).toBe('original');
      expect(phases.lock).toMatchObject({ remaining: 0, transactions: 0 });
      expect(Date.now() - lockStarted).toBeLessThan(8_000);
      await localHolder.query('ROLLBACK');

      const runMarker = 'max373_iso_run';
      await holdSideRow(localGate!);
      const runStarted = Date.now();
      const runUpdate = sqlExecutor.executeSql(
        isolatedId,
        `UPDATE t SET note = '${runMarker}' WHERE id = 1 AND SLEEP(15) = 0`,
        grantFor('max373-iso-run'),
      );
      await waitThread(runMarker);
      const watchedRun = await watchStatementOrder(orderWatcher!, runMarker, 'max373_follow_iso_run', (async () => {
        let followFinishedFirst = false;
        const follow = sqlExecutor.executeSql(isolatedId, successorSql('max373_follow_iso_run'), successorContext('max373-follow-iso-run'))
          .then((result) => {
            if (!runDone) followFinishedFirst = true;
            return result;
          });
        let runDone = false;
        const result = await runUpdate;
        runDone = true;
        return { result, follow: await follow, followFinishedFirst };
      })(), async () => {
        await localGate!.query('ROLLBACK');
      });
      expectStopBeforeSuccessor(watchedRun);
      const runResult = watchedRun.value.result;
      const runFollowResult = watchedRun.value.follow;
      const runFollowFirst = watchedRun.value.followFinishedFirst;
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
        overlap: watchedRun.overlap,
        originalSeenAtMs: watchedRun.originalSeenAtMs,
        stopEvidenceAtMs: watchedRun.stopEvidenceAtMs,
        successorSeenAtMs: watchedRun.successorSeenAtMs,
        transitions: watchedRun.transitions,
        statementTimers: watchedRun.statementTimers,
      };
      expect(runResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
      expect(runResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
      expect(runResult.error).not.toContain('server stop was not confirmed');
      expect(Date.now() - runStarted).toBeGreaterThanOrEqual(1_200);
      expect(Date.now() - runStarted).toBeLessThan(8_000);
      expect(runFollowFirst).toBe(false);
      expect(runFollowResult).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
      const [runSide] = await localAdmin.query<RowDataPacket[]>(`SELECT note FROM \`${isolatedSchema}\`.s WHERE id = 1`);
      expect(runSide[0]?.note).toBe('max373_follow_iso_run');
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
      await holdSideRow(localGate!);
      const killStarted = Date.now();
      const killUpdate = sqlExecutor.executeSql(
        isolatedId,
        `UPDATE t SET note = '${killMarker}' WHERE id = 1 AND SLEEP(15) = 0`,
        grantFor('max373-iso-kill'),
      );
      await waitThread(killMarker);
      const watchedKill = await watchStatementOrder(orderWatcher!, killMarker, 'max373_follow_iso_kill', (async () => {
        let followFinishedFirst = false;
        const follow = sqlExecutor.executeSql(isolatedId, successorSql('max373_follow_iso_kill'), successorContext('max373-follow-iso-kill'))
          .then((result) => {
            if (!killDone) followFinishedFirst = true;
            return result;
          });
        let killDone = false;
        const result = await killUpdate;
        killDone = true;
        return { result, follow: await follow, followFinishedFirst };
      })(), async () => {
        await localGate!.query('ROLLBACK');
      });
      expectStopBeforeSuccessor(watchedKill);
      const killResult = watchedKill.value.result;
      const killFollowResult = watchedKill.value.follow;
      const killFollowFirst = watchedKill.value.followFinishedFirst;
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
        overlap: watchedKill.overlap,
        originalSeenAtMs: watchedKill.originalSeenAtMs,
        stopEvidenceAtMs: watchedKill.stopEvidenceAtMs,
        successorSeenAtMs: watchedKill.successorSeenAtMs,
        transitions: watchedKill.transitions,
        statementTimers: watchedKill.statementTimers,
      };
      expect(killResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
      expect(killResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
      expect(killResult.error).not.toContain('server stop was not confirmed');
      expect(Date.now() - killStarted).toBeGreaterThanOrEqual(1_200);
      expect(Date.now() - killStarted).toBeLessThan(8_000);
      expect(killFollowFirst).toBe(false);
      expect(killFollowResult).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
      const [killSide] = await localAdmin.query<RowDataPacket[]>(`SELECT note FROM \`${isolatedSchema}\`.s WHERE id = 1`);
      expect(killSide[0]?.note).toBe('max373_follow_iso_kill');
      expect(killNote[0]?.note).toBe('original');
      expect(phases.kill).toMatchObject({ remaining: 0, transactions: 0 });

      record.pool = original;
      const evidenceDir = process.env.MAX373_EVIDENCE_DIR;
      if (evidenceDir) fs.writeFileSync(`${evidenceDir}/isolate-phases.json`, `${JSON.stringify(phases, null, 2)}\n`);
    } catch (error) {
      if (error instanceof Error) error.message = redact(password, error);
      throw error;
    } finally {
      if (localAdmin) await restoreIsolateHistory?.().catch(() => undefined);
      restorePool?.();
      try { await localHolder?.query('ROLLBACK'); } catch { /* The holder may already be closed. */ }
      try { await localGate?.query('ROLLBACK'); } catch { /* The side-row gate may already be closed. */ }
      await localHolder?.end().catch(() => undefined);
      await localGate?.end().catch(() => undefined);
      await orderWatcher?.end().catch(() => undefined);
      if (created && localAdmin) await localAdmin.query(`DROP DATABASE IF EXISTS \`${isolatedSchema}\``).catch(() => undefined);
      await localAdmin?.end().catch(() => undefined);
      await small?.end().catch(() => undefined);
      await hanging?.end().catch(() => undefined);
      await databaseService.removeConnection(isolatedId).catch(() => undefined);
    }
  }, 60_000);
});
