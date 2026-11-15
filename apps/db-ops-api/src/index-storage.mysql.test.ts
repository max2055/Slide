import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import { registerIndexRoutes } from './index-routes.js';
import { indexService } from './index-service.js';
import { readFile } from 'node:fs/promises';
const state = vi.hoisted(() => ({ pool: null as mysql.Pool | null }));
vi.mock('./db-connection', () => ({ dbConnection: { getPool: () => state.pool }, decryptData: vi.fn() }));
vi.mock('./database-service.js', () => ({ databaseService: {} }));
vi.mock('./instance-database-service.js', () => ({ instanceDatabaseService: {} }));
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


it.skipIf(!enabled)('MAX-3: concurrent readers observe only committed complete snapshots', async () => {
  const entries = (prefix: string) => Array.from({ length: 1001 }, (_, i) => row(prefix + i));
  await service.saveIndexData(1, entries('old'));
  await state.pool!.query("CREATE TRIGGER slow_refresh BEFORE INSERT ON index_info FOR EACH ROW SET @max3_delay = IF(NEW.index_name = 'new0', SLEEP(0.15), 0)");
  let finished = false;
  const writer = service.saveIndexData(1, entries('new')).finally(() => { finished = true; });
  let observations = 0;
  try {
    do {
      const rows = await service.getIndexesByInstance(1);
      expect(rows).toHaveLength(1001);
      expect(rows.every(r => r.index_name.startsWith('old')) || rows.every(r => r.index_name.startsWith('new'))).toBe(true);
      observations++;
    } while (!finished);
    expect((await writer).success).toBe(true);
    expect(observations).toBeGreaterThan(1);
    console.log('observation: complete committed snapshots', observations);
  } finally {
    await writer;
    await state.pool!.query('DROP TRIGGER slow_refresh');
  }
}, 10000);

it.skipIf(!enabled)('MAX-3/515: report first/middle batch failure and concurrent replacement preserve snapshots', async () => {
  const report = (name: string, instance_id = 1) => ({
    instance_id, table_name: 't', redundant_index: name, covered_by_index: 'cover', reason: 'prefix',
  });
  await service.saveRedundancyReport(1, [report('old')]);
  await state.pool!.query("CREATE TRIGGER reject_report BEFORE INSERT ON index_redundancy_report FOR EACH ROW BEGIN IF NEW.redundant_index = 'bad' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected'; END IF; END");
  try {
    for (const reports of [[report('bad')], [...Array.from({ length: 1000 }, (_, i) => report('i' + i)), report('bad')]]) {
      expect((await service.saveRedundancyReport(1, reports)).success).toBe(false);
      expect((await service.getRedundancyReport(1)).map(r => r.redundant_index)).toEqual(['old']);
    }
  } finally { await state.pool!.query('DROP TRIGGER reject_report'); }
  const results = await Promise.all([
    service.saveRedundancyReport(1, [report('a')]),
    service.saveRedundancyReport(1, [report('b')]),
    service.saveRedundancyReport(2, [report('other', 2)]),
  ]);
  expect(results.every(r => r.success)).toBe(true);
  expect(await service.getRedundancyReport(1)).toHaveLength(1);
  expect((await service.getRedundancyReport(2))[0].redundant_index).toBe('other');
  await service.saveRedundancyReport(1, [report('before')]);
  await state.pool!.query("CREATE TRIGGER slow_report BEFORE INSERT ON index_redundancy_report FOR EACH ROW SET @max3_delay = IF(NEW.redundant_index = 'after0', SLEEP(0.15), 0)");
  let done = false;
  const refreshing = service.saveRedundancyReport(1, Array.from({ length: 1001 }, (_, i) => report('after' + i)))
    .finally(() => { done = true; });
  let observed = 0;
  try {
    do {
      const snapshot = await service.getRedundancyReport(1);
      expect(snapshot.length === 1 && snapshot[0].redundant_index === 'before'
        || snapshot.length === 1001 && snapshot.every(r => r.redundant_index.startsWith('after'))).toBe(true);
      observed++;
    } while (!done);
    expect((await refreshing).success).toBe(true);
    expect(observed).toBeGreaterThan(1);
    console.log('observation: complete committed report snapshots', observed);
  } finally {
    await refreshing;
    await state.pool!.query('DROP TRIGGER slow_report');
  }
  await service.saveIndexData(1, [row('short'), { ...row('long'), column_name: 'c' },
    { ...row('long'), column_name: 'd', seq_in_index: 2 }]);
  expect(await indexService.detectRedundantIndexes(1)).toHaveLength(1);
  expect(await service.getRedundancyReport(1)).toHaveLength(1);
  await service.saveIndexData(1, [{ ...row('long'), column_name: 'c' },
    { ...row('long'), column_name: 'd', seq_in_index: 2 }]);
  expect(await indexService.detectRedundantIndexes(1)).toEqual([]);
  expect(await service.getRedundancyReport(1)).toEqual([]);
});

it.skipIf(!enabled)('MAX-514: real HTTP routes distinguish empty, missing pool and SQL errors without leaking SQL', async () => {
  const app = Fastify();
  // Authentication is outside this storage-fault fixture; production supplies its existing JWT/permission/access chains.
  registerIndexRoutes(app, { view: [], manage: [] });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = app.listeningOrigin;
  const pool = state.pool!;
  const paths = ['/api/indexes/2', '/api/indexes/2/t', '/api/indexes/2/unused', '/api/indexes/2/redundancy'];
  await service.saveIndexData(2, []);
  await service.saveRedundancyReport(2, []);
  try {
    for (const path of paths) {
      const empty = await fetch(base + path);
      expect(empty.status).toBe(200); expect(await empty.json()).toEqual([]);
      state.pool = null;
      const absent = await fetch(base + path);
      expect(absent.status).toBe(500);
      expect(await absent.json()).toEqual({ error: '索引存储暂不可用' });
      state.pool = pool;
    }
    await pool.query('RENAME TABLE index_info TO index_info_hidden, index_redundancy_report TO report_hidden');
    try {
      for (const path of paths) {
        const failed = await fetch(base + path);
        expect(failed.status).toBe(500);
        expect(await failed.json()).toEqual({ error: '索引存储暂不可用' });
      }
      const detection = await fetch(base + '/api/index/detect/2', { method: 'POST' });
      expect(detection.status).toBe(400);
      expect(await detection.json()).toEqual({ success: false, error: '索引存储暂不可用' });
    } finally { await pool.query('RENAME TABLE index_info_hidden TO index_info, report_hidden TO index_redundancy_report'); }
  } finally {
    state.pool = pool;
    await app.close();
  }
});
