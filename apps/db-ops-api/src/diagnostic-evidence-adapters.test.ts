import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertDatabaseService } from './alert-database-service.js';
import type { ActorContext } from './auth/actor-context.js';
import { databaseStorageDiscoveryService } from './database-storage-discovery-service.js';
import { databaseLogService } from './database-log-service.js';
import { dbConnection } from './db-connection.js';
import {
  instanceDiagnosticContextService,
  safeInstanceMetadataProvider,
} from './instance-diagnostic-context-service.js';
import { metricsDatabaseService } from './metrics-database-service.js';
import { instanceHostService } from './resources/instance-host-service.js';

const start = new Date('2026-08-09T00:00:00.000Z');
const end = new Date('2026-08-10T00:00:00.000Z');
const actor: ActorContext = Object.freeze({
  userId: 3,
  username: 'dba',
  roles: Object.freeze(['dba']),
  permissions: Object.freeze(['instance:view', 'servers:view', 'metric:view', 'alert:view', 'log:view']),
  sessionVersion: 1,
  instanceScopes: Object.freeze({ 7: 'read-only' }),
  requestId: 'diagnostic-evidence-adapter-test',
});

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

  it('uses strict realtime reads in the production diagnostic context adapter', async () => {
    vi.spyOn(safeInstanceMetadataProvider, 'getInstance').mockResolvedValue({ id: 7, db_type: 'mysql' });
    const realtime = vi.spyOn(metricsDatabaseService, 'getRealtimeMetrics')
      .mockImplementation(async (...args: unknown[]) => {
        const options = args[1] as { strict?: boolean } | undefined;
        if (options?.strict) throw new Error('REALTIME_METRICS_QUERY_FAILED');
        return null;
      });
    vi.spyOn(metricsDatabaseService, 'getHistoricalMetrics').mockResolvedValue([]);
    vi.spyOn(metricsDatabaseService, 'getSlowQueries').mockResolvedValue([]);
    vi.spyOn(alertDatabaseService, 'getAlerts').mockResolvedValue({ items: [] });
    vi.spyOn(databaseLogService, 'getLogs').mockResolvedValue({ logs: [], total: 0 });
    vi.spyOn(databaseStorageDiscoveryService, 'discover').mockResolvedValue({ descriptors: [], gaps: [] });
    vi.spyOn(instanceHostService, 'listHosts').mockResolvedValue([]);

    const result = await instanceDiagnosticContextService.collect(actor, 7);

    expect(realtime).toHaveBeenCalledWith(7, { strict: true });
    expect(result.database.realtimeMetrics).toBeNull();
    expect(result.gaps).toContainEqual(expect.objectContaining({
      section: 'realtime', code: 'REALTIME_METRICS_QUERY_FAILED',
    }));
  });
});
