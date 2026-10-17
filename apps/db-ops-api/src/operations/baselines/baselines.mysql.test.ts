/** Real isolated MySQL/JWT/listening HTTP. Long windows below are explicitly
 * synthetic; the final test separately measures real local SQL through the
 * integrated scheduler/source acceptance/formal publication/query chain. */
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFeedbackFixture } from '../../investigations/feedback-test-fixture.js';
import { createVerifyToken } from '../../auth-middleware.js';
import { signAccessToken, type ActorContext } from '../../auth/actor-context.js';
import { OperationsAuthorization } from '../authorization.js';
import { operationsFlags } from '../feature-flags.js';
import { OperationsError } from '../contracts.js';
import { createConfigurationRegistry } from '../../metrics/config/registry.js';
import { PolicyService } from '../../metrics/policy/service.js';
import { MysqlPolicyStore } from '../../metrics/policy/store.js';
import { MysqlScheduleStore } from '../../metrics/scheduler/store.js';
import { MetricScheduler } from '../../metrics/scheduler/service.js';
import { MetricFormalization } from '../../metrics/rollout/formalization.js';
import { MysqlFormalMetricStore } from '../../metrics/rollout/formal-store.js';
import { MetricConsumerService } from '../../metrics/consumers/service.js';
import { MYSQL_STATUS_SQL } from '../../metrics/packages/adapters.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../workflows/worker-runtime.js';
import { BaselineStore } from './store.js';
import { FormalBaselineSource, DAY, HOUR, type BaselineSource, type BaselineInput } from './source-adapter.js';
import { syntheticInput, syntheticWindow } from './test-support.js';
import { registerBaselineRoutes } from './routes.js';

const port = Number(process.env.OPERATIONS_TEST_MYSQL_PORT);
describe.skipIf(!port)('P04 B06 real MySQL/HTTP with explicitly separated synthetic windows', () => {
  let f: Awaited<ReturnType<typeof startFeedbackFixture>>, service: BaselineStore, authorization: OperationsAuthorization;
  let actor: ActorContext, base: string, source: BaselineSource, enabled: boolean, now: number;
  let afterSource: (() => Promise<void>) | undefined;
  const input: BaselineInput = { ...syntheticInput, resource: { type: 'instance', id: 101 } };
  const request = async (path = '/api/operations/baselines', method = 'POST', body: unknown = input, caller = actor) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${signAccessToken(caller, f.secret)}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() as any, cache: r.headers.get('cache-control') };
  };
  const count = async () => Number((await f.rows('SELECT COUNT(*) n FROM behavior_baseline_versions'))[0].n);
  beforeAll(async () => {
    const prior = process.env.T11_TEST_MYSQL_PASSWORD;
    process.env.T11_TEST_MYSQL_PASSWORD = process.env.OPERATIONS_TEST_MYSQL_PASSWORD ?? '';
    try { f = await startFeedbackFixture(port); } finally {
      if (prior === undefined) delete process.env.T11_TEST_MYSQL_PASSWORD; else process.env.T11_TEST_MYSQL_PASSWORD = prior;
    }
    for (const sql of readFileSync(new URL('../schema/operations-v1.sql', import.meta.url), 'utf8').split(';').filter(s => s.trim())) await f.pool.query(sql);
    await f.rows("INSERT IGNORE INTO permissions(code,description) VALUES('operations:context:view','P04 fixture')");
    await f.rows("INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT 101,id FROM permissions WHERE code='operations:context:view'");
    authorization = new OperationsAuthorization(f.contexts);
    service = new BaselineStore(() => f.pool, () => ({ load: async (...args) => {
      const result = await source.load(...args); await afterSource?.(); return result;
    } }), authorization, () => ({ ...operationsFlags({}), baselines: enabled }), () => new Date(now));
    await registerBaselineRoutes(f.app, createVerifyToken(f.secret, f.contexts), service);
    base = await f.app.listen({ host: '127.0.0.1', port: 0 });
  }, 120_000);
  afterAll(async () => { await f?.close(); }, 30_000);
  beforeEach(async () => {
    vi.restoreAllMocks(); enabled = true; afterSource = undefined; now = Date.now();
    await f.rows('DELETE FROM behavior_baseline_versions');
    await f.rows("DELETE FROM outbox_events WHERE event_type='operations.baseline.versioned'");
    await f.rows('UPDATE users SET session_version=1 WHERE id IN (101,102,103)');
    await f.rows("UPDATE database_instances SET lifecycle_state='available',status='active',host='fixture.invalid' WHERE id=101");
    await f.rows("INSERT IGNORE INTO instance_permissions(user_id,instance_id,access_level) VALUES(101,101,'read-only'),(101,102,'read-only')");
    await f.rows('UPDATE instance_permissions SET grant_expiry=NULL WHERE user_id=101');
    await f.rows("INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT 101,id FROM permissions WHERE code='operations:context:view'");
    actor = await f.contexts.loadActiveActor(101);
    source = { load: async (_actor, current, fence, targetVersion) => {
      const value = syntheticWindow(current.mode);
      const shift = Math.floor(now / HOUR) * HOUR - Date.parse(value.until);
      const shifted = (at: string) => new Date(Date.parse(at) + shift).toISOString();
      value.from = shifted(value.from); value.until = shifted(value.until);
      for (const bucket of value.buckets) bucket.window = { from: shifted(bucket.window.from), to: shifted(bucket.window.to) };
      value.latest.observedAt = shifted(value.latest.observedAt!);
      value.identity = { ...value.identity!, resource: current.resource, metric: `${current.metric}@1.0.0`, dimensions: current.dimensions,
        source: { ...value.identity!.source, version: targetVersion } };
      value.evaluatedAt = new Date(now).toISOString(); value.validUntil = new Date(now + 120_000).toISOString(); value.fence = fence;
      return value;
    } };
  });

  it('stores immutable synthetic versions with exact source identity and outbox, using real JWT/HTTP', async () => {
    const a = await request(), b = await request();
    expect(a.status).toBe(200); expect(a.cache).toBe('private, no-store');
    expect(a.body.result).toMatchObject({ state: 'qualified', status: 'known', temporalReport: { improvement: 'not_established', labelledSamples: 0 } });
    expect(b.body).toMatchObject({ id: a.body.id, version: 2 });
    expect(b.body.contentHash).not.toBe(a.body.contentHash); expect(await count()).toBe(2);
    const events = await f.rows("SELECT payload FROM outbox_events WHERE event_type='operations.baseline.versioned'"); expect(events).toHaveLength(2);
    const cached = await request(`/api/operations/baselines/${a.body.id}`, 'GET');
    expect(cached.body.version).toBe(2); expect(cached.body.result.status).toBe('known');
  });
  it('does not accept client identity/qualification fields or disclose unknown request bodies', async () => {
    const response = await request(undefined, 'POST', { ...input, state: 'qualified', canary: 'PRIVATE_BASELINE' });
    expect(response.status).toBe(422); expect(JSON.stringify(response.body)).not.toContain('PRIVATE_BASELINE'); expect(await count()).toBe(0);
  });
  it('filters cross-resource, revoked permission, expired grant and service delegation before source IO', async () => {
    const spy = vi.spyOn(source, 'load');
    await f.rows('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101');
    expect((await request()).status).toBe(404); expect(spy).not.toHaveBeenCalled();
    await f.rows("INSERT INTO instance_permissions(user_id,instance_id,access_level,grant_expiry) VALUES(101,101,'read-only',DATE_SUB(NOW(),INTERVAL 1 SECOND))");
    expect((await request()).status).toBe(404); expect(spy).not.toHaveBeenCalled();
    const delegated = { ...actor, resourceBoundary: { instanceIds: [102], serverIds: [], networkDeviceIds: [] } };
    await expect(service.compute(delegated, input)).rejects.toMatchObject({ statusCode: 404 });
    expect(spy).not.toHaveBeenCalled();
  });
  it('checks revocation during source IO before persistence or response', async () => {
    afterSource = async () => { await f.rows('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101'); };
    expect((await request()).status).toBe(404); expect(await count()).toBe(0);
  });
  it('does not leak cached content after role revocation or session replacement', async () => {
    const value = await request();
    await f.rows("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='operations:context:view'");
    const hidden = await request(`/api/operations/baselines/${value.body.id}`, 'GET');
    expect(hidden.status).toBe(404); expect(JSON.stringify(hidden.body)).not.toContain('referenceBands');
    await f.rows('UPDATE users SET session_version=2 WHERE id=101');
    expect((await request(`/api/operations/baselines/${value.body.id}`, 'GET')).status).toBe(401);
  });
  it('detects target replacement during source IO and invalidates cached versions later', async () => {
    const before = await request();
    afterSource = async () => { await f.rows("UPDATE database_instances SET host='replacement.invalid' WHERE id=101"); };
    const changed = await request();
    expect(changed.body.result).toMatchObject({ status: 'unknown', reason: 'source_configuration_changed', referenceBands: [] });
    const cached = await request(`/api/operations/baselines/${before.body.id}`, 'GET');
    expect(cached.body.result.status).toBe('unknown'); expect(await count()).toBe(2);
    afterSource = undefined;
    const repeated = await request();
    expect(repeated.body.result.reason).toBe('resource_changed_reaccumulating');
    expect(repeated.body.result.comparison.baselineAnomaly).toBeNull();
  });
  it.each([false, true])('P04-R1 persists replacement boundary across recomputation, series and reload (history=%s)', async history => {
    const original = history ? await service.compute(actor, input) : null;
    expect(await count()).toBe(history ? 1 : 0);
    const retained = await f.rows('SELECT reference_bands FROM behavior_baseline_versions');
    afterSource = async () => {
      await f.rows("UPDATE database_instances SET host='replacement.invalid' WHERE id=101");
      now += 1000;
    };
    const changed = await service.compute(actor, input);
    expect(changed.result.reason).toBe('source_configuration_changed');
    const boundary = new Date(now).toISOString();
    afterSource = undefined;
    const repeated = await service.compute(actor, input), third = await service.compute(actor, input);
    for (const value of [repeated, third]) expect(value.result).toMatchObject({
      status: 'unknown', reason: 'resource_changed_reaccumulating', comparison: { baselineAnomaly: null },
    });
    // A new process/store must recover resource-wide state from SQL, including
    // different metric, dimensions and mode; no in-memory boundary is enough.
    const reloaded = new BaselineStore(() => f.pool, () => source, authorization,
      () => ({ ...operationsFlags({}), baselines: enabled }), () => new Date(now));
    const weekly: BaselineInput = { ...input, metric: 'host.memory.used_ratio', dimensions: { scope: 'all' }, mode: 'weekly' };
    const other = await reloaded.compute(actor, weekly);
    expect(other.result.reason).toBe('resource_changed_reaccumulating');
    expect((await reloaded.read(actor, repeated.id)).result.status).toBe('unknown');
    expect((await request(`/api/operations/baselines/${other.id}`, 'GET')).body.result.status).toBe('unknown');
    if (original) expect((await reloaded.read(actor, original.id)).result.status).toBe('unknown');

    // Synthetic time advancement: 14/28 complete days start AFTER the observed
    // replacement. It is an algorithm boundary test, not real data qualification.
    now += 14 * DAY;
    expect((await reloaded.compute(actor, input)).result.reason).toBe('resource_changed_reaccumulating');
    now = Math.ceil(Date.parse(boundary) / HOUR) * HOUR + 14 * DAY;
    expect((await reloaded.compute(actor, input)).result.status).toBe('known');
    expect((await reloaded.compute(actor, weekly)).result.reason).toBe('resource_changed_reaccumulating');
    now += 14 * DAY;
    expect((await reloaded.compute(actor, weekly)).result).toMatchObject({ status: 'known', state: 'qualified' });
    const rows = await f.rows('SELECT reference_bands FROM behavior_baseline_versions');
    const envelopes = rows.map(r => typeof r.reference_bands === 'string' ? JSON.parse(r.reference_bands) : r.reference_bands);
    expect(envelopes.filter(e => e.targetSince === boundary)).toHaveLength(rows.length - retained.length);
    if (retained.length) expect(rows).toContainEqual(retained[0]);
    expect(await f.rows("SELECT id FROM outbox_events WHERE event_type='operations.baseline.versioned'")).toHaveLength(rows.length);
    if (process.env.P04_R1_REPORT) writeFileSync(`${process.env.P04_R1_REPORT}-${history ? 'history' : 'first'}.json`, JSON.stringify({
      kind: 'real-isolated-mysql-production-store-and-authorization-synthetic-long-windows', history,
      firstReason: changed.result.reason, repeatedReason: repeated.result.reason, crossSeriesReason: other.result.reason,
      targetSince: boundary, persistedBoundaries: envelopes.map(e => e.targetSince), versions: rows.length,
      actualLongTermQualification: false, productModelCalls: 0,
    }, null, 2));
  });
  it('P04-R1 keeps resource ordering across series when SQL creation timestamps tie', async () => {
    for (let i = 0; i < 3; i++) await service.compute(actor, input);
    afterSource = async () => { await f.rows("UPDATE database_instances SET host='replacement.invalid' WHERE id=101"); };
    await service.compute(actor, { ...input, mode: 'weekly' });
    afterSource = undefined;
    // created_at is DATETIME(3), while version is scoped to id, so neither can
    // establish a total resource order across high/low-version metric series.
    await f.rows('UPDATE behavior_baseline_versions SET created_at=?', [new Date(now)]);
    const repeated = await service.compute(actor, input);
    expect(repeated.result.reason).toBe('resource_changed_reaccumulating');
    const [row] = await f.rows('SELECT reference_bands FROM behavior_baseline_versions WHERE id=? AND version=?', [repeated.id, repeated.version]);
    const envelope = typeof row.reference_bands === 'string' ? JSON.parse(row.reference_bands) : row.reference_bands;
    expect(envelope.targetSince).toBe(new Date(now).toISOString());
  });
  it('P04-R1 final snapshot and cached reads respect a boundary committed by interleaved series', async () => {
    const original = await service.compute(actor, input);
    const boundary = new Date(now).toISOString();
    afterSource = async () => {
      afterSource = undefined;
      await f.rows("UPDATE database_instances SET host='replacement.invalid' WHERE id=101");
      await service.compute(actor, { ...input, mode: 'weekly' });
      await f.rows("UPDATE database_instances SET host='fixture.invalid' WHERE id=101");
      await service.compute(actor, { ...input, mode: 'weekly' });
    };
    // The final fence equals the original again, but old windows are still
    // disallowed after the persisted A -> B -> A identity transition.
    expect((await service.compute(actor, { ...input, metric: 'host.memory.used_ratio' })).result.reason)
      .toBe('resource_changed_reaccumulating');
    expect((await service.read(actor, original.id)).result.reason).toBe('resource_changed_reaccumulating');
    const rows = await f.rows('SELECT reference_bands FROM behavior_baseline_versions WHERE id<>?', [original.id]);
    for (const row of rows) {
      const envelope = typeof row.reference_bands === 'string' ? JSON.parse(row.reference_bands) : row.reference_bands;
      expect(envelope.targetSince).toBe(boundary);
    }
  });
  it('asset collection disable makes retained and newly calculated references unknown', async () => {
    const before = await request();
    await f.rows("UPDATE database_instances SET status='inactive' WHERE id=101");
    const cached = await request(`/api/operations/baselines/${before.body.id}`, 'GET');
    expect(cached.body.result.reason).toBe('resource_collection_disabled');
    expect((await request()).body.result.reason).toBe('resource_collection_disabled');
  });
  it('rechecks time after final asynchronous authorization', async () => {
    const original = authorization.authorize.bind(authorization); let checks = 0;
    vi.spyOn(authorization, 'authorize').mockImplementation(async (...args) => {
      const value = await original(...args); if (++checks === 3) now += 180_000; return value;
    });
    const result = await request();
    expect(result.body.result).toMatchObject({ status: 'unknown', reason: 'expired', comparison: { baselineAnomaly: null } });
  });
  it('expires static fallback after final authorization even when history is insufficient', async () => {
    const originalLoad = source.load.bind(source);
    source.load = async (...args) => ({ ...await originalLoad(...args), buckets: [] });
    const fallbackInput = { ...input, staticThreshold: { operator: '>' as const, value: 100 } };
    const first = await request(undefined, 'POST', fallbackInput);
    expect(first.body.result).toMatchObject({ status: 'unknown', staticComparison: { status: 'known' } });
    const original = authorization.authorize.bind(authorization); let checks = 0;
    vi.spyOn(authorization, 'authorize').mockImplementation(async (...args) => {
      const value = await original(...args); if (++checks === 2) now += 180_000; return value;
    });
    const cached = await request(`/api/operations/baselines/${first.body.id}`, 'GET');
    expect(cached.body.result).toMatchObject({ reason: 'expired', staticComparison: { status: 'unknown', value: null, anomaly: null } });
    checks = -1;
    const computed = await request(undefined, 'POST', fallbackInput);
    expect(computed.body.result).toMatchObject({ reason: 'expired', staticComparison: { status: 'unknown', value: null } });
  });
  it('retains original records on expiry and disabled feature, rejects new work', async () => {
    const value = await request(); enabled = false;
    expect((await request()).status).toBe(422);
    const retained = await request(`/api/operations/baselines/${value.body.id}`, 'GET');
    expect(retained.body.result).toMatchObject({ status: 'unknown', reason: 'feature_disabled' }); expect(await count()).toBe(1);
    enabled = true; now += 180_000;
    expect((await request(`/api/operations/baselines/${value.body.id}`, 'GET')).body.result.reason).toBe('expired');
    const [original] = await f.rows('SELECT state FROM behavior_baseline_versions'); expect(original.state).toBe('qualified');
  });
  it('sends nothing when the final ACL check fails and rolls back the new version/event', async () => {
    const original = authorization.authorize.bind(authorization); let checks = 0, sends = 0;
    vi.spyOn(authorization, 'authorize').mockImplementation(async (...args) => {
      if (++checks === 3) throw new OperationsError('OPERATIONS_NOT_FOUND'); return original(...args);
    });
    await expect(service.compute(actor, input, () => { sends++; })).rejects.toMatchObject({ statusCode: 404 });
    expect(sends).toBe(0); expect(await count()).toBe(0);
    expect(await f.rows("SELECT id FROM outbox_events WHERE event_type='operations.baseline.versioned'")).toHaveLength(0);
  });

  it('real fixed SQL → source acceptance → formal publication → baseline HTTP stays unknown for short observations', async () => {
    const registry = createConfigurationRegistry(), ref = { type: 'instance' as const, id: 101 };
    const [version] = await f.rows('SELECT VERSION() version');
    await f.rows("UPDATE database_instances SET host='127.0.0.1',port=?,db_type='mysql',db_version=? WHERE id=101", [port, version.version]);
    const inventory = () => ({ type: ref.type, id: String(ref.id), attributes: {
      'db.engine': { value: 'mysql', observed_at: new Date(now).toISOString(), source: 'real_driver' },
      'db.version': { value: version.version, observed_at: new Date(now).toISOString(), source: 'real_driver' },
    } });
    const policy = new PolicyService(new MysqlPolicyStore(() => f.pool), registry,
      { exists: async () => true, inventory: async () => inventory() }, () => new Date(now).toISOString());
    const release = registry.list().find(r => r.package.id === 'mysql-basic' && r.package.version === '2.0.0')!.package;
    const administrator = { ...actor, permissions: ['*'], instanceScopes: {} };
    await policy.changeBinding(administrator, ref, { expected_revision: 0,
      package: { id: release.id, version: release.version, digest: release.digest },
      overrides: { interval_ms: { mode: 'set', value: 1000 }, timeout_ms: { mode: 'set', value: 1000 } } }, true);
    let reads = 0;
    const schedule = new MysqlScheduleStore(f.pool, registry, 'production');
    const scheduler = new MetricScheduler(schedule, registry, { resolve: async () => ({ resource: inventory(),
      credential_ref: 'credential:p04-isolated-sql', evidence: {}, resolve: async () => ({ method: 'sql', pool: {
        query: async options => { expect(options.sql).toBe(MYSQL_STATUS_SQL); reads++; return f.pool.query(options); },
      } }) }) }, () => now, undefined, new MetricFormalization(f.pool, registry, () => new Date(now)));
    const jobs = new JobRegistry(); scheduler.register(jobs);
    const worker = new WorkerRuntime(new MysqlWorkflowStore(() => f.pool as never), 'p04-real-sql', 30);
    await scheduler.tick();
    for (let i = 0; i < 4; i++) {
      now += 1001; await scheduler.tick();
      await f.rows("UPDATE workflow_jobs SET available_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE state='queued'");
      expect(await worker.runOnce((job, context) => jobs.execute(job, context), now)).toBe('completed');
    }
    expect(reads).toBe(4);
    const publications = await f.rows('SELECT COUNT(*) n FROM metric_publications'); expect(Number(publications[0].n)).toBe(3);
    const formal = new MysqlFormalMetricStore(f.pool);
    const consumer = new MetricConsumerService(policy, registry, { queryWindow: (...args) => formal.queryWindow(...args),
      dimensions: (...args) => formal.dimensions(...args), inventory: async () => inventory(), attempts: async () => [] }, () => new Date(now + 1).toISOString());
    now += 1;
    source = new FormalBaselineSource(formal, consumer, () => new Date(now));
    const realInput: BaselineInput = { resource: ref, metric: 'db.uptime_seconds', dimensions: {}, mode: 'daily', staticThreshold: { operator: '>', value: 99999999 } };
    const measured = await request(undefined, 'POST', realInput);
    expect(measured.status).toBe(200);
    expect(measured.body.result).toMatchObject({ status: 'unknown', state: 'invalidated', reason: 'long_gap', series: { unit: 's' }, comparison: { baselineAnomaly: null } });
    expect(measured.body.result.series.source.id).toBe('mysql-status');
    expect(measured.body.result.quality.validDays).toBe(0);
    expect(measured.body.result.staticComparison).toMatchObject({ status: 'known', anomaly: false, threshold: realInput.staticThreshold });
    const queried = await consumer.query(actor, { resource: ref });
    expect(queried.metrics[0].series[0].buckets.some(b => b.value !== null)).toBe(true);
    const before = Number((await f.rows('SELECT COUNT(*) n FROM metric_observations'))[0].n);
    const cached = await request(`/api/operations/baselines/${measured.body.id}`, 'GET'); expect(cached.status).toBe(200);
    const attemptsBefore = Number((await f.rows('SELECT COUNT(*) n FROM metric_attempts'))[0].n);
    // Configuration changed while the source IO was outstanding: no stale
    // qualified result can escape the final control snapshot.
    afterSource = async () => { await f.rows("UPDATE metric_policy_bindings SET capabilities='[]' WHERE resource_key='instance:101'"); };
    const lateConfiguration = await request(undefined, 'POST', realInput);
    expect(lateConfiguration.body.result.reason).toBe('source_configuration_changed');
    afterSource = undefined;
    await f.rows("UPDATE metric_rollout SET read_mode='legacy' WHERE resource_type='instance' AND resource_id='101'");
    const rolledBack = await request(`/api/operations/baselines/${measured.body.id}`, 'GET');
    expect(rolledBack.body.result.reason).toBe('source_configuration_changed');
    expect(Number((await f.rows('SELECT COUNT(*) n FROM metric_observations'))[0].n)).toBe(before);
    expect(Number((await f.rows('SELECT COUNT(*) n FROM metric_attempts'))[0].n)).toBe(attemptsBefore);
    if (process.env.P04_REAL_REPORT) writeFileSync(process.env.P04_REAL_REPORT, JSON.stringify({
      kind: 'real-isolated-local-mysql-measurements-controlled-scheduler-clock', target: 'own-isolated-mysql', version: version.version,
      fixedSqlReads: reads, formalPublications: Number(publications[0].n), measured: measured.body,
      cachedStatus: cached.status, rollbackReason: rolledBack.body.result.reason, retainedObservationCount: before,
      lateConfigurationReason: lateConfiguration.body.result.reason, baselineTriggeredCollectionAttempts: 0,
      effectiveObservationDays: 0, fourteenOrTwentyEightDaysQualified: false, productModelCalls: 0,
    }, null, 2));
  }, 60_000);
});
