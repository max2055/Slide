import { describe, expect, it, vi } from 'vitest';
import { serverReportService } from '../src/server-report-service.js';
import { serverDatabaseService, type ServerRow } from '../src/server-database-service.js';
import { internalMetricConsumerService } from '../src/metrics/consumers/runtime.js';
import { dbConnection } from '../src/db-connection.js';
import { reportDatabaseService, type Report } from '../src/report-database-service.js';

describe('server report target scope', () => {
  it('only queries and renders the requested server ids', async () => {
    const all = vi.spyOn(serverDatabaseService, 'getAllServers');
    const byId = vi.spyOn(serverDatabaseService, 'getServerById').mockResolvedValue(
      { id: 2, host: 'two', label: null, status: 'online' } as any);
    const execute = vi.fn().mockResolvedValue([[]]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    const query=vi.spyOn(internalMetricConsumerService,'query').mockResolvedValue({metrics:[]} as any);
    const report = await serverReportService.generateReport([2]);
    expect(report.server_count).toBe(1);
    expect(all).not.toHaveBeenCalled();
    expect(byId).toHaveBeenCalledExactlyOnceWith(2);
    expect(query).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({resource:{type:'server',id:2}}));
    expect(query).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('MAX-687 records the server IDs used to generate a summary', async () => {
    const all = vi.spyOn(serverDatabaseService, 'getAllServers').mockResolvedValue([
      { id: 2, host: 'two', label: null, status: 'online' },
      { id: 7, host: 'seven', label: null, status: 'offline' },
    ] as ServerRow[]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({} as ReturnType<typeof dbConnection.getPool>);
    const samples = { metrics: [] } as Awaited<ReturnType<typeof internalMetricConsumerService.query>>;
    vi.spyOn(internalMetricConsumerService, 'query').mockResolvedValue(samples);
    const create = vi.spyOn(reportDatabaseService, 'createReport').mockResolvedValue({ id: 4 } as Report);

    try {
      await expect(serverReportService.generateAndPersist()).resolves.toEqual({ success: true, reportId: 4 });
      expect(all).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        server_target_ids: [2, 7],
        data: expect.objectContaining({
          server_count: 2,
          servers: [expect.objectContaining({ host: 'two' }), expect.objectContaining({ host: 'seven' })],
        }),
      }));
    } finally {
      vi.restoreAllMocks();
    }
  });
});
