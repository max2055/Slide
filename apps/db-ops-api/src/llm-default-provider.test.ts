import type { Pool, PoolConnection } from 'mysql2/promise';
import { afterEach, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { llmDatabaseService } from './llm-database-service.js';

afterEach(() => vi.restoreAllMocks());

it('destroys the connection when rollback fails', async () => {
  const connection = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockRejectedValue(new Error('update failed')),
    rollback: vi.fn().mockRejectedValue(new Error('rollback failed')),
    destroy: vi.fn(),
    release: vi.fn(),
  };
  const pool = { getConnection: vi.fn().mockResolvedValue(connection as unknown as PoolConnection) };
  vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as unknown as Pool);
  vi.spyOn(console, 'error').mockImplementation(() => {});

  expect(await llmDatabaseService.setDefaultProvider('beta')).toEqual({ success: false, error: 'update failed' });
  expect(connection.destroy).toHaveBeenCalledOnce();
  expect(connection.release).not.toHaveBeenCalled();
});
