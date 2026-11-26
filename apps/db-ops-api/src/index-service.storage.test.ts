import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => {
  const conn = { beginTransaction: vi.fn(), execute: vi.fn(), commit: vi.fn(),
    rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() };
  return { conn, pool: { getConnection: vi.fn() }, available: true,
    read: vi.fn(), save: vi.fn(), target: { execute: vi.fn() }, pgClient: { query: vi.fn() },
    dbType: 'mysql', connectedDb: 'app' };
});
vi.mock('./database-service.js', () => ({ databaseService: {
  getConnection: () => ({
    db_type: f.dbType, pool: f.target, pgClient: f.pgClient,
    config: { host: 'fixture', port: 3306, user: 'reader', database: f.connectedDb },
  }),
} }));
vi.mock('./instance-database-service.js', () => ({ instanceDatabaseService: {
  getInstanceById: async () => ({
    db_type: f.dbType, database_name: 'app', host: 'fixture', port: 3306, username: 'reader',
  }),
} }));
vi.mock('./db-connection.js', () => ({ dbConnection: {
  getPool: () => f.available ? f.pool : null,
}, decryptData: vi.fn() }));
vi.mock('./index-database-service.js', () => ({ indexDatabaseService: {
  getIndexesByInstance: f.read, saveRedundancyReport: f.save,
} }));
import { indexService } from './index-service';
beforeEach(() => {
  vi.resetAllMocks(); f.available = true; f.dbType = 'mysql'; f.connectedDb = 'app';
  f.pool.getConnection.mockResolvedValue(f.conn);
  f.target.execute.mockResolvedValue([[{ table_name: 't', index_name: 'i', usage_count: 0 }]]);
  f.read.mockResolvedValue([]); f.save.mockResolvedValue({ success: true, count: 0 });
});
it.each([1, 2])('MAX-504: UPDATE failure %i returns failure, never computed list', async (fail) => {
  let calls = 0;
  f.conn.execute.mockImplementation(async () => { if (++calls === fail) throw new Error('private SQL'); });
  expect(await indexService.detectUnusedIndexes(1)).toEqual({ error: '未使用索引检测或保存失败' });
  expect(f.conn.rollback).toHaveBeenCalledOnce();
  expect(f.conn.commit).not.toHaveBeenCalled();
});
it('MAX-504: rollback failure destroys connection and still reports failure', async () => {
  f.conn.execute.mockRejectedValue(new Error('write'));
  f.conn.rollback.mockRejectedValue(new Error('rollback'));
  expect(await indexService.detectUnusedIndexes(1)).toHaveProperty('error');
  expect(f.conn.destroy).toHaveBeenCalledOnce();
});
it('MAX-504: no pool fails; normal writes succeed', async () => {
  f.available = false;
  expect(await indexService.detectUnusedIndexes(1)).toHaveProperty('error');
  f.available = true;
  expect(await indexService.detectUnusedIndexes(1)).toEqual([{ table_name: 't', index_name: 'i' }]);
  expect(f.conn.commit).toHaveBeenCalledOnce();
});
it('MAX-515: successful empty detection persists an empty report', async () => {
  expect(await indexService.detectRedundantIndexes(1)).toEqual([]);
  expect(f.save).toHaveBeenCalledWith(1, []);
});
it('MAX-514: failed read cannot clear report; failed save cannot report success', async () => {
  f.read.mockRejectedValue(new Error('索引存储暂不可用'));
  expect(await indexService.detectRedundantIndexes(1)).toHaveProperty('error');
  expect(f.save).not.toHaveBeenCalled();
  f.read.mockResolvedValue([]); f.save.mockResolvedValue({ success: false, error: 'failed' });
  expect(await indexService.detectRedundantIndexes(1)).toEqual({ error: 'failed' });
});

it('R14 uses only known native counters for matching indexes, and never writes marks during reads', async () => {
  const row = (index_name: string) => ({ table_name: 't', index_name, is_unused: false });
  f.read.mockResolvedValue([row('unused'), row('used'), row('unknown'), row('absent')]);
  f.target.execute.mockResolvedValue([[
    { ...row('unused'), usage_count: '0' },
    { ...row('used'), usage_count: 1 },
    { ...row('unknown'), usage_count: null },
    { ...row('uncollected'), usage_count: 0 },
  ]]);
  expect(await indexService.readUnusedIndexObservation(1)).toMatchObject({
    rows: [{ ...row('unused'), is_unused: true }],
    evidence: { status: 'available', source: 'mysql-performance-schema', covered: 2 },
  });
  expect(f.target.execute).toHaveBeenCalledWith(expect.stringContaining('object_schema = ?'), ['app']);
  expect(f.pool.getConnection).not.toHaveBeenCalled();
});

it('R14 PostgreSQL usage matches only qualified identities from the configured connection', async () => {
  f.dbType = 'postgresql';
  const index = { table_name: 'app.service.t', index_name: 'i', is_unused: false };
  f.read.mockResolvedValue([index, { ...index, table_name: 'other.service.t' }, { ...index, table_name: 'app.other.t' }]);
  f.pgClient.query.mockResolvedValue({ rows: [{ ...index, usage_count: '0' }] });
  expect(await indexService.readUnusedIndexObservation(1)).toMatchObject({
    rows: [{ ...index, is_unused: true }],
    evidence: { status: 'available', source: 'postgresql-pg-stat-user-indexes', covered: 1 },
  });
  expect(f.pgClient.query).toHaveBeenCalledWith(expect.stringContaining('stats.schemaname'), ['app']);
  f.connectedDb = 'other';
  await expect(indexService.readUnusedIndexObservation(1)).rejects.toThrow('索引使用统计读取失败');
  expect(f.pgClient.query).toHaveBeenCalledOnce();
});

it.each(['oracle', 'dameng'])('R14 %s without native observations leaves usage unknown', async dbType => {
  f.dbType = dbType;
  f.read.mockResolvedValue([{ table_name: 't', index_name: 'legacy', is_unused: true }]);
  expect(await indexService.readUnusedIndexObservation(1)).toEqual({ rows: [], evidence: { status: 'unsupported' } });
  expect(f.target.execute).not.toHaveBeenCalled();
  expect(f.pgClient.query).not.toHaveBeenCalled();
});
