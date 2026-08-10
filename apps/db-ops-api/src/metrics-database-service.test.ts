import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { metricsDatabaseService } from './metrics-database-service.js';

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
    expect(sql).toMatch(/FROM\s*\(.*ORDER BY recorded_at DESC\s*LIMIT \?.*\)\s+AS recent\s*ORDER BY recorded_at ASC/is);
    expect(sql).not.toContain('LIMIT 1000');
    expect(params).toEqual([7, start, end, 288]);
  });
});
