import { describe, expect, it } from 'vitest';
import { ResourceDiagnosticService } from './resource-diagnostic-service.js';

describe('ResourceDiagnosticService.metricsSummary', () => {
  it('aggregates visible resource observations by type and metric', async () => {
    const service = new ResourceDiagnosticService({
      list: async () => [
        { resource: { type: 'instance', id: 1 }, label: 'db-01', status: 'active', attributes: {} },
        { resource: { type: 'server', id: 2 }, label: 'srv-01', status: 'online', attributes: {} },
        { resource: { type: 'network_device', id: 3 }, label: 'sw-01', status: 'online', attributes: {} },
      ],
      detail: async () => null,
      relations: async () => [],
      alerts: async () => [],
      observations: async (ref) => {
        if (ref.type === 'instance') return [
          { resource: ref, metricId: 'qps', value: 80, observedAt: new Date('2026-08-31T00:00:00Z'), validUntil: null, source: 'test', quality: 'good' },
          { resource: ref, metricId: 'connections', value: 12, observedAt: new Date('2026-08-31T00:00:00Z'), validUntil: null, source: 'test', quality: 'good' },
        ];
        if (ref.type === 'server') return [
          { resource: ref, metricId: 'cpu_usage', value: 40, observedAt: new Date('2026-08-31T00:00:00Z'), validUntil: null, source: 'test', quality: 'good' },
          { resource: ref, metricId: 'memory_usage', value: null, observedAt: null, validUntil: null, source: 'test', quality: 'unknown' },
          { resource: ref, metricId: 'disk_usage', value: 20, observedAt: new Date('2026-08-31T00:00:00Z'), validUntil: null, source: 'test', quality: 'good' },
          { resource: ref, metricId: 'disk_usage', value: 80, observedAt: new Date('2026-08-30T00:00:00Z'), validUntil: null, source: 'test', quality: 'good' },
        ];
        return [{ resource: ref, metricId: 'device_reachability', value: 1, observedAt: new Date('2026-08-31T00:00:00Z'), validUntil: null, source: 'test', quality: 'good' }];
      },
    });

    const result = await service.metricsSummary({ userId: 1, username: 'test', permissions: ['*'] } as any);
    expect(result.scopes.instance.metrics.qps).toMatchObject({ value: 80, resourceCount: 1 });
    expect(result.scopes.instance.metrics.connections).toMatchObject({ value: 12, resourceCount: 1 });
    expect(result.scopes.server.metrics.cpu_usage).toMatchObject({ value: 40, resourceCount: 1 });
    expect(result.scopes.server.metrics.memory_usage).toMatchObject({ value: null, resourceCount: 0 });
    expect(result.scopes.server.metrics.disk_usage).toMatchObject({ value: 20, resourceCount: 1 });
    expect(result.scopes.network_device.metrics.device_reachability).toMatchObject({ value: 1, resourceCount: 1 });
    expect(result.dataQuality).toBe('partial');
  });
});
