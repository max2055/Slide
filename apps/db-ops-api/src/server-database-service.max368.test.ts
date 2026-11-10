import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Fastify from 'fastify';
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { filterByInstanceAccess } from './auth/require-instance-access.js';
import { requirePermission } from './auth/require-permission.js';
import { dbConnection } from './db-connection.js';
import { MigrationRunner } from './migrations/runner.js';
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

  it('restricts only the historical report foreign key', () => {
    expect(migrationSource).toContain('DROP FOREIGN KEY fk_report_server');
    expect(migrationSource).toContain('ON DELETE RESTRICT');
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

const realMysql = process.env.MAX368_MYSQL === '1';
const evidence: Record<string, unknown> = {
  task: 'MAX-368',
  github: 472,
  mode: realMysql ? 'real-mysql3308-isolated-schema' : 'source-contract-only',
  mock_used_for_acceptance: false,
};

describe.skipIf(!realMysql)('MAX-368 real delete service on isolated mysql3308', () => {
  const database = `max368_${process.pid}`;
  let admin: Pool;
  let pool: Pool;
  const counts = [
    'audit_log_entries', 'ssh_trust_decisions', 'permissions', 'role_permissions', 'user_roles',
    'server_metrics', 'metric_collect_requests', 'workflow_jobs',
  ];

  beforeAll(async () => {
    const profile = readMysqlTestProfile();
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
    expect(names).not.toContain(database);
    evidence.schema_present_before = names.filter(name => name.startsWith('max368_') || name === 'db_ops_ai');
    const [activity] = await admin.query<RowDataPacket[]>(
      `SELECT DB AS db, COMMAND AS command, TIME AS time FROM information_schema.processlist WHERE DB IS NOT NULL`,
    );
    evidence.other_activity = activity.map(row => ({ db: row.db, command: row.command, time: Number(row.time) }));
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
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
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``).catch((error: unknown) => {
        evidence.cleanup_error = error instanceof Error ? 'drop database failed' : 'drop database failed';
      });
      const [left] = await admin.query<RowDataPacket[]>(
        'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database],
      );
      evidence.schema_removed = left.length === 0;
      await admin.end();
    }
    const directory = '/Users/max/Coding/40-Slide/outputs/max-368-acceptance';
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/result.json`, `${JSON.stringify(evidence, null, 2)}\n`);
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
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_report_server'`,
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

function fakeReply() {
  const reply = { code: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply);
  return reply;
}

function sanitize(error: unknown, secret: string): Error {
  const message = error instanceof Error ? error.message : 'mysql-test connection failed';
  return new Error(message.split(secret).join('[redacted]'));
}

function readMysqlTestProfile(): { host: string; port: number; user: string; password: string } {
  const parsed = JSON.parse(readFileSync('/Users/max/.config/slide-test-access/connection-profiles.json', 'utf8')) as {
    'mysql-test'?: { host?: string; port?: number; user?: string; password?: string };
  };
  const profile = parsed['mysql-test'];
  if (!profile?.host || !profile.port || !profile.user || !profile.password) throw new Error('mysql-test profile is incomplete');
  return { host: profile.host, port: Number(profile.port), user: profile.user, password: profile.password };
}
