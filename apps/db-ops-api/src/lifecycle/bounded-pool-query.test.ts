import { afterEach, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { boundedPoolQuery } from './bounded-pool-query.js';
afterEach(() => vi.useRealTimers());
it('releases a late checkout without ever submitting its abandoned SQL', async () => {
  vi.useFakeTimers();
  let arrive!: (value: any) => void;
  const pool = { getConnection: () => new Promise(resolve => { arrive = resolve; }) } as unknown as Pool;
  const result = boundedPoolQuery(pool, 'UPDATE worker_leases SET expires_at = NOW()', [], 100);
  const failed = expect(result).rejects.toMatchObject({ code: 'PLATFORM_QUERY_TIMEOUT', stage: 'checkout' });
  await vi.advanceTimersByTimeAsync(101); await failed;
  const connection = { release: vi.fn(), query: vi.fn() }; arrive(connection);
  await Promise.resolve(); await Promise.resolve();
  expect(connection.release).toHaveBeenCalledOnce(); expect(connection.query).not.toHaveBeenCalled();
});
it('destroys a SQL connection on timeout and never returns it to the pool', async () => {
  vi.useFakeTimers();
  const connection = { release: vi.fn(), destroy: vi.fn(), query: vi.fn(() => new Promise(() => {})) };
  const result = boundedPoolQuery({ getConnection: async () => connection } as unknown as Pool, 'SELECT 1', [], 100);
  const failed = expect(result).rejects.toMatchObject({ code: 'PLATFORM_QUERY_TIMEOUT', stage: 'query' });
  await vi.advanceTimersByTimeAsync(101); await failed;
  expect(connection.destroy).toHaveBeenCalledOnce(); expect(connection.release).not.toHaveBeenCalled();
});
it('returns successful reads and releases SQL failures without closing the stable pool', async () => {
  const connection = { release: vi.fn(), destroy: vi.fn(), query: vi.fn(async () => [[{ ok: 1 }], []]) };
  const pool = { getConnection: async () => connection } as unknown as Pool;
  expect(await boundedPoolQuery(pool, 'SELECT 1')).toEqual([[{ ok: 1 }], []]);
  connection.query.mockRejectedValueOnce(Object.assign(new Error('private database detail'), { code: 'ER_BAD_FIELD_ERROR' }));
  await expect(boundedPoolQuery(pool, 'SELECT missing')).rejects.toMatchObject({ code: 'ER_BAD_FIELD_ERROR' });
  expect(connection.release).toHaveBeenCalledTimes(2); expect(connection.destroy).not.toHaveBeenCalled();
});
