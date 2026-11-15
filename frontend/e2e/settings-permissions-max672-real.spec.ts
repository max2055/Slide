import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Explicit local acceptance only. Credentials are injected, never collected by unit tests.
test.skip(process.env.MAX672_REAL !== '1', 'Requires explicit isolated MySQL acceptance');
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise'), bcrypt = require('bcrypt'), dotenv = require('dotenv');
const schema = `db_ops_ai_qualification_max672_${process.pid}`;
const password = randomBytes(24).toString('hex');
const children: ChildProcess[] = [];
let output: string, db: any, userId: number;
const report: any = { schema, modelCalls: 0, checks: [], processes: [], ports: { api: 3672, agent: 29672, vite: 5672 } };

async function start(args: string[], env: Record<string, string>, cwd: string, label: string) {
  const log = await open(resolve(output, `${label}.private.log`), 'w', 0o600);
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', log.fd, log.fd] });
  children.push(child);
  await log.close();
  report.processes.push({ pid: child.pid, cwd, command: [process.execPath, ...args], label });
  return child;
}
async function ready(url: string, child: ChildProcess) {
  await expect.poll(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned process exited; inspect private log');
    try { return (await fetch(url)).status; } catch { return 0; }
  }, { timeout: 90_000 }).toBe(200);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  for (const key of ['MAX672_PROFILES_FILE', 'SLIDE_DEBUG_ENV_FILE', 'MAX672_EVIDENCE_DIR']) {
    if (!process.env[key]) throw new Error(`Missing explicit ${key}`);
  }
  output = resolve(process.env.MAX672_EVIDENCE_DIR!);
  await mkdir(output, { recursive: true });
  const profiles = JSON.parse(await readFile(process.env.MAX672_PROFILES_FILE!, 'utf8'));
  const connection = profiles['mysql-test'];
  if (Number(connection.port) !== 3308) throw new Error('Acceptance requires mysql-test on 3308');
  const cfg = dotenv.parse(await readFile(process.env.SLIDE_DEBUG_ENV_FILE!));
  db = await mysql.createConnection(connection);
  report.database = { host: connection.host, port: connection.port, version: (await db.query('SELECT VERSION() AS version'))[0][0].version };
  await db.query(`CREATE DATABASE \`${schema}\``);
  const apiDir = resolve('../apps/db-ops-api');
  const env = {
    DB_HOST: connection.host, DB_PORT: String(connection.port), DB_USER: connection.user, DB_PASSWORD: connection.password,
    DB_NAME: schema, PORT: '3672', AGENT_WS_PORT: '29672', NODE_ENV: 'test',
    JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: cfg.ENCRYPTION_KEY,
    PROMPT_HOT_RELOAD: 'false',
  };
  const init = await start(['--import', 'tsx', 'init-db.ts'], env, apiDir, 'migration');
  expect(await new Promise(done => init.once('exit', done))).toBe(0);
  await db.query(`USE \`${schema}\``);
  const [user] = await db.execute("INSERT INTO users(username,password_hash,status) VALUES('max672-test',?,'active')", [await bcrypt.hash(password, 10)]);
  userId = user.insertId;
  await db.execute("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE name='admin'", [userId]);
  // Read encrypted provider rows solely for full application startup. No model request.
  const source = await mysql.createConnection(profiles['slide-platform']);
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
  const api = await start(['--import', 'tsx', 'server.ts'], env, apiDir, 'api');
  await ready('http://127.0.0.1:3672/api/health/ready', api);
  const vite = await start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5672', '--strictPort'], {
    VITE_API_PROXY_TARGET: 'http://127.0.0.1:3672', VITE_AGENT_WS_PROXY_TARGET: 'http://127.0.0.1:29672',
    VITE_AGENT_WS_URL: 'ws://127.0.0.1:29672',
  }, resolve('.'), 'vite');
  await ready('http://127.0.0.1:5672', vite);
});

test.afterAll(async () => {
  const cleanupErrors: string[] = [];
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill('SIGTERM');
      await new Promise<void>(done => {
        const timer = setTimeout(done, 5000);
        child.once('exit', () => { clearTimeout(timer); done(); });
      });
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise(done => child.once('exit', done));
      }
    } catch { cleanupErrors.push(`Failed to stop owned PID ${child.pid}`); }
  }
  report.processesStopped = children.every(child => child.exitCode !== null || child.signalCode !== null);
  if (db) {
    try { await db.query(`DROP DATABASE IF EXISTS \`${schema}\``); report.cleaned = true; }
    catch { cleanupErrors.push('Failed to drop owned schema'); }
    finally { await db.end(); }
  }
  report.cleanupErrors = cleanupErrors;
  if (output) await writeFile(resolve(output, 'real-result.json'), JSON.stringify(report, null, 2));
  expect(cleanupErrors).toEqual([]);
});

test('#423 / #687: real login, permission recovery, denial and unauthenticated states', async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem('slide.i18n.locale', 'zh-CN'));
  await page.goto('/settings/access/users', { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill('max672-test');
  await page.getByLabel('密码', { exact: true }).fill(password);
  const login = page.waitForResponse(r => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  expect((await login).status()).toBe(200);
  await expect(page.locator('users-management .table')).toBeVisible();
  report.checks.push('Real browser login 200 and real users table loaded');

  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let reads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/users') reads++; });
  await page.route('**/api/auth/permissions', async route => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('settings-shell app-empty-state')).toHaveAttribute('title', '权限加载中');
    await expect(page.locator('users-management')).toHaveCount(0);
    expect(reads).toBe(0);
  } finally { release(); }
  await expect(page.locator('users-management .table')).toBeVisible();
  report.checks.push('#423 delayed real permissions: no component or users read before grant');
  await page.unroute('**/api/auth/permissions');
  await page.route('**/api/auth/permissions', route => route.abort('connectionfailed'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('settings-shell app-empty-state')).toHaveAttribute('title', '权限不可用');
  await expect(page.locator('users-management')).toHaveCount(0);
  await page.unroute('**/api/auth/permissions');
  await page.locator('settings-shell').getByRole('button', { name: '重试加载权限' }).click();
  await expect(page.locator('users-management .table')).toBeVisible();
  report.checks.push('#423 network failure stays closed; real retry recovers');

  await db.execute('DELETE FROM user_roles WHERE user_id=?', [userId]);
  await page.evaluate(async () => {
    const { loadPermissions } = await import('/src/app/ui/permissions.ts');
    await loadPermissions(document.querySelector('slide-app') as any);
  });
  await expect(page.locator('users-management')).toHaveCount(0);
  await expect(page.locator('settings-shell app-empty-state')).toHaveAttribute('title', '无权访问');
  report.checks.push('#423 real DB role revocation removes restricted view');

  // Only the document is a harness; all authorization/users requests use the real backend.
  await page.route('**/permission-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
  const mount = async () => {
    await page.goto('/permission-fixture');
    await page.evaluate(async () => {
      await import('/src/app/styles.css');
      await import('/src/app/ui/views/users-management.ts');
      document.body.append(document.createElement('users-management'));
    });
  };
  await mount();
  const view = page.locator('users-management');
  await expect(view).toContainText('无权限访问此页面，需要 admin 角色');
  await expect(view).not.toContainText('权限检查失败');
  const denied = await page.evaluate(async () => (await (window as any).__apiClient.fetchResponseWithAuth('/api/users')).status);
  expect(denied).toBe(403);
  report.checks.push('#687 real role check 403 shows denial; independent backend users denial 403');
  await db.execute("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE name='admin'", [userId]);
  await page.route('**/api/v1/rbac/roles', route => route.abort('connectionfailed'));
  await view.getByRole('button', { name: '重新检查权限' }).click();
  await expect(view).toContainText('权限检查失败');
  await expect(view).not.toContainText('需要 admin 角色');
  await page.unroute('**/api/v1/rbac/roles');
  const retry = view.getByRole('button', { name: '重新检查权限' });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(view.locator('.table')).toBeVisible();
  await page.screenshot({ path: info.outputPath('real-recovered.png') });
  report.checks.push('#687 injected network failure visible; keyboard retry obtains real roles/users');
  await page.evaluate(() => {
    (window as any).__apiClient.setToken('invalid-token');
    localStorage.removeItem('refreshToken');
  });
  await mount();
  await expect(view).toContainText('未登录');
  await expect(view).not.toContainText('需要 admin 角色');
  expect((await page.request.get('/api/v1/rbac/roles')).status()).toBe(401);
  await page.screenshot({ path: info.outputPath('real-unauthenticated.png') });
  report.checks.push('#687 real JWT 401 and anonymous roles 401; UI shows unauthenticated');
});
