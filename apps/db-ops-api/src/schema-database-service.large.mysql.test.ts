import { randomBytes } from 'node:crypto';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseService } from './database-service.js';
import { dbConnection } from './db-connection.js';
import { schemaService } from './schema-service.js';
import { MigrationRunner } from './migrations/runner.js';
import type { MigrationPool } from './migrations/types.js';
import { schemaDatabaseService as service, type TableSchemaRow } from './schema-database-service.js';

// Opt in with MAX539_MYSQL_TEST=1 and explicit SNAPSHOT_MYSQL_{HOST,PORT,USER,PASSWORD}.
// Default collection never reads credentials or connects to a database.
describe.skipIf(process.env.MAX539_MYSQL_TEST !== '1')('MAX-539 #554 large snapshots on real MySQL', () => {
  const schema = `max539_${randomBytes(8).toString('hex')}`;
  const sourceSchema = `${schema}_source`;
  let root: Pool;
  let pool: Pool;
  let other: Pool;
  let source: Pool;
  const column = (i: number, batch = 'items'): TableSchemaRow => ({
    table_name: batch, column_name: `c${i}`, column_type: 'int', is_nullable: 'YES',
    column_default: null, column_key: '', extra: '', column_comment: `column ${i}`,
    table_comment: batch, table_rows: 0, data_length: null,
  });
  const columns = (count: number, batch?: string) => Array.from({ length: count }, (_, i) => column(i, batch));
  const use = (target = pool) => vi.spyOn(dbConnection, 'getPool').mockReturnValue(target);

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
    other = mysql.createPool({ ...config, database: schema });
    await root.query(`CREATE DATABASE ${sourceSchema}`);
    source = mysql.createPool({ ...config, database: sourceSchema });
    // The instance lookup needs the current migrated schema. Migration checks
    // need a second connection; all snapshot operations below use limit 1.
    const bootstrap = mysql.createPool({ ...config, database: schema, connectionLimit: 2 });
    try { await new MigrationRunner(bootstrap as unknown as MigrationPool).run(); }
    finally { await bootstrap.end(); }
    await pool.execute(`INSERT INTO database_instances
      (id,name,host,port,username,password_encrypted,database_name)
      VALUES (1,'max539','127.0.0.1',3306,'fixture','fixture',?)`, [sourceSchema]);
    console.log('MAX539 environment', (await pool.query(
      'SELECT VERSION() AS version, @@transaction_isolation AS isolation, @@max_allowed_packet AS max_allowed_packet'
    ))[0]);
  }, 180000);

  afterEach(async () => {
    vi.restoreAllMocks();
    if (!pool) return;
    await pool.query('DROP TRIGGER IF EXISTS max539_fail');
    await pool.query('DELETE FROM schema_snapshots');
  });
  afterAll(async () => {
    await source?.end();
    await other?.end();
    await pool?.end();
    if (root) {
      try {
        await root.query(`DROP DATABASE IF EXISTS ${sourceSchema}`);
        await root.query(`DROP DATABASE IF EXISTS ${schema}`);
        const [remaining] = await root.query<any[]>(
          'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?, ?)', [schema, sourceSchema]);
        expect(remaining).toHaveLength(0);
        console.log('MAX539 cleanup: both owned schemas removed');
      } finally { await root.end(); }
    }
  }, 30000);

  it('reproduces the original 65546-parameter failure on the actual server', async () => {
    const names = 'instance_id,snapshot_time,table_name,column_name,column_type,is_nullable,column_default,column_key,extra,column_comment,table_comment,table_rows,data_length';
    const values = columns(5042).flatMap(row => [
      1, new Date(), row.table_name, row.column_name, row.column_type, row.is_nullable,
      row.column_default, row.column_key, row.extra, row.column_comment, row.table_comment, row.table_rows, row.data_length,
    ]);
    expect(values).toHaveLength(65546);
    await expect(pool.execute(
      `INSERT INTO schema_snapshots (${names}) VALUES ${Array(5042).fill('(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
      values
    )).rejects.toMatchObject({ code: 'ER_PS_MANY_PARAM', errno: 1390 });
    expect((await pool.query<any[]>('SELECT COUNT(*) AS n FROM schema_snapshots'))[0][0].n).toBe(0);
  });

  it.each([5042, 10085])('saves all %i columns with exact metadata and one batch', async (count) => {
    use();
    const rows = columns(count);
    expect(await service.saveSnapshot(1, rows)).toEqual({ success: true, count });
    const latest = await service.getLatestSnapshot(1);
    expect(latest).toHaveLength(count);
    const byName = new Map(latest.map(row => [row.column_name, row]));
    for (const row of rows) expect(byName.get(row.column_name)).toEqual(row);
    const times = await service.getSnapshotTimes(1);
    expect(times).toHaveLength(1);
    expect(times[0]).toMatchObject({ tables: 1, columns: count });
    expect(await service.getTableList(1)).toMatchObject([{ table_name: 'items', column_count: count, data_length: null }]);
    expect(await service.getTableDetail(1, 'items')).toEqual(latest);
  });

  it.each([0, 2500, 5041])('rolls back a 5042-column save failing at row %i and preserves history', async (failAt) => {
    use();
    expect((await service.saveSnapshot(1, [column(0, 'old')])).success).toBe(true);
    const previous = await service.getSnapshotTimes(1);
    const old = await service.getLatestSnapshot(1);
    await pool.query(`CREATE TRIGGER max539_fail BEFORE INSERT ON schema_snapshots FOR EACH ROW
      BEGIN IF NEW.table_name = 'new' AND NEW.column_name = 'c${failAt}'
      THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'max539 injected failure'; END IF; END`);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await service.saveSnapshot(1, columns(5042, 'new'))).toMatchObject({
      success: false, count: 0, error: 'max539 injected failure',
    });
    expect(await service.getSnapshotTimes(1)).toEqual(previous);
    expect(await service.getLatestSnapshot(1)).toEqual(old);
    expect((await pool.query<any[]>('SELECT COUNT(*) AS n FROM schema_snapshots'))[0][0].n).toBe(1);
    await pool.query('DROP TRIGGER max539_fail');
    expect(await service.saveSnapshot(1, columns(5042, 'recovered'))).toEqual({ success: true, count: 5042 });
    expect(await service.getSnapshotTimes(1)).toHaveLength(2);
    expect(await service.getLatestSnapshot(1)).toHaveLength(5042);
  });

  it('serializes concurrent large batches across independent single-connection pools', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2040-01-01T00:00:00.123Z').getTime());
    const writes = ['a', 'b', 'c'].map((batch, i) => {
      use(i % 2 ? other : pool);
      return service.saveSnapshot(1, columns(5042, batch));
    });
    expect(await Promise.all(writes)).toEqual(Array(3).fill({ success: true, count: 5042 }));
    use();
    const times = await service.getSnapshotTimes(1);
    expect(times).toHaveLength(3);
    expect(times.map(t => t.columns)).toEqual([5042, 5042, 5042]);
    expect(times[0].snapshot_time.getTime() - times[2].snapshot_time.getTime()).toBe(2);
    const [batches] = await pool.query<any[]>(`SELECT snapshot_time,COUNT(*) AS n,
      COUNT(DISTINCT table_name) AS tables,COUNT(DISTINCT column_name) AS columns_count
      FROM schema_snapshots GROUP BY snapshot_time`);
    expect(batches).toHaveLength(3);
    expect(batches.every(row => row.n === 5042 && row.tables === 1 && row.columns_count === 5042)).toBe(true);
    expect(await service.getLatestSnapshot(1)).toHaveLength(5042);
  });

  it('keeps every large-batch fragment invisible to readers until commit', async () => {
    use();
    await service.saveSnapshot(1, [column(0, 'old')]);
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
    const write = service.saveSnapshot(1, columns(5042, 'new'));
    try {
      // Also terminate the wait when save fails before reaching commit.
      await Promise.race([atCommit, write.then(() => { throw new Error('Save ended before commit gate'); })]);
      use(other);
      expect(await service.getLatestSnapshot(1)).toEqual([column(0, 'old')]);
      expect(await service.getSnapshotTimes(1)).toHaveLength(1);
    } finally {
      resume();
      await write;
    }
    expect(await write).toEqual({ success: true, count: 5042 });
    expect(await service.getLatestSnapshot(1)).toHaveLength(5042);
  });

  it('collects 5500 real columns through collectSchema and preserves the last snapshot on save failure', async () => {
    // Each table stays below InnoDB's per-table column limit.
    for (let i = 0; i < 11; i++) {
      await source.query(`CREATE TABLE t${i} (${Array.from({ length: 500 }, (_, j) => `c${j} INT`).join(',')})`);
    }
    use();
    vi.spyOn(databaseService, 'getConnection').mockReturnValue({ db_type: 'mysql', pool: source } as any);
    expect(await schemaService.collectSchema(1)).toEqual({ collected: 5500, tables: 11, columns: 5500 });
    const latest = await service.getLatestSnapshot(1);
    expect(latest).toHaveLength(5500);
    expect(new Set(latest.map(row => `${row.table_name}.${row.column_name}`)).size).toBe(5500);
    expect(latest.some(row => row.table_name === 't10' && row.column_name === 'c499')).toBe(true);
    const previous = await service.getSnapshotTimes(1);
    await pool.query(`CREATE TRIGGER max539_fail BEFORE INSERT ON schema_snapshots FOR EACH ROW
      BEGIN IF NEW.table_name = 't9' AND NEW.column_name = 'c499'
      THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'max539 collect failure'; END IF; END`);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await schemaService.collectSchema(1)).toEqual({ error: 'max539 collect failure' });
    expect(await service.getSnapshotTimes(1)).toEqual(previous);
    expect(await service.getLatestSnapshot(1)).toEqual(latest);
    expect((await pool.query<any[]>('SELECT COUNT(*) AS n FROM schema_snapshots'))[0][0].n).toBe(5500);
  }, 30000);
});
