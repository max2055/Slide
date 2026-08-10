import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertDatabaseService } from './alert-database-service.js';
import { databaseLogService } from './database-log-service.js';
import { dbConnection } from './db-connection.js';
import { metricsDatabaseService } from './metrics-database-service.js';

const start = new Date('2026-08-09T00:00:00.000Z');
const end = new Date('2026-08-10T00:00:00.000Z');

describe('strict diagnostic evidence reads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects with stable unavailable codes when the application database is disconnected', async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(null);

    await expect(metricsDatabaseService.getHistoricalMetrics(
      7, start, end, undefined, 288, { strict: true },
    )).rejects.toThrow('METRIC_HISTORY_UNAVAILABLE');
    await expect(metricsDatabaseService.getSlowQueries(7, 20, { strict: true }))
      .rejects.toThrow('SLOW_QUERIES_UNAVAILABLE');
    await expect(alertDatabaseService.getAlerts({ instance_id: 7, limit: 50, offset: 0, strict: true }))
      .rejects.toThrow('ALERTS_UNAVAILABLE');
    await expect(databaseLogService.getLogs(7, { limit: 50, offset: 0, strict: true }))
      .rejects.toThrow('LOGS_UNAVAILABLE');
  });

  it('rejects with stable query codes instead of converting backend failures to empty evidence', async () => {
    const failure = new Error('sensitive backend details');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({
      execute: vi.fn(async () => { throw failure; }),
      query: vi.fn(async () => { throw failure; }),
    } as any);

    await expect(metricsDatabaseService.getHistoricalMetrics(
      7, start, end, undefined, 288, { strict: true },
    )).rejects.toThrow('METRIC_HISTORY_QUERY_FAILED');
    await expect(metricsDatabaseService.getSlowQueries(7, 20, { strict: true }))
      .rejects.toThrow('SLOW_QUERIES_QUERY_FAILED');
    await expect(alertDatabaseService.getAlerts({ instance_id: 7, limit: 50, offset: 0, strict: true }))
      .rejects.toThrow('ALERTS_QUERY_FAILED');
    await expect(databaseLogService.getLogs(7, { limit: 50, offset: 0, strict: true }))
      .rejects.toThrow('LOGS_QUERY_FAILED');
  });
});
