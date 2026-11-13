import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerMetricsTool } from './server_tools.js';
import { serverDiagnosticService } from '../../../server-diagnostic-service.js';
import { serverDatabaseService } from '../../../server-database-service.js';
import { metricConsumerService } from '../../../metrics/consumers/runtime.js';
import type { ToolExecutionContext } from '../../types.js';

// MAX-404 / #698: exercise the real tool -> diagnostic -> resourceMetricRead path.
// Only inventory and the formal consumer's storage-facing ports are replaced.
const actor = { userId: 1, username: 'metrics-test', roles: [], permissions: ['servers:view'],
  instanceScopes: {}, sessionVersion: 0, requestId: 'max404' };
const context = { actor } as ToolExecutionContext;
const recordedAt = '2026-11-12T00:00:00.000Z';

function fixture(ids: string[]) {
  vi.spyOn(serverDatabaseService, 'getServerById').mockResolvedValue({ id: 3 } as any);
  const discover = vi.spyOn(metricConsumerService, 'discover').mockResolvedValue({
    definitions: ids.map(id => ({ id })),
  } as any);
  const query = vi.spyOn(metricConsumerService, 'query').mockResolvedValue({
    metrics: ids.map((id, index) => ({
      definition: { id, semantic_version: '1.0.0' },
      series: [{ dimensions: {}, buckets: [{ observed_at: recordedAt,
        value: { encoding: 'float64', value: index }, unit: 's',
        quality: { status: 'good' }, freshness: 'fresh' }] }],
    })),
  } as any);
  return { discover, query };
}

afterEach(() => vi.restoreAllMocks());

describe('MAX-404 server metric tool names', () => {
  it.each(['linux.uptime.seconds', 'host.filesystem.used_bytes', 'a0._',
    `a.${'b'.repeat(126)}`, 'cpu_usage'])('forwards accepted id %s to the formal filter', async metricName => {
    const canonicalId = metricName === 'cpu_usage' ? 'linux.cpu.user_system_percent' : metricName;
    const { discover, query } = fixture([canonicalId]);
    const result = await getServerMetricsTool.handler({ serverId: 3, metricName }, context);
    expect(result.success).toBe(true);
    expect(discover).toHaveBeenCalledWith(actor, { type: 'server', id: 3 });
    expect(query).toHaveBeenCalledWith(actor, expect.objectContaining({
      resource: { type: 'server', id: 3 }, metric_ids: [canonicalId],
    }));
    expect(result.data).toMatchObject({ history: [{ metric_name: canonicalId, metric_value: 0 }] });
  });

  it.each(['a', `a${'b'.repeat(127)}`])('accepts service syntax %s while preserving catalog rejection', async metricName => {
    const { discover, query } = fixture([]);
    expect(await getServerMetricsTool.handler({ serverId: 3, metricName }, context))
      .toMatchObject({ success: false, errorCode: 'GET_METRICS_FAILED', error: 'METRIC_REFERENCE_REVIEW_REQUIRED' });
    expect(discover).toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['', 'A', '1abc', '_abc', '.abc', 'cpu-load', 'cpu load', 'cpu/usage',
    'cpu;drop', 'cpu\nusage', '指标', `a${'b'.repeat(128)}`, null, 1, {}, []])(
    'rejects illegal input %j before service access', async metricName => {
      const service = vi.spyOn(serverDiagnosticService, 'getMetricData');
      expect(await getServerMetricsTool.handler({ serverId: 3, metricName }, context))
        .toMatchObject({ success: false, errorCode: 'METRIC_NAME_INVALID' });
      expect(service).not.toHaveBeenCalled();
    });

  it('keeps the unfiltered default bounded to 100 returned rows', async () => {
    const { discover, query } = fixture(Array.from({ length: 120 }, (_, i) => `metric_${i}`));
    const result = await getServerMetricsTool.handler({ serverId: 3 }, context);
    expect(result.success).toBe(true);
    expect((result.data as any).history).toHaveLength(100);
    expect((result.data as any).latest).toHaveLength(100);
    expect(discover).not.toHaveBeenCalled();
    expect(query.mock.calls[0][1]).not.toHaveProperty('metric_ids');
  });

  it.each([undefined, { actor: { ...actor, permissions: [] } }])(
    'denies missing permissions or actor before service access', async deniedContext => {
      const service = vi.spyOn(serverDiagnosticService, 'getMetricData');
      expect(await getServerMetricsTool.handler({ serverId: 3, metricName: 'linux.uptime.seconds' },
        deniedContext as ToolExecutionContext)).toMatchObject({ success: false, errorCode: 'RESOURCE_FORBIDDEN' });
      expect(service).not.toHaveBeenCalled();
    });

  it('continues rejecting an explicit limit above 100', async () => {
    const service = vi.spyOn(serverDiagnosticService, 'getMetricData');
    expect(await getServerMetricsTool.handler({ serverId: 3, maxRows: 101 }, context))
      .toMatchObject({ success: false, errorCode: 'INVALID_PARAMETER' });
    expect(service).not.toHaveBeenCalled();
  });
});
