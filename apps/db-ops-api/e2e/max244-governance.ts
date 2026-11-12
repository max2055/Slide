/** Isolated real Lit -> JWT -> Fastify -> MySQL; controlled read-only SQL transport, local owned worker only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import { dbConnection } from '../src/db-connection.js';
import { MigrationRunner } from '../src/migrations/runner.js';
import { createOwnedDatabase } from '../src/testing/owned-fixture.js';
import { actorContextService, signAccessToken } from '../src/auth/actor-context.js';
import { createVerifyToken } from '../src/auth-middleware.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { configurationInventory } from '../src/metrics/config/inventory.js';
import { MySqlTemplateRepository } from '../src/metrics/templates/mysql-repository.js';
import { MetricTemplateService } from '../src/metrics/templates/service.js';
import { TemplateBindingService } from '../src/metrics/templates/binding-service.js';
import { TemplateGovernanceSchemas } from '../src/contracts/metrics/template-governance.js';
import { TemplateGovernance } from '../src/metrics/templates/governance.js';
import { registerTemplateAuthoringRoutes } from '../src/metrics/templates/authoring-routes.js';
import { registerTemplateGovernanceRoutes } from '../src/metrics/templates/governance-routes.js';
import { registerMetricTemplateRoutes } from '../src/metrics/templates/routes.js';
import {
  CollectNowService,
  createCollectNowAuthorizer,
} from '../src/metrics/templates/collect-now.js';
import { MysqlScheduleStore } from '../src/metrics/scheduler/store.js';
import { MetricScheduler } from '../src/metrics/scheduler/service.js';
import { JobRegistry } from '../src/workflows/job-registry.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../src/workflows/worker-runtime.js';
const nonce = randomBytes(8).toString('hex'),
  directory = resolve('/Users/max/Coding/40-Slide/outputs/max244-governance-' + nonce);
mkdirSync(directory, { recursive: true });
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const handle = {
  nonce,
  pid: process.pid,
  cwd: process.cwd(),
  container: '',
  schema: '',
  port: 0,
  api: '',
  frontend: '',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
};
const save = () =>
  writeFileSync(resolve(directory, 'lifecycle.json'), JSON.stringify(handle, null, 2));
save();
let root: mysql.Pool | undefined,
  owned: Awaited<ReturnType<typeof createOwnedDatabase>> | undefined,
  vite: any,
  browser: any;
const app = Fastify();
let pool: mysql.Pool;
let failures = 0;
try {
  handle.container = docker(
    'run',
    '-d',
    '--rm',
    '--label',
    `slide.max244.nonce=${nonce}`,
    '-e',
    'MYSQL_ALLOW_EMPTY_PASSWORD=yes',
    '-p',
    '127.0.0.1::3306',
    'mysql:8.4',
  );
  save();
  handle.port = Number(docker('port', handle.container, '3306/tcp').split(':').at(-1));
  assert(handle.port !== 3306 && handle.port > 0);
  save();
  root = mysql.createPool({ host: '127.0.0.1', port: handle.port, user: 'root', password: '' });
  const deadline = Date.now() + 45000;
  for (;;) {
    try {
      await root.query('SELECT 1');
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  owned = await createOwnedDatabase(root as any, {
    nonce,
    purpose: 'governance',
    handleDir: directory,
  });
  handle.schema = owned.database;
  save();
  assert(
    await dbConnection.initialize({
      host: '127.0.0.1',
      port: handle.port,
      user: 'root',
      password: '',
      database: owned.database,
    }),
  );
  pool = dbConnection.getPool()!;
  await new MigrationRunner(pool as any).run();
  await pool.query(
    "INSERT INTO users(id,username,password_hash) VALUES(701,'governor','no-login'),(702,'other-governor','no-login')",
  );
  await pool.query("INSERT INTO roles(id,name) VALUES(701,'governance-fixture')");
  await pool.query(
    "INSERT IGNORE INTO permissions(code,name,resource,action) VALUES('metric:view','读取指标','metric','view'),('metric:manage','配置指标','metric','manage'),('instance:manage','管理实例','instance','manage')",
  );
  await pool.query(
    "INSERT INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code IN ('metric:view','metric:manage','instance:manage')",
  );
  await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(701,701),(702,701)');
  await pool.query(
    "INSERT INTO database_instances(id,name,environment,db_type,db_version,host,port,database_name,username,password_encrypted,status,lifecycle_state) VALUES(701,'灰度 A','testing','mysql','9.6','fixture.invalid',1,'gov-701','fixture','','active','available'),(702,'灰度 B','testing','mysql','9.6','fixture.invalid',1,'gov-702','fixture','','active','available'),(703,'无权 C','testing','mysql','9.6','fixture.invalid',1,'gov-703','fixture','','active','available')",
  );
  await pool.query(
    "INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(701,701,'read-write'),(701,702,'read-write')",
  );
  const actor = (await actorContextService.loadActiveActor(701))!,
    other = (await actorContextService.loadActiveActor(702))!;
  const secret = randomBytes(32).toString('hex'),
    token = signAccessToken(actor, secret),
    otherToken = signAccessToken(other, secret),
    verify = createVerifyToken(secret);
  const registry = createConfigurationRegistry(),
    inventory = configurationInventory;
  const fail = new Set<number>();
  let reads = 0;
  const access = {
    resolve: async (ref: any) => ({
      resource: await inventory(ref),
      credential_ref: 'credential:fixture',
      evidence: {},
      resolve: async () => ({
        method: 'sql',
        pool: {
          query: async () => {
            reads++;
            if (fail.has(ref.id)) throw Error('controlled transport unavailable');
            return [
              [
                { Variable_name: 'Uptime', Value: '95' },
                { Variable_name: 'Queries', Value: '100' },
              ],
              [],
            ];
          },
        },
      }),
    }),
  };
  const reload = (a: typeof actor) => actorContextService.revalidateActor(a);
  const reloadOn = (a: typeof actor, c: any) =>
    actorContextService.revalidateActorOn(c, a, a.requestId, true);
  const binding = new TemplateBindingService({
    pool: () => pool,
    registry,
    access: access as any,
    inventory,
    reload,
    reloadOn,
    reloadOnLocked: reloadOn,
  });
  const governance = new TemplateGovernance(() => pool, binding),
    repository = new MySqlTemplateRepository(pool),
    templates = new MetricTemplateService(repository, registry);
  const collect = new CollectNowService({ pool: () => pool, registry, reload, reloadOn });
  await registerTemplateAuthoringRoutes(app, verify, () => pool);
  await registerMetricTemplateRoutes(app, verify, binding, collect);
  await registerTemplateGovernanceRoutes(app, verify, () => pool, governance);
  const trace: any[] = [];
  setInterval(
    () => writeFileSync(resolve(directory, 'trace.json'), JSON.stringify(trace, null, 2)),
    1000,
  ).unref();
  const api = async (method: string, url: string, payload?: any, t = token) => {
    const r = await app.inject({
      method: method as any,
      url,
      headers: { authorization: `Bearer ${t}` },
      payload,
    });
    const body = r.json();
    trace.push({ method, url, status: r.statusCode, body });
    if (r.statusCode === 200) {
      if (method === 'GET' && /\/batches\/[^/]+$/.test(url))
        TemplateGovernanceSchemas.TemplateRolloutBatch.parse(body);
      if (url.endsWith('/preview')) TemplateGovernanceSchemas.TemplateRolloutPreview.parse(body);
      if (url.endsWith('/inheritance')) TemplateGovernanceSchemas.TemplateInheritance.parse(body);
      if (url.includes('/diff?')) TemplateGovernanceSchemas.TemplateVersionDifference.parse(body);
    }
    return { status: r.statusCode, body };
  };
  const post = async (url: string, payload: any) => {
    const r = await api('POST', url, payload);
    assert.equal(r.status, 200, JSON.stringify(r));
    return r.body;
  };
  const ref = (id: number) => ({ type: 'instance' as const, id });
  const parent = await templates.create(actor, { name: '基础模板' }),
    child = await templates.create(actor, { name: '继承模板' });
  const pkg = registry
    .list()
    .map((v) => v.package)
    .find((v) => v.id === 'mysql-basic' && v.version === '2.0.0')!;
  const selected = await templates.selectMetric(actor, parent.template_id, {
    item_id: 'uptime',
    package: { id: pkg.id, version: pkg.version, digest: pkg.digest },
    metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' },
  });
  const parentDraft = (await repository.getDraft(parent.template_id))!;
  await templates.updateDraft(actor, parent.template_id, {
    expected_draft_revision: parentDraft.revision,
    aggregate: {
      ...parentDraft.aggregate,
      items: [{ item_id: selected.item.item_id, version: selected.item.version }],
      parameters: {
        schema: { interval_ms: { type: 'integer', min: 1000, max: 86400000 } },
        defaults: { interval_ms: 60000 },
      },
    },
  });
  await templates.publish(actor, parent.template_id, {
    expected_draft_revision: (await repository.getDraft(parent.template_id))!.revision,
    expected_revision: 0,
  });
  const cd = (await repository.getDraft(child.template_id))!;
  await post(`/api/metrics/templates/${child.template_id}/draft`, {
    operation_key: randomUUID(),
    expected_draft_revision: cd.revision,
    aggregate: { ...cd.aggregate, base: { template_id: parent.template_id, version: 1 } },
  });
  const publish = async () => {
    const e = (await api('GET', `/api/metrics/templates/${child.template_id}/editor`)).body;
    return post(`/api/metrics/templates/${child.template_id}/publish`, {
      operation_key: randomUUID(),
      expected_revision: e.template.revision,
      expected_draft_revision: e.draft.revision,
    });
  };
  await publish();
  const pin = async (version: number) => {
    const v = (await repository.getVersion(child.template_id, version))!;
    return { template_id: child.template_id, version, content_hash: v.content_hash };
  };
  // Initial application goes through the SAME governance/binding services; actual applied proof comes from collection.
  const batch = async (version: number, ids: number[]) =>
    post('/api/metrics/template-governance/batches', {
      operation_key: randomUUID(),
      pins: [await pin(version)],
      resources: await Promise.all(
        ids.map(async (id) => ({
          resource: ref(id),
          expected_revision: (await binding.status(actor, ref(id))).revision ?? 0,
        })),
      ),
    });
  const step = (id: string, rid: number, action = 'apply', operation_key = randomUUID()) =>
    post(`/api/metrics/template-governance/batches/${id}/instance/${rid}`, {
      action,
      operation_key,
    });
  const jobs = new JobRegistry();
  new MetricScheduler(
    new MysqlScheduleStore(pool, registry, 'production'),
    registry,
    access as any,
    Date.now,
    undefined,
    undefined,
    createCollectNowAuthorizer({
      loadActor: (id, v) => actorContextService.loadActiveActor(id, v),
      loadActorOn: (c, id, v) =>
        actorContextService.loadActiveActorOn(c as any, id, v, undefined, true),
    }),
  ).register(jobs);
  const worker = new WorkerRuntime(
    new MysqlWorkflowStore(() => pool as any),
    'max244-owned-' + nonce,
    30,
  );
  const formal = async (id: number, key: string, revision: number, expected = 'completed') => {
    await collect.collect(actor, ref(id), { caller_key: key, expected_revision: revision });
    let result: any;
    for (let n = 0; n < 30; n++) {
      await worker.runOnce((j, c) => jobs.execute(j, c), Date.now());
      result = await collect.task(actor, ref(id), key);
      if (['completed', 'failed'].includes(result.state)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(result.state, expected, JSON.stringify(result));
    trace.push({ formal: id, key, result });
  };
  const initial = await batch(1, [701, 702]);
  await step(initial.id, 701);
  await step(initial.id, 702);
  await formal(701, 'initial-a', 1);
  await formal(702, 'initial-b', 1);
  assert.equal((await binding.status(actor, ref(701))).effective?.revision, 1);
  const parentVersion = (await repository.getVersion(parent.template_id, 1))!;
  const conflict = await post('/api/metrics/template-governance/preview', {
    operation_key: randomUUID(),
    pins: [
      { template_id: parent.template_id, version: 1, content_hash: parentVersion.content_hash },
    ],
    resources: [{ resource: ref(701), expected_revision: 1 }],
  });
  assert.equal(conflict.resources[0].error, 'PREFLIGHT_CANONICAL_CONFLICT');
  assert(conflict.resources[0].conflicts.length > 0);
  assert.equal((await binding.status(actor, ref(701))).revision, 1);
  const forbiddenUnbind = await api(
    'POST',
    `/api/metrics/template-governance/batches/${initial.id}/instance/701`,
    { action: 'rollback', operation_key: randomUUID() },
  );
  assert.equal(forbiddenUnbind.status, 422);
  // Browser publishes a changed inherited default. No current binding or effective revision changes.
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  handle.api = address;
  save();
  const { createServer } = await import('../../../frontend/node_modules/vite/dist/node/index.js');
  vite = await createServer({
    configFile: false,
    root: resolve('../../frontend'),
    server: { host: '127.0.0.1', port: 0, proxy: { '/api': address } },
  });
  await vite.listen();
  handle.frontend = `http://127.0.0.1:${vite.httpServer.address().port}`;
  save();
  const req = createRequire(resolve('../../frontend/package.json'));
  const { chromium } = req('@playwright/test');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  await page.addInitScript((t) => localStorage.setItem('token', t), token);
  await page.goto(
    `http://127.0.0.1:${vite.httpServer.address().port}/e2e/fixtures/max244-governance.html`,
  );
  await page.getByLabel('治理模板', { exact: true }).selectOption(child.template_id);
  await page.getByRole('button', { name: '读取模板', exact: true }).click();
  await page
    .getByLabel('固定基础版本', { exact: true })
    .selectOption(JSON.stringify({ template_id: parent.template_id, version: 1 }));
  await page.getByRole('button', { name: '保存基础版本', exact: true }).click();
  await page.getByRole('button', { name: '恢复基础项和参数', exact: true }).click();
  await page.getByLabel('参数值', { exact: true }).fill('120000');
  await page.getByRole('button', { name: '保存参数覆盖', exact: true }).click();
  await page.getByText('模板操作已保存；发布不会自动升级资源。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '发布治理版本', exact: true }).click();
  await page.getByLabel('灰度目标版本', { exact: true }).selectOption('2');
  assert.equal((await binding.status(actor, ref(701))).revision, 1);
  assert.equal((await binding.status(actor, ref(701))).effective?.revision, 1);
  assert.equal(
    (await repository.getVersion(child.template_id, 1))!.aggregate.parameters.defaults.interval_ms,
    60000,
  );
  await page.getByRole('button', { name: '比较版本与影响', exact: true }).click();
  await page.getByText('不可变差异与授权影响资源', { exact: true }).waitFor();
  const diff = (
    await api(
      'GET',
      `/api/metrics/template-governance/templates/${child.template_id}/diff?from=1&to=2`,
    )
  ).body;
  assert.equal(diff.affected.length, 2);
  assert.equal(diff.parameters.after.defaults.interval_ms, 120000);
  await page.getByLabel('灰度 灰度 A', { exact: true }).check();
  await page.getByLabel('灰度 灰度 B', { exact: true }).check();
  // Cancel confirmation is a pure local noop.
  const count = async (table: string) =>
    Number((await pool.query<any[]>(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n);
  const beforeCancel = await count('metric_template_rollouts');
  await page.getByRole('button', { name: '检查灰度影响', exact: true }).click();
  await page.getByRole('button', { name: '返回选择', exact: true }).click();
  assert.equal(await count('metric_template_rollouts'), beforeCancel);
  await page.getByRole('button', { name: '检查灰度影响', exact: true }).click();
  await page.getByRole('button', { name: '确认创建灰度批次', exact: true }).click();
  await page.getByRole('button', { name: '批量应用待处理资源', exact: true }).waitFor();
  const saved = await page.evaluate(() =>
    sessionStorage.getItem(Object.keys(sessionStorage).find((k) => k.endsWith('.batch'))!),
  );
  assert(saved);
  fail.add(702);
  // Abort committed A response: UI retains exact action key and recovers without duplicate revision/audit.
  let lost = false;
  await page.route('**/api/metrics/template-governance/batches/*/instance/701', async (route) => {
    if (!lost) {
      lost = true;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: '批量应用待处理资源', exact: true }).click();
  await page.getByRole('button', { name: '按原操作恢复结果', exact: true }).waitFor();
  await page.getByRole('alert').filter({ hasText: '结果未知' }).waitFor();
  const auditBefore = await count('metric_template_rollout_audit');
  await page.getByRole('button', { name: '按原操作恢复结果', exact: true }).click();
  await page
    .getByRole('button', { name: '按原操作恢复结果', exact: true })
    .waitFor({ state: 'detached' });
  assert.equal(await count('metric_template_rollout_audit'), auditBefore);
  assert.equal((await binding.status(actor, ref(701))).revision, 2);
  await page.unroute('**/api/metrics/template-governance/batches/*/instance/701');
  await page.getByRole('button', { name: '批量应用待处理资源', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: '灰度 B' })
    .getByText('failed / failed', { exact: false })
    .waitFor();
  assert.equal((await binding.status(actor, ref(702))).revision, 1);
  assert.equal((await binding.status(actor, ref(702))).effective?.revision, 1);
  // A new configured revision is NOT applied until a real formal collection commits an envelope.
  assert.equal((await binding.status(actor, ref(701))).effective?.revision, 1);
  await formal(701, 'upgrade-a', 2);
  assert.equal((await binding.status(actor, ref(701))).effective?.revision, 2);
  fail.delete(702);
  const retryKey = randomUUID();
  const retried = await step(saved, 702, 'retry', retryKey);
  assert.equal(retried.target_revision, 2);
  const afterRetry = await count('metric_template_rollout_audit');
  await step(saved, 702, 'retry', retryKey);
  assert.equal(await count('metric_template_rollout_audit'), afterRetry);
  assert.equal((await binding.status(actor, ref(702))).revision, 2);
  // Failure after configuration submission preserves the prior effective snapshot.
  fail.add(702);
  await formal(702, 'failed-formal-b', 2, 'failed');
  assert.equal((await binding.status(actor, ref(702))).effective?.revision, 1);
  fail.delete(702);
  await page.getByRole('button', { name: '查询真实回执', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: '灰度 B' })
    .getByRole('button', { name: '重试失败项', exact: true })
    .click();
  await page
    .getByRole('row')
    .filter({ hasText: '灰度 B' })
    .getByText('3 / 1', { exact: true })
    .waitFor();
  await formal(702, 'retry-formal-b', 3);
  assert.equal((await binding.status(actor, ref(702))).effective?.revision, 3);
  await page.getByRole('button', { name: '查询真实回执', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: '灰度 A' })
    .getByRole('button', { name: '回退前版', exact: true })
    .click();
  await page
    .getByRole('row')
    .filter({ hasText: '灰度 A' })
    .getByText('3 / 2', { exact: true })
    .waitFor();
  await formal(701, 'rollback-a', 3);
  const rolled = await binding.status(actor, ref(701));
  assert.equal(rolled.template_pins[0].version, 1);
  assert.equal(rolled.effective?.revision, 3);
  await page.getByRole('button', { name: '查询真实回执', exact: true }).click();
  for (const [width, height] of [
    [1440, 900],
    [1366, 768],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: resolve(directory, `governance-${width}.png`), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.getByRole('button', { name: '检查灰度影响', exact: true }).click();
  await page.getByRole('button', { name: '返回选择', exact: true }).waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '返回选择', exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => {
    let el: any = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el?.textContent?.includes('检查灰度影响');
  });
  const focus = await page.evaluate(() => {
    let el: any = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el?.textContent;
  });
  assert.match(focus ?? '', /检查灰度影响/);
  // Resource authorization, owner isolation, revocation after lock wait, concurrent apply.
  assert.equal(
    (await api('GET', `/api/metrics/template-governance/batches/${saved}`, undefined, otherToken))
      .status,
    403,
  );
  assert.equal(
    (
      await api('POST', '/api/metrics/template-governance/batches', {
        operation_key: randomUUID(),
        pins: [await pin(2)],
        resources: [{ resource: ref(703), expected_revision: 0 }],
      })
    ).status,
    403,
  );
  const staleBatch = await batch(2, [701]);
  const concurrency = await batch(2, [701]);
  const concurrentResults = await Promise.all(
    [randomUUID(), randomUUID()].map((key) =>
      api('POST', `/api/metrics/template-governance/batches/${concurrency.id}/instance/701`, {
        action: 'apply',
        operation_key: key,
      }),
    ),
  );
  assert(
    concurrentResults.every((r) => r.status === 200),
    JSON.stringify(concurrentResults),
  );
  assert.equal((await binding.status(actor, ref(701))).revision, 4);
  const staleResult = await step(staleBatch.id, 701);
  assert.equal(staleResult.error, 'ROLLOUT_REVISION');
  assert.equal((await binding.status(actor, ref(701))).revision, 4);
  const revoking = await batch(2, [702]);
  const lock = await pool.getConnection();
  await lock.beginTransaction();
  await lock.query(
    'SELECT payload FROM metric_template_rollout_items WHERE batch_id=? FOR UPDATE',
    [revoking.id],
  );
  const waiting = api(
    'POST',
    `/api/metrics/template-governance/batches/${revoking.id}/instance/702`,
    { action: 'apply', operation_key: randomUUID() },
  );
  await new Promise((r) => setTimeout(r, 100));
  await pool.query('DELETE FROM instance_permissions WHERE user_id=701 AND instance_id=702');
  await lock.commit();
  lock.release();
  assert.equal((await waiting).status, 403);
  assert.equal(
    (
      await pool.query<any[]>(
        "SELECT payload FROM metric_policy_bindings WHERE resource_key='instance:702'",
      )
    )[0].length,
    1,
  );
  const limited = (
    await api(
      'GET',
      `/api/metrics/template-governance/templates/${child.template_id}/diff?from=1&to=2`,
    )
  ).body;
  assert(limited.affected.every((r: any) => r.resource.id !== 702));
  // Principal/late response isolation and empty/error states on actual Lit.
  let delivered!: () => void, deliveryError: any;
  const delivery = new Promise<void>((r) => (delivered = r));
  let release!: () => void, seen!: () => void;
  const held = new Promise<void>((r) => (release = r)),
    observed = new Promise<void>((r) => (seen = r));
  let once = false;
  await page.route('**/api/metrics/template-governance/resources', async (route) => {
    if (!once) {
      once = true;
      const response = await route.fetch();
      seen();
      await held;
      try {
        await route.fulfill({ response });
      } catch (error) {
        deliveryError = error;
      } finally {
        delivered();
      }
    } else await route.continue();
  });
  await page.getByRole('button', { name: '刷新治理', exact: true }).click();
  await observed;
  await page.getByText('正在读取或处理，请稍候…', { exact: true }).waitFor();
  await page.evaluate((t) => {
    localStorage.setItem('token', t);
    document.querySelector('template-governance')!.remove();
    document.body.append(document.createElement('template-governance'));
  }, otherToken);
  release();
  await delivery;
  assert.equal(deliveryError, undefined);
  await page.unroute('**/api/metrics/template-governance/resources');
  await page.getByLabel('治理模板', { exact: true }).selectOption(child.template_id);
  await page.getByRole('button', { name: '读取模板', exact: true }).click();
  await page.getByText('暂无可管理资源', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('灰度 灰度 A', { exact: true }).count(), 0);
  await page.route('**/api/metrics/template-governance/resources', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'ROLLOUT_STATE_UNKNOWN' }),
    }),
  );
  await page.getByRole('button', { name: '刷新治理', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'ROLLOUT_STATE_UNKNOWN' }).waitFor();
  await page.screenshot({ path: resolve(directory, 'error-empty.png'), fullPage: true });
  await page.unroute('**/api/metrics/template-governance/resources');
  writeFileSync(resolve(directory, 'trace.json'), JSON.stringify(trace, null, 2));
  writeFileSync(
    resolve(directory, 'result.json'),
    JSON.stringify(
      {
        nonce,
        handle,
        reads,
        passed: [
          'Lit inheritance parameter override and immutable publish; no auto-upgrade',
          'version diff and resource authorization projection',
          'batch cancel noop; create; partial trial failure preserves previous config',
          'committed response loss exact-key recovery; no duplicate audit/revision',
          'formal collection success, formal failure preserves effective previous snapshot, retry and rollback',
          'JWT forbidden; batch owner isolation; revoke while lock waits; concurrent apply serialized',
          'three desktop screenshots, horizontal fit, keyboard Escape/focus restoration',
          'principal remount/late response guard; empty/loading/error',
        ],
        boundary:
          'Controlled SQL transport, not physical hardware; explicit runOnce on owned fixture workflow store, no production worker or scheduler startup; real collector/adapters, MySQL observations/applied-envelope/config writer; no model/provider/external notification/production operation',
      },
      null,
      2,
    ),
  );
  console.log('MAX244 governance evidence', directory);
} catch (e) {
  failures++;
  console.error(e);
} finally {
  try {
    await browser?.close();
    await vite?.close();
    await app.close();
    await dbConnection.close();
    if (owned) await owned.drop();
    await root?.end();
    if (handle.container) {
      assert.equal(
        docker(
          'inspect',
          '--format',
          '{{ index .Config.Labels "slide.max244.nonce" }}',
          handle.container,
        ),
        nonce,
      );
      docker('stop', '--time', '10', handle.container);
    }
    writeFileSync(resolve(directory, 'cleanup.json'), JSON.stringify({ nonce, verified: true }));
  } catch (e) {
    failures++;
    console.error('CLEANUP_UNKNOWN; retained lifecycle handle', e);
  }
}
if (failures) process.exitCode = 1;
