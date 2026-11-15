import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => {
  const conn = { beginTransaction: vi.fn(), execute: vi.fn(), commit: vi.fn(),
    rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() };
  return { conn, pool: { getConnection: vi.fn() }, available: true,
    read: vi.fn(), save: vi.fn(), target: { execute: vi.fn() } };
});
vi.mock('./database-service.js', () => ({ databaseService: {
  getConnection: () => ({ db_type: 'mysql', pool: f.target }),
} }));
vi.mock('./instance-database-service.js', () => ({ instanceDatabaseService: {
  getInstanceById: async () => ({ database_name: 'app' }),
} }));
vi.mock('./db-connection.js', () => ({ dbConnection: {
  getPool: () => f.available ? f.pool : null,
}, decryptData: vi.fn() }));
vi.mock('./index-database-service.js', () => ({ indexDatabaseService: {
  getIndexesByInstance: f.read, saveRedundancyReport: f.save,
} }));
import { indexService } from './index-service';
beforeEach(() => {
  vi.resetAllMocks(); f.available = true;
  f.pool.getConnection.mockResolvedValue(f.conn);
  f.target.execute.mockResolvedValue([[{ object_name: 't', index_name: 'i' }]]);
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
