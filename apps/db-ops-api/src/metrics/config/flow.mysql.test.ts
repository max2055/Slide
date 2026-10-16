import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import Fastify from 'fastify';
import mysql, { type Pool } from 'mysql2/promise';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from '../../../../../frontend/node_modules/vite/dist/node/index.js';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../../db-connection.js';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { PolicyService } from '../policy/service.js';
import { registerMetricPolicyRoutes } from '../policy/routes.js';
import { MysqlMetricStorage } from '../storage.js';
import { admin, pin, resource } from '../policy/test-support.js';
import { installHistoricalMetricRoutes } from '../legacy-routes.js';
import { createConfigurationRegistry } from './registry.js';
import { MetricConfigurationService } from './service.js';
import { createTrialStore, registerMetricConfigurationRoutes } from './routes.js';
import { configurationReader } from './status-store.js';
import { configurationInventory } from './inventory.js';

const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
describe.skipIf(!port)('configuration real HTTP / MySQL / browser', () => {
  const database = `max74_${process.pid}`;
  let root: Pool, pool: Pool, app: ReturnType<typeof Fastify>, vite: ViteDevServer, browser: Browser;
  let base: string, web: string;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const registry = createConfigurationRegistry();
  const auth = async (request: any) => { request.user = request.headers.authorization === 'Bearer readonly'
    ? { ...admin, permissions: ['metric:view', 'instance:view'], instanceScopes: { 1: 'read-only' } } : admin; };
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 12 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    // Production readers use the disposable platform schema, including asset switches,
    // persisted attempts, source checks and publications. No scheduler or formal sample is seeded.
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    vi.stubEnv('METRICS_COLLECTION_ENABLED', 'true');
    await pool.execute(`INSERT INTO database_instances(id,name,host,port,username,password_encrypted,db_type,db_version,status)
      VALUES(1,'isolated flow target','127.0.0.1',3306,'fixture','','mysql','8.0.46','active')`);
    const policy = new PolicyService(new MysqlPolicyStore(() => pool), registry, { exists: async ref => ref.id === 1, inventory: configurationInventory });
    const service = new MetricConfigurationService(policy, registry, createTrialStore(() => pool, registry), { resolve: async ref => ({ resource: resource(ref.id), credential_ref: 'credential:isolated-target',
      evidence: { counter: { bits: '64', start_at: '2026-09-01T00:00:00.000Z' } },
      // Fixed simulated remote target; HTTP, policy persistence, CAS and reservation are real.
      resolve: async () => ({ method: 'sql', pool: { query: async () => [[{ Variable_name: 'Uptime', Value: '1000' }, { Variable_name: 'Queries', Value: '9007199254740993' }], []] } }),
    }) }, configurationReader(() => pool));
    app = Fastify(); installHistoricalMetricRoutes(app); await registerMetricPolicyRoutes(app, auth, policy); await registerMetricConfigurationRoutes(app, auth, service);
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    vite = await createServer({ configFile: false, root: fileURLToPath(new URL('../../../../../frontend', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': base } }, logLevel: 'error' });
    await vite.listen(); const address = vite.httpServer!.address() as { port: number }; web = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
  }, 120000);
  afterAll(async () => {
    await browser?.close(); await vite?.close(); await app?.close(); await pool?.end();
    poolSpy?.mockRestore(); vi.unstubAllEnvs();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
  });
  const post = (path: string, body: unknown) => fetch(`${base}/api/metrics/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  it('reads real configuration evidence and recommendations before first binding', async () => {
    const response = await fetch(`${base}/api/metrics/config/resources/instance/1/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      binding: { state: 'unbound', application: 'unbound', published_revision: null, applied_revision: null },
      effective_enabled: { global_enabled: true, asset_enabled: true, enabled: false },
      collection: { state: 'disabled', last_success_at: null },
      formal_visibility: { state: 'unbound', source: 'none', last_observed_at: null, generation: null },
    });
    const recommendations = await fetch(`${base}/api/metrics/config/resources/instance/1/recommendations`);
    expect(recommendations.status).toBe(200);
    const { packages } = await recommendations.json() as any;
    expect(packages.some((p: any) => p.recommended && p.compatibility === 'compatible')).toBe(true);
  });
  it('select → inherited preview → trial → concurrent publish / 409 → pending and no formal observations', async () => {
    const catalog = await (await fetch(`${base}/api/metrics/config/catalog`)).json() as any;
    expect(catalog.packages.length).toBeGreaterThan(4);
    expect((await post('policy/groups/fixture/publish', { expected_revision: 0, overrides: { interval_ms: { mode: 'set', value: 30000 } } })).status).toBe(200);
    const candidate = { package: pin, expected_revision: 0, group_id: 'fixture' };
    const preview = await (await post('policy/resources/instance/1/preview', candidate)).json() as any;
    expect(preview.resources[0].resolved.sources.interval_ms.layer).toBe('group');
    expect((await post('config/resources/instance/1/trial', candidate)).status).toBe(200);
    const results = await Promise.all([post('policy/resources/instance/1/publish', candidate), post('policy/resources/instance/1/publish', candidate)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const binding = await (await fetch(`${base}/api/metrics/policy/resources/instance/1`)).json() as any;
    expect(binding.application).toMatchObject({ status: 'pending', applied_revision: null });
    const status = await (await fetch(`${base}/api/metrics/config/resources/instance/1/status`)).json() as any;
    expect(status).toMatchObject({
      binding: { state: 'bound', application: 'pending', published_revision: 1, applied_revision: null },
      effective_enabled: { enabled: true, global_enabled: true, asset_enabled: true, policy_enabled: true },
      collection: { state: 'pending', last_success_at: null, in_flight: false },
      formal_visibility: { state: 'pending', source: 'none', last_observed_at: null, generation: null, freshness: 'unknown' },
    });
    expect(status.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, state: 'unknown', reason: 'CAPABILITY_UNKNOWN' }),
    ]));
    expect(status.blockers).toEqual(expect.arrayContaining(['APPLICATION_PENDING', 'AWAITING_SAMPLE']));
    for (const table of ['metric_observations', 'metric_attempts']) {
      const [rows] = await pool.query<any[]>(`SELECT COUNT(*) AS n FROM ${table}`); expect(Number(rows[0].n)).toBe(0);
    }
  });
  it('reads persisted recent attempts only for the authorized resource, bounded to 20', async () => {
    const storage = new MysqlMetricStorage(pool);
    for (let i = 0; i < 23; i++) await storage.writeAttempt({ id: `formal:${i}`, resource_id: '1', binding_id: 'instance:1',
      collector_id: 'mysql-status', config_revision: 1, started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      status: 'failed', error: 'timeout', observation_ids: [] });
    await storage.writeAttempt({ id: 'other-resource', resource_id: '2', binding_id: 'instance:2', collector_id: 'private-collector',
      config_revision: 1, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), status: 'failed', error: 'permission_denied', observation_ids: [] });
    const response = await fetch(`${base}/api/metrics/config/resources/instance/1/attempts`, { headers: { Authorization: 'Bearer readonly' } });
    expect(response.status).toBe(200);
    const attempts = await response.json() as any[];
    expect(attempts).toHaveLength(20);
    expect(attempts.every(a => a.binding_id === 'instance:1' && a.error === 'timeout')).toBe(true);
    expect(JSON.stringify(attempts)).not.toContain('private-collector');
    const denied = await fetch(`${base}/api/metrics/config/resources/instance/2/attempts`, { headers: { Authorization: 'Bearer readonly' } });
    expect(denied.status).toBe(403);
    for (const operation of ['status', 'recommendations']) {
      expect((await fetch(`${base}/api/metrics/config/resources/instance/2/${operation}`, { headers: { Authorization: 'Bearer readonly' } })).status).toBe(403);
    }
    for (const operation of ['trial', 'activate']) {
      expect((await fetch(`${base}/api/metrics/config/resources/instance/1/${operation}`, { method: 'POST',
        headers: { Authorization: 'Bearer readonly', 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: 1, package: pin }) })).status).toBe(403);
    }
  });
  it('desktop and mobile real API preview/trial/publish, readonly and settings routes', async () => {
    const artifacts = join(process.env.METRIC_TEST_ARTIFACT_DIR??tmpdir(), 'slide-metric-config-ui-evidence');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.goto(`${web}/e2e/fixtures/metrics-config.html`);
      await page.getByRole('button', { name: '检查并启用', exact: true }).click();
      // Scope to the host: action buttons are light-DOM children slotted into its dialog.
      const flow = page.locator('app-dialog[title="检查并启用采集"]');
      await browserExpect(flow.getByRole('dialog')).toBeVisible();
      await flow.getByRole('button', { name: '预检与影响预览' }).click();
      await browserExpect(flow.getByText('每小时逻辑读取估算', { exact: false })).toBeVisible();
      await flow.getByRole('button', { name: '试采', exact: true }).click();
      await browserExpect(flow.getByRole('heading', { name: '本次试采（不写正式观测）' })).toBeVisible();
      await browserExpect(flow.getByText('试采成功，可以发布', { exact: true })).toBeVisible();
      const activation = page.waitForResponse(r => r.url().endsWith('/config/resources/instance/1/activate') && r.request().method() === 'POST');
      await flow.getByRole('button', { name: '发布', exact: true }).click();
      expect((await activation).status()).toBe(200);
      await browserExpect(flow.getByText('等待正式观测', { exact: true })).toBeVisible();
      await flow.getByRole('button', { name: '关闭', exact: true }).click();
      await browserExpect(flow.getByRole('dialog')).toHaveCount(0);
      await page.getByText('最近正式采集尝试与技术证据', { exact: true }).click();
      await browserExpect(page.getByRole('button', { name: '重新加载', exact: true })).toBeEnabled();
      await browserExpect(page.getByLabel('策略组', { exact: true })).toHaveValue('fixture');
      await browserExpect(page.getByRole('heading', { name: '指标覆盖', exact: true })).toBeVisible();
      const facts = page.locator('.state-card .collection-facts');
      for (const [label, value] of [['模板绑定', '已绑定'], ['有效采集开关', '启用'], ['调度应用', '等待应用'],
        ['采集执行', '等待采集'], ['正式数据', '等待正式观测'], ['最近成功', '未知'], ['最近观测', '未知']]) {
        await browserExpect(facts.locator('div').filter({ has: page.getByText(label, { exact: true }) })).toContainText(value);
      }
      await page.locator('.state-card').getByText(/^指标覆盖：/).click();
      await browserExpect(page.locator('.state-card').getByText('数据库运行时长：未知', { exact: true })).toBeVisible();
      for (const table of ['metric_observations', 'metric_publications']) {
        const [rows] = await pool.query<any[]>(`SELECT COUNT(*) AS n FROM ${table}`); expect(Number(rows[0].n)).toBe(0);
      }
      expect(await page.locator('body').innerText()).not.toContain('credential:isolated-target');
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await page.screenshot({ path: `${artifacts}/${width}.png`, fullPage: true });
      await page.close();
    }
    // A second real HTTP writer advances the revision after browser preflight.
    const conflict = await browser.newPage();
    await conflict.goto(`${web}/e2e/fixtures/metrics-config.html`);
    await conflict.getByRole('button', { name: '检查并启用', exact: true }).click();
    const conflictFlow = conflict.locator('app-dialog[title="检查并启用采集"]');
    await conflictFlow.getByRole('button', { name: '预检与影响预览' }).click();
    await conflictFlow.getByRole('button', { name: '试采', exact: true }).click();
    await browserExpect(conflictFlow.getByRole('button', { name: '发布', exact: true })).toBeEnabled();
    const before = await (await fetch(`${base}/api/metrics/policy/resources/instance/1`)).json() as any;
    expect((await post('policy/resources/instance/1/publish', { expected_revision: before.binding.revision })).status).toBe(200);
    const rejected = conflict.waitForResponse(r => r.url().endsWith('/config/resources/instance/1/activate') && r.request().method() === 'POST');
    await conflictFlow.getByRole('button', { name: '发布', exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await browserExpect(conflictFlow.getByRole('alert')).toContainText('重新加载');
    await browserExpect(conflictFlow.getByRole('button', { name: '发布', exact: true })).toBeDisabled();
    const after = await (await fetch(`${base}/api/metrics/policy/resources/instance/1`)).json() as any;
    expect(after.binding.revision).toBe(before.binding.revision + 1);
    await conflictFlow.getByRole('button', { name: '关闭', exact: true }).click();
    await conflict.getByText('最近正式采集尝试与技术证据', { exact: true }).click();
    await conflict.getByRole('button', { name: '重新加载', exact: true }).click();
    await conflict.getByRole('button', { name: '放弃修改并继续' }).click();
    await browserExpect(conflict.locator('.state-card .collection-facts').locator('div').filter({ has: conflict.getByText('配置版本', { exact: true }) }))
      .toContainText(`发布 ${after.binding.revision} · 应用 —`);
    await conflict.close();
    const reader = await browser.newPage();
    await reader.addInitScript("localStorage.setItem('token', 'readonly')");
    await reader.goto(`${web}/e2e/fixtures/metrics-config.html`);
    await browserExpect(reader.getByText('只读：未获得此资源的管理权限。')).toBeVisible();
    await browserExpect(reader.getByRole('button', { name: '检查并启用', exact: true })).toBeDisabled();
    await browserExpect(reader.getByLabel('采集包 / 模板版本', { exact: true })).toBeDisabled();
    await browserExpect(reader.getByRole('switch', { name: '启用此对象采集' })).toBeDisabled();
    await reader.close();
    const settings = await browser.newPage();
    await settings.goto(`${web}/e2e/fixtures/metrics-config.html?mode=settings`);
    await browserExpect(settings.locator('metric-settings')).toBeVisible();
    const mysqlPackage = settings.getByRole('row')
      .filter({ has: settings.getByRole('cell', { name: 'MySQL 基础采集', exact: true }) })
      .filter({ has: settings.getByRole('cell', { name: '1.0.0', exact: true }) });
    await browserExpect(mysqlPackage).toBeVisible();
    await mysqlPackage.getByRole('button', { name: '查看模板', exact: true }).click();
    const detail = settings.locator('app-dialog[title="采集模板详情"]');
    await browserExpect(detail.getByRole('dialog')).toBeVisible();
    await browserExpect(detail).toContainText('数据库实例');
    await browserExpect(detail).toContainText('数据库运行时长');
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
    await browserExpect(mysqlPackage.getByRole('button', { name: '查看模板', exact: true })).toBeFocused();
    await settings.close();
  }, 60000);
});
