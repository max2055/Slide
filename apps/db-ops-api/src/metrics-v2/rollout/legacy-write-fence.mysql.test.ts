import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { definitions, identify, sample } from '../../contracts/metrics-v2/fixtures.js';
import { RolloutControl, type Target } from './control.js';
import { withLegacyMetricWrite } from './legacy-write-fence.js';

const port = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);

describe.skipIf(!port)('isolated legacy metric write fencing', () => {
  let root: Pool;
  let pool: Pool;
  const database = `max85_fence_${process.pid}`;
  const target: Target = {
    source: 'legacy', read: 'legacy', revision: 1,
    package: { id: 'fixture', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` },
  };
  const series = identify({ ...sample(definitions[0].id), resource_id: '7' });

  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 4 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    await pool.query('CREATE TABLE legacy_metric_probe (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
  });

  it('orders an in-flight legacy write before CAS cutover and rejects every later old write', async () => {
    const control = new RolloutControl(pool);
    await control.initialize(series, target);
    await control.applied(series, { source: 'legacy', generation: 1, revision: 1 });

    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const legacy = withLegacyMetricWrite(pool, { type: 'instance', id: 7 }, async connection => {
      await connection.execute('INSERT INTO legacy_metric_probe (id) VALUES (1)');
      entered();
      await gate;
    });
    await started;

    let switched = false;
    const cutover = control.switch(series, 1, { ...target, source: 'v2', read: 'v2', revision: 2 })
      .then(generation => { switched = true; return generation; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(switched).toBe(false);

    release();
    await expect(legacy).resolves.toMatchObject({ written: true });
    await expect(cutover).resolves.toBe(2);
    await expect(withLegacyMetricWrite(pool, { type: 'instance', id: 7 }, async connection => {
      await connection.execute('INSERT INTO legacy_metric_probe (id) VALUES (2)');
    })).resolves.toEqual({ written: false });

    const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM legacy_metric_probe ORDER BY id');
    expect(rows).toEqual([{ id: 1 }]);
  });
});
