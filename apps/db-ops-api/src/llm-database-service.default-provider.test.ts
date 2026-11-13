import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { llmDatabaseService } from './llm-database-service.js';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
  const connection = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    execute,
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    destroy: vi.fn(),
  };
  const pool = { getConnection: vi.fn().mockResolvedValue(connection), execute: vi.fn() };
  vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  execute.mockResolvedValueOnce([[{ id: 1 }, { id: 2 }]])
    .mockResolvedValueOnce([[{ id: 2 }]]);
  return { pool, connection };
}

describe('default Provider switching (#523)', () => {
  it('uses one connection and commits only after validating and updating the target', async () => {
    const { pool, connection } = fixture();
    expect(await llmDatabaseService.setDefaultProvider('beta')).toEqual({ success: true });
    expect(pool.execute).not.toHaveBeenCalled();
    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.execute.mock.calls[0][0]).toMatch(/ORDER BY id FOR UPDATE/);
    expect(connection.execute.mock.calls[1]).toEqual([
      'SELECT id FROM llm_providers WHERE name = ?', ['beta'],
    ]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('rolls back when the second write fails', async () => {
    const { connection } = fixture();
    connection.execute.mockResolvedValueOnce([{ affectedRows: 2 }])
      .mockRejectedValueOnce(new Error('injected second write failure'));
    expect(await llmDatabaseService.setDefaultProvider('beta')).toEqual({
      success: false, error: 'injected second write failure',
    });
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('rejects a missing target before clearing the default', async () => {
    const { connection } = fixture();
    connection.execute.mockReset().mockResolvedValueOnce([[{ id: 1 }]]).mockResolvedValueOnce([[]]);
    expect((await llmDatabaseService.setDefaultProvider('missing')).success).toBe(false);
    expect(connection.execute).toHaveBeenCalledTimes(2);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
  });

  it('does not report success if the target update matches no row', async () => {
    const { connection } = fixture();
    connection.execute.mockResolvedValueOnce([{ affectedRows: 2 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }]);
    expect((await llmDatabaseService.setDefaultProvider('beta')).success).toBe(false);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
  });

  it('destroys a connection whose rollback fails instead of returning an open transaction to the pool', async () => {
    const { connection } = fixture();
    connection.execute.mockRejectedValueOnce(new Error('write failed'));
    connection.rollback.mockRejectedValueOnce(new Error('rollback failed'));
    expect((await llmDatabaseService.setDefaultProvider('beta')).success).toBe(false);
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
  });

  it('returns failure on pool acquisition errors', async () => {
    const { pool } = fixture();
    pool.getConnection.mockRejectedValueOnce(new Error('pool unavailable'));
    expect(await llmDatabaseService.setDefaultProvider('beta')).toEqual({ success: false, error: 'pool unavailable' });
  });

  it('returns failure without a database connection', async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(null);
    expect(await llmDatabaseService.setDefaultProvider('beta')).toEqual({ success: false, error: '数据库未连接' });
  });
});
