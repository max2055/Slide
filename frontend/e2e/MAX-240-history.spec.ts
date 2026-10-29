import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { MigrationRunner } from '../../apps/db-ops-api/src/migrations/runner.ts';
import { identify, sample } from '../../apps/db-ops-api/src/contracts/metrics/fixtures.ts';
import type { NormalizedObservation } from '../../apps/db-ops-api/src/contracts/metrics/index.ts';
import { seriesHash } from '../../apps/db-ops-api/src/metrics/storage.ts';
import { createConfigurationRegistry } from '../../apps/db-ops-api/src/metrics/config/registry.ts';
import { PolicyService } from '../../apps/db-ops-api/src/metrics/policy/service.ts';
import { MysqlPolicyStore } from '../../apps/db-ops-api/src/metrics/policy/store.ts';
import { admin } from '../../apps/db-ops-api/src/metrics/policy/test-support.ts';
import { RolloutControl } from '../../apps/db-ops-api/src/metrics/rollout/control.ts';

// MAX240-HISTORY-UI browser acceptance: real production server, real JWT/password login,
// an isolated task-owned MySQL schema on a non-3306 port, and a controlled formal history
// fixture. No MAX238 fixture and no product model invocation is used.
// This harness owns a disposable database and two server processes; it only runs when the
// task supplies its isolated MySQL port. Other suites skip it instead of starting it.
const enabled = Boolean(process.env.MAX240_TEST_MYSQL_PORT && process.env.MAX240_TEST_API_PORT);
test.skip(!enabled, 'requires the task-owned MAX240 MySQL/API fixture');

const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const RESOURCE_ID = 8401;
const output = resolve('../docs/slide/development/MAX-240/e2e-20261029');
const schema = `max240_ui_${randomUUID().replaceAll('-', '')}`;
const password = ` ${randomUUID()} `;
let adminPool: any, pool: any, backend: ChildProcess, vite: Awaited<ReturnType<typeof createServer>>;
let origin: string, workspace: string, backendLog = '', modelCalls = 0;
let modelGuard: ReturnType<typeof createHttpServer>;
let from = 0, to = 0;
const iso = (ms: number) => new Date(ms).toISOString();
const sqlTime = (value: string) => new Date(value).toISOString().slice(0, 23).replace('T', ' ');
const fixture = sample('db.uptime_seconds');
const point = (ms: number, value: number, tag: string) => identify({ ...fixture, resource_id: String(RESOURCE_ID),
  observed_at: iso(ms), collected_at: iso(ms), stored_at: iso(ms), value: { encoding: 'float64', value },
  source: { ...fixture.source, attempt_id: `max240-ui-${tag}` } });
const inventory = () => ({ type: 'instance' as const, id: String(RESOURCE_ID), attributes: {
  'db.engine': { value: 'mysql', observed_at: iso(Date.now()), source: 'fixture' },
  'db.version': { value: '9.6.0', observed_at: iso(Date.now()), source: 'fixture' } } });

async function seed(rows: NormalizedObservation[]) {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await pool.query(`INSERT INTO metric_observations
      (id, series_hash, stage, observed_at, stored_at, valid_value, payload, payload_hash, evidence_expires_at)
      VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,NULL)').join(',')}`,
    chunk.flatMap(o => [o.id, seriesHash(o), o.stage, sqlTime(o.observed_at), sqlTime(o.stored_at!), 1, JSON.stringify(o), 'fixture']));
    await pool.query(`INSERT INTO metric_publications (observation_id, series_hash, generation, observed_at)
      VALUES ${chunk.map(() => '(?,?,?,?)').join(',')}`,
    chunk.flatMap(o => [o.id, seriesHash(o), 1, sqlTime(o.observed_at)]));
  }
}

test.beforeAll(async () => {
  const port = Number(process.env.MAX240_TEST_MYSQL_PORT);
  if (!port) throw new Error('MAX240_TEST_MYSQL_PORT must point to a task-owned isolated MySQL fixture');
  await mkdir(output, { recursive: true });
  workspace = await mkdtemp(`${tmpdir()}/slide-max240-`);
  const options = { host: '127.0.0.1', port, user: 'root', password: process.env.MAX240_TEST_MYSQL_PASSWORD ?? '' };
  adminPool = mysql.createPool(options); await adminPool.query(`CREATE DATABASE ${schema}`);
  pool = mysql.createPool({ ...options, database: schema });
  await new MigrationRunner(pool).run();
  const hash = await bcrypt.hash(password, 10);
  await pool.execute("INSERT INTO users (id,username,password_hash) VALUES (8401,'max240-owner',?)", [hash]);
  await pool.query("INSERT INTO roles (id,name) VALUES (8401,'max240-admin')");
  await pool.query("INSERT IGNORE INTO permissions (code,name,resource,action) VALUES ('*','Fixture admin','admin','all')");
  await pool.query('INSERT INTO role_permissions (role_id,permission_id) SELECT 8401,id FROM permissions');
  await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (8401,8401)');
  await pool.execute(`INSERT INTO database_instances (id,name,environment,db_type,host,port,username,password_encrypted,db_version,status)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [RESOURCE_ID, 'MAX240 历史验收实例', 'testing', 'mysql', 'history.fixture.invalid', 3306, 'fixture', 'unused', '9.6.0', 'active']);

  // Model traffic is forbidden: a local guard answers every provider call with 503.
  modelGuard = createHttpServer((_request, response) => { modelCalls++; response.writeHead(503); response.end('MODEL_CALL_FORBIDDEN'); });
  await new Promise<void>(done => modelGuard.listen(0, '127.0.0.1', done));
  await pool.query('UPDATE llm_providers SET enabled=0,is_default=0');
  await pool.execute("UPDATE llm_providers SET enabled=1,is_default=1,api_base_url=?,deployment_type='local',api_format=NULL WHERE name='ollama'",
    [`http://127.0.0.1:${(modelGuard.address() as { port: number }).port}`]);

  const registry = createConfigurationRegistry();
  const policy = new PolicyService(new MysqlPolicyStore(() => pool), registry,
    { exists: async () => true, inventory: async () => inventory() });
  const pin = registry.list().find(r => r.package.id === 'mysql-basic' && r.package.version === '2.0.0')!.package;
  await policy.changeBinding(admin as any, { type: 'instance', id: RESOURCE_ID }, { expected_revision: 0,
    package: { id: pin.id, version: pin.version, digest: pin.digest },
    overrides: { interval_ms: { mode: 'set', value: MINUTE }, timeout_ms: { mode: 'set', value: 5000 } } }, true);
  const series = { resource_type: 'instance' as const, resource_id: String(RESOURCE_ID),
    metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, dimensions: {} };
  const control = new RolloutControl(pool);
  await control.initialize(series, { source: 'semantic', read: 'semantic', revision: 1,
    package: { id: pin.id, version: pin.version, digest: pin.digest } });
  await control.applied(series, { source: 'semantic', generation: 1, revision: 1 });

  to = Math.floor(Date.now() / MINUTE) * MINUTE; from = to - DAY;
  const rows: NormalizedObservation[] = [];
  // Three samples per minute: any 60s query bucket (offset by query time) still holds several
  // samples, so the min/max envelope is meaningful and independent of bucket alignment.
  for (let i = 0; i < 1440; i++) {
    if (i === 1400 || i === 1401) continue; // retained gap; must stay null, never zero-filled
    const base = i % 41, minute = from + i * MINUTE;
    rows.push(point(minute + 5_000, i === 720 ? 999_999 : base + 3, `m${i}a`));
    rows.push(point(minute + 25_000, base, `m${i}b`));
    rows.push(point(minute + 45_000, base + 2, `m${i}c`));
  }
  await seed(rows);

  const apiPort = Number(process.env.MAX240_TEST_API_PORT);
  const wsPort = Number(process.env.MAX240_TEST_WS_PORT);
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
  }, { timeout: 90_000 }).toBe(200);
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
  if (adminPool) { await adminPool.query(`DROP DATABASE IF EXISTS ${schema}`); await adminPool.end(); }
  if (workspace) await rm(workspace, { recursive: true, force: true });
  if (modelGuard) await new Promise<void>(done => modelGuard.close(() => done()));
  expect(modelCalls).toBe(0);
});

async function login(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('app-theme-mode', 'light');
    const key = 'slide.control.settings.v1:default';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ locale: 'zh-CN', themeMode: 'light' }));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/servers`);
  await page.getByLabel('用户名', { exact: true }).fill('max240-owner');
  await page.getByLabel('密码', { exact: true }).fill(password);
  const authenticated = page.waitForResponse(r => r.url().endsWith('/api/auth/login') && r.status() === 200);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await authenticated;
  await expect(page.locator('.login-gate')).toHaveCount(0);
  // Open the resource only after permissions are loaded; the detail page invalidates
  // evidence that was mounted before the permission event.
  await page.goto(`${origin}/instance-detail?id=${RESOURCE_ID}`);
  await page.getByRole('tab', { name: '指标与趋势' }).click();
}

const queryResponse = (page: Page, match: (body: any) => boolean) => page.waitForResponse(response => {
  if (!response.url().endsWith('/api/metrics/query') || response.request().method() !== 'POST') return false;
  try { return match(response.request().postDataJSON()); } catch { return false; }
});
const windowSpan = (spanMs: number) => (body: any) => Date.parse(body.to) - Date.parse(body.from) === spanMs;
const chooseWindow = async (page: Page, value: string) => {
  const select = page.locator('semantic-metrics select[aria-label="时间范围"]');
  await select.selectOption(value);
};

test('24h, 7d and custom windows share one number/chart context with gaps, peaks and stale-good history', async ({ page }) => {
  await login(page);
  await expect(page.locator('semantic-metrics')).toBeVisible();

  const first = queryResponse(page, windowSpan(DAY)); await chooseWindow(page, '24'); const response24 = await first;
  const request24 = response24.request().postDataJSON();
  expect(request24.bucket_ms).toBe(MINUTE);
  expect(Date.parse(request24.to) - Date.parse(request24.from)).toBe(DAY);
  const body24 = await response24.json() as any;
  const buckets = body24.metrics[0].series[0].buckets as any[];
  expect(buckets).toHaveLength(1440);
  expect(buckets[0].window).toEqual({ from: request24.from, to: new Date(Date.parse(request24.from) + MINUTE).toISOString() });
  expect(buckets.at(-1).window).toEqual({ from: new Date(Date.parse(request24.to) - MINUTE).toISOString(), to: request24.to });
  expect(buckets.reduce((n, b) => n + b.sample_count, 0)).toBeGreaterThan(4_000);
  const gap = buckets.find(b => b.sample_count === 0);
  expect(gap).toMatchObject({ value: null, stats: null, coverage: 0 });
  expect(buckets.some(b => b.stats?.max?.value === 999_999)).toBe(true);
  // The mode value is one sample; the envelope keeps the bucket's in-bucket peak.
  expect(buckets.some(b => b.stats && b.value && Number(b.value.value) < Number(b.stats.max.value))).toBe(true);
  expect(buckets.some(b => b.value && b.quality.status === 'good' && b.accuracy === 'exact')).toBe(true);
  // A good/exact historical bucket may be stale by age; that alone must not hide it.
  expect(buckets.some(b => b.value && b.quality.status === 'good' && b.freshness === 'stale')).toBe(true);

  const metrics = page.locator('semantic-metrics');
  await expect(metrics).toContainText('共 1440 个');
  await expect(metrics).toContainText('本地时区');
  const chart = metrics.locator('metric-chart').first();
  await expect(chart.locator('.chart-title')).not.toBeEmpty();
  await expect(chart.locator('canvas').first()).toBeVisible();
  const chartData = await chart.evaluate((element: any) => ({ time: element.timeData, series: element.series }));
  expect(chartData.time).toHaveLength(1440);
  // The in-bucket spike reaches the chart through the min/max envelope, not only the mode value.
  expect(chartData.series[0].data).toHaveLength(1440);
  expect(Math.max(...chartData.series[0].max.filter((v: number | null) => v !== null))).toBe(999_999);
  // 1,440 bucket rows stay collapsed by default; only the summary and chart are in the DOM.
  expect(await metrics.locator('.bucket-row').count()).toBe(0);
  // Older minute buckets keep good/exact values while being stale relative to now.
  await metrics.locator('summary', { hasText: '查看时间桶、定义与来源' }).first().click();
  await metrics.locator('summary', { hasText: '时间桶明细' }).first().click();
  await expect(metrics.locator('.bucket-row').first()).toBeVisible();
  expect(await metrics.locator('.bucket-row').count()).toBe(200);
  await expect(metrics).toContainText('过期');
  await expect(metrics).toContainText('良好');

  const seven = queryResponse(page, windowSpan(7 * DAY)); await chooseWindow(page, '168'); const response7d = await seven;
  const request7d = response7d.request().postDataJSON();
  expect(request7d.bucket_ms).toBe(MINUTE);
  const body7d = await response7d.json() as any;
  expect(body7d.metrics[0].series[0].buckets).toHaveLength(10_080);
  await expect(metrics).toContainText('共 10080 个');

  await chooseWindow(page, 'custom');
  const day = (offset: number) => {
    const d = new Date(Date.now() + offset), p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  await page.locator('input[aria-label="自定义开始时间"]').fill(day(-8 * DAY));
  await page.locator('input[aria-label="自定义结束时间"]').fill(day(-MINUTE));
  const custom = queryResponse(page, body => body.bucket_ms === 2 * MINUTE); await page.getByRole('button', { name: '应用自定义窗口' }).click();
  const requestCustom = (await custom).request().postDataJSON();
  expect(requestCustom.bucket_ms).toBe(2 * MINUTE);
  await expect(metrics).toContainText('每桶 2 分钟');
  await expect(metrics).toContainText('未静默截断');

  for (const [width, height, name] of [[1440, 900, '1440x900'], [1366, 768, '1366x768'], [1920, 1080, '1920x1080']] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true, animations: 'disabled' });
  }
});

test('the numeric and chart views stay on the same selected resource, metric, dimensions and window after a fast switch', async ({ page }) => {
  await login(page);
  const metrics = page.locator('semantic-metrics');
  const select = metrics.locator('select[aria-label="指标"]');
  await select.selectOption('db.uptime_seconds');
  const fast = queryResponse(page, windowSpan(6 * HOUR));
  await chooseWindow(page, '6');
  const final = queryResponse(page, windowSpan(DAY));
  await chooseWindow(page, '24');
  const body = await (await fast).json() as any;
  const uptime = body.metrics.find((metric: any) => metric.definition.id === 'db.uptime_seconds');
  expect(uptime.series).toHaveLength(1);
  const latest = (await final).request().postDataJSON();
  expect(Date.parse(latest.to) - Date.parse(latest.from)).toBe(DAY);
  await expect(select).toHaveValue('db.uptime_seconds');
  await expect(metrics).toContainText('共 1440 个');
  await expect(metrics.locator('metric-chart').first()).toBeVisible();
  expect(await metrics.locator('.metric-name').count()).toBe(1);
});

test('revoking resource permission clears protected history immediately and rejects stale responses', async ({ page }) => {
  await login(page);
  const metrics = page.locator('semantic-metrics');
  await expect(metrics).toContainText('最近时间桶');
  await pool.query('DELETE FROM role_permissions WHERE role_id = 8401');
  const denied = page.waitForResponse(r => r.url().endsWith('/api/metrics/query') && r.status() === 403);
  await metrics.getByRole('button', { name: '刷新标准指标' }).click();
  await denied;
  await expect(metrics).toContainText('没有此资源的查看权限');
  await expect(metrics).not.toContainText('最近时间桶');
  await page.screenshot({ path: `${output}/permission-revoked.png`, fullPage: true, animations: 'disabled' });
});
