import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'vite';
import { MigrationRunner } from '../../apps/db-ops-api/src/migrations/runner.ts';

// Normal flows use the production server, password verification, JWT and an
// isolated SQL schema. Only explicitly named controlled tests intercept HTTP.
const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const output = process.env.MAX172_OUTPUT_DIR ?? 'test-results/max172';
const key = 'slide.control.settings.v1:default';
const schema = `max172_login_${randomUUID().replaceAll('-', '')}`;
const password = ` ${randomUUID()} `;
let admin: any, pool: any, backend: ChildProcess, vite: Awaited<ReturnType<typeof createServer>>;
let origin: string, workspace: string, backendLog = '';
let modelGuard: ReturnType<typeof createHttpServer>, modelCalls = 0;
async function freePort() {
  const server = createNetServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done())); return port;
}
test.beforeAll(async () => {
  const port = Number(process.env.T06_TEST_MYSQL_PORT);
  if (!port) throw new Error('T06_TEST_MYSQL_PORT must point to a task-owned isolated MySQL fixture');
  workspace = await mkdtemp(join(tmpdir(), 'slide-max172-')); await mkdir(output, { recursive: true });
  const options = { host: '127.0.0.1', port, user: 'root', password: process.env.T06_TEST_MYSQL_PASSWORD ?? '' };
  admin = mysql.createPool(options); await admin.query(`CREATE DATABASE ${schema}`);
  pool = mysql.createPool({ ...options, database: schema }); await new MigrationRunner(pool).run();
  const hash = await bcrypt.hash(password, 10);
  await pool.execute("INSERT INTO users (id,username,password_hash) VALUES (101,'login-owner',?),(102,'login-reader',?)", [hash, hash]);
  await pool.query("INSERT INTO roles (id,name) VALUES (101,'login-admin')");
  await pool.query("INSERT IGNORE INTO permissions (code,name,resource,action) VALUES ('*','Fixture admin','admin','all')");
  await pool.query('INSERT INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions');
  await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (101,101)');
  await pool.query("INSERT INTO servers (id,host,label,os_type,credential_type,credential_encrypted,status,collection_enabled) VALUES (101,'login.fixture.invalid','登录验收服务器','linux','password','unused','offline',0)");
  modelGuard = createHttpServer((_request, response) => { modelCalls++; response.writeHead(503); response.end('MODEL_CALL_FORBIDDEN'); });
  await new Promise<void>(done => modelGuard.listen(0, '127.0.0.1', done));
  await pool.query('UPDATE llm_providers SET enabled=0,is_default=0');
  await pool.execute("UPDATE llm_providers SET enabled=1,is_default=1,api_base_url=?,deployment_type='local',api_format=NULL WHERE name='ollama'",
    [`http://127.0.0.1:${(modelGuard.address() as { port: number }).port}`]);
  const apiPort = await freePort(), wsPort = await freePort();
  backend = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: resolve('../apps/db-ops-api'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', DB_HOST: options.host, DB_PORT: String(port), DB_USER: options.user,
      DB_PASSWORD: options.password, DB_NAME: schema, PORT: String(apiPort),
      AGENT_WS_HOST: '127.0.0.1', AGENT_WS_PORT: String(wsPort), AGENT_WORKSPACE: workspace,
      JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      SLIDE_MEMORY_PIPELINE_ENABLED: 'false', PROMPT_HOT_RELOAD: 'false' },
  });
  backend.stdout!.on('data', data => { backendLog += data; }); backend.stderr!.on('data', data => { backendLog += data; });
  await expect.poll(async () => {
    if (backend.exitCode !== null) throw new Error(`Backend exited: ${backendLog.slice(-2500)}`);
    try { return (await fetch(`http://127.0.0.1:${apiPort}/api/health/ready`)).status; } catch { return 0; }
  }, { timeout: 60_000 }).toBe(200);
  vite = await createServer({ configFile: resolve('vite.config.js'), root: resolve('.'),
    define: { 'import.meta.env.VITE_AGENT_WS_URL': '""' },
    server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      '/__slide': { target: `http://127.0.0.1:${wsPort}` },
      '/agent-ws': { target: `http://127.0.0.1:${wsPort}`, ws: true },
    } },
  });
  await vite.listen(); origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
});
test.afterAll(async () => {
  await vite?.close();
  if (backend && backend.exitCode === null) {
    const stopped = new Promise<void>(done => backend.once('exit', () => done()));
    backend.kill('SIGTERM'); await stopped;
  }
  await writeFile(`${output}/backend.log`, backendLog);
  await pool?.end();
  if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${schema}`); await admin.end(); }
  if (modelGuard) await new Promise<void>(done => modelGuard.close(() => done()));
  if (workspace) await rm(workspace, { recursive: true, force: true });
  expect(modelCalls).toBe(0);
});
async function setup(page: Page, locale = 'zh-CN', theme = 'light') {
  await page.addInitScript(({ key, locale, theme }) => {
    localStorage.setItem('slide.i18n.locale', locale);
    localStorage.setItem('app-theme-mode', theme);
    // Do not clear tokens/preferences on reload: reload is part of acceptance.
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ locale, themeMode: theme }));
  }, { key, locale, theme });
  await page.route(/\/api\/(?:.*diagnos.*|.*chat\/send|.*completions)/, route => { throw new Error(`Product model invocation forbidden: ${route.request().url()}`); });
}
async function credentials(page: Page, username = 'login-owner', secret = password) {
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(secret);
}
async function capture(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true, animations: 'disabled' });
}

test('real password login, invalid credentials, populated and empty resource data, reload and expiry', async ({ page }) => {
  await setup(page); await page.goto(origin + '/servers');
  await credentials(page, 'login-owner', 'incorrect-fixture-password');
  const rejected = page.waitForResponse(r => r.url().endsWith('/api/auth/login') && r.status() === 401);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await rejected;
  await expect(page.getByRole('alert')).toContainText('用户名或密码错误'); await capture(page, 'real-invalid-credentials');
  await credentials(page);
  const authenticated = page.waitForResponse(r => r.url().endsWith('/api/auth/login') && r.status() === 200);
  await page.getByLabel('密码', { exact: true }).press('Enter'); await authenticated;
  await expect(page.locator('.login-gate')).toHaveCount(0);
  await expect(page.locator('servers-page')).toContainText('登录验收服务器'); await capture(page, 'real-login-data');
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeTruthy();
  await page.reload(); await expect(page.locator('servers-page')).toContainText('登录验收服务器');
  await pool.query('DELETE FROM servers WHERE id=101');
  await page.reload(); await expect(page.locator('servers-page')).toContainText('暂无服务器'); await capture(page, 'real-login-empty');
  // Revoke the persisted session version; both HTTP/JWT and WS revalidate it.
  await pool.query('UPDATE users SET session_version=session_version+1 WHERE id=101');
  await page.reload(); await expect(page.locator('.login-gate')).toBeVisible(); await capture(page, 'real-session-expired');
});

test('real password login with zero permissions keeps protected resources inaccessible', async ({ page }) => {
  await setup(page); await page.goto(origin + '/servers'); await credentials(page, 'login-reader');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.login-gate')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('permissions'))).toBe('[]');
  await expect(page.getByRole('link', { name: '服务器', exact: true })).toHaveCount(0);
  const status = await page.evaluate(async () => (await fetch('/api/servers', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })).status);
  expect(status).toBe(403); await capture(page, 'real-no-permissions');
});

test('integrated appearance labels, route IDs, language switching and reload use real preferences API', async ({ page }) => {
  await setup(page); await page.goto(origin + '/settings/platform/appearance'); await credentials(page);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const view = page.locator('appearance-settings'); await expect(view.locator('h1')).toHaveText('外观');
  const card = (title: string) => view.locator('app-card').filter({ has: page.locator('[slot="header"]').filter({ hasText: new RegExp(`^${title}$`) }) });
  const landing = card('默认首页').locator('select');
  await expect(landing.locator('option[value="instances-db"]')).toHaveText('数据库');
  await landing.selectOption('servers'); await card('语言').locator('select').selectOption('en');
  await expect(view.locator('h1')).toHaveText('Appearance');
  await expect(card('Default Landing Page').locator('option[value="servers"]')).toHaveText('Servers');
  await page.reload(); await expect(view.locator('h1')).toHaveText('Appearance');
  await expect(card('Default Landing Page').locator('select')).toHaveValue('servers');
  await expect(card('Language').locator('select')).toHaveValue('en'); await capture(page, 'real-appearance-reload');
});

for (const locale of ['zh-CN', 'en']) for (const theme of ['light', 'dark']) for (const width of [1280, 768, 390]) {
  test(`controlled loading/failure and keyboard ${locale} ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await setup(page, locale, theme);
    const zh = locale === 'zh-CN'; let count = 0; let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    await page.route('**/api/auth/login', async route => { count++; await gate; await route.fulfill({ status: 503, json: { error: 'CONTROLLED_UNAVAILABLE' } }); });
    await page.goto(origin);
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', theme);
    const username = page.getByLabel(zh ? '用户名' : 'Username', { exact: true });
    const secret = page.getByLabel(zh ? '密码' : 'Password', { exact: true });
    await username.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText(zh ? '请输入用户名和密码' : 'Enter your username and password');
    expect(count).toBe(0); await username.fill('controlled-user');
    await page.keyboard.press('Tab'); await expect(secret).toBeFocused(); await secret.fill(' controlled password ');
    await page.keyboard.press('Tab'); const toggle = page.getByRole('button', { name: zh ? '显示密码' : 'Show password', exact: true });
    await expect(toggle).toBeFocused(); await page.keyboard.press('Space');
    await expect(secret).toHaveAttribute('type', 'text'); await expect(secret).toHaveValue(' controlled password ');
    await page.getByRole('button', { name: zh ? '隐藏密码' : 'Hide password', exact: true }).press('Space');
    await page.keyboard.press('Tab'); const submit = page.getByRole('button', { name: zh ? '登录' : 'Log in', exact: true });
    await expect(submit).toBeFocused(); await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: zh ? '正在登录…' : 'Logging in…', exact: true })).toBeDisabled();
    await secret.press('Enter'); await expect.poll(() => count).toBe(1); await capture(page, `controlled-loading-${locale}-${theme}-${width}`);
    release(); await expect(page.getByRole('alert')).toContainText(origin + '/api/auth/login');
    await expect(submit).toBeEnabled(); await capture(page, `controlled-failure-${locale}-${theme}-${width}`);
    // Unparseable/empty server result must remain a service error, never success.
    await page.unroute('**/api/auth/login');
    await page.route('**/api/auth/login', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>CONTROLLED_PROXY_RESPONSE</html>' }));
    await submit.click(); await expect(page.getByRole('alert')).toContainText(origin + '/api/auth/login');
    await expect(page.locator('.login-gate')).toBeVisible();
  });
}
