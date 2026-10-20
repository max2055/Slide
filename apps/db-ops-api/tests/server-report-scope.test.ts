import { describe, expect, it, vi } from 'vitest';
import { serverReportService } from '../src/server-report-service.js';
import { serverDatabaseService } from '../src/server-database-service.js';
import { metricConsumerService } from '../src/metrics/consumers/runtime.js';
import { dbConnection } from '../src/db-connection.js';

describe('server report target scope', () => {
  it('only queries and renders the requested server ids', async () => {
    vi.spyOn(serverDatabaseService, 'getAllServers').mockResolvedValue([
      { id: 1, host: 'one', label: null, status: 'online' }, { id: 2, host: 'two', label: null, status: 'online' },
    ] as any);
    const execute = vi.fn().mockResolvedValue([[]]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    const query=vi.spyOn(metricConsumerService,'query').mockResolvedValue({metrics:[]} as any);
    const report = await serverReportService.generateReport([2]);
    expect(report.server_count).toBe(1);
    expect(query).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({resource:{type:'server',id:2}}));
    expect(query).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
