import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { definitions, identify, sample } from '../../contracts/metrics/fixtures.js';
import type { Resource } from '../../contracts/metrics/index.js';
import { createConfigurationRegistry } from '../config/registry.js';
import type { Published } from '../policy/model.js';
import { resolvePolicy } from '../policy/resolver.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { MysqlMetricStorage, seriesHash } from '../storage.js';
import { RolloutControl } from './control.js';
import { MysqlRolloutCoordinator } from './coordinator.js';

const port = Number(process.env.METRICS_TEST_MYSQL_PORT);

describe.skipIf(!port)('resource rollout coordinator', () => {
  let root: Pool;
  let pool: Pool;
  let coordinator: MysqlRolloutCoordinator;
  let policies: MysqlPolicyStore;
  const database = `max85_coordinator_${process.pid}`;
  const ref = { type: 'instance' as const, id: 1 };
  const registry = createConfigurationRegistry();
  const packagePin = (() => {
    const { id, version, digest } = registry.list().find(item => item.package.id === 'mysql-basic')!.package;
    return { id, version, digest };
  })();
  const actor = { userId: 7, requestId: 'rollout-test' };
  const publishedAt = (revision: number) => new Date(Date.UTC(2026, 9, 29, 0, 0, revision)).toISOString();
  const resource: Resource = { type: 'instance', id: '1', attributes: {
    'db.engine': { value: 'mysql', observed_at: publishedAt(1), source: 'fixture' },
    'db.version': { value: '8.4.10', observed_at: publishedAt(1), source: 'fixture' },
  } };

  /**
   * The exact `Published` the resolver writes, rather than a hand-written sparse
   * payload: the strict reader must accept a row the producer actually stores.
   */
  const published = (revision: number): Published => {
    const binding = { resource: ref, package: packagePin, group_id: null, overrides: {}, revision };
    const resolved = resolvePolicy(registry, binding, null, resource, [], publishedAt(revision));
    return { binding, resolved, published_at: publishedAt(revision),
      application: { applied_revision: null, reported_at: null, status: 'pending', error_code: null } };
  };
  const writePublished = (revision: number) => policies.transaction(tx => tx.saveBinding(published(revision), true));

  const observation = (definitionIndex: number, revision: number) => {
    const base = sample(definitions[definitionIndex].id);
    return identify({
      ...base,
      resource_id: '1',
      versions: { ...base.versions, package_id: packagePin.id, package_version: packagePin.version, config_revision: revision },
    });
  };

  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 12 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    coordinator = new MysqlRolloutCoordinator(pool);
    policies = new MysqlPolicyStore(() => pool);
  }, 120000);

  afterAll(async () => {
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM metric_source_checks');
    await pool.query('DELETE FROM metric_rollout_events');
    await pool.query('DELETE FROM metric_rollout_resources');
    await pool.query('DELETE FROM metric_rollout');
    await pool.query('DELETE FROM metric_publications');
    await pool.query('DELETE FROM metric_observations');
    await pool.query('DELETE FROM metric_policy_bindings');
    await writePublished(1);
    const storage = new MysqlMetricStorage(pool);
    await storage.write(observation(0, 1), definitions[0]);
    await storage.write(observation(6, 1), definitions[6]);
    const samples=[observation(0,1),observation(6,1)];
    await pool.execute('INSERT INTO metric_source_checks(resource_key,revision,payload,checked_at) VALUES(?,1,?,NOW())',['instance:1',JSON.stringify({
      mode:'same_actual_source_snapshot',remote_requests_added:0,resource:ref,revision:1,measured_at:new Date().toISOString(),sample_ids:samples.map(o=>o.id),
      checks:samples.map(o=>({sample_id:o.id,metric_id:o.metric.id,state:'passed',unit:o.unit,dimensions:o.dimensions})),semantic_differences:[]})]);
  });

  it('derives shadow series server-side and rejects an incomplete comparison gate', async () => {
    await expect(coordinator.startShadow(ref, 1, actor)).resolves.toMatchObject({ phase: 'shadow', series_count: 2, revision: 1 });
    const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM metric_rollout ORDER BY series_hash');
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.source === 'legacy' && row.read_mode === 'legacy'
      && Number(row.applied_revision) === 1 && Number(row.generation) === 1)).toBe(true);

    await expect(coordinator.acceptShadow(ref, 1, {
      sample_count: 2,
      source_conflicts: 0,
      duplicate_formal_writes: 0,
      duplicate_alerts: 0,
      value_mismatches: 1,
      unit_mismatches: 0,
      dimension_mismatches: 0,
      quality_mismatches: 0,
      freshness_mismatches: 0,
      missing_mismatches: 0,
      derived_mismatches: 0,
      performance_regressions: 0,
    }, actor)).rejects.toThrow('ROLLOUT_SHADOW_GATE_FAILED');
  });

  it('rejects a caller zero gate when no server measurement exists',async()=>{
    await coordinator.startShadow(ref,1,actor);await pool.query('DELETE FROM metric_source_checks');
    await expect(coordinator.acceptShadow(ref,1,{sample_count:2,source_conflicts:0,duplicate_formal_writes:0,duplicate_alerts:0,value_mismatches:0,
      unit_mismatches:0,dimension_mismatches:0,quality_mismatches:0,freshness_mismatches:0,missing_mismatches:0,derived_mismatches:0,performance_regressions:0},actor)).rejects.toThrow('ROLLOUT_MEASURED_GATE_REQUIRED');
  });

  it('drains legacy writes, switches all series atomically, confirms applied, and rolls back without deleting history', async () => {
    await coordinator.startShadow(ref, 1, actor);
    await coordinator.acceptShadow(ref, 1, {
      sample_count: 2,
      source_conflicts: 0,
      duplicate_formal_writes: 0,
      duplicate_alerts: 0,
      value_mismatches: 0,
      unit_mismatches: 0,
      dimension_mismatches: 0,
      quality_mismatches: 0,
      freshness_mismatches: 0,
      missing_mismatches: 0,
      derived_mismatches: 0,
      performance_regressions: 0,
    }, actor);
    await writePublished(2);

    const legacy = await pool.getConnection();
    await legacy.beginTransaction();
    await legacy.query('SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE');
    let switched = false;
    const cutover = coordinator.cutover(ref, { expected_shadow_revision: 1, expected_generation: 1 }, actor)
      .then(value => { switched = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(switched).toBe(false);
    await legacy.commit();
    legacy.release();

    await expect(cutover).resolves.toMatchObject({ phase: 'cutover_pending', revision: 2, generation: 2, series_count: 2 });
    const [pending] = await pool.query<RowDataPacket[]>('SELECT * FROM metric_rollout ORDER BY series_hash');
    expect(pending.every(row => row.source === 'semantic' && row.read_mode === 'semantic'
      && row.applied_revision === null && Number(row.generation) === 2)).toBe(true);

    const control = new RolloutControl(pool);
    for (const series of [observation(0, 1), observation(6, 1)]) {
      await control.applied(series, { source: 'semantic', generation: 2, revision: 2 });
    }
    await expect(coordinator.confirmApplied(ref, 2, actor)).resolves.toMatchObject({ phase: 'semantic', applied_series: 2 });
    expect(await coordinator.collectionEnabled(ref)).toBe(true);

    const before = await pool.query<RowDataPacket[]>('SELECT id, payload_hash FROM metric_observations ORDER BY id');
    await writePublished(3);
    await expect(coordinator.rollback(ref, { expected_revision: 2, expected_generation: 2 }, actor))
      .resolves.toMatchObject({ phase: 'legacy', revision: 3, generation: 3, series_count: 2 });
    const [rolledBack] = await pool.query<RowDataPacket[]>('SELECT * FROM metric_rollout ORDER BY series_hash');
    expect(rolledBack.every(row => row.source === 'legacy' && row.read_mode === 'legacy'
      && Number(row.applied_revision) === 3 && Number(row.generation) === 3)).toBe(true);
    expect(await coordinator.collectionEnabled(ref)).toBe(false);
    expect(await pool.query<RowDataPacket[]>('SELECT id, payload_hash FROM metric_observations ORDER BY id')).toEqual(before);

    const [events] = await pool.query<RowDataPacket[]>('SELECT action FROM metric_rollout_events ORDER BY id');
    expect(events.map(row => row.action)).toEqual(['shadow_started', 'shadow_accepted', 'cutover_started', 'cutover_applied', 'rollback_applied']);
    expect(await coordinator.status(ref)).toMatchObject({ phase: 'legacy', series_count: 2, applied_series: 2 });
    expect(seriesHash(observation(0, 1))).not.toBe(seriesHash(observation(6, 1)));
  });
});
