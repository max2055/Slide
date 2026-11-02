/** Real authorized targets; fixed SELECTs only. Credentials stay in memory. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import oracledb from 'oracledb';
import dmdb from 'dmdb';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { vendorCredentials } from './max237-vendor-credentials.js';
import { dbConnection } from '../src/db-connection.js';
import { MigrationRunner } from '../src/migrations/runner.js';
import { createOwnedDatabase } from '../src/testing/owned-fixture.js';
import { actorContextService, type ActorContext } from '../src/auth/actor-context.js';
import { createVerifyToken } from '../src/auth-middleware.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { configurationInventory } from '../src/metrics/config/inventory.js';
import { vendorCounterTransport, ORACLE_COUNTER_SQL, DAMENG_COUNTER_SQL } from '../src/metrics/config/vendor-counter.js';
import { databaseReads, oracle1919Reads } from '../src/metrics/database/catalog.js';
import { AdapterError } from '../src/metrics/packages/adapters.js';
import { runPackage } from '../src/metrics/packages/runner.js';
import { MySqlTemplateRepository } from '../src/metrics/templates/mysql-repository.js';
import { MetricTemplateService } from '../src/metrics/templates/service.js';
import { RegisteredCapabilityCatalog } from '../src/metrics/templates/catalog.js';
import { TemplateBindingService } from '../src/metrics/templates/binding-service.js';
import { CollectNowService, createCollectNowAuthorizer } from '../src/metrics/templates/collect-now.js';
import { MysqlScheduleStore } from '../src/metrics/scheduler/store.js';
import { MetricScheduler, type CollectorAccess } from '../src/metrics/scheduler/service.js';
import { JobRegistry } from '../src/workflows/job-registry.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../src/workflows/worker-runtime.js';
import { RolloutControl } from '../src/metrics/rollout/control.js';
import { registerMetricConsumerRoutes } from '../src/metrics/consumers/routes.js';

const nonce = randomBytes(8).toString('hex');
const directory = resolve('../../outputs/max237-vendors/live-' + nonce);
mkdirSync(directory, { recursive: true });
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
const credentials = vendorCredentials();
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const evidence: any = { source, nonce, targets: {}, checks: [], cleanup: {}, target_writes: 0, model_calls: 0,
  credential_boundary: 'CLI member reference → process memory only; isolated platform stores no target secret; CollectorAccess is a fixture-scoped port, not a production credential override' };
const save = () => writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
const pass = (s: string) => { evidence.checks.push(s); save(); console.log('PASS ' + s); };
const safeError = (e: any) => ({ code: typeof e?.code === 'string' ? e.code : null, number: e?.errorNum ?? e?.errCode ?? null });
const registry = createConfigurationRegistry();
const specs = JSON.parse(readFileSync(resolve('../../docs/slide/development/MAX-237/database-template-candidates.json'), 'utf8'));
const platformPort = Number(process.env.MAX237_PLATFORM_PORT);
assert(platformPort > 0 && platformPort !== 3306, 'EXPLICIT_OWNED_PLATFORM_PORT_REQUIRED');
let root: mysql.Pool | undefined, owned: Awaited<ReturnType<typeof createOwnedDatabase>> | undefined;
let app: ReturnType<typeof Fastify> | undefined;
const handles = new Set<any>();
let activeEngine = '';
// The installed driver does not retain the server handshake version publicly.
// Observe only that version argument; preserve the original parser unchanged.
const { Login } = createRequire(import.meta.url)('dmdb/src/net/msg/login.js');
const originalVersion = Login.processServerVersion;
let dmVersion = '';
Login.processServerVersion = function(version: string, connection: unknown) {
  if (/^\d+(\.\d+)+$/.test(version)) dmVersion = version;
  return originalVersion.call(this, version, connection);
};
const connect = async (engine: 'oracle' | 'dameng', account = credentials[engine]) => {
  const client = engine === 'oracle'
    ? await oracledb.getConnection({ ...account, connectString: '127.0.0.1:1521/ORCLCDB' })
    : await dmdb.getConnection({ ...account, connectString: '127.0.0.1:5236', loginEncrypt: false, connectTimeout: 5000, socketTimeout: 5000 });
  handles.add(client); return client as any;
};
const close = async (c: any) => { await c.close(); handles.delete(c); };
try {
  root = mysql.createPool({ host: '127.0.0.1', port: platformPort, user: 'root', password: '' });
  owned = await createOwnedDatabase(root as any, { nonce, purpose: 'vendors', handleDir: directory });
  assert(await dbConnection.initialize({ host: '127.0.0.1', port: platformPort, user: 'root', password: '', database: owned.database }));
  const pool = dbConnection.getPool()!;
  await new MigrationRunner(pool as any).run();
  await pool.query("INSERT INTO users(id,username,password_hash,status,session_version) VALUES(901,'vendor-fixture','no-login','active',1)");
  await pool.query("INSERT INTO users(id,username,password_hash,status,session_version) VALUES(903,'vendor-no-access','no-login','active',1)");
  await pool.query("INSERT INTO roles(id,name) VALUES(901,'vendor-fixture')");
  await pool.query("INSERT IGNORE INTO permissions(code,name,resource,action) VALUES('*','fixture admin','system','admin')");
  await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 901,id FROM permissions WHERE code='*'");
  await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(901,901)');
  const actor = await actorContextService.loadActiveActor(901, 1) as ActorContext;
  const reload = (a: ActorContext) => actorContextService.revalidateActor(a, a.requestId);
  const reloadOn = (a: ActorContext, c: any) => actorContextService.revalidateActorOn(c, a, a.requestId, true);
  const repository = new MySqlTemplateRepository(pool);
  const templates = new MetricTemplateService(repository, registry);
  app = Fastify();
  const secret = randomBytes(32).toString('hex');
  const token = jwt.sign({ userId: 901, sessionVersion: 1 }, secret, { expiresIn: '1h' });
  await registerMetricConsumerRoutes(app, createVerifyToken(secret, actorContextService));
  await app.ready();
  for (const [engine, id] of [['oracle', 901], ['dameng', 902]] as const) {
    activeEngine = engine;
    const e: any = evidence.targets[engine] = { scope: engine === 'oracle' ? 'ORCLCDB / CDB$ROOT only' : 'local DM database', reads: [], readonly_sessions: 0 };
    const c = await connect(engine);
    try {
      e.version = (await c.execute(engine === 'oracle' ? 'SELECT BANNER_FULL FROM V$VERSION' : 'SELECT * FROM V$VERSION')).rows;
      e.roles = (await c.execute('SELECT GRANTED_ROLE FROM USER_ROLE_PRIVS')).rows;
      e.exact_version = engine === 'oracle' ? e.version[0][0].match(/Version (\d+(?:\.\d+)+)/)[1] : dmVersion;
      assert.match(e.exact_version, engine === 'oracle' ? /^19\.19\./ : /^8\.1\./);
      e.minimum_privilege_verified = false; // Supplied accounts have DBA, never claim read-only grants.
    } finally { await close(c); }
    const readList = engine === 'oracle' ? oracle1919Reads : databaseReads.filter(r => r.engine === engine);
    const allowed = new Set([...readList.map(r => r.sql), engine === 'oracle' ? ORACLE_COUNTER_SQL : DAMENG_COUNTER_SQL]);
    const transport = vendorCounterTransport(engine, async (sql, timeout) => {
      assert(allowed.has(sql), 'FIXED_SELECT_ALLOWLIST');
      const client = await connect(engine);
      try {
        client.callTimeout = timeout;
        await client.execute('SET TRANSACTION READ ONLY'); e.readonly_sessions++;
        const result = await client.execute(sql); e.reads.push({ sql, rows: result.rows });
        return result;
      } finally { await close(client); }
    });
    await pool.query(`INSERT INTO database_instances(id,name,environment,db_type,db_version,host,port,username,password_encrypted,database_name,status,lifecycle_state,created_by)
      VALUES(?,?,'testing',?,?,'127.0.0.1',?,'memory-only','no-target-secret',?,'active','available',901)`,
      [id, 'vendor-' + engine, engine, e.exact_version, engine === 'oracle' ? 1521 : 5236, engine === 'oracle' ? 'ORCLCDB' : '']);
    await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(901,?,'admin')", [id]);
    const ref = { type: 'instance' as const, id };
    const credential_ref = 'credential:vendor-' + engine + '-' + nonce;
    const access: CollectorAccess = { resolve: async target => {
      assert.deepEqual(target, ref);
      return { resource: await configurationInventory(ref), credential_ref, evidence: {}, resolve: async (credential, resource, method) => {
        if (credential !== credential_ref || resource.id !== String(id) || resource.type !== 'instance' || method !== 'sql') throw new AdapterError('permission_denied');
        return transport;
      } };
    } };
    const resolved = await access.resolve(ref);
    await assert.rejects(resolved.resolve('credential:other', resolved.resource, 'sql'), { code: 'permission_denied' });
    const spec = specs[engine];
    const release = registry.list().find(r => r.package.id === spec.package_id && r.package.version === (engine === 'oracle' ? '1.2.0' : '1.0.0'))!;
    const { id: packageId, version, digest } = release.package;
    const pin = { id: packageId, version, digest };
    if (engine === 'oracle') {
      const old = registry.list().find(r => r.package.id === spec.package_id && r.package.version === '1.0.0')!.package;
      e.original_candidate = (await runPackage(registry, { package: { id: old.id, version: old.version, digest: old.digest }, credential_ref, overrides: {} },
        { ...resolved, binding_id: 'original-oracle', attempt_id: 'unsupported', config_revision: 1, observed_at: new Date().toISOString() })).decision;
      assert.equal(e.original_candidate, 'unsupported');
    }
    e.baseline = await runPackage(registry, { package: pin, credential_ref, overrides: {} }, {
      ...resolved, binding_id: 'vendor-baseline-' + id, attempt_id: 'baseline-' + id, config_revision: 1, observed_at: new Date().toISOString(),
    });
    assert(e.baseline.attempts.every((a: any) => a.status === 'succeeded'), 'REAL_COLLECTOR_FAILED');
    assert(e.baseline.raw.length === 3 && e.baseline.raw.every((o: any) => o.value?.encoding === 'uint64' && o.quality.status === 'good'), 'REAL_VALUES_MISSING');
    const firstRate = e.baseline.observations.find((o: any) => o.observation.metric.id.endsWith('commit_rate')).observation;
    assert.equal(firstRate.value, null);
    assert.equal(firstRate.quality.reason, 'counter_baseline');
    const available = spec.items;
    const created = await templates.create(actor, { name: `${engine} ${e.exact_version} 真实查询资格模板` });
    const items = [], mappings = [];
    for (const item of available) {
      const selected = await templates.selectMetric(actor, created.template_id, { item_id: item.id, display_name: item.name,
        package: pin, metric: { id: item.metric, semantic_version: '1.0.0' } });
      items.push({ item_id: selected.item.item_id, version: selected.item.version });
      mappings.push(new RegisteredCapabilityCatalog(registry).autofill({ package: pin, metric: selected.item.canonical_metric }));
    }
    const draft = (await repository.getDraft(created.template_id))!;
    await templates.updateDraft(actor, created.template_id, { expected_draft_revision: draft.revision, aggregate: { ...draft.aggregate, items: items.sort((a,b) => a.item_id.localeCompare(b.item_id)) } });
    const published = await templates.publish(actor, created.template_id, { expected_draft_revision: draft.revision + 1, expected_revision: 0 });
    const record = (await repository.getTemplate(created.template_id))!;
    await repository.updateTemplate(created.template_id, record.revision, { status: 'active', updated_at: new Date().toISOString() });
    const snapshot = (await repository.getVersion(created.template_id, published.version))!;
    e.template = { published, snapshot, mappings };
    for (const m of mappings) {
      const raw = e.baseline.raw.find((o: any) => o.metric.id === m.metric.id);
      assert(raw && raw.raw_field === m.raw_field && raw.unit === m.unit && raw.source.collector_id === m.collector_id);
    }
    const bindings = new TemplateBindingService({ pool: () => pool, registry, access, reload, reloadOn });
    const request = { expected_revision: 0, template_pins: [{ template_id: created.template_id, version: snapshot.version, content_hash: snapshot.content_hash }], overrides: { enabled: 'enable' } };
    e.probe = await bindings.probe(actor, ref, request);
    e.trial = await bindings.trial(actor, ref, { ...request, receipt_id: 'vendor-' + id + nonce });
    e.apply = await bindings.apply(actor, ref, { ...request, receipt_id: 'vendor-' + id + nonce, caller_key: 'vendor-' + id + nonce });
    for (const raw of e.baseline.raw) await new RolloutControl(pool).initialize({ resource_type: 'instance', resource_id: String(id), metric: raw.metric, dimensions: raw.dimensions },
      { source: 'semantic', read: 'semantic', package: pin, revision: 1 });
    const collect = new CollectNowService({ pool: () => pool, registry, reload, reloadOn });
    const jobs = new JobRegistry();
    new MetricScheduler(new MysqlScheduleStore(pool, registry, 'production'), registry, access, Date.now, undefined, undefined,
      createCollectNowAuthorizer({ loadActor: (i,v) => actorContextService.loadActiveActor(i,v), loadActorOn: (c,i,v) => actorContextService.loadActiveActorOn(c as never,i,v,undefined,true) })).register(jobs);
    const worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool as never), 'vendor-' + nonce, 30);
    e.collections = [];
    for (let round = 0; round < 2; round++) {
      // A complete 1s counter bucket needs a real observed interval, not two immediate reads.
      if (round) await new Promise(resolve => setTimeout(resolve, 2200));
      const key = 'vendor-' + id + nonce + round;
      await collect.collect(actor, ref, { caller_key: key, expected_revision: 1 });
      let result: any;
      for (let n = 0; n < 30; n++) {
        await worker.runOnce((job, context) => jobs.execute(job, context), Date.now());
        result = await collect.task(actor, ref, key);
        if (['completed', 'failed'].includes(result.state)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      e.collections.push(result);
      assert.equal(result.state, 'completed', 'FORMAL_JOB_NOT_COMPLETED');
      assert.equal(result.samples.length, 3);
      assert(result.samples.every((s: any) => s.value?.encoding === 'uint64' && s.quality.status === 'good'));
    }
    for (const history of [false, true]) {
      const response = await app.inject({ method: 'POST', url: '/api/metrics/query', headers: { authorization: `Bearer ${token}` }, payload: {
        resource: ref, metric_ids: available.map((i: any) => i.metric), from: new Date(Date.now() - 60000).toISOString(), to: new Date().toISOString(), bucket_ms: 1000, ...(history ? { history: true } : {}),
      } });
      assert.equal(response.statusCode, 200);
      const result = response.json() as any;
      e[history ? 'history' : 'latest'] = result;
      assert.equal(result.metrics.length, 3);
      assert(result.metrics.every((m: any) => m.series.some((s: any) => s.buckets.some((b: any) => b.value !== null))));
    }
    const beforeDenied = e.reads.length;
    const denied = await app.inject({ method: 'POST', url: '/api/metrics/query', headers: { authorization: `Bearer ${jwt.sign({ userId: 903, sessionVersion: 1 }, secret, { expiresIn: '1h' })}` },
      payload: { resource: ref, metric_ids: available.map((i: any) => i.metric) } });
    assert.equal(denied.statusCode, 403);
    assert.equal(e.reads.length, beforeDenied);
    e.platform_permission_negative = { status: denied.statusCode, target_reads: e.reads.length - beforeDenied };
    assert.deepEqual(await repository.getVersion(created.template_id, published.version), snapshot);
    pass(`${engine}: three real items on ${e.exact_version} → registered fixed mappings → read-only sessions → immutable publish/apply → two formal worker jobs → authenticated latest/history`);
  }
} catch (error) {
  evidence.failure = { engine: activeEngine, ...safeError(error), assertion: (error as any)?.operator ?? null,
    location: (error as any)?.stack?.split('\n').find((line: string) => line.includes('max237-vendor-qualification.ts:'))?.trim() };
  process.exitCode = 1; console.error('QUALIFICATION_FAILED', JSON.stringify(evidence.failure));
} finally {
  Login.processServerVersion = originalVersion;
  for (const c of [...handles]) { try { await close(c); } catch { evidence.cleanup.target_sessions = false; process.exitCode = 1; } }
  evidence.cleanup.target_sessions = handles.size === 0;
  try { await app?.close(); await dbConnection.close(); await owned?.drop(); await root?.end(); evidence.cleanup.platform = true; }
  catch { evidence.cleanup.platform = false; process.exitCode = 1; }
  save(); console.log('Evidence: ' + directory);
}
