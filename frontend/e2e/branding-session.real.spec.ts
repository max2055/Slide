import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
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
const output = process.env.MAX671_OUTPUT_DIR ?? 'test-results/max671';
const schema = `max671_login_${randomUUID().replaceAll('-', '')}`;
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
  const port = Number(process.env.MAX671_TEST_MYSQL_PORT);
  if (!port) throw new Error('MAX671_TEST_MYSQL_PORT must point to a task-owned isolated MySQL fixture');
  workspace = await mkdtemp(join(tmpdir(), 'slide-max671-')); await mkdir(output, { recursive: true });
  const options = { host: process.env.MAX671_TEST_MYSQL_HOST ?? '127.0.0.1', port, user: process.env.MAX671_TEST_MYSQL_USER ?? 'root', password: process.env.MAX671_TEST_MYSQL_PASSWORD ?? '' };
  admin = mysql.createPool(options); await admin.query(`CREATE DATABASE ${schema}`);
  pool = mysql.createPool({ ...options, database: schema }); await new MigrationRunner(pool).run();
  const hash = await bcrypt.hash(password, 10);
  await pool.execute("INSERT INTO users (id,username,password_hash) VALUES (101,'brand-owner',?),(102,'brand-reader',?)", [hash, hash]);
  await pool.query("INSERT INTO roles (id,name) VALUES (101,'brand-admin')");
  await pool.query("INSERT IGNORE INTO permissions (code,name,resource,action) VALUES ('*','Fixture admin','admin','all')");
  await pool.query('INSERT INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions');
  await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (101,101)');
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
  await writeFile(`${output}/ownership.json`, JSON.stringify({ schema, apiPid: backend.pid, apiCwd: resolve('../apps/db-ops-api'), apiCommand: 'node --import tsx server.ts', apiPort, wsPort, frontendOrigin: origin, branch: execFileSync('git', ['branch','--show-current'], {encoding:'utf8'}).trim(), commit: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim() }));
});
test.afterAll(async () => {
  await vite?.close();
  if (backend && backend.exitCode === null) {
    const stopped = new Promise<void>(done => backend.once('exit', () => done()));
    backend.kill('SIGTERM'); await stopped;
  }
  // Backend log stays in memory to avoid persisting authentication data.
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${schema}`);
    const [remaining] = await admin.execute('SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME=?', [schema]);
    expect(remaining).toEqual([]); await admin.end();
  }
  if (modelGuard) await new Promise<void>(done => modelGuard.close(() => done()));
  if (workspace) await rm(workspace, { recursive: true, force: true });
  expect(modelCalls).toBe(0);
  await writeFile(`${output}/cleanup.json`, JSON.stringify({ schema, schemaDropped: true, backendStopped: backend?.exitCode !== null || backend?.signalCode !== null, viteClosed: true, workspaceRemoved: true, modelCalls }));
});

test('real unauthenticated load → keyboard password login → brand cache, existing slash menu and saved update', async ({ page, browser }) => {
  await writeFile(`${output}/environment.json`, JSON.stringify({node:process.version, platform:process.platform, arch:process.arch, chromium:browser.version(), mysqlPort:Number(process.env.MAX671_TEST_MYSQL_PORT), source:'Production Fastify login/JWT/branding + isolated MySQL schema; controlled avatar transport only'}));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const brandReads: number[] = [];
  page.on('response', response => { if (response.url().endsWith('/api/branding/config') && response.request().method() === 'GET') brandReads.push(response.status()); });
  await pool.execute("INSERT INTO system_config (config_key,config_value) VALUES ('branding.config',?) ON DUPLICATE KEY UPDATE config_value=VALUES(config_value)",
    [JSON.stringify({ cli_name: 'max671', product_name: '品牌验收671', env_prefix: 'MAX671', state_dir: '.max671' })]);
  await page.addInitScript(() => {
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', themeMode: 'light' }));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + '/chat');
  await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
  expect(brandReads).toEqual([]);
  expect(await page.evaluate(async () => (await import('/src/app/src/branding.ts')).getProductName())).toBe('Slide');
  await page.getByLabel('用户名', { exact: true }).fill('brand-owner');
  await page.getByLabel('用户名', { exact: true }).press('Tab');
  await expect(page.getByLabel('密码', { exact: true })).toBeFocused();
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('密码', { exact: true }).press('Enter');
  await expect(page.locator('.login-gate')).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => (await import('/src/app/src/branding.ts')).getProductName())).toBe('品牌验收671');
  expect(brandReads).toContain(200);
  const input = page.locator('.agent-chat__input textarea');
  await input.fill('/restart');
  await expect(page.getByRole('listbox', { name: 'Slash commands' })).toContainText('品牌验收671');
  // A menu already on screen must also refresh, without typing again.
  const saved = await page.evaluate(async () => {
    const { authFetch } = await import('/src/api/index.ts');
    const response = await authFetch('/api/branding/config', {method:'PUT', body:JSON.stringify({
      cli_name:'max671', product_name:'品牌实时671', env_prefix:'MAX671', state_dir:'.max671',
    })});
    await (await import('/src/app/src/branding.ts')).refreshBrandingCache();
    return { status: response.status, brand: (await import('/src/app/src/branding.ts')).getProductName() };
  });
  expect(saved).toEqual({status:200, brand:'品牌实时671'});
  await expect(page.getByRole('listbox', { name: 'Slash commands' })).toContainText('品牌实时671');
  // Exercise existing menu selection/focus without executing a restart command.
  await input.press('ArrowDown'); await input.press('Escape'); await expect(input).toBeFocused();
  await input.fill('');
  await page.goto(origin + '/settings/platform/branding');
  const product = page.getByRole('textbox', { name: '产品名称', exact: true });
  await expect(product).toHaveValue('品牌实时671');
  await product.fill('品牌更新671');
  await page.getByRole('button', { name: '保存品牌', exact: true }).click();
  await expect(page.getByText('品牌配置已保存', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await import('/src/app/src/branding.ts')).getProductName())).toBe('品牌更新671');
  const [rows] = await pool.execute("SELECT config_value FROM system_config WHERE config_key='branding.config'");
  expect(JSON.stringify(rows)).toContain('品牌更新671');
  await writeFile(`${output}/branding-audit.json`, JSON.stringify({query: "SELECT config_value FROM system_config WHERE config_key='branding.config'", rows}));
  for (const width of [1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: width === 1366 ? 768 : width === 1920 ? 1080 : 900 });
    await expect(product).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${output}/real-brand-${width}.png`, fullPage: true });
  }
  await page.evaluate(() => (document.querySelector('slide-app') as any).logout());
  await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
  expect(await page.evaluate(async () => (await import('/src/app/src/branding.ts')).getProductName())).toBe('Slide');
  expect(errors).toEqual([]);
});

test('real WebSocket disconnect/reconnect with controlled avatar metadata: old response stays cleared and fresh avatar renders', async ({ page }) => {
  // Production has no avatar metadata handler. Only that transport and its
  // image are controlled; login, WebSocket, app state and rendering are real.
  await page.addInitScript(() => {
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', themeMode: 'light' }));
  });
  await page.goto(origin + '/chat');
  await page.getByLabel('用户名', { exact: true }).fill('brand-owner');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('密码', { exact: true }).press('Enter');
  await expect(page.locator('.agent-chat__input textarea')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (document.querySelector('slide-app') as any).chatLoading)).toBe(false);

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sawOld!: () => void;
  const oldStarted = new Promise<void>(resolve => { sawOld = resolve; });
  let first = true;
  await page.route('**/avatar/**', async route => {
    const old = first; first = false;
    if (old) { sawOld(); await gate; }
    await route.fulfill({ json: { avatarUrl: old ? '/max671-stale.svg' : '/max671-fresh.svg' } });
  });
  await page.route('**/max671-fresh.svg', route => route.fulfill({
    contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect width="56" height="56" fill="#3366cc"/></svg>',
  }));
  try {
    await page.evaluate(async () => {
      const { refreshChatAvatar } = await import('/src/app/ui/app-chat.ts');
      const app = document.querySelector('slide-app') as any;
      (window as any).avatarPending = refreshChatAvatar(app);
    });
    await oldStarted;
    await page.evaluate(async () => {
      const app = document.querySelector('slide-app') as any;
      app.client.disconnect();
      await (await import('/src/app/ui/app-chat.ts')).refreshChatAvatar(app);
    });
    await expect.poll(() => page.evaluate(() => (document.querySelector('slide-app') as any).connected)).toBe(false);
    release();
    await page.evaluate(() => (window as any).avatarPending);
    expect(await page.evaluate(() => (document.querySelector('slide-app') as any).chatAvatarUrl)).toBeNull();
    await expect(page.locator('img[src="/max671-stale.svg"]')).toHaveCount(0);

    await page.evaluate(() => (document.querySelector('slide-app') as any).connect());
    await expect(page.locator('.agent-chat__input textarea')).toBeEnabled();
    await page.evaluate(async () => {
      await (await import('/src/app/ui/app-chat.ts')).refreshChatAvatar(document.querySelector('slide-app') as any);
    });
    await expect(page.locator('.agent-chat__welcome img[src="/max671-fresh.svg"]')).toBeVisible();
    await page.screenshot({ path: `${output}/controlled-avatar-real-reconnect.png`, fullPage: true });
  } finally {
    release();
    await page.evaluate(() => (window as any).avatarPending).catch(() => {});
    await page.unrouteAll({ behavior: 'wait' });
  }
});
