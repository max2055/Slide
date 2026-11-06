import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { createVerifyToken } from '../auth-middleware.js';
import { splitSqlStatements } from '../migrations/runner.js';
import { ActorAuthenticationError, ActorContextService, applyActorSecuritySchema, signAccessToken } from './actor-context.js';
import { rbacApiRoutes } from './rbac-api.js';
import { RbacService } from './rbac-service.js';

// #496 / MAX-345: explicit opt-in; all mutations use a disposable schema.
const port = Number(process.env.RBAC_TEST_MYSQL_PORT ?? process.env.AUTH_TEST_MYSQL_PORT);
describe.skipIf(!port)('user role renewal with isolated MySQL and real JWT', () => {
  const database = `rbac_renew_${randomUUID().replaceAll('-', '')}`;
  const secret = randomUUID();
  const rawRefresh = randomUUID();
  const service = new RbacService();
  let admin: Pool;
  let pool: Pool;
  let created = false;
  let contexts: ActorContextService;
  let app: FastifyInstance;
  let failAt = '';
  let headers: { authorization: string };
  const store = {
    execute: (sql: string, values?: unknown[]) => pool.execute(sql, values as any[]),
    getConnection: async () => {
      const connection = await pool.getConnection();
      return {
        beginTransaction: () => connection.beginTransaction(),
        execute: async (sql: string, values?: unknown[]) => {
          if (failAt && sql.startsWith(failAt)) throw new Error('injected renewal transaction failure');
          return connection.execute(sql, values as any[]);
        },
        commit: () => connection.commit(), rollback: () => connection.rollback(),
        release: () => connection.release(),
      };
    },
  };
  async function state() {
    const [grants] = await pool.query<any[]>('SELECT id, grant_expiry, created_at FROM user_roles WHERE user_id = 7 AND role_id = 1');
    const [users] = await pool.query<any[]>('SELECT session_version FROM users WHERE id = 7');
    const [tokens] = await pool.query<any[]>('SELECT revoked FROM refresh_tokens WHERE user_id = 7');
    return { grants, version: users[0].session_version, revoked: tokens[0].revoked };
  }
  async function assign() {
    return app.inject({ method: 'POST', url: '/api/v1/rbac/users/7/roles', headers, payload: { roleId: 1 } });
  }

  beforeAll(async () => {
    const options = { host: process.env.RBAC_TEST_MYSQL_HOST ?? '127.0.0.1', port,
      user: process.env.RBAC_TEST_MYSQL_USER ?? 'root',
      password: process.env.RBAC_TEST_MYSQL_PASSWORD ?? process.env.AUTH_TEST_MYSQL_PASSWORD ?? '', connectionLimit: 8 };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    pool = mysql.createPool({ ...options, database });
    const baseline = readFileSync(new URL('../../sql/migrations/000_schema_baseline.sql', import.meta.url), 'utf8');
    for (const sql of splitSqlStatements(baseline)) {
      if (/CREATE TABLE IF NOT EXISTS `(users|database_instances|chat_sessions|roles|permissions|role_permissions|user_roles|instance_permissions)`/.test(sql)) await pool.query(sql);
    }
    const connection = await pool.getConnection();
    try {
      const migration = readFileSync(new URL('../../sql/migrations/005_add_refresh_tokens_and_grant_expiry.sql', import.meta.url), 'utf8');
      for (const sql of splitSqlStatements(migration)) await connection.query(sql);
    } finally { connection.release(); }
    await applyActorSecuritySchema(pool);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(store as unknown as Pool);
    contexts = new ActorContextService(() => store);
    app = Fastify();
    app.decorate('verifyToken', createVerifyToken(secret, contexts));
    await app.register(rbacApiRoutes);
    await app.ready();
    const [environment] = await pool.query('SELECT VERSION() AS version, @@transaction_isolation AS isolation_level');
    console.info('MAX-345 isolated schema:', database, environment);
  });
  beforeEach(async () => {
    failAt = '';
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM roles');
    await pool.query('DELETE FROM permissions');
    await pool.query("INSERT INTO users (id, username, password_hash) VALUES (7, 'target', 'unused'), (8, 'administrator', 'unused')");
    await pool.query("INSERT INTO roles (id, name) VALUES (1, 'reader'), (2, 'admin')");
    await pool.query("INSERT INTO permissions (id, code, name, resource, action) VALUES (1, 'instance:view', 'read', 'instance', 'view'), (2, 'admin:*', 'admin', 'admin', '*')");
    await pool.query('INSERT INTO role_permissions (role_id, permission_id) VALUES (1, 1), (2, 2)');
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES (8, 2)');
    await pool.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (7, ?, NOW() + INTERVAL 1 DAY)',
      [createHash('sha256').update(rawRefresh).digest('hex')]);
    headers = { authorization: `Bearer ${signAccessToken(await contexts.loadActiveActor(8), secret)}` };
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await pool?.end();
    if (created) {
      await admin.query(`DROP DATABASE ${database}`);
      const [remaining] = await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]);
      expect(remaining).toEqual([]);
      console.info('MAX-345 schema cleanup verified:', database);
    }
    await admin?.end();
  });

  it('grants a never-assigned role and invalidates old access and refresh tokens', async () => {
    const token = signAccessToken(await contexts.loadActiveActor(7), secret);
    expect((await assign()).statusCode).toBe(201);
    const result = await state();
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0].grant_expiry).toBeNull();
    expect(result).toMatchObject({ version: 2, revoked: 1 });
    expect((await contexts.loadActiveActor(7)).permissions).toContain('instance:view');
    await expect(contexts.authenticateAccessToken(token, secret)).rejects.toBeInstanceOf(ActorAuthenticationError);
    await expect(contexts.rotateRefreshToken(rawRefresh)).rejects.toBeInstanceOf(ActorAuthenticationError);
  });

  it.each(['NOW() - INTERVAL 1 DAY', 'NOW()'])('restores an expired grant (%s) without replacing the row', async expiry => {
    await pool.query(`INSERT INTO user_roles (user_id, role_id, grant_expiry) VALUES (7, 1, ${expiry})`);
    const before = await state();
    const token = signAccessToken(await contexts.loadActiveActor(7), secret);
    expect((await contexts.loadActiveActor(7)).permissions).not.toContain('instance:view');
    expect((await assign()).statusCode).toBe(201);
    expect(await state()).toEqual({ grants: [{ ...before.grants[0], grant_expiry: null }], version: 2, revoked: 1 });
    expect((await contexts.loadActiveActor(7)).permissions).toContain('instance:view');
    await expect(contexts.authenticateAccessToken(token, secret)).rejects.toBeInstanceOf(ActorAuthenticationError);
    await expect(contexts.rotateRefreshToken(rawRefresh)).rejects.toBeInstanceOf(ActorAuthenticationError);
  });

  it.each(['NULL', 'NOW() + INTERVAL 1 DAY'])('keeps active duplicates (%s) and their sessions unchanged', async expiry => {
    await pool.query(`INSERT INTO user_roles (user_id, role_id, grant_expiry) VALUES (7, 1, ${expiry})`);
    const before = await state();
    const token = signAccessToken(await contexts.loadActiveActor(7), secret);
    expect((await assign()).statusCode).toBe(201);
    expect(await state()).toEqual(before);
    expect((await contexts.authenticateAccessToken(token, secret)).permissions).toContain('instance:view');
    expect((await contexts.rotateRefreshToken(rawRefresh)).actor.sessionVersion).toBe(1);
  });

  it.each(['UPDATE user_roles', 'UPDATE users', 'UPDATE refresh_tokens'])('rolls back an expired renewal when %s fails', async sql => {
    await pool.query('INSERT INTO user_roles (user_id, role_id, grant_expiry) VALUES (7, 1, NOW() - INTERVAL 1 DAY)');
    const before = await state();
    failAt = sql;
    expect((await assign()).statusCode).toBe(400);
    expect(await state()).toEqual(before);
    expect((await contexts.loadActiveActor(7)).permissions).not.toContain('instance:view');
    failAt = '';
    expect((await assign()).statusCode).toBe(201);
    expect(await state()).toMatchObject({ version: 2, revoked: 1 });
  });

  it('rolls back a new grant when refresh revocation fails', async () => {
    const before = await state();
    failAt = 'UPDATE refresh_tokens';
    expect((await assign()).statusCode).toBe(400);
    expect(await state()).toEqual(before);
  });

  it('serializes concurrent renewals into one session invalidation', async () => {
    await pool.query('INSERT INTO user_roles (user_id, role_id, grant_expiry) VALUES (7, 1, NOW() - INTERVAL 1 DAY)');
    const results = await Promise.all([assign(), assign()]);
    expect(results.map(result => result.statusCode)).toEqual([201, 201]);
    expect(await state()).toMatchObject({ version: 2, revoked: 1, grants: [{ grant_expiry: null }] });
  });

  it('denies non-admin renewal and leaves the expired grant untouched', async () => {
    await pool.query('INSERT INTO user_roles (user_id, role_id, grant_expiry) VALUES (7, 1, NOW() - INTERVAL 1 DAY)');
    const before = await state();
    headers = { authorization: `Bearer ${signAccessToken(await contexts.loadActiveActor(7), secret)}` };
    expect((await assign()).statusCode).toBe(403);
    expect(await state()).toEqual(before);
  });

  it('keeps revocation behavior for a renewed role', async () => {
    expect((await service.assignRoleToUser(7, 1)).success).toBe(true);
    expect((await service.revokeRoleFromUser(7, 1)).success).toBe(true);
    expect(await state()).toEqual({ grants: [], version: 3, revoked: 1 });
  });
  it('MAX-340 atomic replacement rolls back deletion, insertion and session failures', async () => {
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES (7, 1)');
    const before = await state();
    for (const failure of ['DELETE FROM user_roles', 'INSERT INTO user_roles', 'UPDATE refresh_tokens']) {
      failAt = failure;
      const result = await service.replaceUserRoles(7, [2], [1]);
      expect(result.success).toBe(false);
      expect(await state()).toEqual(before);
    }
  });
  it('MAX-340 concurrent replacements reject stale snapshot and commit one complete set', async () => {
    await pool.query('INSERT INTO roles (id, name) VALUES (3, \'replacement\')');
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES (7, 1)');
    const results = await Promise.all([service.replaceUserRoles(7, [2], [1]), service.replaceUserRoles(7, [3], [1])]);
    expect(results.filter(r => r.success)).toHaveLength(1);
    expect(results.filter(r => r.conflict)).toHaveLength(1);
    const [rows] = await pool.query<any[]>('SELECT role_id FROM user_roles WHERE user_id = 7');
    expect(rows).toHaveLength(1);
    expect([2, 3]).toContain(rows[0].role_id);
  });
  it('MAX-340 real JWT replacement authorizes administrator and denies ordinary user', async () => {
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES (7, 1)');
    const denied = await app.inject({ method: 'PUT', url: '/api/v1/rbac/users/7/roles',
      headers: {authorization: `Bearer ${signAccessToken(await contexts.loadActiveActor(7), secret)}`}, payload: {roleIds: [], expectedRoleIds: [1]} });
    expect(denied.statusCode).toBe(403);
    const saved = await app.inject({ method: 'PUT', url: '/api/v1/rbac/users/7/roles', headers, payload: {roleIds: [], expectedRoleIds: [1]} });
    expect(saved.statusCode).toBe(200);
    expect((await state()).grants).toEqual([]);
  });

});
