import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { schemaDatabaseService as service, type TableSchemaRow } from './schema-database-service.js';

const column = (name: string): TableSchemaRow => ({
  table_name: 'items', column_name: name, column_type: 'int', is_nullable: 'YES',
  column_default: null, column_key: '', extra: '', column_comment: null,
  table_comment: null, table_rows: 0, data_length: 0,
});

afterEach(() => vi.restoreAllMocks());
describe('GitHub #368 atomic snapshot batches', () => {
  function setup(last: Date | null = null) {
    const connection = {
      beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn(),
      execute: vi.fn().mockResolvedValueOnce([[{ id: 1 }]])
        .mockResolvedValueOnce([[{ snapshot_time: last }]]).mockResolvedValue([{}]),
    };
    const pool = { getConnection: vi.fn().mockResolvedValue(connection) };
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as any);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return { connection, pool };
  }
  it('#558 preserves unavailable size as SQL NULL instead of measured zero', async () => {
    const { connection } = setup();
    expect((await service.saveSnapshot(1, [{ ...column('id'), data_length: null }])).success).toBe(true);
    expect(connection.execute.mock.calls[2][1][12]).toBeNull();
  });
  it('allocates after the last committed batch even if the application clock moves backwards', async () => {
    const previous = new Date('2040-01-01T00:00:00.999Z');
    const { connection } = setup(previous);
    expect(await service.saveSnapshot(1, [column('id')])).toEqual({ success: true, count: 1 });
    expect(connection.execute.mock.calls[2][1][1]).toEqual(new Date('2040-01-01T00:00:01.000Z'));
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });
  it('rolls back earlier chunks when a later chunk fails, without deleting history', async () => {
    const { connection } = setup();
    connection.execute.mockReset().mockResolvedValueOnce([[{ id: 1 }]])
      .mockResolvedValueOnce([[{ snapshot_time: null }]])
      .mockResolvedValueOnce([{}]).mockRejectedValueOnce(new Error('second chunk rejected'));
    const result = await service.saveSnapshot(1, Array.from({ length: 501 }, (_, i) => column(`c${i}`)));
    expect(result.success).toBe(false);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(connection.execute.mock.calls.some(([sql]) => sql.includes('DELETE'))).toBe(false);
  });
  it('destroys a connection if rollback cannot be confirmed', async () => {
    const { connection } = setup();
    connection.commit.mockRejectedValue(new Error('connection lost'));
    connection.rollback.mockRejectedValue(new Error('connection lost'));
    expect((await service.saveSnapshot(1, [column('id')])).success).toBe(false);
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
  });
  it('rejects a missing instance and releases its transaction', async () => {
    const { connection } = setup();
    connection.execute.mockReset().mockResolvedValue([[]]);
    expect((await service.saveSnapshot(1, [column('id')])).success).toBe(false);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.execute).toHaveBeenCalledTimes(1);
  });
  it('rejects empty data without taking a pool connection', async () => {
    const { pool } = setup();
    expect((await service.saveSnapshot(1, [])).success).toBe(false);
    expect(pool.getConnection).not.toHaveBeenCalled();
  });
});

// #558 SQL NULL must survive the aggregate/list conversion as well as INSERT.
it('preserves unavailable allocation in the table list alongside measured zero', async () => {
  const pool = { execute: vi.fn().mockResolvedValue([[
    { table_name: 'unknown', data_length: null, table_rows: 0, column_count: 1, snapshot_time: new Date() },
    { table_name: 'empty', data_length: '0', table_rows: 0, column_count: 1, snapshot_time: new Date() },
  ]]) };
  vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as any);
  expect((await service.getTableList(1)).map(row => row.data_length)).toEqual([null, 0]);
});
