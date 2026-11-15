import { test, expect, type Page } from '@playwright/test';
import Fastify from '../../apps/db-ops-api/node_modules/fastify/fastify.js';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { registerQueryAnalysisRoutes } from '../../apps/db-ops-api/src/query-analysis-routes.js';
import { databaseService } from '../../apps/db-ops-api/src/database-service.js';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import { ActorContextService, signAccessToken } from '../../apps/db-ops-api/src/auth/actor-context.js';
import { createVerifyToken } from '../../apps/db-ops-api/src/auth-middleware.js';
import { MigrationRunner } from '../../apps/db-ops-api/src/migrations/runner.js';

let app: ReturnType<typeof Fastify>, vite: Awaited<ReturnType<typeof createServer>>;
let pool: ReturnType<typeof mysql.createPool>, admin: typeof pool;
let url: string, token: string;
const schema = `max537_${randomUUID().replaceAll('-', '')}`;
const output = process.env.MAX537_EVIDENCE_DIR || 'test-results-query-analysis/evidence';
const connections = (databaseService as any).connections as Map<number, any>;
const sample = `SELECT COUNT(*) FROM ${schema}.max537_sample CROSS JOIN ${schema}.max537_sample AS other WHERE max537_sample.id <= 537`;

test.beforeAll(async () => {
  if (!process.env.MAX537_MYSQL_CONFIG) throw new Error('Set MAX537_MYSQL_CONFIG explicitly to an authorized MySQL test target');
  const options = JSON.parse(process.env.MAX537_MYSQL_CONFIG);
  admin = mysql.createPool(options); await admin.query(`CREATE DATABASE ${schema}`);
  pool = mysql.createPool({ ...options, database: schema });
  const [version] = await pool.query('SELECT VERSION() AS version'); console.log('MySQL version:', (version as any[])[0].version);
  const [capacity] = await pool.query('SELECT COUNT(*) AS used, @@performance_schema_digests_size AS capacity FROM performance_schema.events_statements_summary_by_digest');
  if (Number((capacity as any[])[0].used) >= Number((capacity as any[])[0].capacity)) throw new Error('MySQL digest table is full; use a task-owned MySQL fixture without clearing shared history');
  await new MigrationRunner(pool as any).run();
  await pool.query("INSERT INTO users (id,username,password_hash) VALUES (99537,'max537-readonly','no-login')");
  await pool.query("INSERT INTO roles (id,name) VALUES (99537,'max537-readonly')");
  await pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 99537,id FROM permissions WHERE code IN ('instance:view','instance:query')");
  await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (99537,99537)');
  await pool.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted,db_type) VALUES (99537,'MAX-537 MySQL', 'fixture.invalid',3306,'fixture','unused','mysql')");
  await pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (99537,99537,'read-only')");
  await pool.query('CREATE TABLE max537_sample (id INT PRIMARY KEY, label VARCHAR(30))');
  await pool.query('INSERT INTO max537_sample (id,label) VALUES ?', [Array.from({ length: 600 }, (_, i) => [i + 1, 'real SQL sample'])]);
  // Only task-owned SQL/data; never truncate shared performance_schema history.
  for (let i = 0; i < 200; i++) await pool.query(sample);
  await dbConnection.initialize({ ...options, database: schema });
  const contexts = new ActorContextService(() => pool as any), secret = randomUUID();
  token = signAccessToken(await contexts.loadActiveActor(99537), secret);
  app = Fastify(); await registerQueryAnalysisRoutes(app, createVerifyToken(secret, contexts));
  const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  connections.set(99537, { id: 99537, connected: true, db_type: 'mysql', pool });
  vite = await createServer({ root: resolve('.'), configFile: resolve('vite.config.js'), server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: apiUrl } } } });
  await vite.listen(); url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  await mkdir(output, { recursive: true });
});
test.afterAll(async () => {
  // Playwright closes test pages before this hook; stop HTTP producers before DB cleanup.
  await vite?.close(); await app?.close(); connections.delete(99537); await dbConnection.close(); await pool?.end();
  if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${schema}`); await admin.end(); }
});
async function open(page: Page) {
  await page.addInitScript(token => localStorage.setItem('token', token), token);
  const qan = page.waitForResponse(r => r.url().includes('/qan?'));
  await page.goto(`${url}/e2e/fixtures/query-analysis.html`); const res = await qan;
  expect(res.status()).toBe(200);
  return page.locator('query-analysis-tab');
}
const row = (name: string, sql_text: string | null = `SELECT '${name}'`) => ({ fingerprint: `SELECT ? /* ${name} */`, sql_text, calls: 1, avg_time_ms: 1, total_time_ms: 1, max_time_ms: 1, rows_examined: 1 });

test('real JWT, live permissions, production QAN/EXPLAIN handlers and MySQL sample', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const view = await open(page);
  const target = view.locator('tbody tr:has(.fingerprint[title*="max537_sample"])'); await expect(target).toHaveCount(1);
  const explain = page.waitForResponse(r => r.url().includes('/explain?'));
  await target.focus(); await page.keyboard.press('Enter'); const res = await explain;
  expect(new URL(res.url()).searchParams.get('sql')).toBe(sample); expect(res.status()).toBe(200);
  const result = await res.json(); expect(result.db_type).toBe('mysql'); expect(result.plan.error).toBeUndefined(); expect(JSON.stringify(result.plan)).toContain('max537_sample'); await expect(view.locator('pre')).toContainText('max537_sample');
  await page.screenshot({ path: `${output}/real-mysql-1440.png` });
  await pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=99537 AND p.code='instance:query'");
  const denied = page.waitForResponse(r => r.url().includes('/explain?')); await target.click(); expect((await denied).status()).toBe(403);
  await expect(view).toContainText('HTTP 403'); await expect(view.locator('pre')).toHaveCount(0);
  await pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 99537,id FROM permissions WHERE code='instance:query'");
  await target.click(); await expect(view.locator('pre')).toContainText('max537_sample');
});

test('controlled browser response ordering, HTTP errors and missing executable text', async ({ page }) => {
  await page.route('**/qan?*', route => route.fulfill({ json: [row('A'), row('B'), row('missing', null)] }));
  const view = await open(page); let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  let seenA!: () => void; const started = new Promise<void>(r => { seenA = r; });
  await page.route('**/explain?*', async route => {
    const sql = new URL(route.request().url()).searchParams.get('sql');
    if (sql === "SELECT 'A'") { seenA(); await barrier; }
    await route.fulfill({ json: { plan: { 'Node Type': sql === "SELECT 'A'" ? 'STALE_A' : 'LATEST_B' } } });
  });
  try {
    await view.locator('tbody tr').nth(0).click(); await started;
    await view.locator('tbody tr').nth(1).click(); await expect(view).toContainText('LATEST_B');
    const oldResponse = page.waitForResponse(r => decodeURIComponent(r.url()).includes("SELECT 'A'")); release(); await oldResponse;
  } finally { release(); }
  await expect(view).not.toContainText('STALE_A'); await expect(view).toContainText('LATEST_B');
  await page.unroute('**/explain?*');
  for (const status of [400, 404, 500]) {
    await page.route('**/explain?*', route => route.fulfill({ status, json: { error: 'controlled failure' } }));
    await view.locator('tbody tr').nth(1).click(); await expect(view).toContainText(`HTTP ${status}`); await expect(view).not.toContainText('LATEST_B');
    await page.unroute('**/explain?*');
  }
  let requests = 0; page.on('request', req => { if (req.url().includes('/explain?')) requests++; });
  await view.locator('tbody tr').nth(2).click(); await expect(view).toContainText('没有可执行的语句文本'); expect(requests).toBe(0);
  for (const [width, height] of [[1366, 768], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${output}/no-sample-${width}.png` });
  }
});

test('old completion cannot clear current loading or restore a plan after switching instances', async ({ page }) => {
  await page.route('**/qan?*', route => route.fulfill({ json: [row('A'), row('B')] }));
  const view = await open(page);
  const gates = [0, 1].map(() => {
    let release!: () => void, start!: () => void;
    const wait = new Promise<void>(r => { release = r; }), seen = new Promise<void>(r => { start = r; });
    return { release, start, wait, seen };
  });
  let index = 0;
  await page.route('**/explain?*', async route => {
    const gate = gates[index++]; gate.start(); await gate.wait;
    await route.fulfill({ json: { plan: { 'Node Type': 'OBSOLETE' } } });
  });
  try {
    await view.locator('tbody tr').nth(0).click(); await gates[0].seen;
    await view.locator('tbody tr').nth(1).click(); await gates[1].seen;
    const old = page.waitForResponse(r => decodeURIComponent(r.url()).includes("SELECT 'A'")); gates[0].release(); await old;
    await expect(view).toContainText('加载执行计划'); await expect(view).not.toContainText('OBSOLETE');
    await view.evaluate((el: any) => { el.instanceId = 99538; });
    await expect(view).toContainText('点击左侧查询查看执行计划');
    const previousInstance = page.waitForResponse(r => r.url().includes('/explain?')); gates[1].release(); await previousInstance;
    await expect(view).toContainText('点击左侧查询查看执行计划'); await expect(view).not.toContainText('OBSOLETE');
  } finally { gates.forEach(g => g.release()); }
});
