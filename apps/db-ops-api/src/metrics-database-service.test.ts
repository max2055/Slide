import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { metricsDatabaseService } from './metrics-database-service.js';

describe('MetricsDatabaseService.recordMetrics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists omitted independently scheduled metrics as null without losing real zeroes', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);

    await expect(metricsDatabaseService.recordMetrics({ instance_id: 7, qps: 0 }))
      .resolves.toEqual({ success: true });

    const params = execute.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(7);
    expect(params[1]).toBeNull();
    expect(params[5]).toBe(0);
    expect(params.slice(6, 17)).toEqual(Array(11).fill(null));
  });
});

describe('MetricsDatabaseService.getRealtimeMetrics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves the legacy null fallback unless strict reads are requested', async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(null);

    await expect(metricsDatabaseService.getRealtimeMetrics(7)).resolves.toBeNull();
    await expect(metricsDatabaseService.getRealtimeMetrics(7, { strict: true }))
      .rejects.toThrow('REALTIME_METRICS_UNAVAILABLE');
  });

  it('distinguishes strict query failures from a successful query with no samples', async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error('sensitive backend details'))
      .mockResolvedValueOnce([[], []]);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);

    await expect(metricsDatabaseService.getRealtimeMetrics(7, { strict: true }))
      .rejects.toThrow('REALTIME_METRICS_QUERY_FAILED');
    await expect(metricsDatabaseService.getRealtimeMetrics(7, { strict: true }))
      .resolves.toBeNull();
  });

  it('returns a structured storage-unavailable outcome distinct from no samples', async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(null);
    await expect(metricsDatabaseService.getRealtimeMetricsWithStatus(7)).resolves.toMatchObject({
      available: false,
      data: null,
      errorCode: 'METRICS_STORAGE_UNAVAILABLE',
    });
  });

  it('returns available=true when the query succeeds with no samples', async () => {
    const execute = vi.fn().mockResolvedValue([[], []]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    await expect(metricsDatabaseService.getRealtimeMetricsWithStatus(7)).resolves.toMatchObject({
      available: true,
      data: null,
      errorCode: 'METRICS_NOT_COLLECTED',
    });
  });

  it('merges the latest non-null value for each sparse metric', async () => {
    const execute = vi.fn().mockResolvedValue([[
      { id: 3, instance_id: 7, cpu_usage: 31, disk_usage: null, metrics_data: '{"custom_fast":9}', recorded_at: new Date('2026-09-01T00:02:00Z') },
      { id: 2, instance_id: 7, cpu_usage: 30, disk_usage: 72, metrics_data: { custom_slow: 4 }, recorded_at: new Date('2026-09-01T00:01:00Z') },
    ], []]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);

    await expect(metricsDatabaseService.getRealtimeMetrics(7)).resolves.toMatchObject({
      id: 3,
      cpu_usage: 31,
      disk_usage: 72,
      metrics_data: { custom_fast: 9, custom_slow: 4 },
    });
    expect(execute.mock.calls[0][0]).toMatch(/ORDER BY recorded_at DESC, id DESC\s+LIMIT 1000/);
  });
});

describe('MetricsDatabaseService.getHistoricalMetrics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects only the latest requested rows and returns them in ascending time order', async () => {
    const execute = vi.fn(async (_sql: string, _params: unknown[]): Promise<[unknown[], unknown[]]> => [[], []]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    const start = new Date('2026-08-09T00:00:00.000Z');
    const end = new Date('2026-08-10T00:00:00.000Z');

    await metricsDatabaseService.getHistoricalMetrics(7, start, end, undefined, 288);

    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/FROM\s*\(.*ORDER BY recorded_at DESC\s*LIMIT 288.*\)\s+AS recent\s*ORDER BY recorded_at ASC/is);
    expect(sql).not.toContain('LIMIT 1000');
    expect(params).toEqual([7, start, end]);
  });

  it('bounds raw range reads to the newest samples before restoring chronological order', async () => {
    const execute = vi.fn().mockResolvedValue([[], []]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);

    await metricsDatabaseService.getHistoricalMetricsWithRange(7, '7d', '1m', ['cpu_usage']);

    expect(execute.mock.calls[0][0]).toMatch(/ORDER BY recorded_at DESC, id DESC\s+LIMIT 1000[\s\S]*ORDER BY recorded_at ASC, id ASC/);
  });
});
