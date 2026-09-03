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
      'UPDATE metric_definitions SET default_interval = ? WHERE target_type = ? AND id = ?',
      [45, 'server', 'cpu_usage'],
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
