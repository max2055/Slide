import { beforeEach, expect, it, vi } from 'vitest';
const { pool, conn } = vi.hoisted(() => {
  const conn = { execute: vi.fn(), beginTransaction: vi.fn(), commit: vi.fn(),
    rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() };
  return { conn, pool: { execute: vi.fn(), getConnection: vi.fn() } };
});
vi.mock('./db-connection', () => ({ dbConnection: { getPool: () => pool } }));
import { indexDatabaseService as service, type IndexEntry } from './index-database-service';
beforeEach(() => {
  vi.resetAllMocks();
  pool.getConnection.mockResolvedValue(conn);
  conn.execute.mockResolvedValue([[{ id: 1 }]]);
});
const entry: IndexEntry = { table_name: 't', index_name: 'i', column_name: 'c',
  seq_in_index: 1, non_unique: 1, cardinality: 0, sub_part: null,
  nullable: 'YES', index_type: 'BTREE', comment: null };
it('MAX-513: chunks 5462 entries within a single transaction', async () => {
  expect(await service.saveIndexData(1, Array(5462).fill(entry))).toEqual({ success: true, count: 5462 });
  const inserts = conn.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT'));
  expect(inserts).toHaveLength(6);
  expect(inserts.reduce((n, [, params]) => n + params.length / 12, 0)).toBe(5462);
  expect(inserts.every(([, params]) => params.length <= 12000)).toBe(true);
  expect(conn.commit).toHaveBeenCalledOnce();
  expect(pool.execute).not.toHaveBeenCalled();
});
it('MAX-3: middle batch failure rolls back and releases', async () => {
  conn.execute.mockImplementation(async (sql, params) => {
    if (sql.startsWith('INSERT') && params.length < 12000) throw new Error('private SQL');
    return [[{ id: 1 }]];
  });
  expect(await service.saveIndexData(1, Array(1001).fill(entry))).toEqual({
    success: false, count: 0, error: '索引存储更新失败',
  });
  expect(conn.rollback).toHaveBeenCalledOnce();
  expect(conn.commit).not.toHaveBeenCalled();
  expect(conn.release).toHaveBeenCalledOnce();
});
it('MAX-515: empty report deletes only the supplied instance', async () => {
  expect(await service.saveRedundancyReport(2, [])).toEqual({ success: true, count: 0 });
  expect(conn.execute).toHaveBeenCalledWith('DELETE FROM index_redundancy_report WHERE instance_id = ?', [2]);
  expect(conn.commit).toHaveBeenCalledOnce();
});
it('rejects mixed-instance reports before deleting anything', async () => {
  expect((await service.saveRedundancyReport(1, [{ instance_id: 2 } as any])).success).toBe(false);
  expect(conn.execute).not.toHaveBeenCalled();
});
it.each(['getIndexesByInstance', 'getIndexesByTable', 'getRedundancyReport', 'getUnusedIndexes'] as const)(
  'MAX-514: %s distinguishes empty data and storage failure', async (method) => {
    pool.execute.mockResolvedValue([[]]);
    expect(await service[method](1, 't')).toEqual([]);
    pool.execute.mockRejectedValue(new Error('private SQL'));
    await expect(service[method](1, 't')).rejects.toThrow('索引存储暂不可用');
  });
