import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseService } from './database-service.js';
vi.mock('./resources/instance-access-lifecycle.js', () => ({ instanceAccessLifecycle: { assertAvailable: vi.fn() }, cleanupDeadline: vi.fn() }));
const service = databaseService as any;
afterEach(() => { service.connections.delete(991); vi.restoreAllMocks(); });
describe('query availability remains distinct from empty success', () => {
  it.each(['mysql', 'postgresql', 'oracle', 'dameng'])('%s slow query failures remain unavailable', async db_type => {
    const rejected = vi.fn().mockRejectedValue(new Error('query denied'));
    service.connections.set(991, { id: 991, connected: true, db_type,
      pool: { query: rejected }, pgClient: { query: rejected }, oraclePool: {}, oracleConnection: { execute: rejected }, dmConnection: { execute: rejected } });
    expect(await databaseService.getSlowQueries(991)).toBeNull();
  });
  it('missing pg_stat_statements is unavailable rather than no slow queries', async () => {
    service.connections.set(991, { id: 991, connected: true, db_type: 'postgresql', pgClient: { query: vi.fn().mockResolvedValue({ rows: [] }) } });
    expect(await databaseService.getSlowQueries(991)).toBeNull();
  });
  it('preserves MySQL successful empty and slow_log fallback compatibility', async () => {
    const query = vi.fn().mockResolvedValue([[]]);
    service.connections.set(991, { id: 991, connected: true, db_type: 'mysql', pool: { query } });
    expect(await databaseService.getSlowQueries(991)).toEqual([]);
    query.mockRejectedValueOnce(new Error('performance_schema unavailable'));
    expect(await databaseService.getSlowQueries(991)).toEqual([]); expect(query).toHaveBeenCalledTimes(3);
  });
  it('Oracle session errors remain unavailable', async () => {
    service.connections.set(991, { id: 991, connected: true, db_type: 'oracle', oraclePool: {}, oracleConnection: { execute: vi.fn().mockRejectedValue(new Error('denied')) } });
    expect(await databaseService.getActiveSessions(991)).toBeNull();
  });
  it('unsupported session source remains unavailable', async () => {
    service.connections.set(991, { id: 991, connected: true, db_type: 'redis' });
    expect(await databaseService.getActiveSessions(991)).toBeNull();
  });
});
