import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.hoisted(() => vi.fn());

vi.mock('./db-connection', () => ({
  dbConnection: {
    getPool: () => ({ execute }),
    isConnected: () => true,
  },
}));

import { metricDatabaseService } from './metric-database-service.js';

describe('MetricDatabaseService target identity', () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue([{ affectedRows: 1 }]);
  });

  it('updates only the selected target type when metric ids overlap', async () => {
    await expect(metricDatabaseService.updateMetric(
      'cpu_usage',
      { default_interval: 45 },
      'server',
    )).resolves.toEqual({ success: true });

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE metric_definitions SET default_interval = ?'),
      [45, JSON.stringify({ default_interval: true }), 'server', 'cpu_usage'],
    );
  });

  it('does not insert or rewrite metadata when an unchanged target row already exists', async () => {
    execute
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[{ exists: 1 }]]);

    await expect(metricDatabaseService.updateMetric(
      'cpu_usage',
      { default_interval: 300 },
      'server',
    )).resolves.toEqual({ success: true });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]).toEqual([
      'SELECT 1 FROM metric_definitions WHERE target_type = ? AND id = ? LIMIT 1',
      ['server', 'cpu_usage'],
    ]);
  });
});

// #333: unknown client ids must never become undeletable builtin definitions.
describe('missing metric updates', () => {
  beforeEach(() => { execute.mockReset(); });
  it('rejects concurrent missing ids without any insert', async () => {
    execute.mockImplementation(async (sql: string) => sql.startsWith('UPDATE') ? [{ affectedRows: 0 }] : [[]]);
    const results = await Promise.all(Array.from({ length: 8 }, () => metricDatabaseService.updateMetric('unknown', { name: 'test' })));
    expect(results.every(result => !result.success && result.reason === 'not_found')).toBe(true);
    expect(execute.mock.calls.every(([sql]) => !sql.includes('INSERT'))).toBe(true);
  });
  it('rejects an empty patch for a missing id', async () => {
    execute.mockResolvedValue([[]]);
    await expect(metricDatabaseService.updateMetric('unknown', {})).resolves.toMatchObject({ success: false, reason: 'not_found' });
  });
  it('records explicit nulls in the same update as their values', async () => {
    execute.mockResolvedValue([{ affectedRows: 1 }]);
    await metricDatabaseService.updateMetric('cpu_usage', { threshold_template: null, higher_is_worse: false, collection_sqls: null });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1]).toContain(null);
    expect(JSON.parse(execute.mock.calls[0][1].at(-3))).toMatchObject({ threshold_template: true, higher_is_worse: true, collection_sqls: true });
  });
});
