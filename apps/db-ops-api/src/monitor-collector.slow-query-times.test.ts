import { afterEach, describe, expect, it, vi } from 'vitest';
import { monitorCollector } from './monitor-collector.js';
import { dbConnection } from './db-connection.js';
import { databaseService } from './database-service.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { metricsDatabaseService } from './metrics-database-service.js';
import { reportService } from './report-service.js';

vi.mock('./resources/instance-access-lifecycle.js', () => ({ instanceAccessLifecycle: { assertAvailable: vi.fn() }, cleanupDeadline: vi.fn() }));
vi.mock('./metrics/config/effective-state.js', () => ({ assetCollectionEnabled: async () => true }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('MAX-398 slow-query collection, storage and report reading', () => {
  it.each([20, 0, null, undefined])('persists true minimum %s independently of avg100/max150', async min => {
    vi.stubEnv('METRICS_COLLECTION_ENABLED', 'true');
    vi.spyOn(instanceDatabaseService, 'getAllInstances').mockResolvedValue([{ id: 996, name: 'fixture' }] as any);
    vi.spyOn(databaseService, 'getSlowQueries').mockResolvedValue([{
      id: 'fixture', sql_text: 'select fixture', avg_time_ms: 100, max_time_ms: 150,
      min_time_ms: min, total_time_ms: 401, execution_count: 4, first_seen: '', last_seen: '',
    }]);
    const execute = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.startsWith('INSERT')) return [{ insertId: 1 }];
      return [[], []];
    });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    await monitorCollector.collectSlowQueriesNow();
    const write = execute.mock.calls.find(([sql]) => sql.startsWith('INSERT'))!;
    expect(write[1]?.slice(3, 8)).toEqual([100, 150, min ?? null, 4, 401]);
  });

  it('updates unknown extrema to NULL, replacing earlier fabricated extrema', async () => {
    const execute = vi.fn().mockResolvedValueOnce([[{ id: 1 }]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    await expect(metricsDatabaseService.recordSlowQuery({ instance_id: 996, sql_text: 'select fixture', sql_hash: 'fixture', avg_time_ms: 2000, min_time_ms: null, max_time_ms: null, execution_count: 5, total_time_ms: 10000 })).resolves.toMatchObject({ success: true });
    expect(execute.mock.calls[1][1].slice(0, 5)).toEqual([2000, null, null, 5, 10000]);
  });

  it('reads decimal durations as numbers for reports and thresholds while preserving unknown', async () => {
    const query = vi.fn().mockResolvedValue([[{ avg_time_ms: '2000.00', max_time_ms: null, min_time_ms: null, total_time_ms: '10000.00', execution_count: 5, sql_text: 'select fixture' }]]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ query } as any);
    const rows = await metricsDatabaseService.getSlowQueries(996);
    expect(rows[0]).toMatchObject({ avg_time_ms: 2000, max_time_ms: null, min_time_ms: null, total_time_ms: 10000 });
    expect((reportService as any).generateSlowQueryRecommendations(rows)[0]).toContain('2000ms');
    expect(rows.filter(q => q.avg_time_ms > 1000)).toHaveLength(1);
  });
});
