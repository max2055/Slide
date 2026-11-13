import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Opt-in real Fastify/JWT/MySQL acceptance. Never mutates the source schema.
test.skip(process.env.MAX338_REAL !== '1', 'Requires authorized local MySQL access');
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise'), bcrypt = require('bcrypt'), dotenv = require('dotenv');
const output = resolve('../outputs/max338-followup');
const schema = `db_ops_ai_qualification_max338_${process.pid}`;
const password = randomBytes(24).toString('hex');
const children: ChildProcess[] = [];
let db: any, userId: number;
const report: any = { schema, modelCalls: 0, checks: [], processes: [] };
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
  report.database = { host: connection.host, port: connection.port };
  await db.query(`CREATE DATABASE \`${schema}\``);
  const apiDir = resolve('../apps/db-ops-api');
  const env = { ...cfg, DB_NAME: schema, PORT: '3198', AGENT_WS_PORT: '28998', NODE_ENV: 'test', JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: cfg.ENCRYPTION_KEY };
  const init = await start(process.execPath, ['--import', 'tsx', 'init-db.ts'], env, apiDir, 'migration');
  expect(await new Promise(done => init.once('exit', done))).toBe(0);
  await db.query(`USE \`${schema}\``);
  const [user] = await db.execute("INSERT INTO users(username,password_hash,status) VALUES('max338-test',?,'active')", [await bcrypt.hash(password, 10)]);
  userId = user.insertId;
  await db.execute("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE name='admin'", [userId]);
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
  await ready('http://127.0.0.1:3198/api/health/ready', api);
  const vite = await start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { VITE_API_PROXY_TARGET: 'http://127.0.0.1:3198', VITE_AGENT_WS_PROXY_TARGET: 'http://127.0.0.1:28998', VITE_AGENT_WS_URL: 'ws://127.0.0.1:28998' }, resolve('.'), 'vite');
  await ready('http://127.0.0.1:5199', vite);
});
test.afterAll(async () => {
  for (const child of children.reverse()) if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => setTimeout(done, 5000))]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(done => child.once('exit', done)); }
  }
  if (db) { await db.query(`DROP DATABASE IF EXISTS \`${schema}\``); await db.end(); report.cleaned = true; }
  await writeFile(`${output}/real-result.json`, JSON.stringify(report, null, 2));
});
test('real login, delayed live permissions, failure recovery and database revocation', async ({ page }) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => localStorage.setItem("slide.i18n.locale", "zh-CN"));
  page.on("pageerror", error => console.log("browser error:", error.message));
  console.log('stage: navigate');
  await page.goto('http://127.0.0.1:5199/settings/access/users', { waitUntil: 'domcontentloaded' });
  console.log('stage: login form');
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill('max338-test');
  await page.getByLabel('密码', { exact: true }).fill(password);
  const login = page.waitForResponse(r => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  expect((await login).status()).toBe(200);
  console.log('stage: check complete');
  report.checks.push('real browser login 200');
  // Delay a real upstream response; never synthesize permission data.
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  await page.route('**/api/auth/permissions', async route => {
    const response = await route.fetch(); await gate; await route.fulfill({ response });
  });
  console.log('stage: navigate');
  await page.goto('http://127.0.0.1:5199/settings/access/users', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('settings-shell app-empty-state')).toHaveAttribute('title', '权限加载中');
  await expect(page.locator('users-management')).toHaveCount(0);
  release();
  await expect(page.locator('users-management')).toHaveCount(1);
  console.log('stage: check complete');
  report.checks.push('real delayed permissions: deny before response, mount after response');
  await page.unroute('**/api/auth/permissions');
  await page.route('**/api/auth/permissions', route => route.abort('connectionfailed'));
  console.log('stage: navigate');
  await page.goto('http://127.0.0.1:5199/settings/access/users', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('settings-shell app-empty-state')).toHaveAttribute('title', '权限不可用');
  await expect(page.locator('users-management')).toHaveCount(0);
  await page.unroute('**/api/auth/permissions');
  await page.getByRole('button', { name: '重试加载权限', exact: true }).last().click();
  await expect(page.locator('users-management')).toHaveCount(1);
  console.log('stage: check complete');
  report.checks.push('network failure denies; real HTTP retry recovers');
  await db.execute('DELETE FROM user_roles WHERE user_id=?', [userId]);
  // Invoke the existing application loader, not a fabricated permissions event.
  await page.evaluate(async () => {
    const { loadPermissions } = await import('/src/app/ui/permissions.ts');
    await loadPermissions(document.querySelector('slide-app') as any);
  });
  await expect(page.locator('users-management')).toHaveCount(0);
  await expect(page.locator('settings-shell app-empty-state')).toHaveAttribute('title', '无权访问');
  console.log('stage: check complete');
  report.checks.push('DB revoke → real application loadPermissions → restricted page removed');
  const status = await page.evaluate(async () => {
    const { apiClient } = await import('/src/api/index.ts');
    return (await apiClient.fetchResponseWithAuth('/api/users')).status;
  });
  expect(status).toBe(403); report.checks.push('backend /api/users independently denies revoked user: 403');
});
