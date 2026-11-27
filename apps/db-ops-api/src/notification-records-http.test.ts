import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';
import { transpileModule } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVerifyToken } from './auth-middleware.js';
import { actorContextService, type ActorContext } from './auth/actor-context.js';
import { requirePermission } from './auth/require-permission.js';
import { dbConnection } from './db-connection.js';
import { notificationDatabaseService } from './notification-database-service.js';
import { loadMigrations, MigrationRunner } from './migrations/runner.js';

const secret = 'max-595-isolated-test-secret';
const actor: ActorContext = { userId: 595, username: 'records-reader', roles: [],
  permissions: ['notification:view'], sessionVersion: 1, instanceScopes: { 1: 'read-only' }, requestId: 'max-595' };
const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const route = source.slice(source.indexOf("  fastify.get('/api/notification/records',"),
  source.indexOf("  fastify.get('/api/notification/dead-letters',"));

function appForRecords() {
  const app = Fastify();
  const deps = { fastify: app, verifyToken: createVerifyToken(secret), requirePermission, notificationDatabaseService };
  new Function(...Object.keys(deps), transpileModule(route, {}).outputText)(...Object.values(deps));
  return app;
}

function authenticate() {
  // JWT verification, permission middleware and resource filtering are real;
  // only the live account snapshot is controlled by this fixture.
  return vi.spyOn(actorContextService, 'loadActiveActor').mockResolvedValue(actor);
}

const headers = { authorization: `Bearer ${jwt.sign({ userId: 595, sessionVersion: 1 }, secret)}` };
afterEach(() => vi.restoreAllMocks());

describe('MAX-595 / #541 production notification records HTTP registration', () => {
  it('rejects malformed status through a real socket before querying the service', async () => {
    authenticate();
    const getRecords = vi.spyOn(notificationDatabaseService, 'getRecords');
    const app = appForRecords();
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      for (const query of ['status=not-a-valid-status', 'status=', 'status=SENT', 'status=%20sent',
        'status=sent%20', 'status=toString', 'status=__proto__', 'status=null', 'status=0',
        'status=sent&status=failed', 'status=sent&status=sent']) {
        const response = await fetch(`${address}/api/notification/records?${query}`, { headers });
        expect(response.status, query).toBe(400);
        expect(await response.json()).toEqual({ error: 'status 必须为 pending、sent、failed 或 suppressed' });
      }
      expect(getRecords).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('keeps the four parameterized SQL filters, empty results and other filters', async () => {
    authenticate();
    const execute = vi.fn().mockResolvedValue([[]]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    const app = appForRecords();
    try {
      for (const status of ['pending', 'sent', 'failed', 'suppressed']) {
        const response = await app.inject({ url: `/api/notification/records?status=${status}&alert_id=12&channel_id=3&limit=10&offset=0`, headers });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual([]);
        expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('AND n.status = ?'), [12, 3, status, 10, 0]);
      }
      expect((await app.inject({ url: '/api/notification/records', headers })).json()).toEqual([]);
      expect(execute.mock.lastCall![0]).not.toContain('AND n.status = ?');
      expect(execute.mock.lastCall![1]).toEqual([50, 0]);
      execute.mockRejectedValueOnce(new Error('database unavailable'));
      const failure = await app.inject({ url: '/api/notification/records?status=sent', headers });
      expect(failure.statusCode).toBe(500);
      expect(failure.json()).toEqual({ error: 'DELIVERY_QUERY_UNAVAILABLE' });
    } finally { await app.close(); }
  });

  it('retains JWT authentication, live permission changes and resource visibility', async () => {
    const live = authenticate();
    const getRecords = vi.spyOn(notificationDatabaseService, 'getRecords');
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: vi.fn().mockResolvedValue([[
      { id: 1, status: 'sent', instance_id: 1 }, { id: 2, status: 'sent', instance_id: 2 },
      { id: 3, status: 'sent', server_id: 1 }, { id: 4, status: 'sent', network_device_id: 1 },
    ]]) } as any);
    const app = appForRecords();
    try {
      for (const query of ['', '?status=invalid']) {
        expect((await app.inject({ url: '/api/notification/records' + query })).statusCode).toBe(401);
        expect((await app.inject({ url: '/api/notification/records' + query, headers: { authorization: 'Bearer invalid' } })).statusCode).toBe(401);
        live.mockResolvedValue({ ...actor, permissions: [] });
        expect((await app.inject({ url: '/api/notification/records' + query, headers })).statusCode).toBe(403);
      }
      expect(getRecords).not.toHaveBeenCalled();
      live.mockResolvedValue(actor);
      expect((await app.inject({ url: '/api/notification/records?status=sent', headers })).json()).toEqual([{ id: 1, status: 'sent' }]);
      live.mockResolvedValue({ ...actor, instanceScopes: {} });
      expect((await app.inject({ url: '/api/notification/records?status=sent', headers })).json()).toEqual([]);
    } finally { await app.close(); }
  });
});

it.skipIf(!process.env.NOTIFICATION_RECORDS_TEST_MYSQL_PORT)('migrated notification records preserve existing rows and accept all statuses through HTTP', async () => {
  if (process.env.NOTIFICATION_RECORDS_TEST_MYSQL_PASSWORD === undefined) throw new Error('NOTIFICATION_RECORDS_TEST_MYSQL_PASSWORD must be explicitly injected; explicit empty is reserved for isolated targets');
  authenticate();
  const options = { host: process.env.NOTIFICATION_RECORDS_TEST_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.NOTIFICATION_RECORDS_TEST_MYSQL_PORT), user: process.env.NOTIFICATION_RECORDS_TEST_MYSQL_USER ?? 'root',
    password: process.env.NOTIFICATION_RECORDS_TEST_MYSQL_PASSWORD! };
  const admin = mysql.createPool(options);
  const database = `max595_records_${process.pid}`;
  const priorMigrations = await mkdtemp(join(tmpdir(), 'slide-notification-records-migrations-'));
  let pool: ReturnType<typeof mysql.createPool> | undefined;
  let created = false;
  const app = appForRecords();
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    pool = mysql.createPool({ ...options, database, connectionLimit: 10 });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    for (const migration of await loadMigrations()) {
      if (migration.id < '168_') await writeFile(join(priorMigrations, migration.id), migration.sql);
    }
    await new MigrationRunner(pool, priorMigrations).run();
    await pool.query(`INSERT INTO alerts (id, instance_id, alert_type, level, title, message)
      VALUES (1, 1, 'performance', 'warning', 'allowed', 'fixture'), (2, 2, 'performance', 'warning', 'excluded', 'fixture')`);
    const statuses = ['pending', 'sent', 'failed', 'suppressed'];
    for (const [i, status] of statuses.slice(0, 3).entries()) {
      await pool.execute('INSERT INTO notification_records (id, alert_id, channel_id, status) VALUES (?, 1, 3, ?)', [i + 1, status]);
    }
    await pool.query("INSERT INTO notification_records (id, alert_id, channel_id, status) VALUES (5, 2, 3, 'sent')");
    const runner = new MigrationRunner(pool);
    await runner.run();
    const migrated = await runner.inspect();
    await runner.run();
    expect(await runner.inspect()).toEqual(migrated);
    expect(await notificationDatabaseService.recordNotification({ alert_id: 1, channel_id: 3, status: 'suppressed' })).toEqual({ success: true });
    const [column] = await pool.query<mysql.RowDataPacket[]>(`SELECT COLUMN_DEFAULT, COLUMN_TYPE, COLLATION_NAME, IS_NULLABLE, COLUMN_COMMENT
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_records' AND COLUMN_NAME = 'status'`);
    expect(column).toEqual([{ COLUMN_DEFAULT: 'pending', COLUMN_TYPE: "enum('pending','sent','failed','suppressed')",
      COLLATION_NAME: 'utf8mb4_unicode_ci', IS_NULLABLE: 'NO', COLUMN_COMMENT: '业务状态' }]);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    for (const [i, status] of statuses.entries()) {
      const response = await fetch(`${address}/api/notification/records?status=${status}`, { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([{ id: status === 'suppressed' ? 6 : i + 1, status }]);
    }
    const empty = await fetch(`${address}/api/notification/records?status=sent&channel_id=99`, { headers });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
    const invalid = await fetch(`${address}/api/notification/records?status=not-a-valid-status`, { headers });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toHaveProperty('error');
    const all = await fetch(`${address}/api/notification/records`, { headers });
    expect(all.status).toBe(200);
    expect(await all.json()).toHaveLength(4);
  } finally {
    await app.close();
    await pool?.end();
    try { if (created) await admin.query(`DROP DATABASE ${database}`); }
    finally { await admin.end(); await rm(priorMigrations, { recursive: true, force: true }); }
  }
}, 120_000);
