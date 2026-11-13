import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Explicit opt-in: default collection never reads developer credentials.
test.skip(process.env.PLATFORM_STATUS_REAL !== '1', 'Requires injected MySQL test access');
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise'), bcrypt = require('bcrypt'), dotenv = require('dotenv');
const output = resolve(process.env.PLATFORM_STATUS_EVIDENCE_DIR || './test-results-platform-status-real');
const schema = `max651_status_${process.pid}`;
const password = randomBytes(24).toString('hex');
const children: ChildProcess[] = [];
const report: any = { schema, modelCalls: 0, checks: [], processes: [], cleanupErrors: [] };
let db: any, roleId: number;
async function start(args: string[], env: NodeJS.ProcessEnv, label: string) {
  const cwd = resolve('../apps/db-ops-api');
  const log = await open(`${output}/${label}.private.log`, 'w', 0o600);
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', log.fd, log.fd] });
  await log.close(); children.push(child);
  report.processes.push({ pid: child.pid, cwd, command: [process.execPath, ...args], label });
  return child;
}
test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!process.env.PLATFORM_STATUS_DB_PROFILES) throw new Error('PLATFORM_STATUS_DB_PROFILES is required');
  await mkdir(output, { recursive: true });
  const profile = JSON.parse(await readFile(process.env.PLATFORM_STATUS_DB_PROFILES, 'utf8'))['mysql-test'];
  const connection = { host: profile.host, port: profile.port, user: profile.user, password: profile.password };
  db = await mysql.createConnection(connection);
  report.database = { host: connection.host, port: connection.port };
  await db.query(`CREATE DATABASE \`${schema}\``);
  if (!process.env.PLATFORM_STATUS_BACKEND_ENV) throw new Error('PLATFORM_STATUS_BACKEND_ENV is required');
  const sourceEnv = dotenv.parse(await readFile(process.env.PLATFORM_STATUS_BACKEND_ENV));
  const env = {
    DB_HOST: String(connection.host), DB_PORT: String(connection.port), DB_USER: connection.user,
    DB_PASSWORD: connection.password, DB_NAME: schema, PORT: '3272', AGENT_WS_PORT: '29772',
    AGENT_WORKSPACE: resolve(output, 'runtime'), PROMPT_VERSIONS_DIR: resolve(output, 'runtime/prompts'),
    NODE_ENV: 'test', JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: sourceEnv.ENCRYPTION_KEY,
    INITIAL_ADMIN_USERNAME: 'max651-initial-admin', INITIAL_ADMIN_PASSWORD: randomBytes(24).toString('hex'),
  };
  const init = await start(['--import', 'tsx', 'init-db.ts'], env, 'migration');
  expect(await new Promise(done => init.once('exit', done))).toBe(0);
  await db.query(`USE \`${schema}\``);
  const [user] = await db.execute("INSERT INTO users(username,password_hash,status) VALUES('max651-reader',?,'active')", [await bcrypt.hash(password, 10)]);
  const [role] = await db.execute("INSERT INTO roles(name) VALUES('max651-reader')"); roleId = role.insertId;
  await db.execute('INSERT INTO user_roles(user_id,role_id) VALUES(?,?)', [user.insertId, roleId]);
  await db.execute("INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code IN ('config:view','audit:view')", [roleId]);
  // Copy encrypted Provider configuration for DirectAdapter initialization only.
  // No model discovery/inference; keys stay encrypted in the task-owned schema.
  const platform = JSON.parse(await readFile(process.env.PLATFORM_STATUS_DB_PROFILES, 'utf8'))['slide-platform'];
  const source = await mysql.createConnection({ host: platform.host, port: platform.port, user: platform.user, password: platform.password, database: platform.database || sourceEnv.DB_NAME });
  try {
    const [rows] = await source.query('SELECT * FROM llm_providers');
    const [columns] = await db.query('SHOW COLUMNS FROM llm_providers');
    const names = new Set(columns.map((column: any) => column.Field));
    await db.query('DELETE FROM llm_providers');
    for (const row of rows) {
      const copy = Object.fromEntries(Object.entries(row).filter(([key]) => names.has(key)).map(([key, value]) =>
        [key, value && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value]));
      await db.query('INSERT INTO llm_providers SET ?', [copy]);
    }
  } finally { await source.end(); }
  const api = await start(['--import', 'tsx', 'server.ts'], env, 'api');
  await expect.poll(async () => {
    if (api.exitCode !== null) throw new Error('API exited; inspect private log');
    try { return (await fetch('http://127.0.0.1:3272/api/health/ready')).status; } catch { return 0; }
  }, { timeout: 60_000 }).toBe(200);
});
test.afterAll(async () => {
  // Stop the clients before their dependencies. Only kill recorded children;
  // the runtime daemon PID is passed from its status result, never inferred.
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) {
    if (child.pid === Number(process.env.PLATFORM_STATUS_DAEMON_PID)) throw new Error('Refusing daemon termination');
    child.kill('SIGTERM');
    await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => setTimeout(done, 5000))]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(done => child.once('exit', done)); }
  }
  if (db) {
    try { await db.query(`DROP DATABASE IF EXISTS \`${schema}\``); report.cleaned = true; }
    catch (error: any) { report.cleanupErrors.push(error.code || error.name); }
    finally { await db.end(); }
  }
  await writeFile(`${output}/real-result.json`, JSON.stringify(report, null, 2));
  expect(report.cleanupErrors).toEqual([]);
});
test('#436 real login, API authorization, database revocation and production page', async ({ page, request }) => {
  const api = 'http://127.0.0.1:3272';
  const login = await request.post(`${api}/api/auth/login`, { data: { username: 'max651-reader', password } });
  expect(login.status()).toBe(200);
  const body = await login.json();
  const token = body.token || body.accessToken;
  expect(typeof token).toBe('string');
  const headers = { authorization: `Bearer ${token}` };
  const endpoints = ['/api/health/overview', '/api/platform/observations', '/api/agent/security/sandbox'];
  for (const endpoint of endpoints) {
    const denied = await request.get(`${api}${endpoint}`); expect([401, 403]).toContain(denied.status());
    const allowed = await request.get(`${api}${endpoint}`, { headers }); expect(allowed.status()).toBe(200);
    report.checks.push({ endpoint, unauthenticated: denied.status(), allowed: allowed.status() });
  }
  await page.addInitScript(token => {
    localStorage.setItem('token', token);
    localStorage.setItem('slide.control.session_token.v1', token);
    localStorage.setItem('permissions', JSON.stringify(['config:view', 'audit:view']));
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', theme: 'light' }));
  }, token);
  await page.goto('/health?view=sandbox');
  await expect(page.locator('agent-sandbox-status-page')).toBeVisible();
  await page.getByRole('tab', { name: '平台观测', exact: true }).click();
  await expect(page.locator('platform-observations-page')).toBeVisible();
  await page.getByRole('tab', { name: '平台自检', exact: true }).click();
  await expect(page.locator('health-center-page')).toBeVisible();
  // Revoke in the actual database; the SAME JWT must fail immediately.
  await db.execute('DELETE FROM role_permissions WHERE role_id=?', [roleId]);
  for (const endpoint of endpoints) {
    const denied = await request.get(`${api}${endpoint}`, { headers }); expect(denied.status()).toBe(403);
    report.checks.push({ endpoint, revokedSameToken: denied.status() });
  }
  const current = await request.get(`${api}/api/auth/permissions`, { headers });
  expect(current.status()).toBe(200); const permissions = await current.json(); expect(permissions).toEqual([]);
  await page.evaluate(permissions => {
    localStorage.setItem('permissions', JSON.stringify(permissions));
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions } }));
  }, permissions);
  await expect(page.locator('platform-status-page app-empty-state')).toHaveAttribute('title', '无权限访问平台状态');
  await expect(page.locator('platform-status-page').locator('health-center-page,platform-observations-page,agent-sandbox-status-page')).toHaveCount(0);
  report.checks.push('real permission response applied through production permissions event; no child mounted');
  // A client that lies about permissions still cannot bypass the API.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: ['config:view'] } }));
  });
  await expect(page.locator('health-center-page')).toBeVisible();
  expect((await request.get(`${api}/api/health/overview`, { headers })).status()).toBe(403);
  await page.close();
});
