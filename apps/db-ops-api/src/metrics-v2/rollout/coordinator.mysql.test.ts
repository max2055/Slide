import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { definitions, identify, sample } from '../../contracts/metrics-v2/fixtures.js';
import { MysqlMetricStorage, seriesHash } from '../storage.js';
import { RolloutControl } from './control.js';
import { MysqlRolloutCoordinator } from './coordinator.js';

const port = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);

describe.skipIf(!port)('resource rollout coordinator', () => {
  let root: Pool;
  let pool: Pool;
  let coordinator: MysqlRolloutCoordinator;
  const database = `max85_coordinator_${process.pid}`;
  const ref = { type: 'instance' as const, id: 1 };
  const packagePin = { id: 'fixture', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` };
  const actor = { userId: 7, requestId: 'rollout-test' };

  const published = (revision: number) => ({
    binding: { resource: ref, package: packagePin, group_id: null, overrides: {}, revision },
    resolved: { settings: { enabled: true } },
    published_at: new Date(revision * 1000).toISOString(),
    application: { applied_revision: revision, reported_at: new Date(revision * 1000).toISOString(), status: 'applied', error_code: null },
  });

  const observation = (definitionIndex: number, revision: number) => identify({
    ...sample(definitions[definitionIndex].id),
    resource_id: '1',
    versions: { ...sample(definitions[definitionIndex].id).versions, config_revision: revision },
  });

  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 12 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    coordinator = new MysqlRolloutCoordinator(pool);
  }, 120000);

  afterAll(async () => {
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM metric_v2_rollout_events');
    await pool.query('DELETE FROM metric_v2_rollout_resources');
    await pool.query('DELETE FROM metric_v2_rollout');
    await pool.query('DELETE FROM metric_v2_publications');
    await pool.query('DELETE FROM metric_v2_observations');
    await pool.query('DELETE FROM metric_v2_policy_bindings');
    await pool.query('INSERT INTO metric_v2_policy_bindings (resource_key, group_id, payload, capabilities) VALUES (?, NULL, ?, ?)',
      ['instance:1', JSON.stringify(published(1)), '[]']);
    const storage = new MysqlMetricStorage(pool);
    await storage.write(observation(0, 1), definitions[0]);
    await storage.write(observation(6, 1), definitions[6]);
  });

  it('derives shadow series server-side and rejects an incomplete comparison gate', async () => {
    await expect(coordinator.startShadow(ref, 1, actor)).resolves.toMatchObject({ phase: 'shadow', series_count: 2, revision: 1 });
    const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_rollout ORDER BY series_hash');
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.source === 'legacy' && row.read_mode === 'legacy'
      && Number(row.applied_revision) === 1 && Number(row.generation) === 1)).toBe(true);

    await expect(coordinator.acceptShadow(ref, 1, {
      sample_count: 20,
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

  it('drains legacy writes, switches all series atomically, confirms applied, and rolls back without deleting history', async () => {
    await coordinator.startShadow(ref, 1, actor);
    await coordinator.acceptShadow(ref, 1, {
      sample_count: 20,
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
    await pool.query('UPDATE metric_v2_policy_bindings SET payload = ? WHERE resource_key = ?', [JSON.stringify(published(2)), 'instance:1']);

    const legacy = await pool.getConnection();
    await legacy.beginTransaction();
    await legacy.query('SELECT id FROM metric_v2_policy_lock WHERE id = 1 FOR UPDATE');
    let switched = false;
    const cutover = coordinator.cutover(ref, { expected_shadow_revision: 1, expected_generation: 1 }, actor)
      .then(value => { switched = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(switched).toBe(false);
    await legacy.commit();
    legacy.release();

    await expect(cutover).resolves.toMatchObject({ phase: 'cutover_pending', revision: 2, generation: 2, series_count: 2 });
    const [pending] = await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_rollout ORDER BY series_hash');
    expect(pending.every(row => row.source === 'v2' && row.read_mode === 'v2'
      && row.applied_revision === null && Number(row.generation) === 2)).toBe(true);

    const control = new RolloutControl(pool);
    for (const series of [observation(0, 1), observation(6, 1)]) {
      await control.applied(series, { source: 'v2', generation: 2, revision: 2 });
    }
    await expect(coordinator.confirmApplied(ref, 2, actor)).resolves.toMatchObject({ phase: 'v2', applied_series: 2 });
    expect(await coordinator.collectionEnabled(ref)).toBe(true);

    const before = await pool.query<RowDataPacket[]>('SELECT id, payload_hash FROM metric_v2_observations ORDER BY id');
    await pool.query('UPDATE metric_v2_policy_bindings SET payload = ? WHERE resource_key = ?', [JSON.stringify(published(3)), 'instance:1']);
    await expect(coordinator.rollback(ref, { expected_revision: 2, expected_generation: 2 }, actor))
      .resolves.toMatchObject({ phase: 'legacy', revision: 3, generation: 3, series_count: 2 });
    const [rolledBack] = await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_rollout ORDER BY series_hash');
    expect(rolledBack.every(row => row.source === 'legacy' && row.read_mode === 'legacy'
      && Number(row.applied_revision) === 3 && Number(row.generation) === 3)).toBe(true);
    expect(await coordinator.collectionEnabled(ref)).toBe(false);
    expect(await pool.query<RowDataPacket[]>('SELECT id, payload_hash FROM metric_v2_observations ORDER BY id')).toEqual(before);

    const [events] = await pool.query<RowDataPacket[]>('SELECT action FROM metric_v2_rollout_events ORDER BY id');
    expect(events.map(row => row.action)).toEqual(['shadow_started', 'shadow_accepted', 'cutover_started', 'cutover_applied', 'rollback_applied']);
    expect(await coordinator.status(ref)).toMatchObject({ phase: 'legacy', series_count: 2, applied_series: 2 });
    expect(seriesHash(observation(0, 1))).not.toBe(seriesHash(observation(6, 1)));
  });
});
