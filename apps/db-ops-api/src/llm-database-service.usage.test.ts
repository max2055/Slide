import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { llmDatabaseService } from './llm-database-service.js';

const record = { provider_id: 1, provider_name: 'test', model: 'model', session_id: 's', input_tokens: 2, output_tokens: 3 };
afterEach(() => vi.restoreAllMocks());

describe('recordUsage transaction lifecycle (#524)', () => {
  function fixture() {
    const connection = {
      beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn(),
      execute: vi.fn(async (sql: string) => {
        if (sql.includes('CURRENT_TIMESTAMP')) return [[{ recorded_at: '2026-11-13 00:00:00', usage_date: '2026-11-13' }]];
        if (sql.includes('COUNT(DISTINCT')) return [[{ unique_users: 0, unique_sessions: 1 }]];
        return [{ affectedRows: 1 }];
      }),
    };
    const pool = { getConnection: vi.fn().mockResolvedValue(connection) };
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as any);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return { connection, pool };
  }

  it('uses a single transaction and database time, excluding anonymous users', async () => {
    const { connection, pool } = fixture();
    expect(await llmDatabaseService.recordUsage(record)).toEqual({ success: true });
    expect(pool.getConnection).toHaveBeenCalledTimes(1);
    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    const calls = connection.execute.mock.calls as unknown as [string, unknown[]][];
    expect(calls[1][0]).toContain('ON DUPLICATE KEY UPDATE');
    expect(calls[2][1][3]).toBeNull();
    expect(calls[2][1][14]).toBe('2026-11-13 00:00:00');
    expect(calls[4][1].slice(6, 8)).toEqual([0, 1]);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  for (const stage of ['begin', 'lock', 'detail', 'count', 'aggregate', 'commit']) {
    it(`returns failure and rolls back a ${stage} error without replay`, async () => {
      const { connection, pool } = fixture();
      const error = new Error('injected failure');
      if (stage === 'begin') connection.beginTransaction.mockRejectedValueOnce(error);
      else if (stage === 'commit') connection.commit.mockRejectedValueOnce(error);
      else {
        const original = connection.execute.getMockImplementation()!;
        connection.execute.mockImplementation(async (sql: string) => {
          const match = stage === 'lock' ? 'ON DUPLICATE' : stage === 'detail' ? 'INSERT INTO llm_usage_records'
            : stage === 'count' ? 'COUNT(DISTINCT' : 'UPDATE llm_usage_daily_stats SET';
          if (sql.includes(match)) throw error;
          return original(sql);
        });
      }
      expect(await llmDatabaseService.recordUsage(record)).toEqual({ success: false, error: error.message });
      expect(pool.getConnection).toHaveBeenCalledTimes(1);
      expect(connection.rollback).toHaveBeenCalledTimes(1);
      expect(connection.release).toHaveBeenCalledTimes(1);
    });
  }

  it('destroys a connection whose rollback fails', async () => {
    const { connection } = fixture();
    connection.commit.mockRejectedValueOnce(new Error('commit unknown'));
    connection.rollback.mockRejectedValueOnce(new Error('rollback unknown'));
    expect(await llmDatabaseService.recordUsage(record)).toEqual({ success: false, error: 'commit unknown' });
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(connection.release).not.toHaveBeenCalled();
  });

  it('handles connection acquisition failure and unavailable storage', async () => {
    const { pool } = fixture();
    pool.getConnection.mockRejectedValueOnce(new Error('pool unavailable'));
    expect((await llmDatabaseService.recordUsage(record)).success).toBe(false);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(null);
    expect(await llmDatabaseService.recordUsage(record)).toEqual({ success: false, error: '数据库未连接' });
  });
});
