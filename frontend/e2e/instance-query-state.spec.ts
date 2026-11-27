import { test, expect, type Page } from '@playwright/test';
import Fastify from '../../apps/db-ops-api/node_modules/fastify/fastify.js';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { registerInstanceQueryRoutes } from '../../apps/db-ops-api/src/instance-query-routes.js';
import { databaseService } from '../../apps/db-ops-api/src/database-service.js';
import { ActorContextService, signAccessToken } from '../../apps/db-ops-api/src/auth/actor-context.js';
import { createVerifyToken } from '../../apps/db-ops-api/src/auth-middleware.js';
import { requirePermission } from '../../apps/db-ops-api/src/auth/require-permission.js';
import { requireInstanceAccess } from '../../apps/db-ops-api/src/auth/require-instance-access.js';
import { MigrationRunner } from '../../apps/db-ops-api/src/migrations/runner.js';

// Uses an explicitly isolated MySQL target. No production bindings, provider or tool calls.
let app: ReturnType<typeof Fastify>, vite: Awaited<ReturnType<typeof createServer>>;
let pool: ReturnType<typeof mysql.createPool>, admin: typeof pool;
let url: string, token: string;
const schema = `max163_query_${randomUUID().replaceAll('-', '')}`;
const output = 'test-results/instance-query-acceptance';
const connections = (databaseService as any).connections as Map<number, any>;

test.beforeAll(async () => {
  if (!process.env.MAX163_TEST_MYSQL_PORT) throw new Error('MAX163_TEST_MYSQL_PORT must point to an isolated MySQL fixture');
  const options = { host: '127.0.0.1', port: Number(process.env.MAX163_TEST_MYSQL_PORT), user: 'root', password: process.env.MAX163_TEST_MYSQL_PASSWORD ?? '' };
  admin = mysql.createPool(options); await admin.query(`CREATE DATABASE ${schema}`);
  pool = mysql.createPool({ ...options, database: schema }); await new MigrationRunner(pool as any).run();
  await pool.query("INSERT INTO users (id,username,password_hash) VALUES (991,'max163-readonly','no-login')");
  await pool.query("INSERT INTO roles (id,name) VALUES (991,'max163-readonly')");
  await pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 991,id FROM permissions WHERE code='instance:view'");
  await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (991,991)');
  await pool.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted) VALUES (991,'MAX-163 隔离 MySQL', 'fixture.invalid',3306,'fixture','unused')");
  await pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (991,991,'read-only')");
  const contexts = new ActorContextService(() => pool as any), secret = randomUUID();
  token = signAccessToken(await contexts.loadActiveActor(991), secret);
  app = Fastify(); const verify = createVerifyToken(secret, contexts);
  await registerInstanceQueryRoutes(app, verify);
  app.get('/api/database/instances/:id', { preHandler: [verify, requirePermission('instance:view'), requireInstanceAccess('read-only')] }, async () => {
    const [rows] = await pool.query('SELECT id,name,db_type,host,port,status FROM database_instances WHERE id=991'); return (rows as any[])[0];
  });
  app.get('/api/ai/analysis/history', { preHandler: verify }, async () => ({ records: [] }));
  app.get('/api/resources/instance/:id/investigations', { preHandler: verify }, async () => ({ items: [] }));
  app.post('/api/metrics/query', async (_request, reply) => reply.code(503).send({ error: 'UNRELATED_METRICS_NOT_IN_FIXTURE' }));
  app.setNotFoundHandler(async (_request, reply) => reply.send({ items: [], records: [] }));
  const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  connections.set(991, { id: 991, connected: true, db_type: 'mysql', pool });
  vite = await createServer({ root: resolve('.'), configFile: resolve('vite.config.js'), server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': { target: apiUrl }, '/__slide': { target: apiUrl } } } });
  await vite.listen(); url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  await mkdir(output, { recursive: true });
});
test.afterAll(async () => {
  connections.delete(991); await vite?.close(); await app?.close(); await pool?.end();
  if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${schema}`); await admin.end(); }
});
async function open(page: Page, theme = 'light', width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ token, theme }) => { localStorage.setItem('token', token); localStorage.setItem('query-test-theme', theme); }, { token, theme });
  await page.goto(`${url}/e2e/fixtures/instance-query.html?id=991`);
  await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, theme);
  const view = page.locator('instance-detail-page');
  await expect(view).toContainText('MAX-163 隔离 MySQL');
  // Keep semantic-metrics requests outside these query/session assertions.
  return view;
}
async function capture(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true, animations: 'disabled' });
}

test('real JWT -> live permissions -> production routes -> MySQL: empty, populated, session, revoke', async ({ page }, info) => {
  const requests: Array<{ method: string; path: string }> = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/database\/instances\/991(?:\/|$)/.test(path)) requests.push({ method: request.method(), path });
  });
  await pool.query('TRUNCATE performance_schema.events_statements_summary_by_digest');
  const view = await open(page);
  await view.evaluate((el: any) => { el.autoRefresh = false; el.stopAutoRefresh(); });
  const snapshot = () => page.evaluate(() => ({ url: location.href, length: history.length, key: navigation.currentEntry?.key }));
  const reselect = async (kind: 'topsql' | 'sessions', label: RegExp, result: string) => {
    const before = await snapshot();
    const start = requests.length;
    const path = `/api/database/instances/991/${kind}`;
    const tab = view.getByRole('tab', { name: label });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const response = page.waitForResponse(value => new URL(value.url()).pathname === path);
    await tab.click();
    const status = (await response).status();
    expect(status).toBe(200);
    await expect(view).toContainText(result);
    const reads = requests.slice(start);
    expect(reads).toEqual([{ method: 'GET', path }]);
    const after = await snapshot();
    expect(after).toEqual(before);
    return { kind, status, reads, before, after };
  };
  await view.getByRole('tab', { name: '慢查询', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(view).toContainText('本次查询未返回慢查询记录'); await expect(view).toContainText('MySQL performance_schema');
  await expect(view).toContainText('统计起止时间未知'); await expect(view).not.toContainText('数据库运行良好');
  await capture(page, 'real-mysql-empty-1280-light');
  await pool.query('SELECT SLEEP(1.1) AS max163_slow_sample');
  await view.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(view.locator('tbody')).toContainText('SLEEP'); await capture(page, 'real-mysql-slow-query');
  const slowQueryReselect = await reselect('topsql', /^慢查询/, 'MySQL performance_schema');
  const target = mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.MAX163_TEST_MYSQL_PORT), user: 'root', password: process.env.MAX163_TEST_MYSQL_PASSWORD ?? '' });
  const connection = await target;
  const running = connection.query('SELECT SLEEP(4) AS max163_active_session');
  try {
    await view.getByRole('tab', { name: '会话', exact: true }).click();
    await expect(view.locator('tbody')).toContainText('max163_active_session'); await expect(view).toContainText('活跃会话快照');
    await capture(page, 'real-mysql-active-session');
  } finally { await running; await connection.end(); }
  const sessionReselect = await reselect('sessions', /^会话/, '活跃会话快照');
  await view.getByRole('tab', { name: /^慢查询/ }).click();

  const deniedUser = `max163_denied_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const deniedPassword = randomUUID();
  await admin.query("CREATE USER ?@'%' IDENTIFIED BY ?", [deniedUser, deniedPassword]);
  const deniedPool = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.MAX163_TEST_MYSQL_PORT), user: deniedUser, password: deniedPassword });
  try {
    connections.get(991).pool = deniedPool;
    const sourceRefused = page.waitForResponse(r => r.url().endsWith('/api/database/instances/991/topsql') && r.status() === 424);
    await view.getByRole('tab', { name: /^慢查询/ }).click();
    expect(await (await sourceRefused).json()).toEqual({ error: 'SOURCE_PERMISSION_DENIED' });
    await expect(view.getByRole('alert')).toContainText('数据库账号无权读取慢查询统计');
    await expect(view.locator('tbody')).toHaveCount(0);
    await capture(page, 'real-mysql-query-denied');
  } finally { connections.get(991).pool = pool; await deniedPool.end(); await admin.query("DROP USER ?@'%'", [deniedUser]); }
  await pool.query('DELETE FROM instance_permissions WHERE user_id=991');
  try {
    const denied = page.waitForResponse(r => r.url().endsWith('/api/database/instances/991/topsql') && r.status() === 403);
    // Refreshing the tab goes through the live JWT authorization check.
    await view.getByRole('tab', { name: /^慢查询/ }).click(); await denied;
    await expect(view.getByRole('alert')).toContainText('无权'); await expect(view.locator('tbody')).toHaveCount(0);
    await capture(page, 'real-permission-revoked');
  } finally { await pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (991,991,'read-only')"); }
  await info.attach('query-reselect', { contentType: 'application/json', body: JSON.stringify([slowQueryReselect, sessionReselect]) });
});

for (const kind of ['topsql', 'sessions'] as const) for (const [width, theme] of [[1280, 'dark'], [390, 'light']] as const) test(`controlled ${kind} states and keyboard ${width} ${theme}`, async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let mode = 'loading', release!: () => void;
  await page.clock.install();
  await page.route(`**/api/database/instances/991/${kind}`, async route => {
    if (mode === 'loading') await new Promise<void>(resolve => release = resolve);
    if (mode === 'network') return route.abort('failed');
    const responses: Record<string, { status: number; json: unknown }> = {
      failed: { status: 500, json: { error: 'UPSTREAM_ERROR' } },
      forbidden: { status: 403, json: { error: 'FORBIDDEN' } },
      unavailable: { status: 404, json: { error: 'NOT_CONNECTED' } },
      'source-unavailable': { status: 503, json: { error: 'SOURCE_UNAVAILABLE' } },
      'source-forbidden': { status: 424, json: { error: 'SOURCE_PERMISSION_DENIED' } },
      malformed: { status: 200, json: {} },
    };
    await route.fulfill(responses[mode] ?? { status: 200, json: [] });
  });
  const view = await open(page, theme, width);
  const tab = view.getByRole('tab', { name: kind === 'topsql' ? '慢查询' : '会话', exact: true }); await tab.focus(); await page.keyboard.press('Enter');
  await expect(view).toContainText(kind === 'topsql' ? '加载慢查询数据' : '加载会话数据'); await capture(page, `controlled-${kind}-loading-${width}-${theme}`);
  mode = 'empty'; release(); await expect(view).toContainText('本次查询未返回'); await capture(page, `controlled-${kind}-empty-${width}-${theme}`);
  for (const [next, expected] of [
    ['failed', '读取失败'], ['forbidden', '无权读取'], ['unavailable', '实例未连接'],
    ['source-unavailable', '统计来源未就绪'], ['source-forbidden', '数据库账号无权读取'],
    ['malformed', '读取失败'], ['network', '读取失败'],
  ]) {
    mode = next; await tab.click(); await expect(view).toContainText(expected); await expect(view.locator('tbody')).toHaveCount(0);
    await capture(page, `controlled-${kind}-${next}-${width}-${theme}`);
  }
  mode = 'empty'; await tab.click(); await expect(view).toContainText('本次查询未返回');
  await view.evaluate((el: any) => { el.autoRefresh = false; el.stopAutoRefresh(); });
  await page.clock.fastForward(61_000);
  await expect(view).toContainText('数据已过期'); await capture(page, `controlled-${kind}-expired-${width}-${theme}`);
  expect(errors).toEqual([]);
});
