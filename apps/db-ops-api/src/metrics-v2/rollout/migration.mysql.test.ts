import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, MigrationRunner, splitSqlStatements } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { definitions, sample } from '../../contracts/metrics-v2/fixtures.js';
import { seriesHash } from '../storage.js';

const port = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);
describe.skipIf(!port)('production rollout identity migration from 101', () => {
  let root: Pool, pool: Pool, directory: string;
  const database = `max85_migration_${process.pid}`;
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database });
    directory = await mkdtemp(join(tmpdir(), 'max85-migrations-'));
    for (const m of (await loadMigrations()).filter(m => m.id < '102_')) await writeFile(join(directory, m.id), m.sql);
    await new MigrationRunner(pool as unknown as MigrationPool, directory).run();
  }, 120000);
  afterAll(async () => {
    await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it('backfills only known identities, preserves control state and supports checksum-bound partial repair', async () => {
    const o = sample(definitions[0].id), key = seriesHash(o);
    const pin = JSON.stringify({ id: 'fixture', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` });
    await pool.execute(`INSERT INTO metric_v2_rollout (series_hash, source, generation, read_mode, package_pin, published_revision, applied_revision, latest_payload)
      VALUES (?, 'v2', 7, 'v2', ?, 9, 9, ?)`, [key, pin, JSON.stringify(o)]);
    await pool.execute(`INSERT INTO metric_v2_rollout (series_hash, source, generation, read_mode, package_pin, published_revision)
      VALUES (?, 'legacy', 1, 'legacy', ?, 1)`, ['b'.repeat(64), pin]);
    // Simulate a process crash after atomic ALTER, before its backfill statement.
    const migration = (await loadMigrations()).find(m => m.id === '102_metric_v2_rollout_resource.sql')!;
    const statements = splitSqlStatements(migration.sql);
    await pool.query(statements[0]);
    await pool.execute(`INSERT INTO app_schema_migrations (migration_id, checksum, status, statement_index, error)
      VALUES (?, ?, 'failed', 1, 'isolated crash after ALTER')`, [migration.id, migration.checksum]);
    const runner = new MigrationRunner(pool as unknown as MigrationPool);
    await expect(runner.run()).rejects.toThrow('explicit repair');
    await expect(runner.acknowledgeExternallyRepairedMigration(migration.id, 'fixture', 'repair')).rejects.toThrow('checksum-bound');
    await pool.query(statements[1]);
    const repaired = new MigrationRunner(pool as unknown as MigrationPool, undefined, {
      [migration.id]: { checksum: migration.checksum, verify: async c => {
        const [rows] = await c.query<RowDataPacket[]>('SELECT * FROM metric_v2_rollout WHERE series_hash = ?', [key]);
        expect(rows[0]).toMatchObject({ resource_type: o.resource_type, resource_id: o.resource_id, source: 'v2', generation: 7, published_revision: 9, applied_revision: 9 });
        const [indexes] = await c.query<RowDataPacket[]>("SHOW INDEX FROM metric_v2_rollout WHERE Key_name = 'idx_metric_rollout_resource'");
        expect(indexes.map(r => r.Column_name)).toEqual(['resource_type', 'resource_id']);
        expect(rows[0].latest_payload).toEqual(o);
      } },
    });
    await repaired.acknowledgeExternallyRepairedMigration(migration.id, 'fixture', 'verified resource identity and unchanged control state');
    await repaired.run(); await repaired.run();
    const [missing] = await pool.query<RowDataPacket[]>('SELECT resource_type, resource_id FROM metric_v2_rollout WHERE series_hash = ?', ['b'.repeat(64)]);
    expect(missing[0]).toEqual({ resource_type: null, resource_id: null });
    expect((await repaired.inspect()).find(m => m.migration_id === migration.id)?.status).toBe('completed');
  });
});
