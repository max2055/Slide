import { expect, test } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test.skip(process.env.MAX190_REAL_COLLECTION !== '1', 'Requires task-owned isolated MySQL and explicit live run');
const require = createRequire(resolve('../apps/db-ops-api/package.json'));
const mysql = require('mysql2/promise'), bcrypt = require('bcrypt');
const output = process.env.MAX190_OUTPUT_DIR ?? '/Users/max/Coding/40-Slide/outputs/MAX-190/live';
const apiDirectory = resolve(process.env.MAX190_API_DIRECTORY ?? '../apps/db-ops-api');
const api = 'http://127.0.0.1:3190', site = 'http://127.0.0.1:5196';
const schema = `max190_${process.pid}`, container = `slide-max190-mysql-${process.pid}`;
const targetHost = process.env.MAX190_TARGET_HOST ?? '';
const rootPassword = randomBytes(24).toString('hex'), adminPassword = randomBytes(24).toString('hex');
const children: ChildProcess[] = [];
let pool: any, started = false, token = '', permissions: string[] = [];
const report: any = { source: 'Real isolated MySQL 9.6, complete Fastify/JWT/scheduler, no HTTP mocks, no product LLM',
  backendDirectory: apiDirectory, backendSnapshot: process.env.MAX190_BACKEND_SNAPSHOT ?? null, requests: [], processes: [], checks: {} };
const save = () => writeFile(`${output}/result.json`, JSON.stringify(report, null, 2));
async function request(path: string, body?: unknown) {
  const result = await fetch(api + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  report.requests.push({ path, status: result.status });
  if (!result.ok) throw new Error(`Live API ${path}: HTTP ${result.status}`);
  return result.json();
}
async function launch(args: string[], cwd: string, env: NodeJS.ProcessEnv, name: string) {
  const file = await open(`${output}/${name}.private.log`, 'w', 0o600);
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', file.fd, file.fd] });
  children.push(child); await file.close();
  report.processes.push({ pid: child.pid, cwd, command: ['node', ...args], log: `${name}.private.log` });
  return child;
}
async function ready(url: string, child: ChildProcess) {
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error('Task process exited; inspect private log');
    try { return (await fetch(url)).status; } catch { return 0; }
  }, { timeout: 90000 }).toBe(200);
}
test.beforeAll(async () => {
  test.setTimeout(240000); await mkdir(output, { recursive: true });
  expect(targetHost).toMatch(/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/);
  report.frontendCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('docker', ['run', '-d', '--name', container, '-p', `${targetHost}:23390:3306`, '-e', 'MYSQL_ROOT_PASSWORD', '-e', 'MYSQL_ROOT_HOST', 'mysql:9.6'],
    { env: { ...process.env, MYSQL_ROOT_PASSWORD: rootPassword, MYSQL_ROOT_HOST: '%' }, stdio: 'pipe' }); started = true;
  await expect.poll(async () => {
    try { const c = await mysql.createConnection({ host: targetHost, port: 23390, user: 'root', password: rootPassword, connectTimeout: 1000 }); await c.end(); return true; } catch { return false; }
  }, { timeout: 120000 }).toBe(true);
  const env = { ...process.env, DB_HOST: targetHost, DB_PORT: '23390', DB_USER: 'root', DB_PASSWORD: rootPassword, DB_NAME: schema,
    JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    PORT: '3190', HOST: '127.0.0.1', AGENT_WS_PORT: '29990', SLIDE_MEMORY_PIPELINE_ENABLED: 'false', METRICS_COLLECTION_ENABLED: 'true',
    INITIAL_ADMIN_USERNAME: 'admin', INITIAL_ADMIN_PASSWORD: adminPassword };
  const migration = await launch(['--import', 'tsx', 'init-db.ts'], apiDirectory, env, 'migration');
  await new Promise<void>((ok, fail) => { migration.once('exit', code => code === 0 ? ok() : fail(new Error('Isolated migration failed'))); migration.once('error', fail); });
  pool = mysql.createPool({ host: env.DB_HOST, port: 23390, user: 'root', password: rootPassword, database: schema, timezone: 'Z' });
  await pool.query('UPDATE llm_providers SET enabled=0');
  await pool.query("UPDATE users SET password_hash=?,status='active' WHERE username='admin'", [await bcrypt.hash(adminPassword, 10)]);
  await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name='admin' WHERE u.username='admin'");
  const backend = await launch(['--import', 'tsx', 'server.ts'], apiDirectory, env, 'api'); await ready(api + '/api/health/ready', backend);
  token = (await request('/api/auth/login', { username: 'admin', password: adminPassword })).token;
  permissions = await request('/api/auth/permissions');
  const vite = await launch([resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5196', '--strictPort'], resolve('.'),
    { ...env, VITE_API_PROXY_TARGET: api, VITE_AGENT_WS_PROXY_TARGET: 'http://127.0.0.1:29990' }, 'vite'); await ready(site, vite);
  report.target = { host: targetHost, port: 23390, image: 'mysql:9.6', container, schema }; await save();
});
test.afterAll(async () => {
  test.setTimeout(60000);
  for (const child of [...children].reverse()) if (child.exitCode === null) {
    child.kill('SIGTERM'); await new Promise<void>(ok => { child.once('exit', () => ok()); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); ok(); }, 7000).unref(); });
  }
  await pool?.end();
  if (started) { execFileSync('docker', ['stop', container], { stdio: 'pipe' }); execFileSync('docker', ['rm', '--volumes', container], { stdio: 'pipe' }); }
  report.cleanup = { containerRemoved: started, processes: children.map(c => ({ pid: c.pid, exitCode: c.exitCode, signal: c.signalCode })) }; await save();
});

test('MySQL resource editor → check → trial → activate → formal query and list/detail', async ({ page }) => {
  test.setTimeout(240000);
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/metrics/')) report.requests.push({ path, status: response.status(), source: 'browser' });
  });
  await page.addInitScript(({ token, permissions }) => { localStorage.setItem('token', token); localStorage.setItem('slide.control.session_token.v1', token);
    localStorage.setItem('permissions', JSON.stringify(permissions)); localStorage.setItem('slide.i18n.locale', 'zh-CN'); }, { token, permissions });
  await page.goto(site + '/instances-db');
  await page.getByRole('button', { name: '添加实例', exact: true }).click();
  // Form controls are slotted light DOM, outside the native dialog's DOM subtree.
  const form = page.getByRole('region', { name: '资源编辑', exact: true });
  const field = (label: string) => form.getByLabel(label, { exact: true });
  await field('实例名称').fill('MAX-190 实采 MySQL 9.6'); await field('主机地址').fill(targetHost);
  await field('端口').fill('23390'); await field('用户名').fill('root'); await field('密码').fill(rootPassword);
  await form.getByRole('button', { name: '保存连接并配置采集', exact: true }).click();
  const editor = page.locator('metric-configuration'); await expect(editor).toBeVisible();
  const instances = await request('/api/database/instances'); const resource = instances.find((r: any) => r.name === 'MAX-190 实采 MySQL 9.6');
  report.resource = { id: resource.id, version: resource.db_version }; await save();
  await expect(editor.getByLabel('采集包 / 模板版本', { exact: true })).toBeEnabled();
  expect(resource.db_version).toMatch(/^9\.6/);
  const catalog = await request('/api/metrics/config/catalog'); const pack = catalog.packages.find((r: any) => r.package.id === 'mysql-basic' && r.package.version === '2.0.0').package;
  await expect(editor.getByLabel('采集包 / 模板版本', { exact: true })).toHaveValue(pack.digest);
  await editor.getByLabel('采集间隔（秒）覆盖方式', { exact: true }).selectOption('set');
  await editor.getByLabel('采集间隔（秒）', { exact: true }).fill('5');
  await editor.getByRole('button', { name: '检查并启用', exact: true }).click();
  await editor.getByRole('button', { name: '预检与影响预览' }).click(); await expect(editor).toContainText('影响 1 个资源');
  await editor.getByRole('button', { name: '试采', exact: true }).click(); await expect(editor).toContainText('试采成功，可以发布');
  await page.screenshot({ path: `${output}/mysql-check-trial.png`, fullPage: true });
  await editor.getByRole('button', { name: '发布', exact: true }).click();
  const root = `/api/metrics/config/resources/instance/${resource.id}`;
  await expect.poll(async () => { const status = await request(root + '/status'); report.status = status; await save(); return status.formal_visibility.state; }, { timeout: 90000, intervals: [1000, 2000, 3000] }).toBe('available');
  await expect.poll(async () => Number((await pool.query("SELECT COUNT(*) n FROM metric_attempts WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.resource.id'))=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.status'))='succeeded'", [String(resource.id)]))[0][0].n), { timeout: 60000 }).toBeGreaterThanOrEqual(3);
  report.formalQuery = await request('/api/metrics/query', { resource: { type: 'instance', id: resource.id }, view: 'core' });
  const uptime = report.formalQuery.metrics.find((m: any) => m.definition.id === 'db.uptime_seconds');
  expect(uptime.series.flatMap((s: any) => s.buckets).some((b: any) => Number(b.value?.value) > 0)).toBe(true);
  report.checks.threeCycles = true; report.checks.formalValues = true; await save();
  await editor.getByRole('button', { name: '重新加载', exact: true }).click(); await expect(editor.locator('.collection-facts')).toContainText('正式可用');
  await page.screenshot({ path: `${output}/mysql-formal-available.png`, fullPage: true });
  await page.goto(site + '/instances-db'); await expect(page.locator('resource-metrics-table')).toContainText('已绑定');
  await expect(page.locator('resource-metrics-table')).toContainText('该版本不支持');
  await page.screenshot({ path: `${output}/mysql-list.png`, fullPage: true });
  await page.goto(`${site}/instance-detail?id=${resource.id}`); await page.getByRole('tab', { name: '采集配置', exact: true }).click();
  await expect(page.locator('resource-collection-section')).toContainText('正式可用'); await expect(page.locator('metric-configuration')).toHaveCount(0);
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${output}/mysql-detail-${width}-${theme}.png`, fullPage: true });
  }
  report.checks.listAndDetail = true; await save();
});
