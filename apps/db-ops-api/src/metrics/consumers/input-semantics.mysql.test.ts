import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { CollectionAttemptSchema, type CollectionAttempt, type NormalizedObservation, type Resource } from '../../contracts/metrics/index.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { bindMySql } from '../packages/adapters.js';
import { runPackage } from '../packages/runner.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';
import { MysqlMetricStorage } from '../storage.js';
import { RolloutControl } from '../rollout/control.js';
import { MysqlFormalMetricStore } from '../rollout/formal-store.js';
import { MetricConsumerService } from './service.js';
import { registerMetricConsumerRoutes } from './routes.js';

// Explicit, isolated MySQL 8.x fixture: no developer credentials/default platform database.
const port = Number(process.env.MAX517_MYSQL_PORT);
describe.skipIf(!port)('MAX-517/#529/#530 real collection → derived → formal storage → HTTP', () => {
  const database = `max517_${process.pid}`, ref = { type: 'instance' as const, id: 517 };
  const registry = createConfigurationRegistry();
  const release = registry.list().find(r => r.package.id === 'mysql-representative')!;
  const { id, version, digest } = release.package, pin = { id, version, digest };
  const metric = 'mysql.transaction_commands.commit_rate';
  let root: Pool, pool: Pool, app: ReturnType<typeof Fastify>, resource: Resource, policies: PolicyService;
  let derived: NormalizedObservation;
  let base: string;
  let now = Date.now() - 60000;
  const at = () => new Date(now).toISOString();
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, timezone: 'Z', connectionLimit: 4, supportBigNumbers: true, bigNumberStrings: true });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    const [versions] = await root.query<RowDataPacket[]>('SELECT VERSION() AS version');
    resource = { type: 'instance', id: String(ref.id), attributes: {
      'db.engine': { value: 'mysql', source: 'actual_driver', observed_at: at() },
      'db.version': { value: versions[0].version, source: 'actual_driver', observed_at: at() },
    } };
    const policyStore = new MysqlPolicyStore(() => pool);
    policies = new PolicyService(policyStore, registry, { exists: async () => true, inventory: async () => resource }, at);
    await policies.changeBinding(admin, ref, { expected_revision: 0, package: pin }, true);
    const storage = new MysqlMetricStorage(pool), control = new RolloutControl(pool), initialized = new Set<string>();
    let states: Awaited<ReturnType<typeof runPackage>>['states'] | undefined;
    for (let cycle = 0; cycle < 2; cycle++) {
      await root.query('COMMIT'); await root.query('COMMIT');
      const result = await runPackage(registry, { package: pin, credential_ref: 'credential:isolated-max517', overrides: {} }, {
        resource, binding_id: 'instance:517', attempt_id: `max517-${cycle}`, config_revision: 1, observed_at: at(), states,
        // Stable lifecycle is controlled for this two-cycle fixture, not production restart proof.
        evidence: { counter: { bits: '64', start_at: new Date(now - 3600000 - cycle * 60000).toISOString() } },
        resolve: async () => bindMySql(root), clock: at,
      });
      expect(result.attempts.every(a => a.status === 'succeeded')).toBe(true);
      states = result.states;
      for (const attempt of result.attempts) await storage.writeAttempt(attempt);
      await policyStore.transaction(tx => tx.saveCapabilities(ref, result.capabilities));
      for (const { observation } of result.observations) {
        if (![metric, 'db.uptime_seconds'].includes(observation.metric.id)) continue;
        if (observation.metric.id === metric) derived = observation;
        const ticket = { source: 'semantic', revision: 1, generation: 1 };
        if (!initialized.has(observation.metric.id)) {
          await control.initialize(observation, { source: 'semantic', read: 'semantic', revision: 1, package: pin });
          await control.applied(observation, ticket); initialized.add(observation.metric.id);
        }
        await control.publish(observation, registry.catalog(pin).find(d => d.id === observation.metric.id)!, ticket);
      }
      if (cycle === 0) now += 60000;
    }
    now += 1;
    const formal = new MysqlFormalMetricStore(pool);
    const consumer = new MetricConsumerService(policies, registry, {
      queryWindow: (...args) => formal.queryWindow(...args), dimensions: (...args) => formal.dimensions(...args),
      inventory: async () => resource, attempts: async () => {
        const [rows] = await pool.query<RowDataPacket[]>('SELECT payload FROM metric_attempts');
        return rows.map(r => CollectionAttemptSchema.parse(typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));
      },
    }, at);
    app = Fastify(); await registerMetricConsumerRoutes(app, async r => { (r as any).user = admin; }, consumer);
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  }, 120000);
  afterAll(async () => {
    await app?.close(); await pool?.end();
    if (root) { try { await root.query(`DROP DATABASE IF EXISTS ${database}`); } finally { await root.end(); } }
  });
  const query = async (metric_id = metric) => {
    const response = await post('query', { resource: ref, metric_ids: [metric_id] });
    expect(response.status).toBe(200); return (await response.json() as any).metrics[0];
  };
  const post = (path: string, payload: unknown) => fetch(`${base}/api/metrics/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const failed = async (collector_id: string, error: CollectionAttempt['error']) => {
    now += 1;
    await new MysqlMetricStorage(pool).writeAttempt({ id: `fault-${collector_id}-${now}`, resource_id: '517', binding_id: 'instance:517',
      collector_id, config_revision: 1, started_at: at(), ended_at: at(), status: error ? 'failed' : 'succeeded', error, observation_ids: [] });
  };
  it('keeps real derived values visible after an unrelated persisted failure; fails conservatively and resumes on its own dependency', async () => {
    const before = await query();
    expect(before.state).toBe('available');
    // A real counter delta / 60 need not be exactly representable in float64.
    // Preserve the processor's value and quality instead of upgrading precision.
    expect(derived.value).not.toBeNull();
    const bucket = before.series[0].buckets[0];
    expect(bucket).toMatchObject({ quality: derived.quality, accuracy: derived.accuracy });
    expect(bucket.sources.some((s: { id: string }) => s.id === derived.id)).toBe(true);
    if (derived.value?.encoding !== 'float64') throw new Error('RATE_ENCODING');
    // Rational re-encoding by the query reducer may differ by one ULP.
    expect(bucket.value.value).toBeCloseTo(derived.value.value, 14);
    await failed('mysql-connections', 'permission_denied');
    const after = await query();
    expect(after.state).toBe('available'); expect(after.attempt.collector_id).toBe('mysql-transactions');
    expect(after.series[0].buckets[0].value).toEqual(before.series[0].buckets[0].value);
    await failed('mysql-transactions', 'permission_denied');
    expect(await query()).toMatchObject({ state: 'permission_denied', series: [] });
    await failed('mysql-transactions', 'timeout');
    expect(await query()).toMatchObject({ state: 'temporary_failure' });
    await failed('mysql-transactions', null);
    expect(await query()).toMatchObject({ state: 'available' });
  });
  it('rejects overlapping thresholds and returns mutually exclusive judgments from formal real-SQL evidence', async () => {
    const observed = await query('db.uptime_seconds'), value = observed.series[0].buckets[0].value.value;
    for (const operator of ['>', '>=', '<', '<=', '=', '!=']) {
      const policy = { metric_id: 'db.uptime_seconds', unit: 's', threshold: value, operator, duration_seconds: 0, recovery_seconds: 0 };
      const response = await post('evaluate', {
        query: { resource: ref, metric_ids: [policy.metric_id] }, policies: [policy],
      });
      expect(response.status).toBe(200);
      const check = (await response.json() as any).assessment.checks[0];
      expect(['healthy', 'firing']).toContain(check.state);
      expect(check.state === 'firing' && check.recovery).toBe(false);
    }
    const response = await post('evaluate', {
      query: { resource: ref, metric_ids: ['db.uptime_seconds'] }, policies: [{ metric_id: 'db.uptime_seconds', unit: 's',
        operator: '>', threshold: value - 1, recovery_threshold: value + 1, duration_seconds: 0, recovery_seconds: 0 }],
    });
    expect(response.status).toBe(400);
    await response.json();
  });
});
