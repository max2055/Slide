import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Explicit opt-in: default collection never reads developer credentials.
test.skip(process.env.SIDEBAR_REAL_REAL !== '1', 'Requires injected MySQL test access');
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise'), bcrypt = require('bcrypt'), dotenv = require('dotenv');
const output = resolve(process.env.SIDEBAR_REAL_EVIDENCE_DIR || './test-results-sidebar-real');
const schema = `max661_status_${process.pid}`;
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
  if (!process.env.SIDEBAR_REAL_DB_PROFILES) throw new Error('SIDEBAR_REAL_DB_PROFILES is required');
  await mkdir(output, { recursive: true });
  const profile = JSON.parse(await readFile(process.env.SIDEBAR_REAL_DB_PROFILES, 'utf8'))['mysql-test'];
  const connection = { host: profile.host, port: profile.port, user: profile.user, password: profile.password };
  db = await mysql.createConnection(connection);
  report.database = { host: connection.host, port: connection.port };
  await db.query(`CREATE DATABASE \`${schema}\``);
  if (!process.env.SIDEBAR_REAL_BACKEND_ENV) throw new Error('SIDEBAR_REAL_BACKEND_ENV is required');
  const sourceEnv = dotenv.parse(await readFile(process.env.SIDEBAR_REAL_BACKEND_ENV));
  const env = {
    DB_HOST: String(connection.host), DB_PORT: String(connection.port), DB_USER: connection.user,
    DB_PASSWORD: connection.password, DB_NAME: schema, PORT: '3276', AGENT_WS_PORT: '29776',
    AGENT_WORKSPACE: resolve(output, 'runtime'), PROMPT_VERSIONS_DIR: resolve(output, 'runtime/prompts'),
    NODE_ENV: 'test', JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: sourceEnv.ENCRYPTION_KEY,
    INITIAL_ADMIN_USERNAME: 'max661-initial-admin', INITIAL_ADMIN_PASSWORD: randomBytes(24).toString('hex'),
  };
  const init = await start(['--import', 'tsx', 'init-db.ts'], env, 'migration');
  expect(await new Promise(done => init.once('exit', done))).toBe(0);
  await db.query(`USE \`${schema}\``);
  const [user] = await db.execute("INSERT INTO users(username,password_hash,status) VALUES('max661-reader',?,'active')", [await bcrypt.hash(password, 10)]);
  const [role] = await db.execute("INSERT INTO roles(name) VALUES('max661-reader')"); roleId = role.insertId;
  await db.execute('INSERT INTO user_roles(user_id,role_id) VALUES(?,?)', [user.insertId, roleId]);
  await db.execute("INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code IN ('config:view','alert:view')", [roleId]);
  // Copy encrypted Provider configuration for DirectAdapter initialization only.
  // No model discovery/inference; keys stay encrypted in the task-owned schema.
  const platform = JSON.parse(await readFile(process.env.SIDEBAR_REAL_DB_PROFILES, 'utf8'))['slide-platform'];
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
    try { return (await fetch('http://127.0.0.1:3276/api/health/ready')).status; } catch { return 0; }
  }, { timeout: 60_000 }).toBe(200);
});
test.afterAll(async () => {
  // Stop the clients before their dependencies. Only kill recorded children;
  // the runtime daemon PID is passed from its status result, never inferred.
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) {
    if (child.pid === Number(process.env.SIDEBAR_REAL_DAEMON_PID)) throw new Error('Refusing daemon termination');
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
test('#650 real login and MySQL preference round-trip through production UI', async ({ page, request }) => {
  const api = 'http://127.0.0.1:3276';
  const login = await request.post(`${api}/api/auth/login`, { data: { username: 'max661-reader', password } });
  expect(login.status()).toBe(200);
  const token = (await login.json()).token;
  const headers = { authorization: `Bearer ${token}` };
  // Legacy record: last visible tab is attention; everything else is already hidden.
  const saved = await request.put(`${api}/api/user/preferences`, { headers, data: { preferences: { visibleTabs: ['attention'], locale: 'zh-CN' } } });
  expect(saved.status()).toBe(200);
  const unauthenticatedStatus = (await request.get(`${api}/api/user/preferences`)).status();
  // Record unrelated auth error formatting without expanding this preference fix.
  expect(unauthenticatedStatus).not.toBe(200);
  await page.addInitScript(token => {
    localStorage.setItem('token', token);
    localStorage.setItem('slide.control.session_token.v1', token);
    localStorage.setItem('permissions', JSON.stringify(['config:view', 'alert:view']));
  }, token);
  const startupSave = page.waitForResponse(r => r.url().endsWith('/api/user/preferences') && r.request().method() === 'PUT' && r.request().postDataJSON().preferences.visibleTabs.includes('attention'));
  await page.goto('/settings/platform/appearance');
  expect((await startupSave).status()).toBe(200);
  const attention = page.locator('appearance-settings app-toggle').filter({ hasText: '关注事项' }).locator('button');
  await expect(attention).toHaveAttribute('aria-pressed', 'true');
  const response = page.waitForResponse(r => r.url().endsWith('/api/user/preferences') && r.request().method() === 'PUT' && r.request().postDataJSON().preferences.visibleTabsConfigured === true);
  await attention.focus(); await page.keyboard.press('Space');
  expect((await response).status()).toBe(200);
  await expect(attention).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.shell-nav a.nav-item')).toHaveCount(0);
  const persisted = await request.get(`${api}/api/user/preferences`, { headers });
  expect((await persisted.json()).preferences).toMatchObject({ visibleTabs: [], visibleTabsConfigured: true });
  const [rows] = await db.query('SELECT preferences FROM user_preferences WHERE user_id=(SELECT id FROM users WHERE username=?)', ['max661-reader']);
  const record = typeof rows[0].preferences === 'string' ? JSON.parse(rows[0].preferences) : rows[0].preferences;
  expect(record).toMatchObject({ visibleTabs: [], visibleTabsConfigured: true });
  await page.evaluate(() => { localStorage.removeItem('slide.control.settings.v1:default'); localStorage.removeItem('slide.control.settings.v1'); });
  await page.reload();
  await expect(attention).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.shell-nav a.nav-item')).toHaveCount(0);
  await page.screenshot({ animations: 'disabled', path: `${output}/real-hidden.png` });
  report.checks.push({ unauthenticatedStatus, save: 200, get: persisted.status(), sql: { visibleTabs: record.visibleTabs, visibleTabsConfigured: record.visibleTabsConfigured }, serverRestoreAfterClearingLocal: true });
  await attention.click();
  await expect(attention).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.shell-nav a.nav-item')).toHaveCount(1);
  await page.close();
});
