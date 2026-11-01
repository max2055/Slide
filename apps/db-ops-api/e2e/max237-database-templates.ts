/** Foreground owned PG16.4/MySQL8.4 drill. Explicit fixture connections; no shared targets. */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Client } from 'pg';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { createVerifyToken } from '../src/auth-middleware.js';
import { registerTemplateTriggerRoutes } from '../src/metrics/triggers/routes.js';
import { registerMetricConsumerRoutes } from '../src/metrics/consumers/routes.js';
import { registerEventReadRoutes } from '../src/alert-event-access.js';
import { dbConnection, encryptData } from '../src/db-connection.js';
import { databaseService } from '../src/database-service.js';
import { MigrationRunner } from '../src/migrations/runner.js';
import { createOwnedDatabase } from '../src/testing/owned-fixture.js';
import { actorContextService, type ActorContext } from '../src/auth/actor-context.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { createAssetCollectorAccess } from '../src/metrics/config/access.js';
import { trialDatabaseTransport } from '../src/metrics/config/database-transport.js';
import type { DatabaseConnection } from '../src/database-service.js';
import { MySqlTemplateRepository } from '../src/metrics/templates/mysql-repository.js';
import { MetricTemplateService } from '../src/metrics/templates/service.js';
import { RegisteredCapabilityCatalog } from '../src/metrics/templates/catalog.js';
import { TemplateBindingService } from '../src/metrics/templates/binding-service.js';
import { CollectNowService, createCollectNowAuthorizer } from '../src/metrics/templates/collect-now.js';
import { MysqlScheduleStore } from '../src/metrics/scheduler/store.js';
import { MetricScheduler } from '../src/metrics/scheduler/service.js';
import { JobRegistry } from '../src/workflows/job-registry.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../src/workflows/worker-runtime.js';
import { RolloutControl } from '../src/metrics/rollout/control.js';
import { runPackage } from '../src/metrics/packages/runner.js';

const nonce = randomBytes(8).toString('hex');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
const directory = resolve('../../outputs/max237-databases-' + nonce);
mkdirSync(directory, { recursive: true });
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const manifestPath = resolve('../../docs/slide/development/MAX-237/database-template-candidates.json');
const definitions = JSON.parse(readFileSync(manifestPath, 'utf8'));
const registry = createConfigurationRegistry();
const evidence: any = { source, nonce, checks: [], templates: {}, containers: [], cleanup: {}, product_model_calls: 0 };
const save = () => writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
const passed = (name: string) => { evidence.checks.push(name); console.log('PASS ' + name); save(); };
const waitFor = async (fn: () => Promise<unknown>) => {
  const deadline = Date.now() + 45000;
  for (;;) { try { await fn(); return; } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(r => setTimeout(r, 300)); } }
};
let root: mysql.Pool | undefined, owned: Awaited<ReturnType<typeof createOwnedDatabase>> | undefined;
let pg: Client | undefined;
let app: ReturnType<typeof Fastify> | undefined;
const extraPg: Client[] = [];
try {
  for (const [image, env, internal] of [
    ['postgres:16.4', 'POSTGRES_HOST_AUTH_METHOD=trust', '5432/tcp'],
    ['mysql:8.4', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes', '3306/tcp'],
  ]) {
    const id = docker('run', '-d', '--rm', '--label', `slide.max237.nonce=${nonce}`, '-e', env, '-p', `127.0.0.1::${internal.split('/')[0]}`, image);
    evidence.containers.push({ id, image, internal }); save();
    const port = Number(docker('port', id, internal).split(':').at(-1));
    assert(port > 0 && port !== 3306); evidence.containers.at(-1).port = port; save();
  }
  const pgPort = evidence.containers[0].port, mysqlPort = evidence.containers[1].port;
  await waitFor(async () => { const client = new Client({ host: '127.0.0.1', port: pgPort, user: 'postgres' }); try { await client.connect(); await client.query('SELECT 1'); } finally { await client.end(); } });
  pg = new Client({ host: '127.0.0.1', port: pgPort, user: 'postgres' }); await pg.connect();
  evidence.pg_version = (await pg.query('SELECT version() AS version')).rows[0].version;
  assert.match(evidence.pg_version, /PostgreSQL 16\.4 /);
  await pg.query("CREATE ROLE template_reader LOGIN; ALTER ROLE template_reader SET default_transaction_read_only=on");
  await pg.query('CREATE DATABASE template_target');
  await pg.query('REVOKE CONNECT ON DATABASE template_target FROM PUBLIC');
  await pg.query('GRANT CONNECT ON DATABASE template_target TO template_reader');
  root = mysql.createPool({ host: '127.0.0.1', port: mysqlPort, user: 'root' });
  await waitFor(() => root!.query('SELECT 1'));
  owned = await createOwnedDatabase(root as any, { nonce, purpose: 'pgtemplates', handleDir: directory });
  assert(await dbConnection.initialize({ host: '127.0.0.1', port: mysqlPort, user: 'root', password: '', database: owned.database }));
  const pool = dbConnection.getPool()!;
  await new MigrationRunner(pool as any).run();
  await pool.query("INSERT INTO users(id,username,password_hash,status,session_version) VALUES(701,'template-manager','no-login','active',1)");
  await pool.query("INSERT INTO roles(id,name) VALUES(701,'template-manager')");
  await pool.query("INSERT IGNORE INTO permissions(code,name,resource,action) VALUES('*','fixture admin','system','admin')");
  await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code='*'");
  await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(701,701)');
  const actor = await actorContextService.loadActiveActor(701, 1) as ActorContext;
  const repository = new MySqlTemplateRepository(pool);
  const service = new MetricTemplateService(repository, registry);
  const catalog = new RegisteredCapabilityCatalog(registry);
  for (const engine of ['postgresql', 'oracle', 'dameng']) {
    const spec = definitions[engine];
    const template = await service.create(actor, { name: spec.name });
    const release = registry.list().find(r => r.package.id === spec.package_id && r.package.version === spec.package_version)!;
    assert(release);
    const pin = { id: release.package.id, version: release.package.version, digest: release.package.digest };
    const items = [], mappings = [];
    for (const entry of spec.items) {
      const selected = await service.selectMetric(actor, template.template_id, { item_id: entry.id, display_name: entry.name,
        package: pin, metric: { id: entry.metric, semantic_version: '1.0.0' } });
      items.push({ item_id: selected.item.item_id, version: selected.item.version });
      mappings.push(catalog.autofill({ package: pin, metric: selected.item.canonical_metric }));
    }
    const draft = (await repository.getDraft(template.template_id))!;
    const aggregate = { ...draft.aggregate, items: items.sort((a, b) => a.item_id.localeCompare(b.item_id)), parameters: { schema: { interval_ms: { type: 'integer' as const, min: 1000, max: 86400000 } }, defaults: { interval_ms: spec.interval_ms } } };
    await service.updateDraft(actor, template.template_id, { expected_draft_revision: draft.revision, aggregate });
    evidence.templates[engine] = { template_id: template.template_id, mappings, applicability: release.package.applicability, published: false };
    if (engine !== 'postgresql') {
      assert.equal((await repository.getTemplate(template.template_id))!.current_published_version, null);
      assert.deepEqual(await repository.listVersions(template.template_id), []);
      passed(engine + ': registered mappings resolved; isolated draft only, no published version or binding');
      continue;
    }
    // Real collector access reads both live asset configuration and its established driver connection.
    await pool.query(`INSERT INTO database_instances(id,name,environment,db_type,db_version,host,port,username,password_encrypted,database_name,status,lifecycle_state,created_by)
      VALUES(701,'isolated-pg','testing','postgresql','16.4','127.0.0.1',?,'template_reader',?,'template_target','active','available',701)`, [pgPort, encryptData('')]);
    await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(701,701,'admin')");
    assert(await databaseService.addConnection(701, 'isolated-pg', { host: '127.0.0.1', port: pgPort, user: 'template_reader', password: '', database: 'template_target', db_type: 'postgresql' }));
    const access = await createAssetCollectorAccess().resolve({ type: 'instance', id: 701 });
    const baseline = await runPackage(registry, { package: pin, credential_ref: access.credential_ref, overrides: {} }, {
      ...access, binding_id: 'pg-baseline', config_revision: 1, attempt_id: 'pg-baseline', observed_at: new Date().toISOString(),
    });
    assert(baseline.attempts.every(a => a.status === 'succeeded'), JSON.stringify(baseline.attempts));
    assert(baseline.observations.filter(o => spec.items.some((s: any) => s.metric === o.observation.metric.id)).every(o => o.observation.quality.status === 'good'));
    evidence.baseline = { attempts: baseline.attempts, raw: baseline.raw, observations: baseline.observations };
    assert.equal(baseline.raw!.length, 5);
    for (const mapping of mappings) {
      const raw = baseline.raw!.find(o => o.metric.id === mapping.metric.id)!;
      assert(raw); assert.equal(raw.raw_field, mapping.raw_field); assert.equal(raw.unit, mapping.unit);
      assert.equal(raw.quality.status, 'good'); assert.equal(raw.value?.encoding, 'uint64');
      assert.deepEqual(Object.keys(raw.dimensions).sort(), mapping.dimensions.map(d => d.name).sort());
      if (mapping.dimensions.length) assert.equal(raw.dimensions.database, 'template_target');
      assert.equal(raw.source.collector_id, mapping.collector_id);
    }
    const capacity = baseline.raw!.find(o => o.metric.id === 'postgresql.connections.limit')!;
    assert.equal((capacity.value as any).value, (await pg.query("SELECT current_setting('max_connections') AS capacity")).rows[0].capacity);
    const disk = baseline.raw!.find(o => o.metric.id === 'postgresql.database.disk_bytes')!;
    assert(BigInt((disk.value as any).value) > 0n);
    const beforeReset = baseline.observations.find(o => o.observation.metric.id === 'postgresql.transactions.commit_rate')!.observation;
    assert.equal(beforeReset.value, null); assert.equal(beforeReset.quality.reason, 'counter_baseline');
    const targetAdmin = new Client({ host: '127.0.0.1', port: pgPort, user: 'postgres', database: 'template_target' });
    await targetAdmin.connect();
    try { await targetAdmin.query('SELECT pg_stat_reset()'); } finally { await targetAdmin.end(); }
    const reset = await runPackage(registry, { package: pin, credential_ref: access.credential_ref, overrides: {} }, {
      ...access, states: baseline.states, binding_id: 'pg-baseline', config_revision: 1, attempt_id: 'pg-reset', observed_at: new Date().toISOString(),
    });
    const resetRate = reset.observations.find(o => o.observation.metric.id === 'postgresql.transactions.commit_rate')!.observation;
    assert.equal(resetRate.value, null); assert.equal(resetRate.quality.reason, 'counter_reset');
    evidence.counter_reset = { attempts: reset.attempts, raw: reset.raw, observations: reset.observations };
    const privateTransport = trialDatabaseTransport({ id: 701, db_type: 'postgresql', connected: true,
      config: { host: '127.0.0.1', port: pgPort, user: 'template_reader', password: '', database: 'template_target' } } as DatabaseConnection);
    assert.equal(privateTransport.method, 'sql');
    if (privateTransport.method !== 'sql') throw Error('expected SQL transport');
    await assert.rejects(privateTransport.pool.query({ sql: 'CREATE TABLE forbidden_write(id int)', timeout: 3000 }), { code: '25006' });
    await assert.rejects(privateTransport.pool.query({ sql: 'SELECT pg_sleep(1)', timeout: 30 }), { code: '57014' });
    await pg.query('REVOKE CONNECT ON DATABASE template_target FROM template_reader');
    try {
      const denied = await runPackage(registry, { package: pin, credential_ref: access.credential_ref, overrides: {} }, {
        ...access, binding_id: 'pg-denied', config_revision: 1, attempt_id: 'pg-denied', observed_at: new Date().toISOString(),
      });
      assert(denied.attempts.every(a => a.error === 'permission_denied'), JSON.stringify(denied.attempts));
      assert(denied.observations.every(o => o.observation.value === null));
      evidence.denied = { attempts: denied.attempts, observations: denied.observations };
    } finally { await pg.query('GRANT CONNECT ON DATABASE template_target TO template_reader'); }
    const [session] = (await pg.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE usename='template_reader'")).rows;
    // databaseService owns one established asset connection; every private trial session has closed.
    assert.equal(session.n, 1);
    passed('PG real read-only write refusal, native timeout/session cleanup, permission revocation as unknown, reset as unknown rate');
    let requests = 0;
    const unsupported = await runPackage(registry, { package: pin, credential_ref: access.credential_ref, overrides: {} }, {
      ...access, resource: { ...access.resource, attributes: { ...access.resource.attributes, 'db.version': { value: '17.0', source: 'driver', observed_at: new Date().toISOString() } } },
      binding_id: 'pg-wrong-version', config_revision: 1, attempt_id: 'pg-wrong-version', observed_at: new Date().toISOString(),
      resolve: async (...args) => { requests++; return access.resolve(...args); },
    });
    assert.equal(unsupported.decision, 'unsupported'); assert.equal(requests, 0);
    passed('unregistered PostgreSQL version rejected before target I/O');
    const published = await service.publish(actor, template.template_id, { expected_draft_revision: 1, expected_revision: 0 });
    const record = (await repository.getTemplate(template.template_id))!;
    await repository.updateTemplate(template.template_id, record.revision, { status: 'active', updated_at: new Date().toISOString() });
    let version = (await repository.getVersion(template.template_id, published.version))!;
    const originalVersion = structuredClone(version);
    app = Fastify();
    const secret = randomBytes(32).toString('hex');
    const token = jwt.sign({ userId: actor.userId, sessionVersion: actor.sessionVersion }, secret, { expiresIn: '1h' });
    const auth = createVerifyToken(secret, actorContextService);
    await registerTemplateTriggerRoutes(app, auth, () => pool);
    await registerMetricConsumerRoutes(app, auth);
    await registerEventReadRoutes(app, auth);
    await app.ready();
    const call = async (method: 'POST' | 'GET', url: string, payload?: unknown) => {
      const response = await app!.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
      assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
      return response.json() as any;
    };
    const threshold = Number((baseline.raw!.find(o => o.metric.id === 'postgresql.activity.count')!.value as any).value) + 2;
    const trigger = await call('POST', `/api/metrics/templates/${template.template_id}/triggers`, {
      expected_version: version.version, expected_content_hash: version.content_hash, item_id: spec.items.find((i: any) => i.metric === 'postgresql.activity.count').id,
      parameters: { schema: { boundary: { type: 'number' } }, defaults: { boundary: threshold } },
      problem: { node: 'compare', select: { aggregation: 'last' }, operator: '>=', threshold: { kind: 'parameter', name: 'boundary' } },
      recovery: { node: 'compare', select: { aggregation: 'last' }, operator: '<', threshold: { kind: 'parameter', name: 'boundary' } },
      quality: { accepted_quality: ['good'], min_coverage: 1, allow_estimated: false },
      clock: { stale_after_ms: 120000, nodata: { enabled: false } },
    });
    version = (await repository.getVersion(template.template_id, trigger.version))!;
    evidence.trigger = { publication: trigger, threshold, real_condition: 'three owned read-only PG sessions opened, held and closed; no seeded observations/events' };
    evidence.templates[engine].published = true; evidence.templates[engine].version = version;
    const reload = (a: ActorContext) => actorContextService.revalidateActor(a, a.requestId);
    const reloadOn = (a: ActorContext, c: any) => actorContextService.revalidateActorOn(c, a, a.requestId, true);
    const bindings = new TemplateBindingService({ pool: () => pool, registry, access: createAssetCollectorAccess(), reload, reloadOn });
    const ref = { type: 'instance' as const, id: 701 };
    const body = { expected_revision: 0, template_pins: [{ template_id: template.template_id, version: version.version, content_hash: version.content_hash }], overrides: { enabled: 'enable' } };
    evidence.probe = await bindings.probe(actor, ref, body);
    evidence.trial = await bindings.trial(actor, ref, { ...body, receipt_id: 'pg-' + nonce });
    evidence.apply = await bindings.apply(actor, ref, { ...body, receipt_id: 'pg-' + nonce, caller_key: 'pg-' + nonce });
    // A brand-new isolated target has no legacy source to migrate. Register its
    // selected series through the existing opt-in rollout control, never by
    // seeding publications/observations or enabling a production resource.
    for (const item of spec.items) {
      const raw = baseline.raw!.find(o => o.metric.id === item.metric)!;
      await new RolloutControl(pool).initialize({ resource_type: 'instance', resource_id: '701', metric: raw.metric, dimensions: raw.dimensions },
        { source: 'semantic', read: 'semantic', package: pin, revision: 1 });
    }
    evidence.formal_read_gate = { scope: 'new nonce-owned isolated PG resource only', method: 'existing RolloutControl.initialize before worker publication', seeded_observations: 0, production_activation: false };
    const collect = new CollectNowService({ pool: () => pool, registry, reload, reloadOn });
    const jobs = new JobRegistry();
    new MetricScheduler(new MysqlScheduleStore(pool, registry, 'production'), registry, createAssetCollectorAccess(true), Date.now, undefined, undefined,
      createCollectNowAuthorizer({ loadActor: (id, v) => actorContextService.loadActiveActor(id, v), loadActorOn: (c, id, v) => actorContextService.loadActiveActorOn(c as never, id, v, undefined, true) })).register(jobs);
    const worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool as never), 'pg-' + nonce, 30);
    evidence.collections = [];
    for (let i = 0; i < 3; i++) {
      const client = new Client({ host: '127.0.0.1', port: pgPort, user: 'template_reader', database: 'template_target' });
      await client.connect(); extraPg.push(client);
    }
    for (const step of ['open', 'hold', 'recover']) {
      if (step === 'recover') for (const client of extraPg.splice(0)) await client.end();
      const key = 'pg-' + nonce + '-' + step;
      await collect.collect(actor, ref, { caller_key: key, expected_revision: 1 });
      let result: any;
      for (let n = 0; n < 30; n++) {
        await worker.runOnce((j, c) => jobs.execute(j, c), Date.now());
        result = await collect.task(actor, ref, key);
        if (result.state === 'completed' || result.state === 'failed') break;
        await new Promise(r => setTimeout(r, 100));
      }
      assert.equal(result.state, 'completed', JSON.stringify(result));
      assert.equal(result.samples.length, spec.items.length);
      assert.deepEqual(result.samples.map((s: any) => s.metric.id).sort(), spec.items.map((s: any) => s.metric).sort());
      assert(result.samples.every((s: any) => s.quality.status === 'good' && s.value?.encoding === 'uint64'));
      evidence.collections.push(result);
      const [episodes] = await pool.query<any[]>("SELECT event_id,payload,snapshot FROM metric_trigger_episodes WHERE resource_key='instance:701'");
      assert.equal(episodes.length, 1);
      const episode = typeof episodes[0].payload === 'string' ? JSON.parse(episodes[0].payload) : episodes[0].payload;
      assert.equal(episode.state, step === 'recover' ? 'closed' : 'open');
      assert.equal(episode.recovery_count, step === 'recover' ? 1 : 0);
      evidence.trigger[step] = await call('GET', `/api/metrics/template-events/${episodes[0].event_id}`);
      if (step === 'recover') {
        evidence.trigger.event = await call('GET', `/api/alerts/events/${episodes[0].event_id}`);
        evidence.trigger.logs = await call('GET', `/api/alerts/events/${episodes[0].event_id}/logs`);
      }
    }
    const [stored] = await pool.query<any[]>("SELECT payload FROM metric_observations WHERE stage='normalized' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.resource_id'))='701'");
    assert(stored.length >= 15); evidence.stored_observations = stored;
    const query = { resource: ref, metric_ids: ['postgresql.activity.count'], from: new Date(Date.now() - 60000).toISOString(), to: new Date().toISOString(), bucket_ms: 1000 };
    evidence.latest = await call('POST', '/api/metrics/query', query);
    evidence.history = await call('POST', '/api/metrics/query', { ...query, history: true });
    assert(evidence.latest.metrics[0].series.some((s: any) => s.buckets.some((b: any) => b.value !== null)));
    assert(evidence.history.metrics[0].series.some((s: any) => s.buckets.some((b: any) => b.sources.length)));
    assert.equal(evidence.history.history_context.events.length, 1);
    assert.equal(evidence.history.history_context.missing_revisions.length, 0);
    assert.equal(evidence.history.history_context.configurations[0].state, 'effective');
    assert.equal(evidence.trigger.open.episode.episode_id, evidence.trigger.recover.episode.episode_id);
    passed('PG real session condition → one episode open/hold/recover → authenticated latest/history and immutable configuration/event context');
    passed('PG16.4: real least-privilege collection → immutable publish → probe/trial/apply → three foreground collect jobs → durable samples');
    assert.deepEqual(await repository.getVersion(template.template_id, originalVersion.version), originalVersion);
    assert.deepEqual(await repository.getVersion(template.template_id, version.version), version);
    await assert.rejects(service.publish({ ...actor, permissions: ['metric:view'] }, template.template_id, { expected_draft_revision: 2, expected_revision: 2 }), { code: 'TEMPLATE_FORBIDDEN' });
    passed('published snapshot unchanged; view-only principal cannot publish');
  }
  evidence.manifest_sha256 = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
} catch (error) { evidence.failed = error instanceof Error ? error.message : String(error); process.exitCode = 1; console.error(error); }
finally {
  const clean = async (name: string, action: () => Promise<unknown>) => {
    try { await action(); evidence.cleanup[name] = true; }
    catch { evidence.cleanup[name] = false; process.exitCode = 1; }
  };
  await clean('api', async () => app?.close());
  await clean('extra_sessions', async () => { for (const client of extraPg.splice(0)) await client.end(); });
  await clean('asset_connection', () => databaseService.removeConnection(701));
  await clean('pg_admin', async () => pg?.end());
  await clean('platform_pool', () => dbConnection.close());
  if (owned) await clean('schema', () => owned!.drop());
  await clean('root_pool', async () => root?.end());
  for (const container of evidence.containers.reverse()) {
    await clean(container.id, async () => {
      const inspected = JSON.parse(docker('inspect', container.id))[0];
      assert.equal(inspected.Config.Labels['slide.max237.nonce'], nonce);
      docker('stop', '--time', '10', container.id);
      await waitFor(async () => assert.equal(docker('ps', '-aq', '--filter', 'id=' + container.id), ''));
    });
  }
  save(); console.log('Evidence: ' + directory);
}
