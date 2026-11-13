import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import mysql, { type Pool, type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditLogManager, DatabaseAuditLogStore, MemoryAuditLogStore, type AuditLogEntry } from './audit-log.js';
import { registerSystemAuditRoutes } from './system-audit-routes.js';

// Explicit opt-in only. The caller injects credentials; default collection uses none.
describe.skipIf(process.env.AUDIT_BOUNDARY_MYSQL !== '1')('MAX-434/436 strict MySQL audit acceptance', () => {
  const database = `max434_${randomUUID().replaceAll('-', '')}`;
  let admin: Connection | undefined;
  let pool: Pool | undefined;
  let app: FastifyInstance | undefined;
  let baseUrl: string;
  let manager: AuditLogManager;
  let store: DatabaseAuditLogStore;
  let lastEntry: AuditLogEntry;
  let completed: (() => void) | undefined;
  const mirror = new MemoryAuditLogStore();

  beforeAll(async () => {
    if (!process.env.AUDIT_BOUNDARY_MYSQL_CONFIG) throw new Error('AUDIT_BOUNDARY_MYSQL_CONFIG required');
    const config = JSON.parse(process.env.AUDIT_BOUNDARY_MYSQL_CONFIG);
    // Never inherit a shared platform database from the supplied connection profile.
    const { host, port, user, password } = config;
    admin = await mysql.createConnection({ host, port, user, password });
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    pool = mysql.createPool({ host, port, user, password, database, connectionLimit: 1, charset: 'utf8mb4' });
    await pool.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'");
    await pool.query(await readFile(new URL('../../sql/migrations/065_persistent_audit_log.sql', import.meta.url), 'utf8'));
    // Query enrichment only; no external resource is contacted.
    await pool.query('CREATE TABLE database_instances (id BIGINT PRIMARY KEY, lifecycle_state VARCHAR(32))');
    const [mode] = await pool.query<RowDataPacket[]>('SELECT @@session.sql_mode AS mode, VERSION() AS version');
    expect(mode[0].mode).toContain('STRICT_ALL_TABLES');
    process.stdout.write(`${JSON.stringify({ phase: 'database-ready', database, host, port, mode: mode[0].mode, version: mode[0].version })}\n`);
    store = new DatabaseAuditLogStore(pool);
    manager = new AuditLogManager(mirror);
    manager.setPersistentStore(store);
    manager.on('log:system_operation', (entry: AuditLogEntry) => { lastEntry = entry; completed?.(); });
    app = Fastify();
    const verify = async (request: FastifyRequest) => {
      (request as any).user = { userId: 7, username: 'alice', roles: ['admin'], permissions: ['audit:view'], instanceScopes: {} };
    };
    await registerSystemAuditRoutes(app, verify, manager);
    app.patch('/api/users/:id', { preHandler: verify }, async (request, reply) => {
      return reply.code((request.params as any).id === 'fail' ? 409 : 204).send();
    });
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  }, 15000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (admin) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
        const [rows] = await admin.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM information_schema.schemata WHERE schema_name = ?', [database]);
        expect(Number(rows[0].count)).toBe(0);
        process.stdout.write(`${JSON.stringify({ phase: 'cleanup', database, remainingSchemas: Number(rows[0].count) })}\n`);
      } finally { await admin.end(); }
    }
  }, 15000);

  it('persists 10000 operations while bounding memory; durable query and export survive mirror clear', async () => {
    for (let i = 0; i < 10000; i++) await manager.logSystemOperation({ userId: '7', username: 'alice', method: 'PATCH', route: '/api/bulk', statusCode: i % 2 ? 204 : 409, requestId: String(i) });
    expect(mirror.getCount()).toBe(1000);
    expect((await manager.query({ action: 'PATCH /api/bulk' })).total).toBe(10000);
    expect((await manager.query({ action: 'PATCH /api/bulk', result: 'failure' })).total).toBe(5000);
    mirror.clear();
    expect((await manager.query({ action: 'PATCH /api/bulk' })).total).toBe(10000);
    expect(JSON.parse(await manager.export({ action: 'PATCH /api/bulk', limit: 1 }))).toHaveLength(200);
    const [rows] = await pool!.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM audit_log_entries');
    expect(Number(rows[0].count)).toBe(10000);
  }, 30000);

  it.each([512, 513, 1024])('keeps successful and failed HTTP responses and durable %i-character UA audit', async length => {
    for (const status of [204, 409]) {
      const done = new Promise<void>(resolve => { completed = resolve; });
      const result = await fetch(`${baseUrl}/api/users/${status === 409 ? 'fail' : 'ok'}`, {
        method: 'PATCH', headers: { 'user-agent': 'a'.repeat(length), 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'not-for-audit' }),
      });
      expect(result.status).toBe(status);
      await result.arrayBuffer();
      await done; completed = undefined;
      const [rows] = await pool!.query<RowDataPacket[]>('SELECT * FROM audit_log_entries WHERE id = ?', [lastEntry.id]);
      expect(rows[0].user_agent).toBe('a'.repeat(512));
      expect(rows[0].result).toBe(status === 204 ? 'success' : 'failure');
      expect(rows[0].error_message).toBe(status === 409 ? 'HTTP_409' : null);
      expect(JSON.stringify(rows)).not.toContain('not-for-audit');
    }
  }, 10000);

  it.each([512, 513, 1024])('persists %i Unicode characters intact through manager and direct store', async length => {
    for (const character of ['中', '😀']) {
      for (const statusCode of [204, 500]) {
        await manager.logSystemOperation({ userId: '7', username: 'alice', method: 'PATCH', route: '/api/unicode', statusCode, userAgent: character.repeat(length) });
        const entry = lastEntry;
        expect(entry.userAgent).toBe(character.repeat(512));
        const id = randomUUID();
        await store.write({ ...entry, id, action: 'direct', userAgent: character.repeat(length) });
        const [rows] = await pool!.query<RowDataPacket[]>('SELECT user_agent, CHAR_LENGTH(user_agent) AS len FROM audit_log_entries WHERE id = ?', [id]);
        expect(rows[0]).toMatchObject({ user_agent: character.repeat(512), len: 512 });
      }
    }
  });

  it('propagates real database failure, preserves business response and resumes without automatic replay', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await pool!.query('RENAME TABLE audit_log_entries TO audit_log_entries_unavailable');
      await expect(manager.logSystemOperation({ userId: '7', username: 'alice', method: 'PATCH', route: '/api/unavailable', statusCode: 204 })).rejects.toThrow();
      const done = new Promise<void>(resolve => {
        error.mockImplementation(() => resolve());
      });
      const response = await fetch(`${baseUrl}/api/users/ok`, { method: 'PATCH' });
      expect(response.status).toBe(204); await response.arrayBuffer(); await done;
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      await pool!.query('RENAME TABLE audit_log_entries_unavailable TO audit_log_entries');
      error.mockRestore();
    }
    expect((await manager.query({ action: 'PATCH /api/unavailable' })).total).toBe(0);
    await manager.logSystemOperation({ userId: '7', username: 'alice', method: 'PATCH', route: '/api/recovered', statusCode: 204 });
    expect((await manager.query({ action: 'PATCH /api/recovered' })).total).toBe(1);
  });
});
