import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseService } from './database-service.js';

const connections = (databaseService as any).connections as Map<number, any>;
const id = 996;
afterEach(() => { connections.delete(id); vi.restoreAllMocks(); });

describe('MAX-396/398 slow-query duration contract', () => {
  it('keeps Oracle SQL millisecond aliases once, with total distinct from unknown extrema', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [['oracle-fixture', 'select fixture', 2000, 10000, 5, null, null]] });
    connections.set(id, { id, connected: true, db_type: 'oracle', oraclePool: {}, oracleConnection: { execute } });
    const rows = await databaseService.getSlowQueries(id);
    expect(rows?.[0]).toMatchObject({ avg_time_ms: 2000, total_time_ms: 10000, execution_count: 5, min_time_ms: null, max_time_ms: null });
    expect(execute.mock.calls[0][0]).toContain('elapsed_time / executions > 1000000');
  });

  it.each(['total_exec_time', 'total_time'])('passes PostgreSQL extrema and total from %s', async timeCol => {
    const modern = timeCol === 'total_exec_time';
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [timeCol, modern ? 'min_exec_time' : 'min_time', modern ? 'max_exec_time' : 'max_time', 'calls'].map(column_name => ({ column_name })) })
      .mockResolvedValueOnce({ rows: [{ sql_text: 'select fixture', avg_time_ms: 100.25, min_time_ms: 20, max_time_ms: 150, total_time_ms: 401, execution_count: 4 }] });
    connections.set(id, { id, connected: true, db_type: 'postgresql', pgClient: { query } });
    expect((await databaseService.getSlowQueries(id))?.[0]).toMatchObject({ avg_time_ms: 100.25, min_time_ms: 20, max_time_ms: 150, total_time_ms: 401 });
  });

  it('keeps missing PostgreSQL extrema unknown and real zero intact', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{ column_name: 'total_time' }] })
      .mockResolvedValueOnce({ rows: [{ sql_text: 'select fixture', avg_time_ms: 2000, min_time_ms: null, max_time_ms: null, total_time_ms: 2000 }] });
    connections.set(id, { id, connected: true, db_type: 'postgresql', pgClient: { query } });
    expect((await databaseService.getSlowQueries(id))?.[0]).toMatchObject({ min_time_ms: null, max_time_ms: null });
    expect(query.mock.calls[2][0]).toContain('NULL as max_time_ms');
  });

  it('passes MySQL digest minimum and total in milliseconds', async () => {
    const query = vi.fn().mockResolvedValue([[{ sql_text: 'select fixture', avg_time_ms: '100.25', min_time_ms: '0', max_time_ms: '150', total_time_ms: '401', execution_count: 4 }]]);
    connections.set(id, { id, connected: true, db_type: 'mysql', pool: { query } });
    expect((await databaseService.getSlowQueries(id))?.[0]).toMatchObject({ avg_time_ms: 100.25, min_time_ms: 0, max_time_ms: 150, total_time_ms: 401 });
    expect(query.mock.calls[0][0]).toContain('MIN_TIMER_WAIT / 1000000000');
  });

  it('uses the single MySQL slow-log event for all durations after TIME conversion', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('digest unavailable')).mockResolvedValueOnce([[{ sql_text: 'select fixture', query_time_ms: '2123.456' }]]);
    connections.set(id, { id, connected: true, db_type: 'mysql', pool: { query } });
    expect((await databaseService.getSlowQueries(id))?.[0]).toMatchObject({ avg_time_ms: 2123.456, min_time_ms: 2123.456, max_time_ms: 2123.456, total_time_ms: 2123.456, execution_count: 1 });
    expect(query.mock.calls[1][0]).toContain('TIME_TO_SEC(query_time) * 1000');
  });

  it('uses a single Dameng history execution for min and max', async () => {
    connections.set(id, { id, connected: true, db_type: 'dameng', dmConnection: { execute: vi.fn().mockResolvedValue({ rows: [['dm-fixture', 'select fixture', 2000, 2000, 1, null, null]] }) } });
    expect((await databaseService.getSlowQueries(id))?.[0]).toMatchObject({ avg_time_ms: 2000, min_time_ms: 2000, max_time_ms: 2000, total_time_ms: 2000 });
  });
});
