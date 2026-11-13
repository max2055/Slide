import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock('./db-connection.js', () => ({ dbConnection: { getPool } }));
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';

describe('#310 delete transaction error contract (Chief review)', () => {
  let connection: any;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    connection = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([[{ status: 'completed' }]]),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      destroy: vi.fn(),
    };
    getPool.mockReturnValue({ getConnection: vi.fn().mockResolvedValue(connection) });
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('preserves the SQL error when rollback also fails and discards the connection', async () => {
    connection.execute.mockRejectedValue(new Error('PRIMARY_CONNECTION_LOST'));
    connection.rollback.mockRejectedValue(new Error('ROLLBACK_CONNECTION_LOST'));
    await expect(aiAnalysisDatabaseService.deleteAnalysis(1)).resolves.toEqual({
      success: false, error: 'PRIMARY_CONNECTION_LOST',
    });
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(connection.release).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('删除分析记录回滚失败，事务结果未确认:', expect.objectContaining({ message: 'ROLLBACK_CONNECTION_LOST' }));
  });

  it('returns begin failure and releases only after confirmed rollback', async () => {
    connection.beginTransaction.mockRejectedValue(new Error('BEGIN_FAILED'));
    await expect(aiAnalysisDatabaseService.deleteAnalysis(1)).resolves.toEqual({ success: false, error: 'BEGIN_FAILED' });
    expect(connection.execute).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not replay or reuse after commit acknowledgement failure (rollback fails: %s)', async failRollback => {
    connection.commit.mockRejectedValue(new Error('COMMIT_ACK_UNKNOWN'));
    if (failRollback) connection.rollback.mockRejectedValue(new Error('ROLLBACK_FAILED'));
    await expect(aiAnalysisDatabaseService.deleteAnalysis(1)).resolves.toEqual({ success: false, error: 'COMMIT_ACK_UNKNOWN' });
    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledTimes(6);
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(connection.release).not.toHaveBeenCalled();
  });

  it('releases after a successful commit without rollback', async () => {
    await expect(aiAnalysisDatabaseService.deleteAnalysis(1)).resolves.toEqual({ success: true });
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it('preserves acquisition errors without trying to clean up an unowned connection', async () => {
    getPool.mockReturnValue({ getConnection: vi.fn().mockRejectedValue(new Error('POOL_FAILED')) });
    await expect(aiAnalysisDatabaseService.deleteAnalysis(1)).resolves.toEqual({ success: false, error: 'POOL_FAILED' });
    expect(connection.release).not.toHaveBeenCalled();
    expect(connection.destroy).not.toHaveBeenCalled();
  });
});
