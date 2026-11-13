import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { filterByInstanceAccess } from './auth/require-instance-access.js';
import { requirePermission } from './auth/require-permission.js';
import { dbConnection } from './db-connection.js';
import { MigrationError, MigrationRunner, splitSqlStatements } from './migrations/runner.js';
import type { MigrationPool } from './migrations/types.js';
import { reportDatabaseService } from './report-database-service.js';
import {
  SERVER_HAS_HISTORICAL_REPORTS,
  SERVER_HISTORICAL_REPORT_DELETE_ERROR,
  serverDatabaseService as servers,
} from './server-database-service.js';

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const serviceSource = readFileSync(new URL('./server-database-service.ts', import.meta.url), 'utf8');
const migrationSource = readFileSync(new URL('../sql/migrations/152_report_server_delete_restrict.sql', import.meta.url), 'utf8');
const deletionRoute = serverSource.slice(
  serverSource.indexOf("  fastify.delete('/api/servers/:id'"),
  serverSource.indexOf("  fastify.post('/api/servers/test-connection'"),
);
const deleteMethod = serviceSource.slice(serviceSource.indexOf('async deleteServer'), serviceSource.indexOf('async testConnection'));
const reportListRoute = serverSource.slice(
  serverSource.indexOf("  fastify.get('/api/reports'"),
  serverSource.indexOf('  // ========== 定时报表配置 API =========='),
);

describe('MAX-368 server deletion keeps historical reports', () => {
  it('checks reports inside the server lock and leaves the runs_on guard ahead of delete', () => {
    expect(deleteMethod).toContain('beginTransaction()');
    expect(deleteMethod).toMatch(/SELECT id FROM servers WHERE id = \? FOR UPDATE/);
    expect(deleteMethod).toContain("relation_type = 'runs_on'");
    expect(deleteMethod).toContain('SELECT id FROM reports WHERE server_id = ? LIMIT 1 FOR UPDATE');
    expect(deleteMethod).toContain('SERVER_HAS_HISTORICAL_REPORTS');
    expect(deleteMethod).toContain('ER_ROW_IS_REFERENCED_2');
    const relationAt = deleteMethod.indexOf("relation_type = 'runs_on'");
    const reportAt = deleteMethod.indexOf('SELECT id FROM reports WHERE server_id = ? LIMIT 1 FOR UPDATE');
    const deleteAt = deleteMethod.indexOf('DELETE FROM servers WHERE id = ?');
    expect(relationAt).toBeGreaterThan(-1);
    expect(relationAt).toBeLessThan(reportAt);
    expect(reportAt).toBeLessThan(deleteAt);
    expect(deleteMethod.indexOf('FOR UPDATE')).toBeLessThan(deleteAt);
  });

  it('replaces the historical report foreign key in one statement', () => {
    expect(splitSqlStatements(migrationSource)).toHaveLength(1);
    expect(migrationSource).toContain('DROP FOREIGN KEY fk_report_server');
    expect(migrationSource).toContain('ADD CONSTRAINT fk_report_server_restrict');
    expect(migrationSource).toContain('ON DELETE RESTRICT');
    expect(migrationSource).toContain('ALGORITHM=COPY');
    expect(migrationSource).toContain('LOCK=SHARED');
    expect(migrationSource).not.toContain('fk_rc_server');
    expect(migrationSource).not.toContain('fk_server_metrics_server');
    expect(migrationSource).not.toContain('ON DELETE CASCADE');
  });

  it('returns a business error from the existing delete route without changing report read permission', () => {
    expect(deletionRoute).toContain("requirePermission('servers:manage')");
    expect(deletionRoute).toContain('SERVER_HAS_HISTORICAL_REPORTS');
    expect(deletionRoute).toContain('reply.code(409)');
    expect(deletionRoute).toContain('SERVER_HISTORICAL_REPORT_DELETE_ERROR');
    expect(deletionRoute).not.toContain('auditLogManager');
    expect(reportListRoute).toContain("requirePermission('report:view')");
    expect(reportListRoute).toContain('filterByInstanceAccess');
  });
});

type MysqlEnv = Record<string, string | undefined>;

function acceptanceEnabled(env: MysqlEnv = process.env): boolean {
  return env.MAX368_MYSQL === '1';
}

function readMysqlTestProfile(env: MysqlEnv = process.env): { host: string; port: number; user: string; password: string } {
  const host = env.MAX368_MYSQL_HOST;
  const portText = env.MAX368_MYSQL_PORT;
  const user = env.MAX368_MYSQL_USER;
  const password = env.MAX368_MYSQL_PASSWORD;
  const port = Number(portText);
  if (host !== '127.0.0.1' || portText !== '3308' || !Number.isInteger(port) || !user || !password) {
    throw new Error(
      'MAX368_MYSQL=1 requires MAX368_MYSQL_HOST=127.0.0.1, MAX368_MYSQL_PORT=3308, MAX368_MYSQL_USER, and MAX368_MYSQL_PASSWORD',
    );
  }
  return { host, port, user, password };
}

function evidenceDirectory(env: MysqlEnv = process.env): string {
  const directory = env.MAX368_EVIDENCE_DIR?.trim();
  if (!directory) throw new Error('MAX368_MYSQL=1 requires MAX368_EVIDENCE_DIR for this task evidence directory');
  return directory;
}

const realMysql = acceptanceEnabled();
let evidenceDirectoryPath: string | null = null;
const evidence: Record<string, unknown> = {
  task: 'MAX-368',
  github: 472,
  mode: realMysql ? 'real-mysql3308-isolated-schema' : 'source-contract-only',
  // The database assertions use mysql3308. This does not mean the whole
  // request path is free of test doubles: JWT login is not exercised.
  mock_used_for_acceptance: {
    database: false,
    jwt_login_chain: 'not tested',
    permission_check: 'production requirePermission; the test Fastify hook injects the user',
  },
};

describe('MAX-368 injected mysql acceptance config', () => {
  it('stays off unless real mysql acceptance is explicitly enabled', () => {
    expect(acceptanceEnabled({})).toBe(false);
    expect(acceptanceEnabled({ MAX368_MYSQL: '0' })).toBe(false);
  });

  it('fails when real acceptance is enabled without the injected 3308 endpoint', () => {
    expect(() => readMysqlTestProfile({ MAX368_MYSQL: '1' })).toThrow(/MAX368_MYSQL_PORT=3308/);
    expect(() => readMysqlTestProfile({
      MAX368_MYSQL: '1',
      MAX368_MYSQL_HOST: '127.0.0.1',
      MAX368_MYSQL_PORT: '3306',
      MAX368_MYSQL_USER: 'root',
      MAX368_MYSQL_PASSWORD: 'injected',
    })).toThrow(/MAX368_MYSQL_PORT=3308/);
  });

  it('fails when real acceptance is enabled without an evidence directory', () => {
    expect(() => evidenceDirectory({})).toThrow(/MAX368_EVIDENCE_DIR/);
    expect(() => evidenceDirectory({ MAX368_EVIDENCE_DIR: '   ' })).toThrow(/MAX368_EVIDENCE_DIR/);
  });

  it('accepts an injected 3308 endpoint and evidence directory', () => {
    expect(readMysqlTestProfile({
      MAX368_MYSQL_HOST: '127.0.0.1',
      MAX368_MYSQL_PORT: '3308',
      MAX368_MYSQL_USER: 'root',
      MAX368_MYSQL_PASSWORD: 'injected',
    })).toEqual({ host: '127.0.0.1', port: 3308, user: 'root', password: 'injected' });
    expect(evidenceDirectory({ MAX368_EVIDENCE_DIR: '/tmp/max368-evidence' })).toBe('/tmp/max368-evidence');
  });
});

describe.skipIf(!realMysql)('MAX-368 real delete service on isolated mysql3308', () => {
  const database = `max368_${process.pid}`;
  let admin: Pool;
  let pool: Pool;
  let lease: DatabaseLease | null = null;
  const counts = [
    'audit_log_entries', 'ssh_trust_decisions', 'permissions', 'role_permissions', 'user_roles',
    'server_metrics', 'metric_collect_requests', 'workflow_jobs',
  ];

  beforeAll(async () => {
    const profile = readMysqlTestProfile();
    evidenceDirectoryPath = evidenceDirectory();
    expect(profile.port).toBe(3308);
    expect(profile.host).toBe('127.0.0.1');
    try {
      admin = mysql.createPool({
        host: profile.host, port: profile.port, user: profile.user, password: profile.password,
        connectionLimit: 4, timezone: 'Z',
      });
      await admin.query('SELECT 1 AS ok');
    } catch (error) {
      throw sanitize(error, profile.password);
    }
    const [identity] = await admin.query<RowDataPacket[]>('SELECT @@port AS port, @@version AS version, @@hostname AS hostname');
    evidence.endpoint = { host: profile.host, port: profile.port };
    evidence.server = {
      in_container_port: Number(identity[0].port),
      version: identity[0].version,
      hostname: identity[0].hostname,
    };
    const [schemas] = await admin.query<RowDataPacket[]>('SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA');
    const names = schemas.map(row => String(row.name));
    evidence.schema_present_before = names.filter(name => name.startsWith('max368_') || name === 'db_ops_ai');
    const [activity] = await admin.query<RowDataPacket[]>(
      `SELECT DB AS db, COMMAND AS command, TIME AS time FROM information_schema.processlist WHERE DB IS NOT NULL`,
    );
    evidence.other_activity = activity.map(row => ({ db: row.db, command: row.command, time: Number(row.time) }));
    lease = await claimIsolatedDatabase(admin, database);
    pool = mysql.createPool({
      host: profile.host, port: profile.port, user: profile.user, password: profile.password,
      database, connectionLimit: 6, timezone: 'Z',
    });
    pool.on('connection', (connection) => {
      connection.query('SET innodb_lock_wait_timeout = 8');
    });
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      await new MigrationRunner(pool as unknown as MigrationPool).run();
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
    const [current] = await pool.query<RowDataPacket[]>('SELECT DATABASE() AS db');
    expect(current[0].db).toBe(database);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as unknown as mysql.Pool);
  }, 180000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await pool?.end().catch(() => undefined);
    if (admin) {
      const ownedByThisRun = lease?.owned === true;
      if (ownedByThisRun) {
        await releaseIsolatedDatabase(admin, lease).catch((error: unknown) => {
          evidence.cleanup_error = error instanceof Error ? 'drop database failed' : 'drop database failed';
        });
        const [left] = await admin.query<RowDataPacket[]>(
          'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database],
        );
        evidence.schema_removed = left.length === 0;
      } else {
        evidence.schema_removed = false;
        evidence.cleanup = 'skipped because this run did not create the database';
      }
      await admin.end();
    }
  });

  it('blocks deletion, preserves identity, and rejects a second delete the same way', async () => {
    const serverId = await insertServer('203.0.113.68', 36821);
    await pool.execute(
      `INSERT INTO server_metrics (server_id, metric_name, metric_value, recorded_at) VALUES (?, 'cpu_usage', 1, '2026-01-01 00:00:00')`,
      [serverId],
    );
    const [reportInsert] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO reports (name, type, format, server_id, instance_id, content, status)
       VALUES ('MAX-368 historical', 'server_health', 'json', ?, NULL, 'max368-historical-report', 'completed')`,
      [serverId],
    );
    const reportId = Number(reportInsert.insertId);
    const identityBefore = await identity(serverId, reportId);
    const before = await snapshot();

    const anonymous = await callDelete(serverId, null);
    expect(anonymous.status).toBe(401);
    const denied = await callDelete(serverId, { permissions: ['report:view'] });
    expect(denied.status).toBe(403);
    const allowed = await callDelete(serverId, { permissions: ['servers:manage'], username: 'max368-manager' });
    expect(allowed.status).toBe(409);
    expect(allowed.body).toEqual({
      error: SERVER_HISTORICAL_REPORT_DELETE_ERROR,
      code: SERVER_HAS_HISTORICAL_REPORTS,
    });
    const repeated = await servers.deleteServer(serverId);
    expect(repeated).toEqual({ success: false, error: SERVER_HAS_HISTORICAL_REPORTS });

    const identityAfter = await identity(serverId, reportId);
    expect(identityAfter).toEqual(identityBefore);
    const report = await reportDatabaseService.getReportById(reportId);
    expect(report).toMatchObject({
      id: reportId, server_id: serverId, server_name: '203.0.113.68', instance_id: null,
      content: 'max368-historical-report', name: 'MAX-368 historical',
    });
    const scopedReader = { permissions: ['report:view'], instanceScopes: { 9: 'read-only' as const } };
    expect(filterByInstanceAccess(scopedReader, [report!], row => row.instance_id)).toEqual([report]);
    const reply = fakeReply();
    await requirePermission('report:view')({ user: { permissions: ['servers:manage'] } }, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(await snapshot()).toEqual(before);
    const [metrics] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM server_metrics WHERE server_id = ?', [serverId]);
    expect(Number(metrics[0].count)).toBe(1);
    evidence.blocked_delete = {
      http_status: allowed.status,
      service_error: repeated.error,
      repeat_error: repeated.error,
      anonymous_status: anonymous.status,
      permission_denied_status: denied.status,
      report_view_without_manage: 403,
      identity_unchanged: true,
      collection_enabled: identityAfter.collection_enabled,
      audit_and_grant_counts_unchanged: true,
      metric_rows: 1,
    };
  });

  it('still deletes a server with no report, including one whose runs_on relation has ended', async () => {
    const openId = await insertServer('203.0.113.68', 36822);
    await pool.execute(
      `INSERT INTO resource_relations
         (source_type, source_id, target_type, target_id, relation_type, provenance)
       VALUES ('instance', 1, 'server', ?, 'runs_on', 'max368')`,
      [openId],
    );
    expect(await servers.deleteServer(openId)).toEqual({ success: false, error: 'SERVER_HAS_INSTANCE_RELATIONS' });
    const [openLeft] = await pool.query<RowDataPacket[]>('SELECT id FROM servers WHERE id = ?', [openId]);
    expect(openLeft).toHaveLength(1);

    const endedId = await insertServer('203.0.113.68', 36823);
    await pool.execute(
      `INSERT INTO resource_relations
         (source_type, source_id, target_type, target_id, relation_type, provenance, valid_until)
       VALUES ('instance', 1, 'server', ?, 'runs_on', 'max368', '2000-01-01 00:00:00.000000')`,
      [endedId],
    );
    const removed = await callDelete(endedId, { permissions: ['servers:manage'] });
    expect(removed.status).toBe(200);
    expect(await servers.deleteServer(endedId)).toEqual({ success: false, error: '服务器不存在' });
    const [endedLeft] = await pool.query<RowDataPacket[]>('SELECT id FROM servers WHERE id = ?', [endedId]);
    expect(endedLeft).toHaveLength(0);
    evidence.no_report_delete = { active_relation: 'SERVER_HAS_INSTANCE_RELATIONS', ended_relation_deleted: true, repeat: '服务器不存在' };
  });

  it('keeps a report that commits while the delete transaction is waiting, and the foreign key rejects a raw delete', async () => {
    const serverId = await insertServer('203.0.113.68', 36824);
    const holder = await pool.getConnection();
    try {
      await holder.beginTransaction();
      const [inserted] = await holder.execute<mysql.ResultSetHeader>(
        `INSERT INTO reports (name, type, format, server_id, content, status)
         VALUES ('MAX-368 concurrent', 'server_health', 'json', ?, 'concurrent-body', 'completed')`,
        [serverId],
      );
      const pending = servers.deleteServer(serverId);
      const sawWait = await seenLockWait();
      await holder.commit();
      const result = await pending;
      expect(sawWait).toBe(true);
      expect(result).toEqual({ success: false, error: SERVER_HAS_HISTORICAL_REPORTS });
      const [rows] = await pool.query<RowDataPacket[]>('SELECT id, server_id, content FROM reports WHERE id = ?', [inserted.insertId]);
      expect(rows).toEqual([expect.objectContaining({ server_id: serverId, content: 'concurrent-body' })]);
      const raw: { rejected: boolean; errno?: number; code?: string } = await pool.query('DELETE FROM servers WHERE id = ?', [serverId]).then(
        () => ({ rejected: false }),
        (error: { errno?: number; code?: string }) => ({ rejected: true, errno: error.errno, code: error.code }),
      );
      expect(raw).toMatchObject({ rejected: true, errno: 1451 });
      const [still] = await pool.query<RowDataPacket[]>('SELECT id FROM reports WHERE id = ?', [inserted.insertId]);
      expect(still).toHaveLength(1);
      const [rule] = await pool.query<RowDataPacket[]>(
        `SELECT DELETE_RULE AS delete_rule FROM information_schema.REFERENTIAL_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_report_server_restrict'`,
      );
      expect(rule[0].delete_rule).toBe('RESTRICT');
      evidence.concurrent_insert = { saw_lock_wait: sawWait, service_error: result.error, raw_delete_errno: raw.errno, delete_rule: rule[0].delete_rule };
    } finally {
      await holder.rollback().catch(() => undefined);
      holder.release();
    }
  });

  it('does not leave a report behind when a no-report delete holds the server lock', async () => {
    const serverId = await insertServer('203.0.113.68', 36825);
    const holder = await pool.getConnection();
    let inserter: PoolConnection | undefined;
    try {
      await holder.beginTransaction();
      await holder.execute('SELECT id FROM servers WHERE id = ? FOR UPDATE', [serverId]);
      inserter = await pool.getConnection();
      const insert = inserter.execute(
        `INSERT INTO reports (name, type, format, server_id, content, status)
         VALUES ('MAX-368 late', 'server_health', 'json', ?, 'late-body', 'completed')`,
        [serverId],
      );
      const sawWait = await seenLockWait();
      await holder.execute('DELETE FROM servers WHERE id = ?', [serverId]);
      await holder.commit();
      const failure = await insert.then(() => null, (error: { errno?: number; code?: string }) => error);
      expect(sawWait).toBe(true);
      expect(failure).toMatchObject({ errno: 1452 });
      const [reports] = await pool.query<RowDataPacket[]>('SELECT id FROM reports WHERE server_id = ?', [serverId]);
      const [left] = await pool.query<RowDataPacket[]>('SELECT id FROM servers WHERE id = ?', [serverId]);
      expect(reports).toHaveLength(0);
      expect(left).toHaveLength(0);
      evidence.lock_held_insert = { saw_lock_wait: sawWait, insert_errno: failure?.errno ?? null, reports_left: 0, server_left: 0 };
    } finally {
      await holder.rollback().catch(() => undefined);
      holder.release();
      inserter?.release();
    }
  });

  async function insertServer(host: string, port: number): Promise<number> {
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO servers (host, port, label, os_type, credential_type, credential_encrypted, collection_enabled)
       VALUES (?, ?, 'max368-isolated', 'Other', 'password', 'max368-placeholder', 0)`,
      [host, port],
    );
    return Number(result.insertId);
  }

  async function identity(serverId: number, reportId: number) {
    const [serverRows] = await pool.query<RowDataPacket[]>(
      'SELECT id, host, port, label, collection_enabled FROM servers WHERE id = ?', [serverId],
    );
    const [reportRows] = await pool.query<RowDataPacket[]>(
      'SELECT id, server_id, instance_id, name, content FROM reports WHERE id = ?', [reportId],
    );
    const server = serverRows[0];
    const report = reportRows[0];
    return {
      id: Number(server.id),
      host: String(server.host),
      port: Number(server.port),
      label: String(server.label),
      collection_enabled: Number(server.collection_enabled),
      report: {
        id: Number(report.id),
        server_id: Number(report.server_id),
        instance_id: report.instance_id == null ? null : Number(report.instance_id),
        name: String(report.name),
        content: String(report.content),
      },
    };
  }

  async function snapshot() {
    const result: Record<string, number> = {};
    for (const table of counts) {
      const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM \`${table}\``);
      result[table] = Number(rows[0].count);
    }
    return result;
  }

  async function seenLockWait(): Promise<boolean> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS waits FROM performance_schema.data_lock_waits w
         JOIN performance_schema.data_locks requested ON requested.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
         WHERE requested.OBJECT_SCHEMA = ?`,
        [database],
      );
      if (Number(rows[0].waits) > 0) return true;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return false;
  }

  async function callDelete(id: number, user: Record<string, unknown> | null) {
    const route = ts.transpileModule(deletionRoute, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const app = Fastify();
    const verifyToken = async (request: { headers: Record<string, string | undefined>; user?: unknown }) => {
      if (user) request.user = user;
    };
    new Function(
      'fastify', 'verifyToken', 'requirePermission', 'serverDatabaseService',
      'SERVER_HAS_HISTORICAL_REPORTS', 'SERVER_HISTORICAL_REPORT_DELETE_ERROR',
      route,
    )(app, verifyToken, requirePermission, servers, SERVER_HAS_HISTORICAL_REPORTS, SERVER_HISTORICAL_REPORT_DELETE_ERROR);
    try {
      const response = await app.inject({ method: 'DELETE', url: `/api/servers/${id}` });
      return { status: response.statusCode, body: response.json() };
    } finally {
      await app.close();
    }
  }
});

describe('MAX-368 isolated database cleanup ownership', () => {
  it('does not drop a sentinel when the name already exists', async () => {
    const server = memoryServer(['max368_sentinel']);
    await expect(claimIsolatedDatabase(server, 'max368_sentinel')).rejects.toThrow(/refusing to adopt existing database/);
    expect(await releaseIsolatedDatabase(server, { name: 'max368_sentinel', owned: false })).toBe(false);
    expect(await releaseIsolatedDatabase(server, null)).toBe(false);
    expect(server.dropped).toEqual([]);
    expect(server.schemas.has('max368_sentinel')).toBe(true);
  });

  it('does not drop a sentinel when create fails', async () => {
    const server = memoryServer(['max368_sentinel']);
    await expect(claimIsolatedDatabase(server, 'max368_new_run', async () => {
      throw new Error('create failed before the schema existed');
    })).rejects.toThrow(/create failed before the schema existed/);
    expect(await releaseIsolatedDatabase(server, { name: 'max368_new_run', owned: false })).toBe(false);
    expect(server.dropped).toEqual([]);
    expect(server.schemas.has('max368_sentinel')).toBe(true);
    expect(server.schemas.has('max368_new_run')).toBe(false);
  });

  it('drops only the database this claim created', async () => {
    const server = memoryServer(['max368_sentinel']);
    const lease = await claimIsolatedDatabase(server, 'max368_created');
    expect(lease.owned).toBe(true);
    expect(await releaseIsolatedDatabase(server, lease)).toBe(true);
    expect(lease.owned).toBe(false);
    expect(server.dropped).toEqual(['max368_created']);
    expect(server.schemas.has('max368_sentinel')).toBe(true);
    expect(server.schemas.has('max368_created')).toBe(false);
  });
});

describe.skipIf(!realMysql)('MAX-368 mysql3308 ownership and migration 152', () => {
  it('keeps a real sentinel when the name conflicts or creation fails', async () => {
    const profile = readMysqlTestProfile();
    const admin = mysql.createPool({
      host: profile.host, port: profile.port, user: profile.user, password: profile.password,
      connectionLimit: 2, timezone: 'Z',
    });
    const nonce = randomBytes(4).toString('hex');
    const sentinelName = `max368_sentinel_${nonce}`;
    let sentinel: DatabaseLease | null = null;
    try {
      sentinel = await claimIsolatedDatabase(admin, sentinelName);
      await admin.query(`CREATE TABLE \`${sentinelName}\`.sentinel_marker (id INT PRIMARY KEY)`);
      await admin.query(`INSERT INTO \`${sentinelName}\`.sentinel_marker (id) VALUES (1)`);
      await expect(claimIsolatedDatabase(admin, sentinelName)).rejects.toThrow(/refusing to adopt existing database/);
      expect(await releaseIsolatedDatabase(admin, { name: sentinelName, owned: false })).toBe(false);
      const failedName = `max368_uncreated_${nonce}`;
      await expect(claimIsolatedDatabase(admin, failedName, async () => {
        throw new Error('create failed before the schema existed');
      })).rejects.toThrow(/create failed before the schema existed/);
      expect(await releaseIsolatedDatabase(admin, { name: failedName, owned: false })).toBe(false);
      const [marker] = await admin.query<RowDataPacket[]>(`SELECT id FROM \`${sentinelName}\`.sentinel_marker`);
      expect(Number(marker[0].id)).toBe(1);
      const [ghost] = await admin.query<RowDataPacket[]>(
        'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
        [failedName],
      );
      expect(ghost).toHaveLength(0);
      evidence.ownership_regression = { conflict_preserved_sentinel: true, create_failure_left_no_schema: true };
    } finally {
      if (sentinel) await releaseIsolatedDatabase(admin, sentinel).catch(() => undefined);
      await admin.end();
    }
  }, 60000);

  it('upgrades existing reports while concurrent writes wait, without dropping the foreign key', async () => {
    const prior = migrationsExcept152();
    const nonce = randomBytes(4).toString('hex');
    try {
      await withOwnedDatabase(`max368_upgrade_${nonce}`, async (pool, database) => {
        await runMigrations(pool, prior);
        const keptId = await insertPlainServer(pool, 36871);
        const otherId = await insertPlainServer(pool, 36872);
        const [historical] = await pool.execute<mysql.ResultSetHeader>(
          `INSERT INTO reports (name, type, format, server_id, content, status)
           VALUES ('MAX-368 upgrade', 'server_health', 'json', ?, 'upgrade-body', 'completed')`,
          [keptId],
        );
        const historicalId = Number(historical.insertId);
        const loader = await pool.getConnection();
        try {
          await loader.query('SET SESSION cte_max_recursion_depth = 1000000');
          await loader.query(
            `INSERT INTO reports (name, type, format, server_id, content, status)
             WITH RECURSIVE seq AS (
               SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < ?
             )
             SELECT 'bulk', 'server_health', 'json', ?, 'bulk-body', 'completed' FROM seq`,
            [UPGRADE_ROWS, keptId],
          );
        } finally {
          loader.release();
        }
        const before = await reportCount(pool, keptId);
        const migration = runMigrations(pool);
        const deleter = await pool.getConnection();
        const writer = await pool.getConnection();
        let deletePromise: Promise<{ rejected: boolean; errno: number }> = Promise.resolve({ rejected: false, errno: 0 });
        let insertPromise: Promise<mysql.ResultSetHeader> = Promise.resolve({ insertId: 0 } as mysql.ResultSetHeader);
        try {
          const sawCopy = await waitForProcess(pool, database, /copy to tmp table|altering table|fk_report_server_restrict/);
          expect(sawCopy).toBe(true);
          deletePromise = deleter.query('DELETE FROM servers WHERE id = ?', [keptId]).then(
            () => ({ rejected: false, errno: 0 }),
            (error: { errno?: number }) => ({ rejected: true, errno: error.errno ?? 0 }),
          );
          insertPromise = writer.execute<mysql.ResultSetHeader>(
            `INSERT INTO reports (name, type, format, server_id, content, status)
             VALUES ('MAX-368 during', 'server_health', 'json', ?, 'during-body', 'completed')`,
            [otherId],
          ).then(([header]) => header);
          expect(await waitForProcess(pool, database, /Waiting for table metadata lock/)).toBe(true);
          await migration;
          const deleted = await deletePromise;
          const inserted = await insertPromise;
          expect(deleted).toEqual({ rejected: true, errno: 1451 });
          expect(Number(inserted.insertId)).toBeGreaterThan(0);
        } finally {
          await migration.catch(() => undefined);
          await Promise.allSettled([deletePromise, insertPromise]);
          deleter.release();
          writer.release();
        }
        expect(await reportCount(pool, keptId)).toBe(before);
        const [kept] = await pool.query<RowDataPacket[]>(
          'SELECT server_id, content FROM reports WHERE id = ?', [historicalId],
        );
        expect(kept[0]).toMatchObject({ server_id: keptId, content: 'upgrade-body' });
        const [during] = await pool.query<RowDataPacket[]>(
          `SELECT server_id, content FROM reports WHERE content = 'during-body'`,
        );
        expect(during[0]).toMatchObject({ server_id: otherId, content: 'during-body' });
        const rules = await reportForeignKeys(pool);
        expect(rules).toEqual([{ name: 'fk_report_server_restrict', delete_rule: 'RESTRICT' }]);
        const [device] = await pool.query<RowDataPacket[]>(
          `SELECT DELETE_RULE AS delete_rule FROM information_schema.REFERENTIAL_CONSTRAINTS
           WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_report_network_device'`,
        );
        expect(device[0].delete_rule).toBe('CASCADE');
        const [index] = await pool.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS count FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reports' AND INDEX_NAME = 'idx_report_server_id'`,
        );
        expect(Number(index[0].count)).toBeGreaterThan(0);
        evidence.migration_upgrade = {
          separate_from_delete_service_e2e: true,
          existing_reports_preserved: before,
          concurrent_delete_errno: 1451,
          concurrent_insert_committed: true,
          delete_rule: 'RESTRICT',
          network_device_fk: 'CASCADE',
        };
      });
    } finally {
      rmSync(prior, { recursive: true, force: true });
    }
  }, 300000);

  it('keeps the old foreign key when 152 fails and does not replay the migration', async () => {
    const prior = migrationsExcept152();
    const nonce = randomBytes(4).toString('hex');
    try {
      await withOwnedDatabase(`max368_fail_${nonce}`, async (pool) => {
        await runMigrations(pool, prior);
        const serverId = await insertPlainServer(pool, 36873);
        const [report] = await pool.execute<mysql.ResultSetHeader>(
          `INSERT INTO reports (name, type, format, server_id, content, status)
           VALUES ('MAX-368 still cascaded', 'server_health', 'json', ?, 'cascade-body', 'completed')`,
          [serverId],
        );
        const reportId = Number(report.insertId);
        const planter = await pool.getConnection();
        try {
          await planter.query('SET FOREIGN_KEY_CHECKS = 0');
          await planter.query(
            `INSERT INTO reports (name, type, format, server_id, content, status)
             VALUES ('MAX-368 orphan', 'server_health', 'json', 4294967295, 'orphan-body', 'completed')`,
          );
          await planter.query('SET FOREIGN_KEY_CHECKS = 1');
        } finally {
          await planter.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => undefined);
          planter.release();
        }
        await expect(runMigrations(pool)).rejects.toBeInstanceOf(MigrationError);
        expect(await reportForeignKeys(pool)).toEqual([{ name: 'fk_report_server', delete_rule: 'CASCADE' }]);
        await pool.query('DELETE FROM reports WHERE server_id = 4294967295');
        await expect(runMigrations(pool)).rejects.toThrow(/requires explicit repair/);
        expect(await reportForeignKeys(pool)).toEqual([{ name: 'fk_report_server', delete_rule: 'CASCADE' }]);
        const [ledger] = await pool.query<RowDataPacket[]>(
          `SELECT status FROM app_schema_migrations WHERE migration_id = '152_report_server_delete_restrict.sql'`,
        );
        expect(ledger[0].status).toBe('failed');
        await pool.query('DELETE FROM servers WHERE id = ?', [serverId]);
        const [left] = await pool.query<RowDataPacket[]>('SELECT id FROM reports WHERE id = ?', [reportId]);
        const [serverLeft] = await pool.query<RowDataPacket[]>('SELECT id FROM servers WHERE id = ?', [serverId]);
        expect(left).toHaveLength(0);
        expect(serverLeft).toHaveLength(0);
        evidence.migration_failure = {
          replayed: false,
          delete_rule_after_rejected_retry: 'CASCADE',
          old_constraint_still_cascades: true,
        };
      });
    } finally {
      rmSync(prior, { recursive: true, force: true });
    }
  }, 300000);
});

function fakeReply() {
  const reply = { code: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply);
  return reply;
}

function sanitize(error: unknown, secret: string): Error {
  const message = error instanceof Error ? error.message : 'mysql-test connection failed';
  return new Error(message.split(secret).join('[redacted]'));
}

const SAFE_DATABASE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const UPGRADE_ROWS = 120000;

type SqlClient = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
};

type DatabaseLease = {
  name: string;
  owned: boolean;
};

async function schemaExists(client: SqlClient, name: string): Promise<boolean> {
  const result = await client.query(
    'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
    [name],
  );
  const rows = Array.isArray(result) ? result[0] : [];
  return Array.isArray(rows) && rows.length > 0;
}

async function claimIsolatedDatabase(
  client: SqlClient,
  name: string,
  create?: () => Promise<void>,
): Promise<DatabaseLease> {
  if (!SAFE_DATABASE_NAME.test(name)) throw new Error(`refusing unexpected database name ${name}`);
  const lease: DatabaseLease = { name, owned: false };
  if (await schemaExists(client, name)) throw new Error(`refusing to adopt existing database ${name}`);
  try {
    if (create) await create();
    else await client.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch (error) {
    lease.owned = false;
    throw error;
  }
  lease.owned = true;
  return lease;
}

async function releaseIsolatedDatabase(client: SqlClient, lease: DatabaseLease | null): Promise<boolean> {
  if (!lease?.owned) return false;
  if (!SAFE_DATABASE_NAME.test(lease.name)) throw new Error(`refusing to drop unexpected database name ${lease.name}`);
  await client.query(`DROP DATABASE IF EXISTS \`${lease.name}\``);
  lease.owned = false;
  return true;
}

function memoryServer(initial: string[]) {
  const schemas = new Set(initial);
  const dropped: string[] = [];
  const client: SqlClient = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes('information_schema.SCHEMATA')) {
        const name = String(values?.[0] ?? '');
        return [schemas.has(name) ? [{ name }] : []];
      }
      const identifier = /`([^`]+)`/.exec(sql)?.[1] ?? '';
      if (sql.startsWith('CREATE DATABASE')) {
        if (schemas.has(identifier)) throw new Error('database exists');
        schemas.add(identifier);
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('DROP DATABASE')) {
        dropped.push(identifier);
        schemas.delete(identifier);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected sql ${sql}`);
    },
  };
  return { schemas, dropped, ...client };
}

function migrationsExcept152(): string {
  const source = fileURLToPath(new URL('../sql/migrations/', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'max368-mig-'));
  for (const file of readdirSync(source)) {
    if (!/^\d+_.+\.sql$/.test(file) || file.startsWith('152_')) continue;
    symlinkSync(join(source, file), join(dir, file));
  }
  return dir;
}

async function runMigrations(pool: Pool, directory?: string): Promise<void> {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    await new MigrationRunner(pool as unknown as MigrationPool, directory).run();
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  }
}

async function withOwnedDatabase(
  name: string,
  body: (pool: Pool, database: string) => Promise<void>,
): Promise<void> {
  const profile = readMysqlTestProfile();
  const admin = mysql.createPool({
    host: profile.host, port: profile.port, user: profile.user, password: profile.password,
    connectionLimit: 2, timezone: 'Z',
  });
  let lease: DatabaseLease | null = null;
  let pool: Pool | undefined;
  try {
    lease = await claimIsolatedDatabase(admin, name);
    pool = mysql.createPool({
      host: profile.host, port: profile.port, user: profile.user, password: profile.password,
      database: name, connectionLimit: 8, timezone: 'Z',
    });
    pool.on('connection', (connection) => {
      connection.query('SET SESSION innodb_lock_wait_timeout = 60');
      connection.query('SET SESSION lock_wait_timeout = 120');
    });
    await body(pool, name);
  } finally {
    await pool?.end().catch(() => undefined);
    if (lease) await releaseIsolatedDatabase(admin, lease).catch(() => undefined);
    await admin.end();
  }
}

async function insertPlainServer(pool: Pool, port: number): Promise<number> {
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO servers (host, port, label, os_type, credential_type, credential_encrypted, collection_enabled)
     VALUES ('203.0.113.68', ?, 'max368-upgrade', 'Other', 'password', 'max368-placeholder', 0)`,
    [port],
  );
  return Number(result.insertId);
}

async function reportCount(pool: Pool, serverId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM reports WHERE server_id = ?',
    [serverId],
  );
  return Number(rows[0].count);
}

async function reportForeignKeys(pool: Pool): Promise<Array<{ name: string; delete_rule: string }>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT CONSTRAINT_NAME AS name, DELETE_RULE AS delete_rule
     FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'reports'
       AND CONSTRAINT_NAME IN ('fk_report_server', 'fk_report_server_restrict')
     ORDER BY CONSTRAINT_NAME`,
  );
  return rows.map(row => ({ name: String(row.name), delete_rule: String(row.delete_rule) }));
}

afterAll(() => {
  if (!realMysql || !evidenceDirectoryPath) return;
  mkdirSync(evidenceDirectoryPath, { recursive: true });
  writeFileSync(join(evidenceDirectoryPath, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`);
});

async function waitForProcess(pool: Pool, database: string, pattern: RegExp): Promise<boolean> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT STATE AS state, INFO AS info FROM information_schema.processlist WHERE DB = ?',
      [database],
    );
    if (rows.some(row => pattern.test(`${row.state ?? ''} ${row.info ?? ''}`))) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}
