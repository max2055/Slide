import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, MigrationRunner, splitSqlStatements } from '../migrations/runner.js';
import type { MigrationPool } from '../migrations/types.js';
import { definitions, observations, identify, rawObservation, resources, timeoutAttempt } from '../contracts/metrics-v2/fixtures.js';
import { MysqlMetricStorage, seriesHash } from './storage.js';
import { MetricStorageAdapter } from './compatibility.js';
import { MysqlObservationStore, ObservationService } from '../resources/observation-service.js';

// Opt-in disposable localhost MySQL. Never reads application .env or an existing database.
const port = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);
describe.skipIf(!port)('Metrics V2 isolated MySQL', () => {
  let admin: Pool, pool: Pool, upgrade: Pool;
  let storage: MysqlMetricStorage;
  let directory: string;
  const database = `max65_${process.pid}`;
  const upgradeDatabase = `${database}_upgrade`;
  let now = new Date('2026-09-01T00:02:00Z');
  const runner = (p: Pool, dir?: string) => new MigrationRunner(p as unknown as MigrationPool, dir);

  beforeAll(async () => {
    admin = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.query(`CREATE DATABASE ${upgradeDatabase}`);
    const options = { host: '127.0.0.1', port, user: 'root', password: '', connectionLimit: 8, timezone: 'Z' };
    pool = mysql.createPool({ ...options, database });
    upgrade = mysql.createPool({ ...options, database: upgradeDatabase });
    directory = await mkdtemp(join(tmpdir(), 'max65-migrations-'));
    // Full empty-install migration chain, not a mock or manually fabricated schema.
    await runner(pool).run();
    for (const migration of (await loadMigrations()).filter(m => m.id < '098_')) await writeFile(join(directory, migration.id), migration.sql);
    await runner(upgrade, directory).run();
  }, 120000);

  afterAll(async () => {
    await pool?.end(); await upgrade?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.query(`DROP DATABASE IF EXISTS ${upgradeDatabase}`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['metric_v2_observations', 'metric_v2_attempts', 'metric_v2_inventory']) await pool.query(`DELETE FROM ${table}`);
    now = new Date('2026-09-01T00:02:00Z');
    storage = new MysqlMetricStorage(pool, () => now);
  });

  it('fresh install ledger is complete; rerun skips even non-idempotent CREATE TABLE', async () => {
    const before = await runner(pool).inspect();
    expect(before.find(m => m.migration_id === '098_metric_v2_storage.sql')?.status).toBe('completed');
    await runner(pool).run();
    expect(await runner(pool).inspect()).toEqual(before);
  });

  it('upgrades populated legacy tables without changing values; legacy API and explicit fallback stay usable', async () => {
    await upgrade.query("INSERT INTO database_instances (name, db_type, host, port, username, password_encrypted) VALUES ('fixture', 'mysql', 'localhost', 3306, 'fixture', 'not-a-secret')");
    await upgrade.query("INSERT INTO metrics_history (instance_id, cpu_usage, recorded_at) VALUES (1, 12.5, '2026-09-01 00:00:00')");
    const [before] = await upgrade.query('SELECT * FROM metrics_history');
    await runner(upgrade).run();
    expect((await upgrade.query('SELECT * FROM metrics_history'))[0]).toEqual(before);
    const oldStore = new MysqlObservationStore(() => upgrade as never);
    const oldRead = () => oldStore.latestInstanceMetric(1, 'cpu_usage');
    expect((await oldRead())?.value).toBe(12.5);
    const service = new ObservationService(oldStore);
    const actor = { userId: 1, username: 'test', permissions: ['instance:*'], instanceScopes: {}, roles: [], sessionVersion: 1, requestId: 'max65-test' };
    const result = await service.latest(actor, { type: 'instance', id: 1 }, 'cpu_usage', { validForMs: 120000, now: new Date('2026-09-01T00:01:00Z') });
    expect(result.value).toBe(12.5);
    const upgradedStorage = new MysqlMetricStorage(upgrade, () => now);
    const legacy = new MetricStorageAdapter(upgradedStorage);
    expect(await legacy.latest(observations[0], oldRead, 'metrics_history')).toMatchObject({ value: 12.5, provenance: { contract: 'legacy', semantic_version: null }, quality: { reason: 'legacy_unknown' } });
    let writes = 0;
    const writeLegacy = async () => { writes++; };
    await legacy.write(observations[0], definitions[0], writeLegacy);
    expect(await upgradedStorage.latest(observations[0])).toBeNull();
    const shadow = new MetricStorageAdapter(upgradedStorage, { read: 'legacy', write: 'shadow' });
    await shadow.write(observations[0], definitions[0], writeLegacy);
    expect(writes).toBe(2);
    const v2 = new MetricStorageAdapter(upgradedStorage, { read: 'v2', write: 'v2' });
    await v2.write(observations[0], definitions[0], writeLegacy);
    expect(writes).toBe(2);
    expect(await v2.latest(observations[0], oldRead, 'metrics_history')).toMatchObject({ id: observations[0].id });
    expect(await legacy.latest(observations[0], oldRead, 'metrics_history')).toMatchObject({ value: 12.5 });
    expect(await legacy.range(observations[0], '2026-09-01T00:00:00Z', '2026-09-01T00:02:00Z',
      () => oldStore.rangeInstanceMetric(1, 'cpu_usage', new Date('2026-09-01T00:00:00Z'), now, 200), 'metrics_history')).toMatchObject([{ value: 12.5, provenance: { contract: 'legacy' } }]);
    expect(await v2.range(observations[0], '2026-09-01T00:00:00Z', '2026-09-01T00:02:00Z', async () => [], 'metrics_history')).toHaveLength(1);
  });

  it('partial DDL failure blocks rerun; externally complete remaining DDL and acknowledge with checksum-bound verification', async () => {
    const migration = (await loadMigrations()).find(m => m.id === '098_metric_v2_storage.sql')!;
    await runner(upgrade).run();
    // Separate upgraded database: remove only this task's empty tables/ledger entry for fault injection.
    for (const table of ['metric_v2_observations', 'metric_v2_attempts', 'metric_v2_inventory']) await upgrade.query(`DROP TABLE ${table}`);
    await upgrade.query('DELETE FROM app_schema_migrations WHERE migration_id = ?', [migration.id]);
    await upgrade.query('CREATE TABLE metric_v2_attempts (fault INT)');
    await expect(runner(upgrade).run()).rejects.toThrow('failed');
    const failed = (await runner(upgrade).inspect()).find(m => m.migration_id === migration.id)!;
    expect(failed.statement_index).toBe(1);
    await expect(runner(upgrade).run()).rejects.toThrow('explicit repair');
    await upgrade.query('DROP TABLE metric_v2_attempts');
    for (const statement of splitSqlStatements(migration.sql).slice(1)) await upgrade.query(statement);
    await expect(runner(upgrade).acknowledgeExternallyRepairedMigration(migration.id, 'test', 'fixture repair')).rejects.toThrow('checksum-bound');
    const repaired = new MigrationRunner(upgrade as unknown as MigrationPool, undefined, {
      [migration.id]: { checksum: migration.checksum, verify: async connection => {
        // Compare every column and index to the fresh-install schema, including types and defaults.
        for (const table of ['metric_v2_observations', 'metric_v2_attempts', 'metric_v2_inventory']) {
          const [columns] = await connection.query(`SHOW FULL COLUMNS FROM ${table}`);
          expect(columns).toEqual((await pool.query(`SHOW FULL COLUMNS FROM ${table}`))[0]);
          const [indexes] = await connection.query<RowDataPacket[]>(`SHOW INDEX FROM ${table}`);
          const shape = (rows: RowDataPacket[]) => rows.map(({ Cardinality: _cardinality, ...row }) => row);
          expect(shape(indexes)).toEqual(shape((await pool.query<RowDataPacket[]>(`SHOW INDEX FROM ${table}`))[0]));
        }
      } },
    });
    await repaired.acknowledgeExternallyRepairedMigration(migration.id, 'isolated-test', 'remaining statements verified against fresh install');
    await repaired.run();
    expect((await repaired.inspect()).find(m => m.migration_id === migration.id)?.status).toBe('completed');
  });

  it('roundtrips all MAX-64 canonical/extension fixtures, exact integers, lineage and provenance', async () => {
    await storage.write(rawObservation, definitions[0]);
    for (const [index, observation] of observations.entries()) {
      await storage.write(observation, definitions[index]);
      expect(await storage.latest(observation)).toEqual({ ...observation, observed_at: new Date(observation.observed_at).toISOString(), collected_at: new Date(observation.collected_at).toISOString(), stored_at: now.toISOString() });
    }
    const maximum = identify({ ...observations[3], value: { encoding: 'uint64' as const, value: '18446744073709551615' }, observed_at: '2026-09-01T00:01:01Z', collected_at: '2026-09-01T00:01:01Z' });
    await storage.write(maximum, definitions[3]);
    expect((await storage.latest(maximum))?.value).toEqual(maximum.value);
    const signed = identify({ ...observations[0], value: { encoding: 'int64' as const, value: '-9223372036854775808' } });
    // A distinct semantic fixture for signed encoding, never mutate an existing series definition.
    signed.metric = { id: 'db.signed_test', semantic_version: '1.0.0' };
    const signedObservation = identify(signed);
    await storage.write(signedObservation, { ...definitions[0], id: signed.metric.id, value_type: 'int64' });
    expect((await storage.latest(signedObservation))?.value).toEqual(signed.value);
    expect(await storage.evidence(rawObservation.id)).toMatchObject({ status: 'available', observation: { stage: 'raw', raw_field: 'Uptime' } });
  });

  it('concurrent duplicate writes are idempotent, dimension order stable, conflicts rejected without timestamp refresh', async () => {
    const observation = observations[1];
    await Promise.all(Array.from({ length: 8 }, () => storage.write(observation, definitions[1])));
    const first = await storage.latest(observation);
    now = new Date(now.getTime() + 1000);
    const reordered = { ...observation, dimensions: Object.fromEntries(Object.entries(observation.dimensions).reverse()) };
    await storage.write(reordered, definitions[1]);
    expect(await storage.latest(reordered)).toEqual(first);
    expect((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM metric_v2_observations'))[0][0].n).toBe(1);
    await expect(storage.write({ ...observation, value: { encoding: 'uint64', value: '42' } }, definitions[1])).rejects.toThrow('IDEMPOTENCY_PAYLOAD_CONFLICT');
    expect(await storage.latest(observation)).toEqual(first);
  });

  it('failed attempt, invalid observation and late arrival never overwrite latest effective value or observed_at', async () => {
    await storage.write(observations[0], definitions[0]);
    const before = await storage.latest(observations[0]);
    await storage.writeAttempt(timeoutAttempt);
    await storage.write(identify({ ...observations[0], observed_at: '2026-09-01T00:01:01Z', collected_at: '2026-09-01T00:01:01Z', value: null, quality: { status: 'unknown', reason: 'source_error' } }), definitions[0]);
    await storage.write(identify({ ...observations[0], observed_at: '2026-09-01T00:00:00Z' }), definitions[0]);
    expect(await storage.latest(observations[0])).toEqual(before);
    expect(await storage.attempt(timeoutAttempt.id)).toEqual(timeoutAttempt);
    const history = await storage.range(observations[0], '2026-09-01T00:00:00Z', '2026-09-01T00:02:00Z');
    expect(history).toHaveLength(3);
    expect(history[0].value).toBeNull();
  });

  it('attempt transitions are serialized and terminal attempts are immutable', async () => {
    const { ended_at: _end, ...base } = timeoutAttempt;
    await storage.writeAttempt({ ...base, status: 'running', error: null });
    await storage.writeAttempt(timeoutAttempt);
    await storage.writeAttempt(timeoutAttempt);
    await expect(storage.writeAttempt({ ...timeoutAttempt, status: 'succeeded', error: null })).rejects.toThrow('ATTEMPT_TERMINAL');
    expect(await storage.attempt(timeoutAttempt.id)).toEqual(timeoutAttempt);
  });

  it('different dimensions and semantic versions remain separate; provenance revisions are retained', async () => {
    await storage.write(observations[1], definitions[1]);
    const changed = identify({ ...observations[1], dimensions: { ...observations[1].dimensions, mount: '/archive' },
      versions: { ...observations[1].versions, config_revision: 2, package_version: '1.1.0' } });
    await storage.write(changed, definitions[1]);
    const revised = identify({ ...observations[1], metric: { ...observations[1].metric, semantic_version: '1.1.0' } });
    await storage.write(revised, { ...definitions[1], semantic_version: '1.1.0' });
    expect((await storage.latest(observations[1]))?.id).toBe(observations[1].id);
    expect(await storage.latest(changed)).toMatchObject({ id: changed.id, versions: { config_revision: 2, package_version: '1.1.0' } });
    expect((await storage.latest(revised))?.id).toBe(revised.id);
  });

  it('rejects invalid contracts and unsafe integers before persisting', async () => {
    await expect(storage.write({ ...observations[0], unit: 'ms' }, definitions[0])).rejects.toThrow('UNIT_CONFLICT');
    await expect(storage.write({ ...observations[3], value: { encoding: 'uint64', value: '18446744073709551616' } }, definitions[3])).rejects.toThrow('UINT64_RANGE');
    await expect(storage.write({ ...observations[0], id: 'invented' }, definitions[0])).rejects.toThrow('IDEMPOTENCY_ID');
    await expect(storage.range(observations[0], 'invalid', '2026-09-02T00:00:00Z')).rejects.toThrow('STORAGE_RANGE');
    expect((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM metric_v2_observations'))[0][0].n).toBe(0);
  });

  it('raw evidence expires even before cleanup, leaves tombstone and cannot be revived by retry; pruning bounded and reversible before deletion', async () => {
    storage = new MysqlMetricStorage(pool, () => now, { rawMs: 1000, historyMs: 10000, attemptMs: 5000 });
    await storage.write(rawObservation, definitions[0]);
    await storage.write(observations[0], definitions[0]);
    await storage.writeAttempt(timeoutAttempt);
    now = new Date(now.getTime() + 1000);
    expect(await storage.evidence(rawObservation.id)).toEqual({ status: 'expired' });
    await storage.prune();
    expect((await pool.query<RowDataPacket[]>('SELECT payload FROM metric_v2_observations WHERE id = ?', [rawObservation.id]))[0][0].payload).toBeNull();
    await storage.write(rawObservation, definitions[0]);
    expect(await storage.evidence(rawObservation.id)).toEqual({ status: 'expired' });
    expect((await storage.latest(observations[0]))?.lineage[0].id).toBe(rawObservation.id);
    now = new Date(now.getTime() + 10000);
    await storage.prune();
    expect(await storage.evidence(rawObservation.id)).toEqual({ status: 'not_retained' });
    expect(await storage.latest(observations[0])).toBeNull();
    expect(await storage.attempt(timeoutAttempt.id)).toBeNull();
  });

  it('inventory is separate and late attributes cannot overwrite newer facts', async () => {
    await storage.writeInventory(resources[0]);
    await storage.writeInventory({ ...resources[0], attributes: { 'db.version': { value: 'older', source: 'inventory', observed_at: '2026-08-31T00:00:00Z' } } });
    expect(await storage.inventory(resources[0].type, resources[0].id)).toEqual(resources[0]);
    expect((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM metric_v2_observations'))[0][0].n).toBe(0);
  });

  it('latest and range queries use composite series/time indexes', async () => {
    // Representative mix of series and valid/invalid points; a one-row table may rationally use another index.
    for (let i = 0; i < 300; i++) {
      const time = new Date(Date.parse('2026-09-01T00:00:00Z') + i * 1000).toISOString();
      now = new Date(Date.parse(time) + 1000);
      await storage.write(identify({ ...observations[0], resource_id: i < 100 ? observations[0].resource_id : `db-${i}`,
        observed_at: time, collected_at: time, stored_at: null,
        ...(i % 2 ? { value: null, quality: { status: 'unknown' as const, reason: 'source_error' as const } } : {}) }), definitions[0]);
    }
    await pool.query('ANALYZE TABLE metric_v2_observations');
    const [latest] = await pool.query<RowDataPacket[]>(`EXPLAIN SELECT payload FROM metric_v2_observations WHERE series_hash = ? AND stage = 'normalized' AND valid_value = 1 ORDER BY observed_at DESC, id DESC LIMIT 1`, [seriesHash(observations[0])]);
    expect(latest[0].key).toBe('idx_metric_v2_latest');
    const [range] = await pool.query<RowDataPacket[]>(`EXPLAIN SELECT payload FROM metric_v2_observations FORCE INDEX (idx_metric_v2_range) WHERE series_hash = ? AND stage = 'normalized' AND observed_at >= '2026-09-01' AND observed_at <= '2026-09-02' ORDER BY observed_at DESC, id DESC LIMIT 200`, [seriesHash(observations[0])]);
    expect(range[0].key, JSON.stringify(range)).toBe('idx_metric_v2_range');
    expect(`${latest[0].Extra} ${range[0].Extra}`).not.toContain('filesort');
  });
});
