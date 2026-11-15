import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { metricsDatabaseService } from './metrics-database-service.js';

describe('MAX-257 D1 / MAX-511 capacity transaction lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  function fixture() {
    const connection = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([{ insertId: 51 }]),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(), release: vi.fn(),
    };
    const pool = { getConnection: vi.fn().mockResolvedValue(connection), execute: vi.fn() };
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as any);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return { connection, pool };
  }

  const data = { instance_id: 10, total_size_gb: 21, databases: [{ name: 'complete', size_gb: 21 }] };

  it('publishes header and details on one connection and defaults the count to the supplied details', async () => {
    const { connection, pool } = fixture();
    expect(await metricsDatabaseService.recordCapacity(data)).toEqual({ success: true });
    expect(pool.execute).not.toHaveBeenCalled();
    expect(connection.execute.mock.calls[0][1]).toEqual([10, 21, 1, 0]);
    expect(connection.execute.mock.calls[1][1]).toEqual([51, 10, 'complete', 21, 0]);
    expect(connection.beginTransaction.mock.invocationCallOrder[0]).toBeLessThan(connection.execute.mock.invocationCallOrder[0]);
    expect(connection.execute.mock.invocationCallOrder[1]).toBeLessThan(connection.commit.mock.invocationCallOrder[0]);
    expect(connection.commit.mock.invocationCallOrder[0]).toBeLessThan(connection.release.mock.invocationCallOrder[0]);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it('commits a legitimate empty snapshot', async () => {
    const { connection } = fixture();
    expect(await metricsDatabaseService.recordCapacity({ instance_id: 10, total_size_gb: 0, databases: [] })).toEqual({ success: true });
    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute.mock.calls[0][1]).toEqual([10, 0, 0, 0]);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it.each(['begin', 'header', 'details', 'commit'])('rolls back and releases on %s failure without replay', async stage => {
    const { connection, pool } = fixture();
    const failure = new Error(`failed ${stage}`);
    if (stage === 'begin') connection.beginTransaction.mockRejectedValueOnce(failure);
    if (stage === 'header') connection.execute.mockRejectedValueOnce(failure);
    if (stage === 'details') connection.execute.mockResolvedValueOnce([{ insertId: 51 }]).mockRejectedValueOnce(failure);
    if (stage === 'commit') connection.commit.mockRejectedValueOnce(failure);
    expect(await metricsDatabaseService.recordCapacity(data)).toEqual({ success: false, error: failure.message });
    expect(pool.getConnection).toHaveBeenCalledTimes(1);
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(connection.destroy).not.toHaveBeenCalled();
    if (stage !== 'commit') expect(connection.commit).not.toHaveBeenCalled();
  });

  it('destroys a connection with unknown transaction state when rollback fails, preserving the original failure', async () => {
    const { connection } = fixture();
    connection.execute.mockRejectedValueOnce(new Error('original insert failure'));
    connection.rollback.mockRejectedValueOnce(new Error('rollback failed'));
    expect(await metricsDatabaseService.recordCapacity(data)).toEqual({ success: false, error: 'original insert failure' });
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it('returns acquisition failures without trying to roll back an unowned connection', async () => {
    const { connection, pool } = fixture();
    pool.getConnection.mockRejectedValueOnce(new Error('pool unavailable'));
    expect(await metricsDatabaseService.recordCapacity(data)).toEqual({ success: false, error: 'pool unavailable' });
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).not.toHaveBeenCalled();
  });
});
