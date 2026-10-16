import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import Fastify from 'fastify';
import mysql, { type Pool } from 'mysql2/promise';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from '../../../../../frontend/node_modules/vite/dist/node/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { PolicyService } from '../policy/service.js';
import { registerMetricPolicyRoutes } from '../policy/routes.js';
import { admin } from '../policy/test-support.js';
import { MYSQL_STATUS_SQL } from '../packages/adapters.js';
import { createConfigurationRegistry } from './registry.js';
import { MetricConfigurationService } from './service.js';
import { createTrialStore, registerMetricConfigurationRoutes } from './routes.js';

// Explicit opt-in. All policy writes use a unique disposable schema, never the deployed platform schema.
describe.skipIf(process.env.MYSQL96_TEST !== 'true')('MySQL 9.6 real SQL, HTTP, persistence and browser', () => {
  const database = `max156_${process.pid}`, user = `max156_${process.pid}`, password = randomBytes(24).toString('hex');
  const config = { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' };
  let root: Pool, pool: Pool, target: Pool, app: ReturnType<typeof Fastify>, vite: ViteDevServer, browser: Browser;
  let base: string, web: string, version: string, createdUser = false;
  const registry = createConfigurationRegistry(), evidence: Record<string, unknown> = {};
  const artifacts = process.env.MAX156_EVIDENCE_DIR;
  const resource = () => ({ type: 'instance' as const, id: '1', attributes: {
    'db.engine': { value: 'mysql', source: 'driver', observed_at: new Date().toISOString() },
    'db.version': { value: version, source: 'driver', observed_at: new Date().toISOString() },
  } });
  const post = async (path: string, payload: unknown) => {
    const response = await fetch(`${base}/api/metrics/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() as any };
  };
  beforeAll(async () => {
    root = mysql.createPool(config);
    const [versions] = await root.query<any[]>('SELECT VERSION() AS version'); version = versions[0].version;
    expect(version).toMatch(/^9\.6\./);
    await root.query(`CREATE DATABASE ${mysql.escapeId(database)}`);
    await root.query('CREATE USER ? IDENTIFIED BY ?', [user, password]); createdUser = true;
    pool = mysql.createPool({ ...config, database, connectionLimit: 12 });
    target = mysql.createPool({ host: config.host, port: config.port, user, password, supportBigNumbers: true, bigNumberStrings: true });
    const [grants] = await target.query<any[]>('SHOW GRANTS');
    expect(grants).toHaveLength(1); expect(String(Object.values(grants[0])[0])).toMatch(/^GRANT USAGE ON/);
    const [raw] = await target.query<any[]>(MYSQL_STATUS_SQL);
    expect(raw.map(r => r.Variable_name).sort()).toEqual(['Queries', 'Uptime']);
    for (const row of raw) { expect(typeof row.Value).toBe('string'); expect(row.Value).toMatch(/^\d+$/); }
    evidence.target = { version, permissions: 'USAGE only; no PROCESS, SELECT or administrative grants', raw };
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    const policy = new PolicyService(new MysqlPolicyStore(() => pool), registry, { exists: async ref => ref.id === 1, inventory: async () => resource() });
    const service = new MetricConfigurationService(policy, registry, createTrialStore(() => pool, registry), {
      resolve: async () => ({ resource: resource(), credential_ref: 'credential:disposable-reader', evidence: {}, resolve: async () => ({ method: 'sql', pool: { query: options => target.query(options) } }) }),
    });
    app = Fastify();
    const auth = async (request: any) => { request.user = request.headers.authorization === 'Bearer reader'
      ? { ...admin, permissions: ['instance:view'], instanceScopes: { 1: 'read-only' } } : admin; };
    await registerMetricPolicyRoutes(app, auth, policy); await registerMetricConfigurationRoutes(app, auth, service);
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    vite = await createServer({ configFile: false, root: fileURLToPath(new URL('../../../../../frontend', import.meta.url)), server: { host: '127.0.0.1', port: 0, proxy: { '/api': base } }, logLevel: 'error' });
    await vite.listen(); web = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
    browser = await chromium.launch({ headless: true });
    if (artifacts) await mkdir(artifacts, { recursive: true });
  }, 120000);
  afterAll(async () => {
    await browser?.close(); await vite?.close(); await app?.close(); await target?.end(); await pool?.end();
    if (root) {
      try {
        await root.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(database)}`);
        if (createdUser) await root.query('DROP USER ?', [user]);
      } finally { await root.end(); }
    }
    if (artifacts) await writeFile(`${artifacts}/mysql96-evidence.json`, JSON.stringify(evidence, null, 2));
  });
  it('first binding → mismatch → real trial → publish → refresh; no formal writes or automatic collection', async () => {
    const unbound = await fetch(`${base}/api/metrics/policy/resources/instance/1`);
    expect(unbound.status).toBe(404); expect(await unbound.json()).toEqual({ error: 'POLICY_NOT_FOUND' });
    const old = registry.list().find(r => r.package.id === 'mysql-basic' && r.package.version === '1.0.0')!.package;
    const pack = registry.list().find(r => r.package.id === 'mysql-basic' && r.package.version === '2.0.0')!.package;
    const candidate = (p: typeof pack) => ({ expected_revision: 0, package: { id: p.id, version: p.version, digest: p.digest } });
    const mismatch = await post('config/resources/instance/1/trial', candidate(old));
    expect(mismatch).toMatchObject({ status: 200, body: { decision: 'unsupported', attempts: [], samples: [] } });
    const preflight = await post('policy/resources/instance/1/preview', candidate(pack));
    expect(preflight.status).toBe(200); expect(preflight.body.resources[0].resolved.applicability.every((a: any) => a.status === 'supported')).toBe(true);
    const trial = await post('config/resources/instance/1/trial', candidate(pack));
    expect(trial).toMatchObject({ status: 200, body: { persisted: false, decision: 'attempted', lifecycle_evidence: 'unavailable', attempts: [{ status: 'succeeded' }], samples: [{ metric: { id: 'db.uptime_seconds' }, quality: { status: 'good' }, unit: 's' }] } });
    evidence.http = { mismatch, preflight, trial };
    for (const table of ['metric_policy_bindings', 'metric_observations', 'metric_attempts']) {
      const [rows] = await pool.query<any[]>(`SELECT COUNT(*) AS n FROM ${table}`); expect(Number(rows[0].n)).toBe(0);
    }
    const readOnly = await fetch(`${base}/api/metrics/config/resources/instance/1/trial`, { method: 'POST', headers: { Authorization: 'Bearer reader', 'Content-Type': 'application/json' }, body: JSON.stringify(candidate(pack)) });
    expect(readOnly.status).toBe(403);
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${web}/e2e/fixtures/metrics-config.html`);
      if (width === 1440) await browserExpect(page.getByText('首次绑定', { exact: false })).toBeVisible();
      await page.getByLabel('采集包 / 模板版本', { exact: true }).selectOption(old.digest);
      await page.getByRole('button', { name: '预检与影响预览', exact: true }).click();
      await browserExpect(page.getByText('版本不适用', { exact: false }).first()).toBeVisible();
      await page.getByRole('button', { name: '试采', exact: true }).click();
      await browserExpect(page.getByText('版本或资源不适用，不能发布。请选择支持当前版本的采集包。', { exact: true })).toBeVisible();
      await browserExpect(page.getByRole('button', { name: '发布', exact: true })).toBeDisabled();
      if (artifacts) await page.screenshot({ path: `${artifacts}/mysql96-unsupported-${width}.png`, fullPage: true });
      await page.getByLabel('采集包 / 模板版本', { exact: true }).selectOption(pack.digest);
      await browserExpect(page.getByText('Queries 累计计数及速率缺少可信生命周期证据', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: '预检与影响预览', exact: true }).click();
      await browserExpect(page.getByRole('button', { name: '试采', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '试采', exact: true }).click();
      await browserExpect(page.getByText('试采成功，可以发布', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '发布', exact: true }).click();
      const revision = width === 1440 ? 1 : 2;
      await browserExpect(page.getByText(`当前发布版本 ${revision}`, { exact: false })).toBeVisible();
      await page.reload();
      await browserExpect(page.getByText(`当前发布版本 ${revision}`, { exact: false })).toBeVisible();
      await browserExpect(page.getByLabel('采集包 / 模板版本', { exact: true })).toHaveValue(pack.digest);
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      expect(errors).toEqual([]);
      if (artifacts) await page.screenshot({ path: `${artifacts}/mysql96-${width}.png`, fullPage: true });
      await page.close();
    }
    const binding = await (await fetch(`${base}/api/metrics/policy/resources/instance/1`)).json() as any;
    const effective = await (await fetch(`${base}/api/metrics/policy/resources/instance/1/effective`)).json() as any;
    expect(binding.binding).toMatchObject({ package: candidate(pack).package, revision: 2 });
    expect(effective).toMatchObject({ published_revision: 2, application: { status: 'pending', applied_revision: null } });
    expect((await post('policy/resources/instance/1/publish', candidate(pack))).status).toBe(409);
    evidence.binding = binding; evidence.effective = effective;
    for (const table of ['metric_observations', 'metric_attempts', 'metric_schedule']) {
      const [rows] = await pool.query<any[]>(`SELECT COUNT(*) AS n FROM ${table}`); expect(Number(rows[0].n)).toBe(0);
    }
    evidence.formalObservations = 0; evidence.formalAttempts = 0; evidence.schedulerStarted = false;
  }, 60000);
});
