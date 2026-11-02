import { compileTriggerSnapshot } from '../../apps/db-ops-api/src/metrics/triggers/compile.ts';
import { evaluateTriggerRule } from '../../apps/db-ops-api/src/metrics/triggers/evaluate.ts';
import { nextTriggerEpisode } from '../../apps/db-ops-api/src/metrics/triggers/episode.ts';
import { alertEventService } from '../../apps/db-ops-api/src/alert-event-service.ts';
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

// MAX242-HISTORY-UI browser acceptance: real production server, real JWT/password login,
// an isolated task-owned MySQL schema on a non-3306 port, and a controlled formal history
// fixture. No MAX238 fixture and no product model invocation is used.
// This harness owns a disposable database and two server processes; it only runs when the
// task supplies its isolated MySQL port. Other suites skip it instead of starting it.
const enabled = Boolean(process.env.MAX242_TEST_MYSQL_PORT && process.env.MAX242_TEST_API_PORT);
test.describe.configure({ mode: 'serial', timeout: 120000 });
test.skip(!enabled, 'requires the task-owned MAX242 MySQL/API fixture');

const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const RESOURCE_ID = 8401;
const output = resolve(process.env.MAX242_BROWSER_OUTPUT ?? '/Users/max/Coding/40-Slide/outputs/max242-entry-20261101');
const schema = `max242_ui_${randomUUID().replaceAll('-', '')}`;
const password = ` ${randomUUID()} `;
let adminPool: any, pool: any, backend: ChildProcess, vite: Awaited<ReturnType<typeof createServer>>;
let origin: string, workspace: string, backendLog = '', modelCalls = 0;
let modelGuard: ReturnType<typeof createHttpServer>;
let from = 0, to = 0, eventId = 0;
const iso = (ms: number) => new Date(ms).toISOString();
const sqlTime = (value: string) => new Date(value).toISOString().slice(0, 23).replace('T', ' ');
const fixture = sample('db.uptime_seconds');
const point = (ms: number, value: number, tag: string) => identify({ ...fixture, resource_id: String(RESOURCE_ID),
  observed_at: iso(ms), collected_at: iso(ms), stored_at: iso(ms), value: { encoding: 'float64', value },
  source: { ...fixture.source, attempt_id: `max242-ui-${tag}` } });
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
  const port = Number(process.env.MAX242_TEST_MYSQL_PORT);
  if (!port || port === 3306) throw new Error('MAX242_TEST_MYSQL_PORT must point to a task-owned isolated MySQL fixture');
  await mkdir(output, { recursive: true });
  workspace = await mkdtemp(`${tmpdir()}/slide-max242-`);
  const options = { host: '127.0.0.1', port, user: 'root', password: process.env.MAX242_TEST_MYSQL_PASSWORD ?? '' };
  adminPool = mysql.createPool(options); await adminPool.query(`CREATE DATABASE ${schema}`);
  pool = mysql.createPool({ ...options, database: schema });
  await new MigrationRunner(pool).run();
  const hash = await bcrypt.hash(password, 10);
  await pool.execute("INSERT INTO users (id,username,password_hash) VALUES (8401,'max242-owner',?)", [hash]);
  await pool.query("INSERT INTO roles (id,name) VALUES (8401,'max242-admin')");
  await pool.query("INSERT IGNORE INTO permissions (code,name,resource,action) VALUES ('*','Fixture admin','admin','all')");
  await pool.query('INSERT INTO role_permissions (role_id,permission_id) SELECT 8401,id FROM permissions');
  await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (8401,8401)');
  await pool.execute(`INSERT INTO database_instances (id,name,environment,db_type,host,port,username,password_encrypted,db_version,status)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [RESOURCE_ID, 'MAX242 历史验收实例', 'testing', 'mysql', 'history.fixture.invalid', 3306, 'fixture', 'unused', '9.6.0', 'active']);

  await pool.execute("INSERT INTO users(id,username,password_hash) VALUES(8402,'max242-other',?)", [hash]);
  await pool.query("INSERT INTO roles(id,name) VALUES(8402,'max242-bounded-reader')");
  await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 8402,id FROM permissions WHERE code IN ('chat:view','instance:view','metric:view','alert:view')");
  await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(8402,8402)');
  await pool.execute(`INSERT INTO database_instances(id,name,host,port,username,password_encrypted) VALUES(?, 'Other authorized resource','other.fixture.invalid',3306,'fixture','unused')`, [RESOURCE_ID + 1]);
  await pool.execute("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(8402,?,'read-only')", [RESOURCE_ID + 1]);

  // Model traffic is forbidden: a local guard answers every provider call with 503.
  modelGuard = createHttpServer((_request, response) => { modelCalls++; response.writeHead(503); response.end('MODEL_CALL_FORBIDDEN'); });
  await new Promise<void>(done => modelGuard.listen(0, '127.0.0.1', done));
  await pool.query('UPDATE llm_providers SET enabled=0,is_default=0');
  await pool.execute("UPDATE llm_providers SET enabled=1,is_default=1,api_base_url=?,deployment_type='local',api_format=NULL WHERE name='ollama'",
    [`http://127.0.0.1:${(modelGuard.address() as { port: number }).port}`]);
  await pool.query('UPDATE llm_providers SET enabled=0,is_default=0');

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

  // Controlled read-side fixture uses the real snapshot compiler and existing event
  // writer. It does not claim a remote collection/production binding acceptance.
  const snapshotIdentity = `sha256:${'a'.repeat(64)}`;
  const expression = (value: number, operator: string) => ({ node: 'compare', select: { aggregation: 'last' }, operator,
    threshold: { kind: 'constant', value } });
  const snapshot = compileTriggerSnapshot({ kind: 'trigger_candidate', internal: true, persisted: false, applied: false,
    effective: false, status: 'candidate', resource: { type: 'instance', id: String(RESOURCE_ID) }, config_revision: 1,
    plan_identity: snapshotIdentity, templates: [{ template_id: 'max242-fixture', version: 1, content_hash: snapshotIdentity }],
    rules: [{ rule_id: 'max242-uptime', version: 1, body_hash: snapshotIdentity, scope: 'item:uptime',
      item: { template_id: 'max242-fixture', item_id: 'uptime', item_version: 1 },
      metric: series.metric, unit: 's', dimensions: {}, decision: 'collect', parameters: [],
      problem: expression(90, '>'), recovery: expression(70, '<'),
      quality: { accepted_quality: ['good'], min_coverage: 1, allow_estimated: false },
      clock: { stale_after_ms: 180000, nodata: { enabled: false } } }],
  });
  await pool.execute('INSERT INTO metric_trigger_snapshots(resource_key,config_revision,snapshot_hash,payload) VALUES(?,1,?,?)',
    [`instance:${RESOURCE_ID}`, snapshot.snapshot_hash, JSON.stringify(snapshot)]);
  const peak = rows.find(o => o.value && 'value' in o.value && o.value.value === 999999)!;
  const triggerSample = { metric: peak.metric, unit: peak.unit, value: peak.value!, observed_at: peak.observed_at,
    dimensions: {}, quality: peak.quality, accuracy: peak.accuracy, coverage: 1, window: null };
  const rule = snapshot.rules[0];
  const evaluation = evaluateTriggerRule(snapshot, { rule_id: rule.rule_id, scope: rule.scope }, {
    input: { now: peak.observed_at, last_seen_at: peak.observed_at, previous: null, samples: [triggerSample] },
    applied: { resource: { type: 'instance', id: RESOURCE_ID }, applied_revision: 1, plan_identity: snapshotIdentity, application_status: 'applied' },
  });
  const episode = nextTriggerEpisode({ identity: { resource: snapshot.resource, rule_id: rule.rule_id, version: rule.version,
    body_hash: rule.body_hash, scope: rule.scope }, previous: null, evaluation })!;
  await pool.query('UPDATE notification_channels SET enabled=0');
  const c = await pool.getConnection();
  try { await c.beginTransaction(); await alertEventService.persistTemplateTransition(c, null, episode, snapshot,
    { sample_ids: [peak.id], attempt_ids: [peak.source.attempt_id], unit: peak.unit, dimensions: {}, samples: [{ ...triggerSample, id: peak.id }] });
    await c.commit(); } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
  eventId = Number((await pool.query('SELECT event_id FROM metric_trigger_episodes WHERE episode_id=?', [episode.episode_id]))[0][0].event_id);

  // MAX242-LATEST-DATA: the current collection is failed while an older formal success and
  // its history stay readable. The status route derives state/blockers from these attempts.
  const attempt = (id: string, status: string, startedMs: number, endedMs: number, error: string | null, evidence?: string) => ({
    id, resource_id: String(RESOURCE_ID), binding_id: `instance:${RESOURCE_ID}`, collector_id: 'mysql.status',
    config_revision: 1, started_at: iso(startedMs), ended_at: iso(endedMs), status, error,
    ...(evidence ? { evidence_code: evidence } : {}), observation_ids: [] });
  const succeededAttempt = attempt('max242-attempt-success', 'succeeded', to - 2 * HOUR, to - 2 * HOUR + MINUTE, null);
  const failedAttempt = attempt('max242-attempt-failed', 'failed', to - 10 * MINUTE, to - 9 * MINUTE, 'connection_error', 'CONNECTION_REFUSED');
  for (const row of [succeededAttempt, failedAttempt]) {
    await pool.execute('INSERT INTO metric_attempts (id, payload, stored_at) VALUES (?,?,?)', [row.id, JSON.stringify(row), sqlTime(row.ended_at)]);
  }

  const apiPort = Number(process.env.MAX242_TEST_API_PORT);
  const wsPort = Number(process.env.MAX242_TEST_WS_PORT);
  backend = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: resolve('../apps/db-ops-api'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', DB_HOST: options.host, DB_PORT: String(port), DB_USER: options.user,
      DB_PASSWORD: options.password, DB_NAME: schema, PORT: String(apiPort),
      AGENT_WS_HOST: '127.0.0.1', AGENT_WS_PORT: String(wsPort), AGENT_WORKSPACE: workspace,
      JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      // Collection must be enabled for the status route to report the seeded failed attempt,
      // not "disabled". The fixture never runs a collector process.
      METRICS_COLLECTION_ENABLED: 'false',
      INVESTIGATION_OPS_AUTO_ENABLED: 'false', INVESTIGATION_SYSTEM_AUTO_ENABLED: 'false', INVESTIGATION_SYSTEM_EVENTS_ENABLED: 'false',
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

let ownerStorage: Array<{ name: string; value: string }> | undefined;
async function login(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('app-theme-mode', 'light');
    const key = 'slide.control.settings.v1:default';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ locale: 'zh-CN', themeMode: 'light' }));
  });
  if (ownerStorage) await page.addInitScript(values => { for (const { name, value } of values) localStorage.setItem(name, value); }, ownerStorage);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/servers`);
  if (ownerStorage) { await expect(page.locator('.login-gate')).toHaveCount(0); return; }
  await page.getByLabel('用户名', { exact: true }).fill('max242-owner');
  await page.getByLabel('密码', { exact: true }).fill(password);
  const authenticated = page.waitForResponse(r => r.url().endsWith('/api/auth/login'));
  await page.getByRole('button', { name: '登录', exact: true }).click();
  expect((await authenticated).status()).toBe(200);
  await expect(page.locator('.login-gate')).toHaveCount(0);
  // Keep only this run's signed session in memory. Every subsequent request still
  // performs real live JWT validation; do not weaken the production login limiter.
  ownerStorage = await page.evaluate(() => Object.keys(localStorage).map(name => ({ name, value: localStorage.getItem(name)! })));
}

const entryContext = (extra = {}) => ({ schemaVersion: 1, resourceRefs: [{ type: 'instance', id: RESOURCE_ID, role: 'primary' }],
  from: iso(from), to: iso(to), metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, dimensions: {},
  sourceEventIds: [eventId], returnTo: `/instance-detail?id=${RESOURCE_ID}&tab=metrics`, ...extra });
const entryUrl = (context = entryContext()) => `${origin}/investigations?entry=${encodeURIComponent(JSON.stringify(context))}`;
async function request(page: Page, path: string, body?: any, key?: string) {
  return page.evaluate(async ({ path, body, key }) => {
    const r = await fetch(path, { method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() };
  }, { path, body, key });
}
const counts = async () => {
  const result: Record<string, number> = {};
  for (const table of ['investigations','chat_sessions','investigation_requests','agent_runs','workflow_jobs'])
    result[table] = Number((await pool.query(`SELECT COUNT(*) n FROM ${table}${table === 'workflow_jobs' ? " WHERE job_type='investigation.execute'" : ''}`))[0][0].n);
  return result;
};
test('real JWT/API/DB browser: exact event/history context, zero-model draft and refresh recovery at desktop sizes', async ({ page }) => {
  await login(page);
  const before = await counts();
  await page.goto(entryUrl());
  const entry = page.locator('investigation-entry');
  await expect(entry.getByText('db.uptime_seconds · 1.0.0', { exact: false })).toBeVisible();
  await expect(entry.getByText('审批、执行与恢复验证尚未开始。', { exact: false })).toBeVisible();
  await expect(entry.getByText(`正式观测共`, { exact: false })).toBeVisible();
  expect(await counts()).toEqual(before);
  const preview = await request(page, '/api/investigations/entry-facts', entryContext());
  expect(preview.status).toBe(200); expect(preview.cache).toContain('no-store');
  expect(preview.body.context).toEqual(entryContext()); expect(preview.body.modelInvoked).toBe(false);
  expect(preview.body.facts[0].observations.length).toBe(200); expect(preview.body.facts[0].has_more).toBe(true);
  expect(preview.body.facts[0].observations[0].sources[0].versions).toBeTruthy();
  for (const size of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size);
    const save = entry.getByRole('button', { name: '保存调查草案', exact: true });
    await save.focus(); await expect(save).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await entry.evaluate(el => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `${output}/entry-${size.width}.png`, fullPage: true });
  }
  const save = entry.getByRole('button', { name: '保存调查草案', exact: true });
  await save.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/investigation=[a-f0-9-]+/);
  const id = new URL(page.url()).searchParams.get('investigation')!;
  await expect(page.locator('investigation-entry').getByRole('link', { name: '返回来源' })).toHaveAttribute('href', entryContext().returnTo);
  const persisted = await counts(); expect(persisted.investigations).toBe(before.investigations + 1);
  for (const t of ['investigation_requests','agent_runs','workflow_jobs']) expect(persisted[t]).toBe(before[t]);
  const [rows] = await pool.query('SELECT command_snapshot FROM investigation_create_keys WHERE investigation_id=?', [id]);
  const snapshot = typeof rows[0].command_snapshot === 'string' ? JSON.parse(rows[0].command_snapshot) : rows[0].command_snapshot;
  expect(snapshot.context.entry).toEqual(entryContext());
  await page.reload(); await expect(page.locator('investigation-entry table')).toBeVisible();
  expect(await counts()).toEqual(persisted);
  // Back to the original link and save again: persisted session key recovers original.
  await page.goto(entryUrl()); await page.locator('investigation-entry').getByRole('button', { name: '保存调查草案', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`investigation=${id}`)); expect(await counts()).toEqual(persisted);
  await writeFile(`${output}/real-flow.json`, JSON.stringify({ context: entryContext(), before, after: persisted,
    source: 'controlled formal observations + production JWT/API/MySQL + browser', modelCalls, testedSource: process.env.MAX242_SOURCE_SHA }, null, 2));
});

test('R1 real parent rerender and fact refresh preserve a committed save, context and exact return', async ({ page }) => {
  await login(page);
  const context = entryContext({ returnTo: `/instance-detail?id=${RESOURCE_ID}&tab=parent-race` });
  await page.goto(entryUrl(context)); const entry = page.locator('investigation-entry');
  await expect(entry.locator('table')).toBeVisible();
  let reached!: () => void, release!: () => void;
  const committed = new Promise<void>(r => reached = r), gate = new Promise<void>(r => release = r);
  await page.route('**/api/investigations/drafts', async route => {
    const response = await route.fetch(); reached(); await gate; await route.fulfill({ response });
  });
  const before = await counts();
  await entry.getByRole('button', { name: '保存调查草案', exact: true }).click();
  await committed;
  try {
    // Use the actual list read/filter path; it re-renders the real parent with a new equal parsed context.
    const listed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/investigations' && r.request().method() === 'GET');
    await page.locator('form[aria-label="调查筛选"]').getByRole('button', { name: '筛选', exact: true }).click();
    await listed;
    // Also overlap an explicit fact reread with this save; only reads may supersede reads.
    await entry.evaluate(async (element: any) => { await element.load(); });
  } finally { release(); }
  await expect(page).toHaveURL(/investigation=[a-f0-9-]+/, { timeout: 10000 });
  await expect(page.locator('investigation-entry').getByRole('link', { name: '返回来源' })).toHaveAttribute('href', context.returnTo);
  await expect(page.getByText('正在保存…', { exact: true })).toHaveCount(0);
  const after = await counts(); expect(after.investigations).toBe(before.investigations + 1);
  expect(after.chat_sessions).toBe(before.chat_sessions + 1);
  for (const key of ['investigation_requests','agent_runs','workflow_jobs']) expect(after[key]).toBe(before[key]);
  await page.reload(); await expect(page.locator('investigation-entry table')).toBeVisible();
  expect(await counts()).toEqual(after);
  await page.locator('investigation-entry').getByRole('link', { name: '返回来源' }).click();
  await expect(page).toHaveURL(origin + context.returnTo);
  await writeFile(`${output}/parent-save-race.json`, JSON.stringify({ testedSource: process.env.MAX242_SOURCE_SHA,
    before, after, parentFilterRerender: true, factRereadWhileSaving: true, exactReturn: context.returnTo, modelCalls }, null, 2));
});

test('invalid resources/windows/metric identity and event mismatch are rejected without creating', async ({ page }) => {
  await login(page); const before = await counts();
  const invalids = [
    { from: iso(to) }, { from: iso(from - 40 * DAY) }, { from: '2026-02-30T00:00:00.000Z' },
    { returnTo: '//evil.invalid' }, { resourceRefs: [{ type: 'instance', id: RESOURCE_ID + 1, role: 'primary' }] },
    { metric: { id: 'db.uptime_seconds', semantic_version: '99.0.0' } }, { dimensions: { unexpected: 'outside' } },
    { sourceEventIds: [999999] }, { actor: { userId: 1 } },
  ];
  const statuses = [];
  for (const patch of invalids) {
    const result = await request(page, '/api/investigations/drafts', entryContext(patch), randomUUID());
    expect([400, 403, 404]).toContain(result.status); statuses.push(result.status);
  }
  const denied = await page.request.post(`${origin}/api/investigations/entry-facts`, { data: entryContext() });
  expect(denied.status()).toBe(401); expect(await counts()).toEqual(before);
  // Resource-only entry retains its exact window, without metric/version selection.
  await page.goto(entryUrl(entryContext({ metric: undefined, dimensions: undefined, sourceEventIds: [] })));
  await expect(page.locator('investigation-entry table')).toBeVisible(); expect(await counts()).toEqual(before);
  // A valid empty historical window stays empty; it does not fall back to latest data.
  await page.goto(entryUrl(entryContext({ from: iso(to - 2 * DAY), to: iso(to - DAY), sourceEventIds: [] })));
  await expect(page.locator('investigation-entry').getByText('窗口内暂无正式观测', { exact: true })).toBeVisible();
  expect(await counts()).toEqual(before);
  await writeFile(`${output}/negative-flow.json`, JSON.stringify({ statuses, unauthorized: denied.status(), unchanged: before, modelCalls }, null, 2));
});

test('concurrent idempotency and cross-principal/event scope remain fenced over real JWT and SQL', async ({ page }) => {
  await login(page); const key = randomUUID();
  const [one, two] = await Promise.all([
    request(page, '/api/investigations/drafts', entryContext(), key),
    request(page, '/api/investigations/drafts', entryContext(), key),
  ]);
  expect(one.status).toBe(200); expect(two.status).toBe(200); expect(one.body.id).toBe(two.body.id);
  expect((await request(page, '/api/investigations/drafts', entryContext({ returnTo: '/instances-db' }), key)).status).toBe(409);
  const mismatch = await request(page, '/api/investigations/drafts', entryContext({
    resourceRefs: [{ type: 'instance', id: RESOURCE_ID + 1, role: 'primary' }], metric: undefined, dimensions: undefined,
  }), randomUUID());
  expect(mismatch.status).toBe(400);
  const other = await page.request.post(`${origin}/api/auth/login`, { data: { username: 'max242-other', password } });
  expect(other.status()).toBe(200); const token = (await other.json()).token;
  const before = await counts();
  const denied = await page.request.post(`${origin}/api/investigations/drafts`, {
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() }, data: entryContext(),
  });
  expect(denied.status()).toBe(404);
  expect((await page.request.get(`${origin}/api/investigations/${one.body.id}/context-facts`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(404);
  expect(await counts()).toEqual(before);
  await writeFile(`${output}/scope-idempotency.json`, JSON.stringify({ concurrentSameId: true, payloadMismatch: 409,
    mismatchedEventResource: mismatch.status, crossPrincipal: denied.status(), unchanged: before, modelCalls }, null, 2));
});

test('unknown commit recovers the same draft, server revocation clears facts and blocks retries', async ({ page }) => {
  await login(page); const context = entryContext({ returnTo: `/instance-detail?id=${RESOURCE_ID}&tab=unknown` });
  await page.goto(entryUrl(context)); await expect(page.locator('investigation-entry table')).toBeVisible();
  let dropped = false;
  await page.route('**/api/investigations/drafts', async route => {
    if (!dropped) { dropped = true; await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  const before = await counts();
  await page.locator('investigation-entry').getByRole('button', { name: '保存调查草案', exact: true }).click();
  await expect(page.locator('investigation-entry').getByRole('button', { name: '核对原保存请求', exact: true })).toBeEnabled();
  const unknown = await counts(); expect(unknown.investigations).toBe(before.investigations + 1);
  // Reload before recovery keeps the previously stored key.
  await page.reload(); await expect(page.locator('investigation-entry table')).toBeVisible();
  await page.locator('investigation-entry').getByRole('button', { name: '保存调查草案', exact: true }).click();
  await expect(page).toHaveURL(/investigation=/); expect(await counts()).toEqual(unknown);
  const id = new URL(page.url()).searchParams.get('investigation')!;
  // Remove resource visibility without changing the JWT; API must reload live grants.
  await pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=8401 AND p.code IN ('instance:view','instance:*','*')");
  // The existing workspace subscription may clear the whole view before a retry button remains.
  await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('investigation-entry button')].find(b => b.textContent?.trim() === '重试读取')?.click());
  await expect(page.locator('investigation-entry table')).toHaveCount(0);
  await expect(page.locator('investigation-entry').getByRole('link', { name: '返回来源' })).toHaveCount(0);
  expect((await request(page, `/api/investigations/${id}/context-facts`)).status).toBe(404);
  expect((await request(page, '/api/investigations/drafts', context, randomUUID())).status).toBe(404);
  expect(await counts()).toEqual(unknown);
  await page.screenshot({ path: `${output}/revoked-1440.png`, fullPage: true });
  await writeFile(`${output}/revocation.json`, JSON.stringify({ unknown, recovered: unknown, revoked: true, modelCalls }, null, 2));
});
