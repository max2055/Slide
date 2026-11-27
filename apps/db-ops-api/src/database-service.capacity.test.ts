import { afterEach, expect, it, vi } from 'vitest';
import { databaseService } from './database-service.js';

const connections = (databaseService as any).connections as Map<number, unknown>;
const id = 997;
afterEach(() => connections.delete(id));

it('R12 PostgreSQL reports only the connected database and independently readable details', async () => {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [{ name: 'current', size_gb: '1.25', size: '1280 MB' }] })
    .mockResolvedValueOnce({ rows: [{ tc: '3' }] })
    .mockRejectedValueOnce(new Error('private detail failure'));
  connections.set(id, { id, connected: true, db_type: 'postgresql', pgClient: { query } });
  expect(await databaseService.getCapacityInfo(id)).toMatchObject({
    source: 'PostgreSQL pg_database_size(current_database())',
    total_size_gb: 1.25,
    details_unavailable: true,
    databases: [{ name: 'current', size_gb: 1.25, table_count: 3 }],
    top_tables: [],
  });
  expect(query.mock.calls[0][0]).toContain('pg_database_size(current_database())');
});

it.each(['oracle', 'dameng'] as const)('R12 %s adds permanent allocations before rounding and preserves available bytes on detail failure', async dbType => {
  const execute = vi.fn()
    .mockResolvedValueOnce({ rows: [['first', 64 * 2 ** 20, 512 * 2 ** 20], ['second', 64 * 2 ** 20, 512 * 2 ** 20]] })
    .mockRejectedValueOnce(new Error('private detail failure'));
  connections.set(id, { id, connected: true, db_type: dbType, oraclePool: {},
    oracleConnection: { execute }, dmConnection: { execute } });
  expect(await databaseService.getCapacityInfo(id)).toMatchObject({
    total_size_gb: 0.13, details_unavailable: true, top_tables: [],
    tablespaces: [{ name: 'first', size_gb: 0.06 }, { name: 'second', size_gb: 0.06 }],
  });
  expect(execute.mock.calls[0][0]).toContain('DBA_DATA_FILES');
  expect(execute.mock.calls[0][0]).not.toContain('DBA_FREE_SPACE');
});

it('R12 unreadable allocation does not become zero or hide independently available segments', async () => {
  const execute = vi.fn()
    .mockRejectedValueOnce(new Error('missing file privilege'))
    .mockResolvedValueOnce({ rows: [['SCHEMA.TABLE', 'TABLE', 0.01]] });
  connections.set(id, { id, connected: true, db_type: 'oracle', oraclePool: {}, oracleConnection: { execute } });
  const result = await databaseService.getCapacityInfo(id);
  expect(result).not.toHaveProperty('total_size_gb');
  expect(result.top_tables).toEqual([{ name: 'SCHEMA.TABLE', type: 'TABLE', size_gb: 0.01 }]);
});

it('R12 a valid MySQL zero remains a numeric observation', async () => {
  const execute = vi.fn().mockResolvedValue([[]]);
  connections.set(id, { id, connected: true, db_type: 'mysql', pool: { execute } });
  expect(await databaseService.getCapacityInfo(id)).toMatchObject({
    total_size_gb: 0, databases: [], top_tables: [], source: expect.stringContaining('估算'),
  });
});
