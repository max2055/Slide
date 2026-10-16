import { test, expect, type Page } from '@playwright/test';
import Fastify from '../../apps/db-ops-api/node_modules/fastify/fastify.js';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { MigrationRunner } from '../../apps/db-ops-api/src/migrations/runner.js';
import { ActorContextService, signAccessToken } from '../../apps/db-ops-api/src/auth/actor-context.js';
import { createVerifyToken } from '../../apps/db-ops-api/src/auth-middleware.js';
import { requirePermission } from '../../apps/db-ops-api/src/auth/require-permission.js';
import { requireInstanceAccess } from '../../apps/db-ops-api/src/auth/require-instance-access.js';
import { createConfigurationRegistry } from '../../apps/db-ops-api/src/metrics/config/registry.js';
import { builtinReleases, canonicalDefinitions } from '../../apps/db-ops-api/src/metrics/packages/builtins.js';
import { PolicyService } from '../../apps/db-ops-api/src/metrics/policy/service.js';
import { MysqlPolicyStore } from '../../apps/db-ops-api/src/metrics/policy/store.js';
import { MysqlMetricStorage } from '../../apps/db-ops-api/src/metrics/storage.js';
import { MysqlFormalMetricStore } from '../../apps/db-ops-api/src/metrics/rollout/formal-store.js';
import { RolloutControl } from '../../apps/db-ops-api/src/metrics/rollout/control.js';
import { MetricConsumerService } from '../../apps/db-ops-api/src/metrics/consumers/service.js';
import { registerMetricConsumerRoutes } from '../../apps/db-ops-api/src/metrics/consumers/routes.js';
import { identify, sample } from '../../apps/db-ops-api/src/contracts/metrics/fixtures.js';

// Only an explicitly isolated MySQL fixture: no shared bindings, scheduler, SSH or model calls.
let app: ReturnType<typeof Fastify>, vite: Awaited<ReturnType<typeof createServer>>;
let admin: ReturnType<typeof mysql.createPool>, pool: typeof admin;
let url: string, token: string, control: RolloutControl;
const schema = `max165_time_${randomUUID().replaceAll('-', '')}`;
const output = 'test-results/detail-observation';
const sampledAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000).toISOString();
// Controlled evaluation clock ages persisted evidence without waiting or recollecting it.
const evaluatedAt = new Date(Date.parse(sampledAt) + 600_000).toISOString();
const serviceClock = () => new Date(Date.parse(evaluatedAt) + 60_000).toISOString();
const releases = builtinReleases();
const releaseFor = (kind: string) => releases.find(r => r.package.id === (kind === 'instance' ? 'mysql-basic' : 'linux-host'))!;
const definitionFor = (kind: string) => canonicalDefinitions.find(d => d.id === (kind === 'instance' ? 'db.uptime_seconds' : 'host.filesystem.used_bytes'))!;
let uptime = 0;
let readMetrics: (kind: 'instance' | 'server') => Promise<unknown>;

test.beforeAll(async () => {
  if (!process.env.MAX163_TEST_MYSQL_PORT) throw new Error('MAX163_TEST_MYSQL_PORT must point to an isolated fixture');
  const options = { host: '127.0.0.1', port: Number(process.env.MAX163_TEST_MYSQL_PORT), user: 'root', password: process.env.MAX163_TEST_MYSQL_PASSWORD ?? '' };
  admin = mysql.createPool(options); await admin.query(`CREATE DATABASE ${schema}`);
  pool = mysql.createPool({ ...options, database: schema }); await new MigrationRunner(pool as any).run();
  await pool.query("INSERT INTO users (id,username,password_hash) VALUES (992,'max165-browser','no-login')");
  await pool.query("INSERT INTO user_roles (user_id,role_id) SELECT 992,id FROM roles WHERE name='admin'");
  await pool.query("INSERT INTO database_instances (id,name,db_type,host,port,username,password_encrypted,status) VALUES (992,'MAX-165 隔离 MySQL','mysql','fixture.invalid',3306,'fixture','unused','active')");
  await pool.query("INSERT INTO servers (id,host,port,label,os_type,credential_type,credential_encrypted,status) VALUES (992,'max165-host.invalid',22,'MAX-165 受控主机观测','Linux','password','unused','online')");
  const [status] = await pool.query("SHOW GLOBAL STATUS LIKE 'Uptime'"); uptime = Number((status as any[])[0].Value);
  const contexts = new ActorContextService(() => pool as any), secret = randomUUID();
  const actor = await contexts.loadActiveActor(992); token = signAccessToken(actor, secret);
  const registry = createConfigurationRegistry(), store = new MysqlMetricStorage(pool as any);
  const policies = new MysqlPolicyStore(() => pool as any);
  const resources = {
    exists: async () => true,
    inventory: (ref: { type: string; id: number }) => store.inventory(ref.type as any, String(ref.id)),
  };
  const policy = new PolicyService(policies, registry, resources, () => evaluatedAt);
  for (const kind of ['instance', 'server'] as const) {
    const attributes = kind === 'instance' ? { 'db.engine': 'mysql', 'db.version': '8.4' } : { 'os.family': 'linux' };
    await store.writeInventory({ type: kind, id: '992', attributes: Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, { value, observed_at: sampledAt, source: 'isolated-fixture' }])) });
    const release = releaseFor(kind), { id, version, digest } = release.package;
    await policy.changeBinding(actor, { type: kind, id: 992 }, { expected_revision: 0, package: { id, version, digest }, overrides: { max_rows: { mode: 'set', value: 1 } } }, true);
    const capabilities = release.package.collectors.flatMap(c => c.mappings.map(m => ({ resource_id: '992', metric: m.metric, method: c.method, status: 'supported' as const,
      basis: [{ kind: 'permission' as const, evidence: 'isolated-fixture' }], evaluated_at: sampledAt, valid_until: new Date(Date.parse(evaluatedAt) + 3600000).toISOString() })));
    await policies.reportCapabilities({ type: kind, id: 992 }, 1, capabilities, null);
  }
  control = new RolloutControl(pool as any, undefined, () => new Date(serviceClock()));
  const formal = new MysqlFormalMetricStore(pool as any);
  const service = new MetricConsumerService(policy, registry, {
    queryWindow: (...args) => formal.queryWindow(...args), inventory: (...args) => formal.inventory(...args),
    dimensions: (...args) => formal.dimensions(...args), attempts: async () => [],
  }, serviceClock);
  readMetrics = kind => service.query(actor, { resource: { type: kind, id: 992 }, view: 'all', from: new Date(Date.parse(evaluatedAt) - 3600000).toISOString(), to: evaluatedAt, bucket_ms: 60000 });
  app = Fastify(); const verify = createVerifyToken(secret, contexts);
  await registerMetricConsumerRoutes(app, verify, service);
  app.get('/api/database/instances/:id', { preHandler: [verify, requirePermission('instance:view'), requireInstanceAccess('read-only')] }, async () => (await pool.query('SELECT id,name,db_type,host,port,status FROM database_instances WHERE id=992'))[0][0]);
  app.get('/api/servers/:id', { preHandler: [verify, requirePermission('servers:view')] }, async () => (await pool.query('SELECT id,host,label,status,os_type,port FROM servers WHERE id=992'))[0][0]);
  app.get('/api/servers/:id/instances', { preHandler: verify }, async () => ({ instances: [] }));
  app.setNotFoundHandler(async (_request, reply) => reply.send({ items: [], records: [] }));
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  vite = await createServer({ root: resolve('.'), configFile: resolve('vite.config.js'), server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api }, '/__slide': { target: api } } } });
  await vite.listen(); url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  await mkdir(output, { recursive: true });
});
test.afterAll(async () => {
  await vite?.close(); await app?.close(); await pool?.end();
  if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${schema}`); await admin.end(); }
});
async function seed(kind: 'instance' | 'server', at: string, reset = false) {
  if (reset) {
    await pool.query('DELETE FROM metric_publications'); await pool.query('DELETE FROM metric_observations'); await pool.query('DELETE FROM metric_rollout');
  }
  const definition = definitionFor(kind), { id, version, digest } = releaseFor(kind).package;
  const observation = identify({ ...sample(definition.id), resource_id: '992', observed_at: at, collected_at: at, stored_at: null,
    ...(kind === 'instance' ? { value: { encoding: 'float64' as const, value: uptime } } : {}),
    versions: { ...sample(definition.id).versions, package_id: id, package_version: version },
  });
  const ticket = { source: 'v2', generation: 1, revision: 1 };
  if (reset) { await control.initialize(observation, { source: 'v2', read: 'v2', package: { id, version, digest }, revision: 1 }); await control.applied(observation, ticket); }
  await control.publish(observation, definition, ticket);
  await readMetrics(kind);
}
async function capture(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${output}/${name}.png`, animations: 'disabled' });
  // Keep the actual observation readable even when earlier empty buckets make the table long.
  const observed = page.locator('semantic-metrics time').last();
  if (await observed.count()) {
    if (!(await observed.isVisible())) await page.locator('semantic-metrics summary').filter({hasText:'查看原始时间桶'}).first().click();
    await observed.locator('..').locator('..').screenshot({ path: `${output}/${name}-observed.png`, animations: 'disabled' });
  }
}
for (const kind of ['instance', 'server'] as const) for (const [width, theme] of [[1280, 'dark'], [390, 'light']] as const) test(`${kind} observation and read states ${width} ${theme}`, async ({ page }) => {
  await seed(kind, sampledAt, true);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({ time: Date.parse(evaluatedAt) });
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(token => localStorage.setItem('token', token), token);
  await page.goto(`${url}/e2e/fixtures/detail-observation.html?kind=${kind}&tab=${kind === 'server' ? 'server-detail' : 'instance-detail'}&id=992`);
  await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, theme);
  const view = page.locator(kind === 'server' ? 'server-detail' : 'instance-detail-page');
  if (kind === 'instance') await view.evaluate((el: any) => { el.autoRefresh = false; el.stopAutoRefresh(); });
  await view.getByRole('tab', { name: '指标与趋势', exact: true }).click();
  const metrics = view.locator('semantic-metrics'), header = view.locator('.last-updated');
  const times = metrics.locator('time');
  await expect(times.first()).toHaveAttribute('datetime', sampledAt);
  await expect(metrics).toContainText('过期'); await expect(header).toContainText('非资源观测');
  await capture(page, `${kind}-stale-${width}-${theme}`);
  const firstRead = await header.textContent();
  await page.clock.fastForward(2000);
  const refresh = view.getByRole('button', { name: '刷新', exact: true }); await refresh.focus(); await page.keyboard.press('Enter');
  await expect(header).not.toHaveText(firstRead!); await expect(refresh).toBeEnabled();
  await expect(times.first()).toHaveAttribute('datetime', sampledAt); await expect(metrics).toContainText('过期');
  await capture(page, `${kind}-refreshed-still-stale-${width}-${theme}`);
  const successfulRead = await header.textContent();
  const path = kind === 'instance' ? '**/api/database/instances/992' : '**/api/servers/992';
  let release!: () => void;
  await page.route(path, async route => { await new Promise<void>(resolve => release = resolve); await route.fulfill({ status: 500, body: '{}' }); });
  await page.clock.fastForward(2000); await refresh.click(); await expect(refresh).toBeDisabled();
  await expect(header).toHaveText(successfulRead!); await capture(page, `${kind}-loading-${width}-${theme}`);
  release(); await expect(view.getByRole('alert')).toContainText('成功读取时间未更新'); await expect(refresh).toBeEnabled();
  await expect(header).toHaveText(successfulRead!); await capture(page, `${kind}-detail-failed-${width}-${theme}`);
  await page.unroute(path);
  // New accepted evidence changes observed_at and freshness together; server values are controlled, not SSH acceptance.
  const freshAt = new Date(Date.parse(evaluatedAt) - 1000).toISOString(); await seed(kind, freshAt);
  await refresh.click(); await expect(refresh).toBeEnabled(); await expect(times.last()).toHaveAttribute('datetime', freshAt);
  await expect(metrics).toContainText('新鲜'); await capture(page, `${kind}-fresh-${width}-${theme}`);
  await pool.query('DELETE FROM metric_publications');
  await refresh.click(); await expect(refresh).toBeEnabled(); await expect(times).toHaveCount(0);
  await expect(metrics).toContainText('未知'); await capture(page, `${kind}-unknown-${width}-${theme}`);
  await page.route('**/api/metrics/query', route => route.fulfill({ status: 403, body: '{}' }));
  await metrics.getByRole('button', { name: '刷新标准指标' }).click(); await expect(metrics.getByRole('alert')).toContainText('权限');
  await expect(times).toHaveCount(0); await capture(page, `${kind}-metrics-forbidden-${width}-${theme}`);
  await page.unroute('**/api/metrics/query');
  await page.route(path, route => route.fulfill({ status: 403, body: '{}' }));
  await refresh.click(); await expect(view).toContainText('无权读取'); await expect(view.locator('semantic-metrics')).toHaveCount(0);
  await capture(page, `${kind}-detail-forbidden-${width}-${theme}`);
  expect(errors).toEqual([]);
  await writeFile(`${output}/${kind}-${width}-fields.json`, JSON.stringify({ kind, width, theme, sampledAt, evaluatedAt: serviceClock(), browserClockAt: evaluatedAt, freshAt, firstRead, successfulRead,
    source: kind === 'instance' ? 'live isolated MySQL SHOW GLOBAL STATUS Uptime; controlled evaluation clock' : 'controlled filesystem normalized observation; no SSH',
    path: 'JWT -> live SQL actor -> production metric consumer -> MySQL policy + formal publication store -> production reducer -> detail component',
  }, null, 2));
});
