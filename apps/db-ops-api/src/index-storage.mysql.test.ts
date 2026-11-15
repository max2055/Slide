import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
const state = vi.hoisted(() => ({ pool: null as mysql.Pool | null }));
vi.mock('./db-connection', () => ({ dbConnection: { getPool: () => state.pool } }));
import { indexDatabaseService as service, type IndexEntry } from './index-database-service';
const enabled = !!process.env.INDEX_TEST_MYSQL_CONFIG;
const schema = `max3_index_${process.pid}`;
let admin: mysql.Connection;
beforeAll(async () => {
  if (!enabled) return;
  const config = JSON.parse(process.env.INDEX_TEST_MYSQL_CONFIG!);
  admin = await mysql.createConnection(config);
  await admin.query(`CREATE DATABASE \`${schema}\``);
  state.pool = mysql.createPool({ ...config, database: schema, connectionLimit: 4 });
  await state.pool.query('CREATE TABLE database_instances (id INT PRIMARY KEY) ENGINE=InnoDB');
  await state.pool.query('INSERT INTO database_instances VALUES (1),(2)');
  const ddl = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
  for (const table of ['index_info', 'index_redundancy_report']) {
    const sql = ddl.match(new RegExp('CREATE TABLE IF NOT EXISTS `' + table + '`[\\s\\S]*?;'))![0];
    await state.pool.query(sql);
  }
});
afterAll(async () => {
  if (!enabled) return;
  await state.pool?.end();
  await admin.query(`DROP DATABASE \`${schema}\``);
  await admin.end();
});
const row = (name: string): IndexEntry => ({ table_name: 't', index_name: name,
  column_name: 'c', seq_in_index: 1, non_unique: 1, cardinality: 0,
  sub_part: null, nullable: 'YES', index_type: 'BTREE', comment: null });
it.skipIf(!enabled)('MAX-3/513/515: real InnoDB rollback, concurrent replacement, chunks and empty snapshots', async () => {
  expect((await service.saveIndexData(1, [row('old')])).success).toBe(true);
  await state.pool!.query("CREATE TRIGGER reject_bad BEFORE INSERT ON index_info FOR EACH ROW BEGIN IF NEW.index_name = 'bad' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected'; END IF; END");
  const entries = [...Array.from({ length: 1000 }, (_, i) => row('i' + i)), row('bad')];
  expect((await service.saveIndexData(1, entries)).success).toBe(false);
  expect((await service.getIndexesByInstance(1)).map(r => r.index_name)).toEqual(['old']);
  await state.pool!.query('DROP TRIGGER reject_bad');
  expect((await service.saveIndexData(1, Array.from({ length: 5462 }, (_, i) => row('i' + i)))).count).toBe(5462);
  expect(await service.getIndexesByInstance(1)).toHaveLength(5462);
  const results = await Promise.all([
    service.saveIndexData(1, [row('a')]), service.saveIndexData(1, [row('b')]),
    service.saveIndexData(2, [row('other')]),
  ]);
  expect(results.every(r => r.success)).toBe(true);
  expect(await service.getIndexesByInstance(1)).toHaveLength(1);
  expect((await service.getIndexesByInstance(2))[0].index_name).toBe('other');
  const report = { instance_id: 1, table_name: 't', redundant_index: 'a', covered_by_index: 'b', reason: 'prefix' };
  await service.saveRedundancyReport(1, [report]);
  await service.saveRedundancyReport(2, [{ ...report, instance_id: 2 }]);
  expect((await service.saveRedundancyReport(1, [])).success).toBe(true);
  expect(await service.getRedundancyReport(1)).toEqual([]);
  expect(await service.getRedundancyReport(2)).toHaveLength(1);
  expect((await service.saveIndexData(1, [])).success).toBe(true);
  expect(await service.getIndexesByInstance(1)).toEqual([]);
}, 20000);
