import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverDiagnosticService } from '../server-diagnostic-service.js';
import { getServerDiagnosticsTool, getServerMetricsTool, analyzeServerHealthTool } from './generated/slide-self-mgmt/server_tools.js';
import type { ToolExecutionContext } from './types.js';

const context: ToolExecutionContext = {
  actor: { userId: 3, username: 'ops', roles: [], permissions: ['servers:view'],
    instanceScopes: {}, sessionVersion: 1, requestId: 'max402' },
};
afterEach(() => vi.restoreAllMocks());

describe('MAX-407 diagnostic tool time semantics', () => {
  it('labels expiry explicitly, preserving the body and gaps through the public tool', async () => {
    const gaps = [{ section: 'systemLogs', reason: 'SYSTEM_LOGS_UNAVAILABLE' }];
    const diagnostics = {
      collectedAt: '2026-11-12T00:00:00.000Z', expiresAt: '2026-11-12T00:05:00.000Z',
      sections: { systemLogs: { source: ['journald'], items: [{ message: 'warning' }] } },
      gaps,
    };
    const get = vi.spyOn(serverDiagnosticService, 'readDiagnosticsSnapshot').mockResolvedValue(diagnostics as any);
    const result = await getServerDiagnosticsTool.handler({ serverId: 3, section: 'systemLogs', maxRows: 1 }, context);
    expect(result.success).toBe(true);
    expect(result.details).toEqual({ server_id: 3, expiresAt: diagnostics.expiresAt, gaps });
    expect(result.details).not.toHaveProperty('freshness');
    expect(result.data).toMatchObject(diagnostics);
    expect(get).toHaveBeenCalledWith(3);
  });

  it('keeps metrics and health freshness as the sample timestamp', async () => {
    const freshness = '2026-11-11T23:59:00.000Z';
    vi.spyOn(serverDiagnosticService, 'getMetricData').mockResolvedValue({ latest: [], history: [], freshness, gaps: [] });
    vi.spyOn(serverDiagnosticService, 'analyzeHealth').mockResolvedValue({ overall_health: 'unknown', freshness, gaps: [] });
    for (const tool of [getServerMetricsTool, analyzeServerHealthTool]) {
      const result = await tool.handler({ serverId: 3 }, context);
      expect(result.details).toMatchObject({ freshness });
      expect(result.details).not.toHaveProperty('expiresAt');
    }
  });

  it.each([undefined, { actor: { ...context.actor!, permissions: [] } }])('denies unauthorized diagnostics without collection', async actorContext => {
    const get = vi.spyOn(serverDiagnosticService, 'readDiagnosticsSnapshot');
    expect(await getServerDiagnosticsTool.handler({ serverId: 3 }, actorContext)).toMatchObject({
      success: false, errorCode: 'RESOURCE_FORBIDDEN',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('directs explicit refresh requests to the diagnostic collection entry without reading or collecting', async () => {
    const read = vi.spyOn(serverDiagnosticService, 'readDiagnosticsSnapshot');
    const collect = vi.spyOn(serverDiagnosticService, 'collectDiagnostics');
    expect(await getServerDiagnosticsTool.handler({ serverId: 3, refresh: true }, context)).toMatchObject({
      success: false, errorCode: 'DIAGNOSTIC_REFRESH_REQUIRES_COLLECTION',
    });
    expect(read).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  it.each(['SERVER_NOT_FOUND', 'DIAGNOSTIC_SNAPSHOT_NOT_FOUND'])('preserves diagnostic failure code %s', async code => {
    vi.spyOn(serverDiagnosticService, 'readDiagnosticsSnapshot').mockRejectedValue(new Error(code));
    expect(await getServerDiagnosticsTool.handler({ serverId: 3 }, context)).toMatchObject({
      success: false, errorCode: code,
    });
  });
});
