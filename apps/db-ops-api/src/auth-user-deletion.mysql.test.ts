/** #299: opt-in real InnoDB, production route slice/JWT/RBAC, and browser UI.
 * SLIDE_USER_DELETE_MYSQL=1 SLIDE_TEST_PROFILES_FILE=... SLIDE_TEST_HANDLE_DIR=...
 * pnpm --filter slide-api exec vitest run src/auth-user-deletion.mysql.test.ts
 * Default test collection never reads private credentials or contacts MySQL.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import ts from 'typescript';
import { chromium, type Browser } from '@playwright/test';
import { dbConnection } from './db-connection.js';
import { MigrationRunner } from './migrations/runner.js';
import { createOwnedDatabase, generateRunNonce } from './testing/owned-fixture.js';
import { actorContextService, signAccessToken } from './auth/actor-context.js';
import { createVerifyToken } from './auth-middleware.js';
import { requirePermission } from './auth/require-permission.js';
import { rbacApiRoutes } from './auth/rbac-api.js';
import { strictBody } from './utils/strict-body.js';
import { authDatabaseService } from './auth-database-service.js';
import { AgentToolAuditService } from './security/agent-tool-audit-service.js';

describe.skipIf(process.env.SLIDE_USER_DELETE_MYSQL !== '1')('MAX-669 / #299 and MAX-673 / #492 user deletion', () => {
  let root: mysql.Pool, pool: mysql.Pool, token: string, browser: Browser;
  let owned: Awaited<ReturnType<typeof createOwnedDatabase>>;
  let vite: ChildProcess, viteExited: Promise<unknown>, origin: string;
  const app = Fastify();
  const secret = randomBytes(32).toString('hex');
  const audit = new AgentToolAuditService(() => ({ execute: (sql, values) => pool.execute(sql, values as any[]) }));
  const operator = 66901;
  const observations: Record<string, unknown>[] = [];
  const headers = () => ({ authorization: 'Bearer ' + token });
  const remove = (id: number) => app.inject({ method: 'DELETE', url: '/api/users/' + id, headers: headers() });
  async function user(id: number) {
    await pool.execute('INSERT INTO users(id,username,password_hash) VALUES(?,?,?)', [id, 'max669_' + id, 'no-login']);
    return actorContextService.loadActiveActor(id);
  }
  async function record(id: number, executor?: mysql.PoolConnection) {
    const actor = await actorContextService.loadActiveActor(id);
    await audit.record({ phase: 'decision', actor,
      decision: { allow: true, reasonCode: 'ALLOW', actor: { userId: id, username: actor.username, roles: [] },
        tool: 'slide_update_db_config', resource: { type: 'instance', instanceId: 1 }, requestId: actor.requestId },
      args: { instance_id: 1 },
    }, executor ? { execute: (sql, values) => executor.execute(sql, values as any[]) } : undefined);
  }
  const count = async (id: number) => {
    const [rows] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM agent_tool_audit WHERE actor_id=?', [id]);
    return Number(rows[0].n);
  };
  beforeAll(async () => {
    const file = process.env.SLIDE_TEST_PROFILES_FILE, handleDir = process.env.SLIDE_TEST_HANDLE_DIR;
    if (!file || !handleDir) throw Error('explicit profiles and evidence/handle directory required');
    const c = JSON.parse(readFileSync(file, 'utf8'))['mysql-test'];
    if (Number(c.port) !== 3308) throw Error('authorized mysql-test port 3308 required');
    root = mysql.createPool({ host: c.host, port: c.port, user: c.user, password: c.password });
    owned = await createOwnedDatabase(root, { nonce: generateRunNonce(), purpose: 'userdelete', handleDir });
    pool = mysql.createPool({ host: c.host, port: c.port, user: c.user, password: c.password,
      database: owned.database, connectionLimit: 4 });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    const started = Date.now();
    await new MigrationRunner(pool as any).run();
    console.info('MAX-669 migrated schema', owned.database, 'ms', Date.now() - started);
    console.info('MAX-669 environment', (await pool.query('SELECT VERSION() AS version, @@transaction_isolation AS isolation_level'))[0]);
    observations.push({ phase: 'environment', database: owned.database, mysqlPort: c.port,
      environment: (await pool.query('SELECT VERSION() AS version, @@transaction_isolation AS isolation_level'))[0] });
    await user(operator);
    await pool.execute("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE name='admin'", [operator]);
    token = signAccessToken(await actorContextService.loadActiveActor(operator), secret);
    const verifyToken = createVerifyToken(secret);
    app.decorate('verifyToken', verifyToken);
    await app.register(rbacApiRoutes);
    // Execute the actual server route definitions, without unrelated schedulers/model adapters.
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const start = source.indexOf('  // 列出所有用户\n'), end = source.indexOf('  // 重置密码\n', start);
    if (start < 0 || end < 0) throw Error('production route slice boundaries missing');
    new Function('fastify', 'verifyToken', 'requirePermission', 'authDatabaseService', 'dbConnection', 'strictBody',
      ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    )(app, verifyToken, requirePermission, authDatabaseService, dbConnection, strictBody);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as { port: number };
    const frontend = fileURLToPath(new URL('../../../frontend/', import.meta.url));
    // Vite CLI treats port=0 as its default port. Reserve an OS-assigned port first.
    const { createServer } = await import('node:net');
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const vitePort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort)], {
      cwd: frontend, env: { ...process.env, VITE_API_PROXY_TARGET: 'http://127.0.0.1:' + address.port },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    viteExited = once(vite, 'exit');
    origin = await new Promise<string>((resolve, reject) => {
      let output = '';
      let errors = '';
      const timer = setTimeout(() => reject(Error('Vite startup timed out')), 15000);
      vite.once('error', error => { clearTimeout(timer); reject(error); });
      vite.stderr!.on('data', chunk => { errors += String(chunk); });
      vite.once('exit', () => { clearTimeout(timer); reject(Error('Vite exited before readiness: ' + errors)); });
      vite.stdout!.on('data', chunk => {
        output += String(chunk);
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (url) { clearTimeout(timer); resolve(url); }
      });
    });
    browser = await chromium.launch({ headless: true });
    console.info('MAX-669 isolated API port', address.port, 'frontend', origin);
    observations.push({ phase: 'listeners', apiPort: address.port, frontend: origin });
  }, 120000); // Full repository schema migration, separate from request assertions.
  afterAll(async () => {
    // Stop request producers before the API/store; each cleanup failure remains a failing hook.
    try { await browser?.close(); }
    finally {
      try { if (vite && vite.exitCode === null) { vite.kill('SIGTERM'); await viteExited; } }
      finally {
        try { await app.close(); }
        finally {
          vi.restoreAllMocks();
          try { await pool?.end(); }
          finally {
            try {
              await owned?.drop();
              observations.push({ phase: 'cleanup', ownedSchemaRemoved: !!owned });
              console.info('MAX-669 cleanup: owned schema removed');
            } finally {
              await root?.end();
              if (process.env.SLIDE_TEST_HANDLE_DIR) writeFileSync(process.env.SLIDE_TEST_HANDLE_DIR + '/observations.json', JSON.stringify(observations, null, 2) + '\n');
            }
          }
        }
      }
    }
  });

  it('reproduces the real FK rejection, returns 409, preserves audit and supports existing deactivation', async () => {
    const id = 66902;
    const actor = await user(id);
    const priorToken = signAccessToken(actor, secret);
    await record(id);
    await expect(pool.execute('DELETE FROM users WHERE id=?', [id])).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2', errno: 1451 });
    const response = await remove(id);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ success: false, code: 'USER_HAS_RETAINED_RECORDS' });
    expect(response.body).toContain('停用');
    expect(response.body).not.toMatch(/DELETE|foreign key|fk_|sqlMessage/i);
    expect(await authDatabaseService.deleteUser(actor.username)).toMatchObject({ code: 'USER_HAS_RETAINED_RECORDS' });
    expect((await app.inject({ method: 'PUT', url: '/api/users/' + id, headers: headers(), payload: { status: 'inactive' } })).statusCode).toBe(200);
    expect((await pool.query<any[]>('SELECT username,status,session_version FROM users WHERE id=?', [id]))[0][0])
      .toMatchObject({ username: actor.username, status: 'inactive', session_version: 2 });
    expect(await count(id)).toBe(1);
    const [retained] = await pool.query<any[]>('SELECT u.username,a.actor_id FROM agent_tool_audit a JOIN users u ON u.id=a.actor_id WHERE a.actor_id=?', [id]);
    expect(retained[0]).toMatchObject({ username: actor.username, actor_id: id });
    await expect(actorContextService.authenticateAccessToken(priorToken, secret)).rejects.toThrow();
    console.info('MAX-669 audit retained after deactivate', retained);
    observations.push({ case: 'retained audit and deactivation', status: response.statusCode, retained,
      auditRows: await count(id), oldAccessTokenRejected: true });
  });

  it('deletes users without retained records, preserves admin/self protection and live permissions', async () => {
    await user(66903);
    expect((await remove(66903)).statusCode).toBe(200);
    expect((await pool.query<any[]>('SELECT id FROM users WHERE id=66903'))[0]).toHaveLength(0);
    const plain = await user(66904);
    expect(await authDatabaseService.deleteUser(plain.username)).toEqual({ success: true });
    const [admins] = await pool.query<any[]>("SELECT id FROM users WHERE username='admin'");
    expect((await remove(admins[0].id)).json().error).toBe('不能删除管理员账户');
    expect(await authDatabaseService.deleteUser('admin')).toMatchObject({ success: false });
    expect((await remove(operator)).json().error).toBe('不能删除自己');
    expect((await app.inject({ method: 'DELETE', url: '/api/users/' + operator })).statusCode).toBe(401);
    const unprivileged = signAccessToken(await user(66905), secret);
    expect((await app.inject({ method: 'DELETE', url: '/api/users/' + operator,
      headers: { authorization: 'Bearer ' + unprivileged } })).statusCode).toBe(403);
    await pool.execute('DELETE FROM user_roles WHERE user_id=?', [operator]);
    try { expect((await remove(66905)).statusCode).toBe(403); }
    finally { await pool.execute("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE name='admin'", [operator]); }
    observations.push({ case: 'no audit deletion, admin, self, unauthenticated and revoked permissions', passed: true });
  });

  for (const [index, status] of ['active', 'inactive', 'locked'].entries()) {
    it(`#492 deletes ${status} users without retained records and preserves authentication filtering`, async () => {
      const id = 67310 + index;
      await user(id);
      await pool.execute('UPDATE users SET status=? WHERE id=?', [status, id]);
      expect(await authDatabaseService.getUserById(id)).toEqual(status === 'active'
        ? expect.objectContaining({ id }) : null);
      const response = await remove(id);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect((await pool.query<any[]>('SELECT id FROM users WHERE id=?', [id]))[0]).toHaveLength(0);
      observations.push({ case: '#492 delete without audit', status, httpStatus: response.statusCode, userRows: 0 });
    });

    it(`#492 preserves the complete audit row and user identity for ${status} users`, async () => {
      const id = 67320 + index;
      const actor = await user(id);
      await record(id);
      await pool.execute('UPDATE users SET status=? WHERE id=?', [status, id]);
      const before = (await pool.query('SELECT * FROM agent_tool_audit WHERE actor_id=?', [id]))[0];
      const response = await remove(id);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ success: false, code: 'USER_HAS_RETAINED_RECORDS' });
      expect(response.body).not.toMatch(/fk_|DELETE|sqlMessage|foreign key/i);
      expect((await pool.query('SELECT * FROM agent_tool_audit WHERE actor_id=?', [id]))[0]).toEqual(before);
      expect((await pool.query<any[]>('SELECT username,status FROM users WHERE id=?', [id]))[0][0])
        .toEqual({ username: actor.username, status });
      observations.push({ case: '#492 retained audit', status, httpStatus: response.statusCode,
        auditRows: await count(id), completeAuditUnchanged: true, username: actor.username });
    });

    it(`#492 protects the ${status} admin account`, async () => {
      const [rows] = await pool.query<any[]>("SELECT id FROM users WHERE username='admin'");
      const id = rows[0].id;
      await pool.execute('UPDATE users SET status=? WHERE id=?', [status, id]);
      try {
        const response = await remove(id);
        expect(response.statusCode).toBe(400);
        expect(response.json().error).toBe('不能删除管理员账户');
        expect((await pool.query<any[]>('SELECT id FROM users WHERE id=?', [id]))[0]).toHaveLength(1);
        observations.push({ case: '#492 admin protection', status, httpStatus: response.statusCode, userRows: 1 });
      } finally { await pool.execute("UPDATE users SET status='active' WHERE id=?", [id]); }
    });
  }

  it('#492 returns absence for a nonexistent ID and preserves self-delete protection', async () => {
    const missing = await remove(67399);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ success: false, error: '用户不存在' });
    const self = await remove(operator);
    expect(self.statusCode).toBe(400);
    expect(self.json().error).toBe('不能删除自己');
    expect((await pool.query<any[]>('SELECT id FROM users WHERE id=?', [operator]))[0]).toHaveLength(1);
    observations.push({ case: '#492 nonexistent and self', missingStatus: missing.statusCode, selfStatus: self.statusCode });
  });

  it('an uncommitted audit write wins: DELETE waits then reports a safe conflict', async () => {
    const id = 66906;
    await user(id);
    const writer = await pool.getConnection();
    let deletion: ReturnType<typeof remove> | undefined;
    try {
      await writer.beginTransaction();
      await record(id, writer);
      deletion = remove(id);
      await expect.poll(async () => {
        const [rows] = await root.query<any[]>(`SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w
          JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.BLOCKING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=?`, [owned.database]);
        return Number(rows[0].n);
      }, { timeout: 3000 }).toBeGreaterThan(0);
      await writer.commit();
      const response = await deletion;
      expect(response.statusCode).toBe(409);
      expect(response.body).toContain('停用');
      expect(await count(id)).toBe(1);
      expect(await authDatabaseService.getUserById(id)).not.toBeNull();
      observations.push({ case: 'concurrent audit commit', lockWaitObserved: true, status: response.statusCode, auditRows: await count(id) });
    } finally { await writer.rollback(); writer.release(); await deletion; }
  });

  it('a committed deletion rejects late audit writes without creating dangling records', async () => {
    const id = 66907, actor = await user(id);
    expect((await remove(id)).statusCode).toBe(200);
    await expect(audit.record({ phase: 'decision', actor,
      decision: { allow: true, reasonCode: 'ALLOW', actor: { userId: id, username: actor.username, roles: [] },
        tool: 'slide_update_db_config', resource: { type: 'instance', instanceId: 1 }, requestId: actor.requestId }, args: {},
    })).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    expect(await count(id)).toBe(0);
    observations.push({ case: 'late audit after deletion', rejected: 'ER_NO_REFERENCED_ROW_2', auditRows: 0 });
  });

  it('production users UI shows the real conflict and completes deactivation at desktop sizes', async () => {
    for (const [index, [width, height]] of [[1440, 900], [1366, 768], [1920, 1080]].entries()) {
      const id = 66910 + index;
      await user(id); await record(id);
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await page.addInitScript(value => (globalThis as any).localStorage.setItem('token', value), token);
        await page.goto(origin + '/e2e/fixtures/user-deletion.html');
        const view = page.locator('users-management');
        const row = view.locator('tr').filter({ hasText: 'max669_' + id });
        await row.getByRole('button', { name: '删除', exact: true }).waitFor();
        page.once('dialog', dialog => dialog.accept());
        const response = page.waitForResponse(r => r.url().endsWith('/api/users/' + id) && r.request().method() === 'DELETE');
        await row.getByRole('button', { name: '删除', exact: true }).press('Enter');
        expect((await response).status()).toBe(409);
        await page.waitForFunction(() => (globalThis as any).document.querySelector('users-management')?.shadowRoot?.querySelector('.error-msg')?.textContent?.includes('停用'));
        expect(await view.locator('.error-msg').innerText()).toContain('审计');
        expect(await view.locator('.error-msg').innerText()).not.toMatch(/DELETE|fk_|foreign key/i);
        await page.screenshot({ path: process.env.SLIDE_TEST_HANDLE_DIR + '/conflict-' + width + '.png', fullPage: true });
        await row.getByRole('button', { name: '编辑', exact: true }).press('Enter');
        const status = view.locator('select').filter({ has: page.locator('option[value="inactive"]') });
        await status.selectOption('inactive');
        const updated = page.waitForResponse(r => r.url().endsWith('/api/users/' + id) && r.request().method() === 'PUT');
        await view.getByRole('button', { name: '保存', exact: true }).press('Enter');
        expect((await updated).status()).toBe(200);
        await page.waitForFunction(target => {
          const rows = (globalThis as any).document.querySelector('users-management')?.shadowRoot?.querySelectorAll('tr');
          return Array.from(rows ?? []).some((row: any) => row.textContent?.includes(target) && row.textContent?.includes('停用'));
        }, 'max669_' + id);
        expect(await count(id)).toBe(1);
        expect(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth)).toBe(true);
        await page.screenshot({ path: process.env.SLIDE_TEST_HANDLE_DIR + '/inactive-' + width + '.png', fullPage: true });
        observations.push({ case: 'browser conflict then deactivation', width, height, conflictStatus: 409,
          deactivationStatus: 200, auditRows: await count(id), keyboardSubmission: true, noPageOverflow: true });
      } finally { await page.close(); }
    }
  }, 60000);
});
