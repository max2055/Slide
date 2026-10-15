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
const output = process.env.MAX170_OUTPUT_DIR ?? 'test-results/max170';
const schema = `max170_login_${randomUUID().replaceAll('-', '')}`;
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
  workspace = await mkdtemp(join(tmpdir(), 'slide-max170-')); await mkdir(output, { recursive: true });
  const options = { host: '127.0.0.1', port, user: 'root', password: process.env.T06_TEST_MYSQL_PASSWORD ?? '' };
  admin = mysql.createPool(options); await admin.query(`CREATE DATABASE ${schema}`);
  pool = mysql.createPool({ ...options, database: schema }); await new MigrationRunner(pool).run();
  const hash = await bcrypt.hash(password, 10);
  await pool.execute("INSERT INTO users (id,username,password_hash) VALUES (101,'audit-owner',?),(102,'audit-reader',?)", [hash, hash]);
  await pool.query("INSERT INTO roles (id,name) VALUES (101,'audit-admin')");
  await pool.query("INSERT IGNORE INTO permissions (code,name,resource,action) VALUES ('*','Fixture admin','admin','all')");
  await pool.query('INSERT INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions');
  await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (101,101)');
  await pool.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted,status) VALUES (101,'SQL 审核验收','127.0.0.1',9,'fixture','unused','inactive'),(102,'空历史','127.0.0.1',9,'fixture','unused','inactive')");
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
  await pool.query("INSERT INTO sql_audit_records (id,instance_id,sql_text,risk_level,status) VALUES (501,101,'SELECT id FROM example WHERE id = 1','P2','completed')");
  await pool.query(`INSERT INTO ai_analysis (id,analysis_type,instance_id,related_id,status,result,created_at) VALUES
    (101,'sql_audit',101,NULL,'completed',NULL,'2026-10-14 01:00:00'),
    (102,'sql_audit',101,501,'completed',JSON_OBJECT('raw_content','真实服务读取验收：已有分析内容，不调用模型。'),'2026-10-15 01:00:00')`);
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
async function login(page: Page, username = 'audit-owner') {
  const res = await page.request.post(origin + '/api/auth/login', { data: { username, password } });
  expect(res.status()).toBe(200);
  const session = await res.json();
  await page.addInitScript(token => localStorage.setItem('token', token), session.token);
}
async function capture(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true, animations: 'disabled' });
}
const fixture = '/e2e/fixtures/sql-audit-history.html';

test('real SQL history and joined detail, keyboard opening/collapsing, empty list and permission denial', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page); await page.setViewportSize({ width: 1280, height: 900 });
  const read = page.waitForResponse(r => r.url().includes('/api/sql/audit/instance/101'));
  await page.goto(origin + fixture); const res = await read;
  expect(res.status()).toBe(200); const rows = await res.json();
  expect(rows).toHaveLength(2); expect(rows[0].sql_text).toBeUndefined(); expect(rows[0].risk_level).toBeUndefined();
  const view = page.locator('sql-audit-tab');
  await expect(view.getByText('列表未提供 SQL，请查看详情', { exact: true })).toHaveCount(2);
  await expect(view.getByText('风险未提供', { exact: true })).toHaveCount(2);
  const current = view.getByRole('button', { name: '审核记录 #102 详情', exact: true });
  // Disabled submit is skipped; start at the SQL input and Tab into history.
  await view.locator('textarea').focus(); await page.keyboard.press('Tab'); await expect(current).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(current).toHaveAttribute('aria-expanded', 'true');
  await expect(view.locator('.history-detail')).toContainText('SELECT id FROM example WHERE id = 1');
  await expect(view.locator('.history-detail')).toContainText('低风险（P2）');
  await expect(view.locator('.history-detail')).toContainText('真实服务读取验收');
  await capture(page, 'real-joined-detail-keyboard');
  await page.keyboard.press('Space'); await expect(current).toHaveAttribute('aria-expanded', 'false'); await expect(current).toBeFocused();
  await page.keyboard.press('Tab'); const legacy = view.getByRole('button', { name: '审核记录 #101 详情', exact: true });
  await expect(legacy).toBeFocused(); await page.keyboard.press('Space');
  await expect(view.locator('.history-detail')).toContainText('未保存分析结果');
  await expect(view.locator('.history-detail')).toContainText('无法还原原始语句');
  await view.locator('summary').press('Enter'); await expect(view.locator('details')).toHaveAttribute('open', '');
  await capture(page, 'real-legacy-missing-fields');
  await page.goto(origin + fixture + '?instance=102'); await expect(view.getByText('暂无审核记录')).toBeVisible(); await capture(page, 'real-empty');
  await login(page, 'audit-reader'); await page.goto(origin + fixture);
  await expect(view.getByRole('alert')).toContainText('无权限查看审核历史'); await capture(page, 'real-no-permission');
  expect(errors).toEqual([]);
});

for (const [theme, width] of [['light', 1280], ['dark', 390]] as const) {
  test(`controlled compatibility, loading, unknown and failures ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await login(page);
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const rows = [{ id: 201, status: 'unknown', created_at: 'invalid' }, { id: 202, status: 'future-state', risk_level: 'future-risk', sql_text: 'SELECT ' + 'long_field_name,'.repeat(60) + 'id FROM example' }, { id: 203, status: 'failed' }];
    await page.route('**/api/sql/audit/instance/101?*', async route => { await gate; await route.fulfill({ json: rows }); });
    let releaseDetail!: () => void; const detailGate = new Promise<void>(done => { releaseDetail = done; });
    await page.route('**/api/sql/audit/201', async route => { await detailGate; await route.fulfill({ json: { ...rows[0], result: null } }); });
    await page.route('**/api/sql/audit/202', route => route.fulfill({ json: { ...rows[1], result: '历史文本分析结果' } }));
    await page.route('**/api/sql/audit/203', route => route.fulfill({ json: { ...rows[2], result: null, error_message: '受控测试：分析失败' } }));
    await page.goto(origin + fixture + '?theme=' + theme);
    const view = page.locator('sql-audit-tab'); await expect(view.getByText('加载审核历史...')).toBeVisible();
    await capture(page, `controlled-loading-${theme}-${width}`); release();
    await expect(view.getByText('状态待确认', { exact: true })).toBeVisible();
    await expect(view.getByText('未知状态', { exact: true })).toBeVisible();
    await expect(view.getByText('未知风险等级', { exact: true })).toBeVisible();
    const toggle = view.getByRole('button', { name: '审核记录 #201 详情', exact: true });
    await toggle.press('Space'); await expect(view.getByText('加载审核详情...')).toBeVisible();
    await capture(page, `controlled-detail-loading-${theme}-${width}`); releaseDetail();
    await expect(view.locator('.history-detail')).toContainText('无法确认审核是否完成');
    const bounds = await view.locator('.history-detail').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await expect(view.locator('.history-detail')).toContainText('未保存分析结果');
    await capture(page, `controlled-unknown-${theme}-${width}`);
    await view.getByRole('button', { name: '审核记录 #202 详情', exact: true }).press('Enter');
    await expect(view.locator('.history-detail')).toContainText('历史文本分析结果');
    await expect(view.locator('.history-detail')).toContainText(rows[1].sql_text!);
    await capture(page, `controlled-long-sql-unknown-enum-${theme}-${width}`);
    await view.getByRole('button', { name: '审核记录 #203 详情', exact: true }).press('Space');
    await expect(view.locator('.history-detail')).toContainText('受控测试：分析失败');
    await capture(page, `controlled-analysis-failed-${theme}-${width}`);
    await page.unroute('**/api/sql/audit/201');
    await page.route('**/api/sql/audit/201', route => route.fulfill({ status: 404, json: {} }));
    await toggle.press('Enter');
    await expect(view.getByRole('alert')).toContainText('审核记录不存在或已不可访问');
    await capture(page, `controlled-detail-404-${theme}-${width}`);
    await page.unroute('**/api/sql/audit/201');
    await page.route('**/api/sql/audit/201', route => route.fulfill({ status: 403, json: {} }));
    await view.getByRole('button', { name: '重试详情' }).click(); await expect(view.getByRole('alert')).toContainText('无权限查看此审核详情');
    await page.unroute('**/api/sql/audit/instance/101?*');
    await page.route('**/api/sql/audit/instance/101?*', route => route.fulfill({ status: 500, json: {} }));
    await page.reload(); await expect(view.getByRole('alert')).toContainText('审核历史加载失败');
    await expect(view.getByText('暂无审核记录')).toHaveCount(0); await capture(page, `controlled-history-failure-${theme}-${width}`);
    await page.unroute('**/api/sql/audit/instance/101?*');
    await page.route('**/api/sql/audit/instance/101?*', route => route.fulfill({ json: [] }));
    await view.getByRole('button', { name: '重试历史' }).click(); await expect(view.getByText('暂无审核记录')).toBeVisible();
  });
}
