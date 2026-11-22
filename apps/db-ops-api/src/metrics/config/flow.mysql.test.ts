import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
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
import { admin, pin } from '../policy/test-support.js';
import { createConfigurationRegistry } from './registry.js';
import { MetricConfigurationService } from './service.js';
import { createTrialStore, registerMetricConfigurationRoutes } from './routes.js';
import { configurationReader } from './status-store.js';
import { configurationInventory } from './inventory.js';
import { TemplateBindingService } from '../templates/binding-service.js';
import { registerMetricTemplateRoutes } from '../templates/routes.js';
import { MySqlTemplateRepository } from '../templates/mysql-repository.js';
import { MetricTemplateService } from '../templates/service.js';
import type { TemplatePin } from '../../contracts/metrics/templates.js';
import type { CollectorAccess } from '../scheduler/service.js';

const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
describe.skipIf(!port)('configuration real HTTP / MySQL / browser', () => {
  const database = `max74_${process.pid}`;
  let root: Pool, pool: Pool, app: ReturnType<typeof Fastify>, vite: ViteDevServer, browser: Browser;
  let base: string, web: string;
  let remoteHasRows = true;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const registry = createConfigurationRegistry();
  const templateName = 'MySQL 指标配置验收';
  let templatePin: TemplatePin;
  const bindingPath = 'template-bindings/instance/1';
  const configurationPath = 'config/resources/instance/1';
  const targetRows = [{ Variable_name: 'Uptime', Value: '1000' }, { Variable_name: 'Queries', Value: '9007199254740993' }];
  const candidate = () => ({ expected_revision: 0, template_pins: [templatePin], group_id: 'fixture', overrides: {} });

  async function publishFixtureTemplate() {
    const repository = new MySqlTemplateRepository(pool);
    const templates = new MetricTemplateService(repository, registry);
    const template = await templates.create(admin, { name: templateName });
    const items = [];
    for (const id of ['db.uptime_seconds', 'mysql.queries.total']) {
      const { item } = await templates.selectMetric(admin, template.template_id,
        { package: pin, metric: { id, semantic_version: '1.0.0' } });
      items.push({ item_id: item.item_id, version: item.version });
    }
    const draft = (await repository.getDraft(template.template_id))!;
    const updated = await templates.updateDraft(admin, template.template_id, {
      expected_draft_revision: draft.revision,
      aggregate: { ...draft.aggregate, items: items.sort((a, b) => a.item_id.localeCompare(b.item_id)) },
    });
    const version = await templates.publish(admin, template.template_id, {
      expected_draft_revision: updated.revision, expected_revision: template.revision,
    });
    const current = (await repository.getTemplate(template.template_id))!;
    await templates.setCurrent(admin, template.template_id, { version: version.version, expected_revision: current.revision });
    return { template_id: template.template_id, version: version.version, content_hash: version.content_hash };
  }

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
    const access: CollectorAccess = { resolve: async ref => ({
      resource: await configurationInventory(ref), credential_ref: 'credential:isolated-target',
      evidence: { counter: { bits: '64', start_at: new Date(Date.now() - 1000_000).toISOString() } },
      // Only the target transport is controlled. The template and policy routes
      // perform real checks, persistence, CAS and collector decoding.
      resolve: async () => ({ method: 'sql', pool: { query: async () => [remoteHasRows ? targetRows : [], []] } }),
    }) };
    const service = new MetricConfigurationService(policy, registry, createTrialStore(() => pool, registry), access,
      configurationReader(() => pool));
    templatePin = await publishFixtureTemplate();
    app = Fastify();
    await registerMetricPolicyRoutes(app, auth, policy, async actor => actor);
    await registerMetricConfigurationRoutes(app, auth, service);
    await registerMetricTemplateRoutes(app, auth, new TemplateBindingService({
      pool: () => pool, registry, access, reload: async actor => actor,
    }));
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
    const intent = candidate();
    const probe = await post(`${bindingPath}/probe`, intent);
    expect(probe.status, await probe.text()).toBe(200);
    const preview = await (await post(`${bindingPath}/preview`, intent)).json() as any;
    expect(preview).toMatchObject({ executable: true, settings: { interval_ms: 30000 } });
    const receipt_id = 'api-config-trial';
    expect((await post(`${bindingPath}/trial`, { ...intent, receipt_id })).status).toBe(200);
    const results = await Promise.all(['api-config-first', 'api-config-second'].map(caller_key =>
      post(`${bindingPath}/apply`, { ...intent, receipt_id, caller_key })));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const binding = await (await fetch(`${base}/api/metrics/${bindingPath}`)).json() as any;
    expect(binding).toMatchObject({ template_pins: [templatePin], application: { status: 'pending', applied_revision: null } });
    const status = await (await fetch(`${base}/api/metrics/config/resources/instance/1/status`)).json() as any;
    expect(status).toMatchObject({
      binding: { state: 'bound', application: 'pending', published_revision: 1, applied_revision: null },
      effective_enabled: { enabled: true, global_enabled: true, asset_enabled: true, policy_enabled: true },
      collection: { state: 'pending', last_success_at: null, in_flight: false },
      formal_visibility: { state: 'pending', source: 'none', last_observed_at: null, generation: null, freshness: 'unknown' },
    });
    expect(status.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, state: 'covered' }),
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
    const readonly = await fetch(`${base}/api/metrics/${bindingPath}/trial`, { method: 'POST',
      headers: { Authorization: 'Bearer readonly', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...candidate(), expected_revision: 1, receipt_id: 'readonly-trial' }) });
    expect(readonly.status).toBe(403);
    expect((await post(`${configurationPath}/activate`, {})).status).toBe(404);
  });

  it('checks, trials and applies a fixed template in desktop and compact viewports', async () => {
    const artifacts = join(process.env.METRIC_TEST_ARTIFACT_DIR ?? tmpdir(), 'slide-metric-config-ui-evidence');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 375]) {
      await pool.query("DELETE FROM metric_policy_bindings WHERE resource_key = 'instance:1'");
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      try {
        const principal = Buffer.from(JSON.stringify({ userId: admin.userId })).toString('base64url');
        await page.addInitScript(`localStorage.setItem('token', 'fixture.${principal}.fixture')`);
        await page.goto(`${web}/e2e/fixtures/metrics-config.html`);
        await page.getByRole('checkbox', { name: `选择模板 ${templateName}` }).check();
        await page.getByLabel('策略组', { exact: true }).selectOption('fixture');
        const preview = await pageAction(page, '检查配置', 'preview');
        expect(preview).toMatchObject({ executable: true, settings: { interval_ms: 30000 } });
        const trial = await pageAction(page, '试采', 'trial');
        expect(trial).toMatchObject({ trial: true, persisted: false, decision: 'attempted' });
        expect(trial.items).toHaveLength(2);
        expect(trial.items.every((item: any) => item.phases.read && item.phases.transform && item.phases.unit)).toBe(true);
        expect(trial.samples).toEqual(expect.arrayContaining([
          expect.objectContaining({ metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' } }),
          expect.objectContaining({ metric: { id: 'mysql.queries.total', semantic_version: '1.0.0' },
            value: { encoding: 'uint64', value: '9007199254740993' }, quality: { status: 'good', reason: 'none' } }),
        ]));
        await browserExpect(page.getByRole('list', { name: '逐项试采结果' })).toBeVisible();
        await writeFile(join(artifacts, `trial-${width}.json`), JSON.stringify(trial, null, 2));
        expect(await pageAction(page, '首次绑定并启用', 'apply')).toMatchObject({ kind: 'committed', revision: 1 });
        await browserExpect(page.getByText('配置已提交，目标版本 1', { exact: false })).toBeVisible();
        await browserExpect(page.getByText('尚未收到正式首样本', { exact: true })).toBeVisible();
        expect(await page.locator('body').innerText()).not.toContain('credential:isolated-target');
        expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
        await page.screenshot({ path: join(artifacts, `${width}.png`), fullPage: true });
      } finally { await page.close(); }
    }
    for (const table of ['metric_observations', 'metric_publications']) {
      const [rows] = await pool.query<any[]>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(Number(rows[0].n)).toBe(0);
    }

    const reader = await browser.newPage();
    try {
      await reader.addInitScript("localStorage.setItem('token', 'readonly')");
      await reader.goto(`${web}/e2e/fixtures/metrics-config.html`);
      await browserExpect(reader.getByText('只读：未获得此资源的管理权限。')).toBeVisible();
      await browserExpect(reader.getByRole('checkbox', { name: `选择模板 ${templateName}` })).toBeDisabled();
      await browserExpect(reader.getByRole('button', { name: '检查配置', exact: true })).toBeDisabled();
    } finally { await reader.close(); }

    const settings = await browser.newPage();
    try {
      await settings.goto(`${web}/e2e/fixtures/metrics-config.html?mode=settings`);
      await browserExpect(settings.locator('metric-settings')).toBeVisible();
      await browserExpect(settings.locator('template-library')).toHaveCount(1);
      await browserExpect(settings.locator('template-governance')).toHaveCount(0);
    } finally { await settings.close(); }
  }, 60000);

  async function pageAction(page: import('@playwright/test').Page, name: string, action: string) {
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith(`/${bindingPath}/${action}`) && r.request().method() === 'POST'),
      page.getByRole('button', { name, exact: true }).click(),
    ]);
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  }

  it('keeps application disabled when template trial returns no valid samples', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${web}/e2e/fixtures/metrics-config.html`);
      await pageAction(page, '检查配置', 'preview');
      const complete = await pageAction(page, '试采', 'trial');
      expect(complete.samples).toHaveLength(2);
      await browserExpect(page.getByText('试采通过', { exact: true })).toBeVisible();
      await browserExpect(page.getByRole('button', { name: '应用并启用', exact: true })).toBeEnabled();
      remoteHasRows = false;
      const invalid = await pageAction(page, '试采', 'trial');
      expect(invalid.samples.some((sample: any) => sample.value !== null && sample.quality.status === 'good')).toBe(false);
      await browserExpect(page.getByText('试采未满足启用门禁', { exact: false })).toBeVisible();
      await browserExpect(page.getByRole('button', { name: '应用并启用', exact: true })).toBeDisabled();
    } finally { remoteHasRows = true; await page.close(); }
  }, 30000);
});
