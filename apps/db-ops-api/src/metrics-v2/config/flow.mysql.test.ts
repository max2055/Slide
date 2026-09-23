import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import Fastify from 'fastify';
import mysql, { type Pool } from 'mysql2/promise';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from '../../../../../frontend/node_modules/vite/dist/node/index.js';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { PolicyService } from '../policy/service.js';
import { registerMetricPolicyRoutes } from '../policy/routes.js';
import { MysqlMetricStorage } from '../storage.js';
import { admin, pin, resource } from '../policy/test-support.js';
import { createConfigurationRegistry } from './registry.js';
import { MetricConfigurationService } from './service.js';
import { createTrialStore, registerMetricConfigurationRoutes } from './routes.js';

const port = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);
describe.skipIf(!port)('configuration real HTTP / MySQL / browser', () => {
  const database = `max74_${process.pid}`;
  let root: Pool, pool: Pool, app: ReturnType<typeof Fastify>, vite: ViteDevServer, browser: Browser;
  let base: string, web: string;
  const registry = createConfigurationRegistry();
  const auth = async (request: any) => { request.user = request.headers.authorization === 'Bearer readonly'
    ? { ...admin, permissions: ['metric:view', 'instance:view'], instanceScopes: { 1: 'read-only' } } : admin; };
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 12 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    const policy = new PolicyService(new MysqlPolicyStore(() => pool), registry, { exists: async () => true, inventory: async ref => resource(ref.id) });
    const service = new MetricConfigurationService(policy, registry, createTrialStore(() => pool, registry), { resolve: async ref => ({ resource: resource(ref.id), credential_ref: 'credential:isolated-target',
      evidence: { counter: { bits: '64', start_at: '2026-09-01T00:00:00.000Z' } },
      // Fixed simulated remote target; HTTP, policy persistence, CAS and reservation are real.
      resolve: async () => ({ method: 'sql', pool: { query: async () => [[{ Variable_name: 'Uptime', Value: '1000' }, { Variable_name: 'Queries', Value: '9007199254740993' }], []] } }),
    }) });
    app = Fastify(); await registerMetricPolicyRoutes(app, auth, policy); await registerMetricConfigurationRoutes(app, auth, service);
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    vite = await createServer({ configFile: false, root: fileURLToPath(new URL('../../../../../frontend', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': base } }, logLevel: 'error' });
    await vite.listen(); const address = vite.httpServer!.address() as { port: number }; web = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
  }, 120000);
  afterAll(async () => {
    await browser?.close(); await vite?.close(); await app?.close(); await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
  });
  const post = (path: string, body: unknown) => fetch(`${base}/api/metrics-v2/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  it('select → inherited preview → trial → concurrent publish / 409 → pending and no formal observations', async () => {
    const catalog = await (await fetch(`${base}/api/metrics-v2/config/catalog`)).json() as any;
    expect(catalog.packages.length).toBeGreaterThan(4);
    expect((await post('policy/groups/fixture/publish', { expected_revision: 0, overrides: { interval_ms: { mode: 'set', value: 30000 } } })).status).toBe(200);
    const candidate = { package: pin, expected_revision: 0, group_id: 'fixture' };
    const preview = await (await post('policy/resources/instance/1/preview', candidate)).json() as any;
    expect(preview.resources[0].resolved.sources.interval_ms.layer).toBe('group');
    expect((await post('config/resources/instance/1/trial', candidate)).status).toBe(200);
    const results = await Promise.all([post('policy/resources/instance/1/publish', candidate), post('policy/resources/instance/1/publish', candidate)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const binding = await (await fetch(`${base}/api/metrics-v2/policy/resources/instance/1`)).json() as any;
    expect(binding.application).toMatchObject({ status: 'pending', applied_revision: null });
    for (const table of ['metric_v2_observations', 'metric_v2_attempts']) {
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
    const response = await fetch(`${base}/api/metrics-v2/config/resources/instance/1/attempts`, { headers: { Authorization: 'Bearer readonly' } });
    expect(response.status).toBe(200);
    const attempts = await response.json() as any[];
    expect(attempts).toHaveLength(20);
    expect(attempts.every(a => a.binding_id === 'instance:1' && a.error === 'timeout')).toBe(true);
    expect(JSON.stringify(attempts)).not.toContain('private-collector');
    const denied = await fetch(`${base}/api/metrics-v2/config/resources/instance/2/attempts`, { headers: { Authorization: 'Bearer readonly' } });
    expect(denied.status).toBe(403);
  });
  it('desktop and mobile real API preview/trial/publish, readonly and settings routes', async () => {
    const artifacts = fileURLToPath(new URL('../../../../../docs/slide/metrics-v2/config-ui/screenshots', import.meta.url));
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.goto(`${web}/e2e/fixtures/metrics-config.html`);
      await browserExpect(page.getByRole('button', { name: '预检与影响预览' })).toBeEnabled();
      await page.getByRole('button', { name: '预检与影响预览' }).click();
      await browserExpect(page.getByText('每小时逻辑读取估算', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: '试采', exact: true }).click();
      await browserExpect(page.getByRole('heading', { name: '本次试采（不写正式观测）' })).toBeVisible();
      await page.getByRole('button', { name: '发布', exact: true }).click();
      await browserExpect(page.getByRole('button', { name: '重新加载' })).toBeEnabled();
      await browserExpect(page.locator('app-form-field[label="策略组"]').getByText('fixture', { exact: true })).toBeVisible();
      await browserExpect(page.getByRole('heading', { name: '指标能力、依据与覆盖' })).toBeVisible();
      expect(await page.locator('body').innerText()).not.toContain('credential:isolated-target');
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await page.screenshot({ path: `${artifacts}/${width}.png`, fullPage: true });
      await page.close();
    }
    // A second real HTTP writer advances the revision after browser preflight.
    const conflict = await browser.newPage();
    await conflict.goto(`${web}/e2e/fixtures/metrics-config.html`);
    await conflict.getByRole('button', { name: '预检与影响预览' }).click();
    await conflict.getByRole('button', { name: '试采', exact: true }).click();
    await browserExpect(conflict.getByRole('button', { name: '发布', exact: true })).toBeEnabled();
    const before = await (await fetch(`${base}/api/metrics-v2/policy/resources/instance/1`)).json() as any;
    expect((await post('policy/resources/instance/1/publish', { expected_revision: before.binding.revision })).status).toBe(200);
    await conflict.getByRole('button', { name: '发布', exact: true }).click();
    await browserExpect(conflict.getByRole('alert')).toContainText('重新加载');
    await browserExpect(conflict.getByRole('button', { name: '发布', exact: true })).toBeDisabled();
    const after = await (await fetch(`${base}/api/metrics-v2/policy/resources/instance/1`)).json() as any;
    expect(after.binding.revision).toBe(before.binding.revision + 1);
    await conflict.getByRole('button', { name: '重新加载' }).click();
    await conflict.getByRole('button', { name: '放弃修改并继续' }).click();
    await browserExpect(conflict.getByText(`当前发布版本 ${after.binding.revision}`, { exact: false })).toBeVisible();
    await conflict.close();
    const reader = await browser.newPage();
    await reader.addInitScript("localStorage.setItem('token', 'readonly')");
    await reader.goto(`${web}/e2e/fixtures/metrics-config.html`);
    await browserExpect(reader.getByText('只读：未获得此资源的管理权限。')).toBeVisible();
    await browserExpect(reader.getByRole('button', { name: '预检与影响预览' })).toHaveCount(0);
    await reader.close();
    const settings = await browser.newPage();
    await settings.goto(`${web}/e2e/fixtures/metrics-config.html?mode=settings`);
    await browserExpect(settings.locator('metric-settings')).toBeVisible();
    await browserExpect(settings.locator('summary').filter({ hasText: 'MySQL 基础采集 · 1.0.0' })).toBeVisible();
    await settings.close();
  }, 60000);
});
