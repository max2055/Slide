import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { CronRunStore } from './cron-run-store.js';

afterEach(() => vi.restoreAllMocks());

describe('Cron run/log atomic binding (#510)', () => {
  it.each(['success', 'first-update', 'second-update', 'commit', 'rollback'])(
    'uses one transaction and releases its connection: %s', async failure => {
      const cause = new Error(failure);
      const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
      if (failure === 'first-update') execute.mockRejectedValueOnce(cause);
      if (['second-update', 'rollback'].includes(failure)) {
        execute.mockResolvedValueOnce([{ affectedRows: 1 }]).mockRejectedValueOnce(cause);
      }
      const connection = {
        beginTransaction: vi.fn().mockResolvedValue(undefined), execute,
        commit: vi.fn().mockImplementation(async () => { if (failure === 'commit') throw cause; }),
        rollback: vi.fn().mockImplementation(async () => { if (failure === 'rollback') throw new Error('rollback error'); }),
        release: vi.fn(), destroy: vi.fn(),
      };
      const pool = { getConnection: vi.fn().mockResolvedValue(connection), execute: vi.fn() };
      vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as any);
      const result = new CronRunStore().bindLog('run-id', 12);
      if (failure === 'success') await result;
      else await expect(result).rejects.toBe(cause);
      expect(pool.getConnection).toHaveBeenCalledTimes(1);
      expect(pool.execute).not.toHaveBeenCalled();
      expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenNthCalledWith(1, 'UPDATE cron_runs SET log_id = ? WHERE run_id = ?', [12, 'run-id']);
      if (failure !== 'first-update') {
        expect(execute).toHaveBeenNthCalledWith(2, 'UPDATE cron_job_logs SET run_id = ? WHERE id = ?', ['run-id', 12]);
      }
      expect(connection.commit).toHaveBeenCalledTimes(['success', 'commit'].includes(failure) ? 1 : 0);
      expect(connection.rollback).toHaveBeenCalledTimes(failure === 'success' ? 0 : 1);
      expect(connection.release).toHaveBeenCalledTimes(1);
      expect(connection.destroy).toHaveBeenCalledTimes(failure === 'rollback' ? 1 : 0);
    },
  );
});
