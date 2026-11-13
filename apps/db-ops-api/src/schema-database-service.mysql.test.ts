import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseService } from './database-service.js';
import { schemaService } from './schema-service.js';
import { dbConnection } from './db-connection.js';
import { MigrationRunner } from './migrations/runner.js';
import type { MigrationPool } from './migrations/types.js';
import { schemaDatabaseService as service, type TableSchemaRow } from './schema-database-service.js';

// Explicit configuration only; default CI collection never reads local secrets.
const enabled = process.env.SNAPSHOT_MYSQL_TEST === '1';
describe.skipIf(!enabled)('GitHub #368 real MySQL snapshot transactions and upgrade', () => {
  const schema = `max399_${randomBytes(8).toString('hex')}`;
  let root: Pool;
  let pool: Pool;
  let secondPool: Pool;
  const column = (name: string, table = 'items'): TableSchemaRow => ({
    table_name: table, column_name: name, column_type: 'int', is_nullable: 'YES',
    column_default: null, column_key: '', extra: '', column_comment: null,
    table_comment: null, table_rows: 0, data_length: 0,
  });
  const migration = new URL('../sql/migrations/156_schema_snapshot_batch_precision.sql', import.meta.url);
  beforeAll(async () => {
    if (!process.env.SNAPSHOT_MYSQL_PORT || !process.env.SNAPSHOT_MYSQL_USER) {
      throw new Error('Explicit SNAPSHOT_MYSQL_PORT and SNAPSHOT_MYSQL_USER are required');
    }
    const config = {
      host: process.env.SNAPSHOT_MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.SNAPSHOT_MYSQL_PORT), user: process.env.SNAPSHOT_MYSQL_USER,
      password: process.env.SNAPSHOT_MYSQL_PASSWORD || '', connectionLimit: 1,
    };
    root = mysql.createPool(config);
    await root.query(`CREATE DATABASE ${schema}`);
    pool = mysql.createPool({ ...config, database: schema });
    secondPool = mysql.createPool({ ...config, database: schema });
    // Full migration entrypoint, empty installation and repeated startup.
    // The existing runner checks invariants through its pool while holding its
    // migration connection. Bootstrap needs two; snapshot acceptance uses one.
    const bootstrap = mysql.createPool({ ...config, database: schema, connectionLimit: 2 });
    try {
      await new MigrationRunner(bootstrap as unknown as MigrationPool).run();
      await new MigrationRunner(bootstrap as unknown as MigrationPool).run();
    } finally { await bootstrap.end(); }
    await pool.query(`INSERT INTO database_instances
      (id, name, host, port, username, password_encrypted)
      VALUES (1, 'max399', '127.0.0.1', 3306, 'fixture', 'fixture')`);
    console.log('MAX399 environment', (await pool.query('SELECT VERSION() AS version, @@transaction_isolation AS isolation'))[0]);
  }, 180000);
  afterEach(async () => {
    vi.restoreAllMocks();
    if (!pool) return;
    await pool.query('DROP TRIGGER IF EXISTS max399_fail');
    await pool.query('DELETE FROM schema_snapshots');
  });
  afterAll(async () => {
    await secondPool?.end();
    await pool?.end();
    if (root) {
      try {
        await root.query(`DROP DATABASE IF EXISTS ${schema}_source`);
        await root.query(`DROP DATABASE IF EXISTS ${schema}`);
        const [rows] = await root.query<any[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [schema]);
        expect(rows).toHaveLength(0);
        console.log('MAX399 cleanup: owned schema removed');
      } finally { await root.end(); }
    }
  }, 30000);
  function use(target = pool) { vi.spyOn(dbConnection, 'getPool').mockReturnValue(target); }
  it('upgrades legacy history without changing timestamps, is repeatable, and retains schema attributes', async () => {
    // Simulate an old deployment after existing migrations, before 156.
    await pool.query("ALTER TABLE schema_snapshots MODIFY snapshot_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '快照时间'");
    await pool.query(`INSERT INTO schema_snapshots
      (instance_id,snapshot_time,table_name,column_name,column_type)
      VALUES (1,'2020-01-02 03:04:05','items','legacy','int')`);
    const sql = await readFile(migration, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const [attributes] = await pool.query<any[]>(`SELECT DATETIME_PRECISION, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'schema_snapshots' AND COLUMN_NAME = 'snapshot_time'`, [schema]);
    expect(attributes[0]).toMatchObject({ DATETIME_PRECISION: 3, IS_NULLABLE: 'NO', COLUMN_COMMENT: '快照时间' });
    expect(String(attributes[0].COLUMN_DEFAULT).toLowerCase()).toBe('current_timestamp(3)');
    use();
    expect((await service.getLatestSnapshot(1)).map(r => r.column_name)).toEqual(['legacy']);
    const [old] = await service.getSnapshotTimes(1);
    expect(old.snapshot_time.getMilliseconds()).toBe(0);
    expect((await service.saveSnapshot(1, [column('new')])).success).toBe(true);
    expect((await service.compareWithSnapshot(1, old.snapshot_time)).map(c => [c.type, c.column_name])).toEqual([['deleted', 'legacy'], ['added', 'new']]);
  });
  it('keeps 12 concurrent same-second batches distinct across two independent one-connection pools', async () => {
    const now = new Date('2040-01-01T00:00:00.123Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    // Alternate pools at the synchronous entry of each save; no nested pool checkout.
    const saves = Array.from({ length: 12 }, (_, i) => {
      use(i % 2 ? pool : secondPool);
      return service.saveSnapshot(1, [column(`batch${i}_a`), column(`batch${i}_b`)]);
    });
    expect((await Promise.all(saves)).every(r => r.success)).toBe(true);
    use();
    const times = await service.getSnapshotTimes(1, 20);
    expect(times).toHaveLength(12);
    expect(new Set(times.map(t => t.snapshot_time.getTime())).size).toBe(12);
    expect(times.every(t => t.columns === 2 && t.tables === 1)).toBe(true);
    expect(times[0].snapshot_time.getTime() - times[11].snapshot_time.getTime()).toBe(11);
    const latest = await service.getLatestSnapshot(1);
    expect(latest).toHaveLength(2);
    expect(latest[0].column_name.split('_')[0]).toBe(latest[1].column_name.split('_')[0]);
    expect((await service.getTableList(1))[0].column_count).toBe(2);
    expect(await service.getTableDetail(1, 'items')).toEqual(latest);
  });
  it('rolls back the first 500 columns on a second-chunk failure and keeps the previous valid batch', async () => {
    use();
    await service.saveSnapshot(1, [column('previous')]);
    const previous = await service.getSnapshotTimes(1);
    await pool.query(`CREATE TRIGGER max399_fail BEFORE INSERT ON schema_snapshots FOR EACH ROW
      BEGIN IF NEW.column_name = 'fail' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected failure'; END IF; END`);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = [...Array.from({ length: 500 }, (_, i) => column(`c${i}`)), column('fail')];
    expect((await service.saveSnapshot(1, rows)).success).toBe(false);
    expect(await service.getSnapshotTimes(1)).toEqual(previous);
    expect((await service.getLatestSnapshot(1)).map(r => r.column_name)).toEqual(['previous']);
    await pool.query('DROP TRIGGER max399_fail');
    expect((await service.saveSnapshot(1, [column('recovered')])).success).toBe(true);
    expect(await service.getSnapshotTimes(1)).toHaveLength(2);
  });
  it('readers see the previous complete batch while another connection is inserting', async () => {
    use();
    await service.saveSnapshot(1, [column('previous')]);
    const connection = await pool.getConnection();
    const commit = connection.commit.bind(connection);
    let arrived!: () => void;
    let resume!: () => void;
    const atCommit = new Promise<void>(resolve => { arrived = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(pool, 'getConnection').mockResolvedValueOnce(connection);
    vi.spyOn(connection, 'commit').mockImplementation(async () => {
      arrived();
      await gate;
      await commit();
    });
    const write = service.saveSnapshot(1, Array.from({ length: 501 }, (_, i) => column(`new${i}`)));
    try {
      await atCommit;
      use(secondPool);
      expect((await service.getLatestSnapshot(1)).map(r => r.column_name)).toEqual(['previous']);
    } finally { resume(); }
    expect((await write).success).toBe(true);
    expect(await service.getLatestSnapshot(1)).toHaveLength(501);
  });
  it('collects real information_schema through the production collection entrypoint', async () => {
    use();
    // A managed source schema is separate from platform storage. Use real
    // columns spanning two insertion chunks, without unrelated platform ENUMs.
    await root.query(`CREATE DATABASE ${schema}_source`);
    const definitions = Array.from({ length: 501 }, (_, i) => `c${i} INT`).join(',');
    await root.query(`CREATE TABLE ${schema}_source.source_items (${definitions})`);
    await pool.execute('UPDATE database_instances SET database_name = ? WHERE id = 1', [`${schema}_source`]);
    vi.spyOn(databaseService, 'getConnection').mockReturnValue({ db_type: 'mysql', pool } as any);
    const result = await schemaService.collectSchema(1);
    expect(result).not.toHaveProperty('error');
    const latest = await service.getLatestSnapshot(1);
    expect(latest.length).toBeGreaterThan(500);
    expect(result).toMatchObject({ collected: latest.length, columns: latest.length });
    expect(latest.some(row => row.table_name === 'source_items' && row.column_name === 'c500')).toBe(true);
    expect(await service.getSnapshotTimes(1)).toHaveLength(1);
  });
  it('does not resurrect tables removed from the latest batch', async () => {
    use();
    await service.saveSnapshot(1, [column('id', 'removed')]);
    await service.saveSnapshot(1, [column('id', 'retained')]);
    expect(await service.getTableDetail(1, 'removed')).toEqual([]);
    expect((await service.getTableList(1)).map(r => r.table_name)).toEqual(['retained']);
  });
});
