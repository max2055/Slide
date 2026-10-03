import { afterEach, expect, it, vi } from 'vitest';
import { baselineCalculator } from '../baseline-calculator.js';
import { monitorCollector } from '../monitor-collector.js';
import { dbConnection } from '../db-connection.js';
import { instanceDatabaseService } from '../instance-database-service.js';
import { databaseService } from '../database-service.js';
import { metricsDatabaseService } from '../metrics-database-service.js';

afterEach(() => vi.restoreAllMocks());
it('returns actual cleanup outcome and does not swallow storage failure as success', async () => {
  const execute = vi.fn(async () => [{ affectedRows: 3 }]);
  vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
  expect(await baselineCalculator.cleanupOldBaselines()).toEqual({ success: true, deleted: 3 });
  execute.mockRejectedValueOnce(new Error('SQL_ERROR'));
  expect(await baselineCalculator.cleanupOldBaselines()).toEqual({ success: false, error: 'SQL_ERROR' });
});
it('counts unavailable capacity and failed persistence along with actual successes', async () => {
  vi.spyOn(instanceDatabaseService, 'getAllInstances').mockResolvedValue([1, 2, 3, 4].map(id => ({ id, status: 'active', name: String(id) })) as any);
  vi.spyOn(databaseService, 'getCapacityInfo').mockImplementation(async id => {
    if (id === 4) throw new Error('TARGET_UNAVAILABLE');
    return id === 2 ? null : { total_size_gb: 1, databases: [] } as any;
  });
  vi.spyOn(metricsDatabaseService, 'recordCapacity').mockImplementation(async data => ({ success: data.instance_id !== 3 }));
  expect(await monitorCollector.collectCapacityNow()).toEqual({ succeeded: 1, failed: 3 });
});
