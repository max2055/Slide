import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { splitSqlStatements } from '../migrations/runner.js';
import { RbacService } from './rbac-service.js';
import { applyActorSecuritySchema } from './actor-context.js';

// #316 / MAX-336: opt-in real InnoDB tests, never use the application schema.
const port = Number(process.env.RBAC_TEST_MYSQL_PORT ?? process.env.AUTH_TEST_MYSQL_PORT);
describe.skipIf(!port)('permission deletion with isolated MySQL', () => {
  const database = `rbac_delete_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let created = false;
  let afterExecute: (sql: string) => Promise<void>;
  let beforeExecute: (sql: string) => void;
  const service = new RbacService();

  // Only scheduling/failure injection is intercepted; all SQL uses real connections.
  const execute = async (connection: Pool | PoolConnection, sql: string, values?: unknown[]) => {
    beforeExecute(sql);
    const result = await connection.execute(sql, values as any[]);
    await afterExecute(sql);
    return result;
  };
  const store = {
    execute: (sql: string, values?: unknown[]) => execute(pool, sql, values),
    getConnection: async () => {
      const connection = await pool.getConnection();
      return {
        beginTransaction: () => connection.beginTransaction(),
        execute: (sql: string, values?: unknown[]) => execute(connection, sql, values),
        commit: () => connection.commit(), rollback: () => connection.rollback(),
        release: () => connection.release(),
      };
    },
  };
  function barrier(pattern: RegExp) {
    let resume!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const released = new Promise<void>(resolve => { resume = resolve; });
    afterExecute = async sql => {
      if (pattern.test(sql)) { reached(); await released; }
    };
    return { paused, resume };
  }
  async function blockedOrFinished(finished: () => boolean) {
    await expect.poll(async () => {
      if (finished()) return true;
      const [rows] = await admin.query<any[]>(
        `SELECT COUNT(*) AS cnt FROM performance_schema.data_lock_waits w
         JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID
         WHERE l.OBJECT_SCHEMA = ?`, [database]);
      return rows[0].cnt > 0;
    }, { timeout: 3000 }).toBe(true);
  }
  async function state() {
    const [permissions] = await pool.query<any[]>('SELECT id FROM permissions WHERE id = 9001');
    const [refs] = await pool.query<any[]>('SELECT role_id FROM role_permissions WHERE permission_id = 9001');
    const [users] = await pool.query<any[]>('SELECT session_version FROM users WHERE id = 9001');
    const [tokens] = await pool.query<any[]>('SELECT revoked FROM refresh_tokens WHERE user_id = 9001');
    return { permissions: permissions.length, refs: refs.length, version: users[0].session_version, revoked: tokens[0].revoked };
  }

  beforeAll(async () => {
    const options = { host: process.env.RBAC_TEST_MYSQL_HOST ?? '127.0.0.1', port,
      user: process.env.RBAC_TEST_MYSQL_USER ?? 'root',
      password: process.env.RBAC_TEST_MYSQL_PASSWORD ?? process.env.AUTH_TEST_MYSQL_PASSWORD ?? '',
      connectionLimit: 8 };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    pool = mysql.createPool({ ...options, database });
    // Load repository DDL and RBAC migrations, including the actual CASCADE FKs.
    const schema = readFileSync(new URL('../../sql/migrations/000_schema_baseline.sql', import.meta.url), 'utf8');
    for (const sql of splitSqlStatements(schema)) {
      if (/CREATE TABLE IF NOT EXISTS `(users|database_instances|chat_sessions|roles|permissions|role_permissions|user_roles|instance_permissions)`/.test(sql)) await pool.query(sql);
    }
    const connection = await pool.getConnection();
    try {
      for (const migration of ['005_add_refresh_tokens_and_grant_expiry']) {
        for (const sql of splitSqlStatements(readFileSync(new URL(`../../sql/migrations/${migration}.sql`, import.meta.url), 'utf8'))) {
          await connection.query(sql);
        }
      }
    } finally { connection.release(); }
    await applyActorSecuritySchema(pool);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(store as unknown as Pool);
    const [environment] = await pool.query('SELECT VERSION() AS version, @@transaction_isolation AS isolation_level, @@autocommit AS autocommit');
    console.info('MAX-336 isolated schema:', database, environment);
  });
  beforeEach(async () => {
    beforeExecute = () => {};
    afterExecute = async () => {};
    await pool.query('DELETE FROM permissions WHERE id = 9001');
    await pool.query('DELETE FROM users WHERE id = 9001');
    await pool.query('DELETE FROM roles WHERE id = 9001');
    await pool.query("INSERT INTO users (id, username, password_hash) VALUES (9001, 'max336', 'unused')");
    await pool.query("INSERT INTO roles (id, name) VALUES (9001, 'max336')");
    await pool.query("INSERT INTO permissions (id, code, name, resource, action) VALUES (9001, 'max336:view', 'fixture', 'max336', 'view')");
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES (9001, 9001)');
    await pool.query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (9001, REPEAT('a', 64), NOW() + INTERVAL 1 DAY)");
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await pool?.end();
    if (created) {
      await admin.query(`DROP DATABASE ${database}`);
      const [remaining] = await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]);
      expect(remaining).toEqual([]);
      console.info('MAX-336 schema cleanup verified:', database);
    }
    await admin?.end();
  });

  it('rejects deletion of a referenced permission and preserves session state', async () => {
    await pool.query('INSERT INTO role_permissions (role_id, permission_id) VALUES (9001, 9001)');
    expect(await service.deletePermission(9001)).toEqual({ success: false, error: '权限被 1 个角色引用，无法删除' });
    expect(await state()).toEqual({ permissions: 1, refs: 1, version: 1, revoked: 0 });
  });

  it('deletes an unreferenced permission and keeps deletion idempotent', async () => {
    expect(await service.deletePermission(9001)).toEqual({ success: true });
    expect(await service.deletePermission(9001)).toEqual({ success: true });
    expect(await state()).toEqual({ permissions: 0, refs: 0, version: 1, revoked: 0 });
  });

  it('assignment winning the race cannot be silently cascaded away', async () => {
    const gate = barrier(/^INSERT IGNORE INTO role_permissions/);
    const assignment = service.assignPermissionToRole(9001, 9001);
    await gate.paused;
    let finished = false;
    const deletion = service.deletePermission(9001).finally(() => { finished = true; });
    try { await blockedOrFinished(() => finished); } finally { gate.resume(); }
    const [assigned, deleted] = await Promise.all([assignment, deletion]);
    expect(assigned.success).toBe(true);
    expect(deleted.success).toBe(false);
    expect(await state()).toEqual({ permissions: 1, refs: 1, version: 2, revoked: 1 });
  });

  it('deletion winning the race makes the later assignment explicitly fail', async () => {
    const gate = barrier(/SELECT.*FROM role_permissions WHERE permission_id/);
    const deletion = service.deletePermission(9001);
    await gate.paused;
    let finished = false;
    const assignment = service.assignPermissionToRole(9001, 9001).finally(() => { finished = true; });
    try { await blockedOrFinished(() => finished); } finally { gate.resume(); }
    const [deleted, assigned] = await Promise.all([deletion, assignment]);
    expect(deleted.success).toBe(true);
    expect(assigned.success).toBe(false);
    expect(assigned.error).toBeTruthy();
    expect(await state()).toEqual({ permissions: 0, refs: 0, version: 1, revoked: 0 });
  });

  it('rolls back deletion and releases its lock on SQL failure', async () => {
    afterExecute = async sql => { if (sql.startsWith('DELETE FROM permissions')) throw new Error('injected delete failure'); };
    expect((await service.deletePermission(9001)).success).toBe(false);
    expect(await state()).toEqual({ permissions: 1, refs: 0, version: 1, revoked: 0 });
    afterExecute = async () => {};
    expect((await service.assignPermissionToRole(9001, 9001)).success).toBe(true);
  });

  it('rolls back assignment and session changes when token revocation fails', async () => {
    beforeExecute = sql => { if (sql.startsWith('UPDATE refresh_tokens')) throw new Error('injected revocation failure'); };
    expect((await service.assignPermissionToRole(9001, 9001)).success).toBe(false);
    expect(await state()).toEqual({ permissions: 1, refs: 0, version: 1, revoked: 0 });
    expect((await service.deletePermission(9001)).success).toBe(true);
  });

  it('duplicate assignment keeps sessions unchanged after the first grant', async () => {
    expect((await service.assignPermissionToRole(9001, 9001)).success).toBe(true);
    expect((await service.assignPermissionToRole(9001, 9001)).success).toBe(true);
    expect(await state()).toEqual({ permissions: 1, refs: 1, version: 2, revoked: 1 });
    expect((await service.revokePermissionFromRole(9001, 9001)).success).toBe(true);
    expect(await state()).toEqual({ permissions: 1, refs: 0, version: 3, revoked: 1 });
  });
});
