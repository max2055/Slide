import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Opt-in real Fastify/JWT/MySQL acceptance. Never mutates the source schema.
test.skip(process.env.MAX339_REAL !== '1', 'Requires authorized local MySQL access');
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise'), bcrypt = require('bcrypt'), dotenv = require('dotenv');
const output = resolve('../outputs/max339-followup');
const schema = `db_ops_ai_qualification_max339_${process.pid}`;
const password = randomBytes(24).toString('hex');
const children: ChildProcess[] = [];
let db: any, userId: number, targetId: number;
const report: any = { schema, modelCalls: 0, checks: [], processes: [], ports: { api: 3197, agent: 28997, vite: 5197 } };
async function start(command: string, args: string[], env: any, cwd: string, label: string) {
  const log = await open(`${output}/${label}.private.log`, 'w', 0o600);
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', log.fd, log.fd] });
  await log.close(); children.push(child);
  report.processes.push({ pid: child.pid, cwd, command: [command, ...args], label });
  return child;
}
async function ready(url: string, child: ChildProcess) {
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error('Owned process exited; inspect private log');
    try { return (await fetch(url)).status; } catch { return 0; }
  }, { timeout: 90000 }).toBe(200);
}
test.beforeAll(async () => {
  test.setTimeout(180000);
  await mkdir(output, { recursive: true });
  const cfg = dotenv.parse(await readFile(process.env.SLIDE_DEBUG_ENV_FILE!));
  const connection = { host: cfg.DB_HOST || '127.0.0.1', port: Number(cfg.DB_PORT || 3306), user: cfg.DB_USER, password: cfg.DB_PASSWORD };
  db = await mysql.createConnection(connection);
  report.database = { host: connection.host, port: connection.port, version: (await db.query('SELECT VERSION() AS version'))[0][0].version };
  await db.query(`CREATE DATABASE \`${schema}\``);
  const apiDir = resolve('../apps/db-ops-api');
  const env = { ...cfg, DB_NAME: schema, PORT: '3197', AGENT_WS_PORT: '28997', NODE_ENV: 'test', JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: cfg.ENCRYPTION_KEY };
  const init = await start(process.execPath, ['--import', 'tsx', 'init-db.ts'], env, apiDir, 'migration');
  expect(await new Promise(done => init.once('exit', done))).toBe(0);
  await db.query(`USE \`${schema}\``);
  const [user] = await db.execute("INSERT INTO users(username,password_hash,status) VALUES('max339-test',?,'active')", [await bcrypt.hash(password, 10)]);
  userId = user.insertId;
  await db.execute("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE name='admin'", [userId]);
  const [target] = await db.execute("INSERT INTO users(username,password_hash,status,email) VALUES('max339-dual',?,'active','before@example.test')", [await bcrypt.hash(password, 10)]);
  targetId = target.insertId;
  await db.execute("INSERT INTO user_roles(user_id,role_id,grant_expiry) SELECT ?,id,'2030-01-01 00:00:00' FROM roles WHERE name IN ('dba','auditor')", [targetId]);
  // Reuse configured encrypted providers solely for runtime initialization, with
  // the existing encryption key in memory. No discovery, tests or inference.
  const source = await mysql.createConnection({ ...connection, database: cfg.DB_NAME });
  try {
    for (const table of ['llm_providers', 'llm_scene_bindings']) {
      const [rows] = await source.query('SELECT * FROM ??', [table]);
      const [columns] = await db.query('SHOW COLUMNS FROM ??', [table]);
      const names = new Set(columns.map((column: any) => column.Field));
      await db.query('DELETE FROM ??', [table]);
      for (const row of rows) {
        const copy = Object.fromEntries(Object.entries(row).filter(([key]) => names.has(key)).map(([key, value]) =>
          [key, value && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value]));
        await db.query('INSERT INTO ?? SET ?', [table, copy]);
      }
    }
  } finally { await source.end(); }
  const api = await start(process.execPath, ['--import', 'tsx', 'server.ts'], env, apiDir, 'api');
  await ready('http://127.0.0.1:3197/api/health/ready', api);
  const vite = await start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5197', '--strictPort'], { VITE_API_PROXY_TARGET: 'http://127.0.0.1:3197', VITE_AGENT_WS_PROXY_TARGET: 'http://127.0.0.1:28997', VITE_AGENT_WS_URL: 'ws://127.0.0.1:28997' }, resolve('.'), 'vite');
  await ready('http://127.0.0.1:5197', vite);
});
test.afterAll(async () => {
  for (const child of children.reverse()) if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => setTimeout(done, 5000))]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(done => child.once('exit', done)); }
  }
  report.processesStopped = children.every(child => child.exitCode !== null || child.signalCode !== null);
  if (db) { await db.query(`DROP DATABASE IF EXISTS \`${schema}\``); await db.end(); report.cleaned = true; }
  await writeFile(`${output}/real-result.json`, JSON.stringify(report, null, 2));
});
test('MAX-339 real profile, role selection, cancel and permission denial', async ({ page }, info) => {
  test.setTimeout(90000);
  const roleSnapshot = async () => {
    const [rows] = await db.execute('SELECT ur.id,ur.role_id,r.name,ur.grant_expiry FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=? ORDER BY ur.role_id', [targetId]);
    return rows.map((row: any) => ({ ...row, grant_expiry: row.grant_expiry?.toISOString() }));
  };
  const profile = async () => (await db.execute('SELECT email,status FROM users WHERE id=?', [targetId]))[0][0];
  const before = await roleSnapshot();
  expect(before.map((r: any) => r.name).sort()).toEqual(['auditor', 'dba']);
  await page.addInitScript(() => localStorage.setItem('slide.i18n.locale', 'zh-CN'));
  await page.goto('http://127.0.0.1:5197/settings/access/users', { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill('max339-test');
  await page.getByLabel('密码', { exact: true }).fill(password);
  const login = page.waitForResponse(r => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  expect((await login).status()).toBe(200);
  const view = page.locator('users-management');
  const edit = view.getByRole('row').filter({ hasText: 'max339-dual' }).getByRole('button', { name: '编辑', exact: true });
  const roleWrites: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/api/v1/rbac/users/') && request.method() !== 'GET') roleWrites.push(request.method() + ' ' + new URL(request.url()).pathname);
  });
  await edit.click();
  await expect(view.getByRole('checkbox', { name: '数据库管理员', exact: true })).toBeChecked();
  await expect(view.getByRole('checkbox', { name: '审计员', exact: true })).toBeChecked();
  await view.getByLabel('邮箱', { exact: true }).fill('after@example.test');
  const saved = page.waitForResponse(r => r.url().endsWith('/api/users/' + targetId) && r.request().method() === 'PUT');
  await view.getByRole('button', { name: '保存', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(view.getByRole('dialog')).toHaveCount(0);
  expect(await roleSnapshot()).toEqual(before);
  expect(await profile()).toMatchObject({ email: 'after@example.test', status: 'active' });
  expect(roleWrites).toEqual([]);
  report.checks.push('profile-only save: real PUT 200, no role writes, both binding IDs and expiry unchanged');
  report.profilePreservedBindings = before;

  // Cancel through the keyboard. No mutation should reach either API or MySQL.
  const writes: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/') && ['PUT','POST','DELETE'].includes(request.method())) writes.push(request.method() + ' ' + new URL(request.url()).pathname); });
  await edit.click();
  await view.getByRole('checkbox', { name: '数据库管理员', exact: true }).uncheck();
  await view.getByRole('checkbox', { name: '观察者', exact: true }).check();
  await view.getByLabel('邮箱', { exact: true }).fill('cancelled@example.test');
  const cancel = view.getByRole('button', { name: '取消', exact: true });
  await cancel.focus(); await page.keyboard.press('Enter');
  await expect(view.getByRole('dialog')).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(await roleSnapshot()).toEqual(before);
  expect((await profile()).email).toBe('after@example.test');
  report.checks.push('cancel via keyboard: no API mutations and unchanged MySQL profile/bindings');

  await edit.click();
  await expect(view.getByRole('checkbox', { name: '数据库管理员', exact: true })).toBeChecked();
  await expect(view.getByRole('checkbox', { name: '审计员', exact: true })).toBeChecked();
  await view.getByRole('checkbox', { name: '数据库管理员', exact: true }).uncheck();
  await view.getByRole('checkbox', { name: '观察者', exact: true }).check();
  await page.screenshot({ path: info.outputPath('real-role-selection.png') });
  await view.getByRole('button', { name: '保存', exact: true }).click();
  await expect(view.getByRole('dialog')).toHaveCount(0);
  const after = await roleSnapshot();
  expect(after.map((r: any) => r.name).sort()).toEqual(['auditor', 'viewer']);
  expect(after.find((r: any) => r.name === 'auditor')).toEqual(before.find((r: any) => r.name === 'auditor'));
  expect(roleWrites).toHaveLength(2);
  report.checks.push('explicit role change: MySQL has exactly auditor/viewer; auditor binding ID and expiry retained');
  report.explicitRoleWrites = roleWrites;
  report.afterBindings = after;
  // Reload fetches live bindings rather than reusing the form's state.
  await page.reload();
  await edit.click();
  await expect(view.getByRole('checkbox', { name: '观察者', exact: true })).toBeChecked();
  await expect(view.getByRole('checkbox', { name: '数据库管理员', exact: true })).not.toBeChecked();
  await view.getByRole('button', { name: '取消', exact: true }).click();

  // Real lower-privilege and anonymous JWT boundaries reject role/profile changes.
  const lowerLogin = await page.request.post('http://127.0.0.1:5197/api/auth/login', { data: { username: 'max339-dual', password } });
  expect(lowerLogin.status()).toBe(200);
  const lower = await lowerLogin.json();
  const headers = { Authorization: 'Bearer ' + lower.token };
  const denied = [
    await page.request.get('http://127.0.0.1:5197/api/users', { headers }),
    await page.request.put('http://127.0.0.1:5197/api/users/' + targetId, { headers, data: { status: 'locked' } }),
    await page.request.post('http://127.0.0.1:5197/api/v1/rbac/users/' + targetId + '/roles', { headers, data: { roleId: before[0].role_id } }),
    await page.request.delete('http://127.0.0.1:5197/api/v1/rbac/users/' + targetId + '/roles/' + after[0].role_id, { headers }),
  ];
  expect(denied.map(r => r.status())).toEqual([403,403,403,403]);
  const anonymous = await page.request.put('http://127.0.0.1:5197/api/users/' + targetId, { data: { status: 'locked' } });
  expect(anonymous.status()).toBe(401);
  expect(await roleSnapshot()).toEqual(after);
  expect((await profile()).status).toBe('active');
  report.checks.push('real permission regression: non-admin list/profile/assign/remove 403, anonymous profile 401; DB unchanged');
  // Verify a stale admin UI handles a real permission denial and sends no role changes.
  await edit.click();
  await view.getByRole('checkbox', { name: '观察者', exact: true }).uncheck();
  await page.evaluate(token => localStorage.setItem('token', token), lower.token);
  const roleWriteCount = roleWrites.length;
  await view.getByRole('button', { name: '保存', exact: true }).click();
  await expect(view.locator('.save-error')).toContainText('403');
  expect(roleWrites).toHaveLength(roleWriteCount);
  expect(await roleSnapshot()).toEqual(after);
  report.checks.push('stale admin form with real lower-privilege JWT: PUT 403 shown; no role writes');
});
