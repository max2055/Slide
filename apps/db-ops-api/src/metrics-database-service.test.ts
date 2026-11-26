import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { metricsDatabaseService } from './metrics-database-service.js';

describe('MetricsDatabaseService.recordMetrics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists omitted independently scheduled metrics as null without losing real zeroes', async () => {
    const execute = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('FROM metric_policy_bindings')) return [[], []];
    if (sql.includes('metric_policy_lock')) return [[{ id: 1 }], []];
      if (sql.includes('FROM metric_rollout')) return [[], []];
      return [{ affectedRows: 1 }, []];
    });
    const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() };
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ getConnection: async () => connection } as any);

    await expect(metricsDatabaseService.recordMetrics({ instance_id: 7, qps: 0 }))
      .resolves.toEqual({ success: true });

    const insert = execute.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO metrics_history'))!;
    const params = insert[1] as unknown[];
    expect(params[0]).toBe(7);
    expect(params[1]).toBeNull();
    expect(params[5]).toBe(0);
    expect(params.slice(6, 17)).toEqual(Array(11).fill(null));
  });

  it('treats a pending or v2 resource as an intentional legacy skip', async () => {
    const execute = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('FROM metric_policy_bindings')) return [[], []];
    if (sql.includes('metric_policy_lock')) return [[{ id: 1 }], []];
      if (sql.includes('FROM metric_rollout')) return [[{
        source: 'semantic', read_mode: 'semantic', published_revision: 2, applied_revision: null,
      }], []];
      throw new Error('legacy insert must be fenced');
    });
    const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() };
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ getConnection: async () => connection } as any);

    await expect(metricsDatabaseService.recordMetrics({ instance_id: 7, qps: 9 }))
      .resolves.toEqual({ success: true, skipped: 'source_fenced' });
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO metrics_history'))).toBe(false);
  });
});

describe('MetricsDatabaseService.getSlowQueries', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preserves SQL NULL for reports and leaves ordinary numeric reads compatible', async () => {
    const query = vi.fn().mockResolvedValue([[
      { avg_time_ms: null, total_time_ms: null, min_time_ms: null, max_time_ms: null },
      { avg_time_ms: '0.00', total_time_ms: '0.00', min_time_ms: '0.00', max_time_ms: '0.00' },
      { avg_time_ms: '12.34', total_time_ms: '24.68', min_time_ms: '11.57', max_time_ms: '13.11' },
    ], []]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ query } as any);

    const report = await metricsDatabaseService.getSlowQueries(7, 20, { preserveUnknownDurations: true });
    expect(report.map(row => [row.avg_time_ms, row.total_time_ms])).toEqual([[null, null], [0, 0], [12.34, 24.68]]);
    const existing = await metricsDatabaseService.getSlowQueries(7, 20);
    expect(existing.map(row => [row.avg_time_ms, row.total_time_ms])).toEqual([[0, 0], [0, 0], [12.34, 24.68]]);
  });
});

describe('MAX-536 MetricsDatabaseService.getSlowQueryById', () => {
  afterEach(() => vi.restoreAllMocks());

  it('scopes the parameterized primary-key lookup to the requested instance and normalizes decimals', async () => {
    const row = { id: 101, instance_id: 7, sql_text: 'SELECT 1', avg_time_ms: '1.25', max_time_ms: null, min_time_ms: '0.00', total_time_ms: '2.50' };
    const execute = vi.fn().mockResolvedValue([[row], []]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    await expect(metricsDatabaseService.getSlowQueryById(7, 101)).resolves.toMatchObject({
      id: 101, instance_id: 7, avg_time_ms: 1.25, max_time_ms: null, min_time_ms: 0, total_time_ms: 2.5,
    });
    expect(execute.mock.calls[0][0]).toMatch(/WHERE instance_id = \? AND id = \?/);
    expect(execute.mock.calls[0][1]).toEqual([7, 101]);
  });

  it('returns null only for a successful empty read', async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: vi.fn().mockResolvedValue([[], []]) } as any);
    await expect(metricsDatabaseService.getSlowQueryById(7, 101)).resolves.toBeNull();
  });

  it('keeps storage unavailability distinct from absence', async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(null);
    await expect(metricsDatabaseService.getSlowQueryById(7, 101)).rejects.toThrow('SLOW_QUERIES_UNAVAILABLE');
  });

  it('preserves the query failure cause without exposing backend details in the message', async () => {
    const cause = new Error('backend details');
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: vi.fn().mockRejectedValue(cause) } as any);
    await expect(metricsDatabaseService.getSlowQueryById(7, 101)).rejects.toMatchObject({ message: 'SLOW_QUERIES_QUERY_FAILED', cause });
  });
});
