import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createVerifyToken } from '../auth-middleware.js';
import { splitSqlStatements } from '../migrations/runner.js';
import { canReadResource } from '../resources/resource-service.js';
import type { ResourceRef } from '../resources/types.js';
import { ActorContextService, applyActorSecuritySchema, signAccessToken, type ActorContext } from './actor-context.js';
import { getAccessibleInstanceIds, hasInstanceAccess, requireInstanceAccess } from './require-instance-access.js';
import { requirePermission } from './require-permission.js';

const port = Number(process.env.AUTH_TEST_MYSQL_PORT);
describe.skipIf(!port)('bounded actors with real JWT and isolated MySQL grants', () => {
  const database = `auth_boundary_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  // Test-owned secret and ceiling; neither comes from a client or a model.
  const secret = randomUUID();
  const boundary = Object.freeze({ instanceIds: Object.freeze([1]), serverIds: Object.freeze([10]),
    networkDeviceIds: Object.freeze([20]) });
  let admin: Pool;
  let pool: Pool;
  let contexts: ActorContextService;
  let app: FastifyInstance;
  let headers: { authorization: string };
  const actorOf = (request: FastifyRequest) => (request as FastifyRequest & { user: ActorContext }).user;
  const bounded = async (): Promise<ActorContext> => Object.freeze({
    ...await contexts.loadActiveActor(7, 1), resourceBoundary: boundary,
  });

  beforeAll(async () => {
    const options = { host: '127.0.0.1', port, user: 'root',
      password: process.env.AUTH_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database });
    // Use the repository's real table definitions and actor security upgrade.
    const tables = new Set(['users', 'database_instances', 'chat_sessions', 'roles', 'permissions', 'role_permissions', 'user_roles', 'instance_permissions']);
    const baseline = readFileSync(new URL('../../sql/migrations/000_schema_baseline.sql', import.meta.url), 'utf8');
    for (const sql of splitSqlStatements(baseline)) {
      const table = sql.match(/CREATE TABLE IF NOT EXISTS `([^`]+)`/i)?.[1];
      if (table && tables.has(table)) await pool.query(sql);
    }
    const connection = await pool.getConnection();
    try {
      const migration = readFileSync(new URL('../../sql/migrations/005_add_refresh_tokens_and_grant_expiry.sql', import.meta.url), 'utf8');
      for (const sql of splitSqlStatements(migration)) await connection.query(sql);
    } finally { connection.release(); }
    await applyActorSecuritySchema(pool);
    await pool.execute("INSERT INTO users (id, username, password_hash) VALUES (7, 'bounded-worker', 'not-a-login-hash')");
    await pool.execute("INSERT INTO roles (id, name) VALUES (1, 'diagnostic-reader'), (2, 'admin')");
    for (const [id, code] of [[1, 'instance:view'], [2, 'servers:view'], [3, 'network_devices:view'], [4, '*']] as const) {
      const [resource, action] = code.split(':');
      await pool.execute('INSERT INTO permissions (id, code, name, resource, action) VALUES (?, ?, ?, ?, ?)',
        [id, code, code, resource, action ?? '*']);
    }
    await pool.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (1, 1), (1, 2), (1, 3), (2, 4)');
    for (const id of [1, 2]) {
      await pool.execute(`INSERT INTO database_instances
        (id, name, host, port, username, password_encrypted) VALUES (?, ?, 'fixture.invalid', 3306, 'fixture', 'unused')`, [id, `fixture-${id}`]);
    }
    contexts = new ActorContextService(() => pool);
    app = Fastify();
    app.addHook('preHandler', createVerifyToken(secret, contexts));
    app.addHook('preHandler', async (request) => {
      // This harness represents a server-owned delegated call; JWT claims never set a ceiling.
      (request as FastifyRequest & { user: ActorContext }).user = Object.freeze({ ...actorOf(request), resourceBoundary: boundary });
    });
    app.get('/fixtures/instances', { preHandler: requirePermission('instance:view') }, async (request) => {
      const ids = getAccessibleInstanceIds(actorOf(request));
      if (ids?.length === 0) return { items: [], count: 0 };
      const [items] = await pool.execute<RowDataPacket[]>(`SELECT id, name FROM database_instances${ids ? ` WHERE id IN (${ids.map(() => '?').join(',')})` : ''} ORDER BY id`, ids ?? []);
      return { items, count: items.length };
    });
    app.get('/fixtures/instances/:id', { preHandler: [requirePermission('instance:view'), requireInstanceAccess()] },
      async (request) => ({ id: Number((request.params as { id: string }).id), content: 'protected fixture' }));
    app.post('/fixtures/instances/:id', { preHandler: [requirePermission('instance:view'), requireInstanceAccess('read-write')] },
      async () => ({ accepted: true }));
    await app.ready();
  });
  beforeEach(async () => {
    await pool.execute("UPDATE users SET status = 'active', session_version = 1 WHERE id = 7");
    await pool.execute('DELETE FROM user_roles WHERE user_id = 7');
    await pool.execute('DELETE FROM instance_permissions WHERE user_id = 7');
    await pool.execute('INSERT INTO user_roles (user_id, role_id) VALUES (7, 1)');
    await pool.execute("INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (7, 1, 'read-only'), (7, 2, 'admin')");
    headers = { authorization: `Bearer ${signAccessToken(await contexts.loadActiveActor(7, 1), secret)}` };
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });

  it('lists/counts only the intersection and blocks a boundary-excluded URL despite an explicit grant', async () => {
    const list = await app.inject({ url: '/fixtures/instances', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [{ id: 1, name: 'fixture-1' }], count: 1 });
    expect((await app.inject({ url: '/fixtures/instances/1', headers })).statusCode).toBe(200);
    const excluded = await app.inject({ url: '/fixtures/instances/2', headers });
    expect(excluded.statusCode).toBe(403);
    expect(excluded.body).not.toContain('protected fixture');
    expect((await app.inject({ method: 'POST', url: '/fixtures/instances/1', headers })).statusCode).toBe(403);
  });

  it.each(['delete', 'expire'] as const)('same JWT loses list, count and URL access immediately after grant %s', async (mode) => {
    expect((await app.inject({ url: '/fixtures/instances/1', headers })).statusCode).toBe(200);
    if (mode === 'delete') await pool.execute('DELETE FROM instance_permissions WHERE user_id = 7 AND instance_id = 1');
    else await pool.execute('UPDATE instance_permissions SET grant_expiry = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE user_id = 7 AND instance_id = 1');
    const list = await app.inject({ url: '/fixtures/instances', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [], count: 0 });
    expect((await app.inject({ url: '/fixtures/instances/1', headers })).statusCode).toBe(403);
    expect((await app.inject({ url: '/fixtures/instances/2', headers })).statusCode).toBe(403);
  });

  it('revalidates retained actors from live grants without losing any resource ceiling', async () => {
    const retained = await bounded();
    await pool.execute('DELETE FROM instance_permissions WHERE user_id = 7 AND instance_id = 1');
    const current = await contexts.revalidateActor(retained);
    expect(current.resourceBoundary).toEqual(boundary);
    expect(getAccessibleInstanceIds(current)).toEqual([]);
    expect(hasInstanceAccess(current, 1)).toBe(false);
    expect(hasInstanceAccess(current, 2)).toBe(false);
    const reply = await app.inject({ url: '/fixtures/instances/1', headers });
    expect(reply.statusCode).toBe(403);
  });

  it('later admin promotion cannot erase a retained ceiling or admit an instance without a live grant', async () => {
    const retained = await bounded();
    await pool.execute('INSERT INTO user_roles (user_id, role_id) VALUES (7, 2)');
    await pool.execute('DELETE FROM instance_permissions WHERE user_id = 7 AND instance_id = 1');
    const current = await contexts.revalidateActor(retained);
    expect(current.permissions).toContain('*');
    expect(current.resourceBoundary).toEqual(boundary);
    expect(getAccessibleInstanceIds(current)).toEqual([]);
    expect(hasInstanceAccess(current, 1)).toBe(false);
    expect(hasInstanceAccess(current, 2)).toBe(false);
    expect((await app.inject({ url: '/fixtures/instances/2', headers })).statusCode).toBe(403);
  });

  it('requires every instance/server/network scope and rejects each excluded scope after refresh', async () => {
    const current = await contexts.revalidateActor(await bounded());
    const required: ResourceRef[] = [{ type: 'instance', id: 1 }, { type: 'server', id: 10 }, { type: 'network_device', id: 20 }];
    expect(required.every((ref) => canReadResource(current, ref))).toBe(true);
    for (let index = 0; index < required.length; index++) {
      const scopes = required.map((ref, i) => i === index ? { ...ref, id: ref.id + 1 } : ref);
      expect(scopes.every((ref) => canReadResource(current, ref))).toBe(false);
    }
    await pool.execute('UPDATE user_roles SET grant_expiry = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE user_id = 7');
    const revoked = await contexts.revalidateActor(current);
    expect(canReadResource(revoked, required[1])).toBe(false);
    expect(canReadResource(revoked, required[2])).toBe(false);
    expect((await app.inject({ url: '/fixtures/instances', headers })).statusCode).toBe(403);
  });

  it.each(['inactive', 'version'] as const)('same JWT and retained actor fail closed on user %s change', async (mode) => {
    const retained = await bounded();
    await pool.execute(mode === 'inactive' ? "UPDATE users SET status = 'inactive' WHERE id = 7" : 'UPDATE users SET session_version = 2 WHERE id = 7');
    await expect(contexts.revalidateActor(retained)).rejects.toThrow('Authentication failed');
    const result = await app.inject({ url: '/fixtures/instances', headers });
    expect(result.statusCode).toBe(401);
    expect(result.body).not.toContain('fixture-1');
  });
});
