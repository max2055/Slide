import { describe, expect, it, vi } from 'vitest';
import { ResourceDiagnosticService } from './resource-diagnostic-service.js';
import type { Observation, ResourceDetail, ResourceRef } from './types.js';

const actor = { userId: 1, username: 'test', permissions: ['*'] } as any;

function detail(type: ResourceRef['type'], id: number): ResourceDetail {
  return { resource: { type, id }, label: `${type}-${id}`, status: 'online', attributes: {} };
}

function observation(
  ref: ResourceRef,
  metricId: string,
  value: number | null,
  observedAt: Date | null,
  validUntil: Date | null,
  quality: Observation['quality'] = 'good',
): Observation {
  return { resource: ref, metricId, value, observedAt, validUntil, source: 'test', quality };
}

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

    const result = await service.metricsSummary(actor);
    expect(result.scopes.instance.metrics.qps).toMatchObject({ value: 80, resourceCount: 1 });
    expect(result.scopes.instance.metrics.connections).toMatchObject({ value: 12, resourceCount: 1 });
    expect(result.scopes.server.metrics.cpu_usage).toMatchObject({ value: 40, resourceCount: 1 });
    expect(result.scopes.server.metrics.memory_usage).toMatchObject({ value: null, resourceCount: 0 });
    expect(result.scopes.server.metrics.disk_usage).toMatchObject({ value: 20, resourceCount: 1 });
    expect(result.scopes.network_device.metrics.device_reachability).toMatchObject({ value: 1, resourceCount: 1 });
    expect(result.dataQuality).toBe('partial');
  });

  it('excludes unknown, invalid, null, non-finite, future, and expired observations', async () => {
    const now = new Date('2026-08-31T01:00:00.000Z');
    const ref = { type: 'server' as const, id: 10 };
    const deps = {
      list: async () => [detail(ref.type, ref.id)],
      detail: async () => null,
      relations: async () => [],
      alerts: async () => [],
      observations: vi.fn(async () => [
        // The newest *valid* sample must win after unusable samples are removed.
        observation(ref, 'cpu_usage', 25, new Date('2026-08-31T00:40:00.000Z'), new Date('2026-08-31T01:10:00.000Z')),
        observation(ref, 'cpu_usage', 99, new Date('2026-08-31T00:50:00.000Z'), new Date('2026-08-31T00:59:00.000Z')),
        observation(ref, 'cpu_usage', 98, new Date('2026-08-31T00:55:00.000Z'), new Date('2026-08-31T01:10:00.000Z'), 'unknown'),
        observation(ref, 'cpu_usage', 97, new Date('2026-08-31T00:56:00.000Z'), new Date('2026-08-31T01:10:00.000Z'), 'invalid'),
        observation(ref, 'cpu_usage', null, new Date('2026-08-31T00:57:00.000Z'), new Date('2026-08-31T01:10:00.000Z')),
        observation(ref, 'memory_usage', Number.NaN, new Date('2026-08-31T00:40:00.000Z'), new Date('2026-08-31T01:10:00.000Z')),
        observation(ref, 'disk_usage', Number.POSITIVE_INFINITY, new Date('2026-08-31T00:40:00.000Z'), new Date('2026-08-31T01:10:00.000Z')),
        observation(ref, 'load_1min', 1, new Date('2026-08-31T01:01:00.000Z'), new Date('2026-08-31T01:10:00.000Z')),
        observation(ref, 'load_1min', 2, new Date('invalid'), new Date('2026-08-31T01:10:00.000Z')),
        observation(ref, 'load_1min', 3, new Date('2026-08-31T00:40:00.000Z'), new Date('invalid')),
      ]),
    };
    const service = new ResourceDiagnosticService(deps);

    const result = await service.metricsSummary(actor, now);

    expect(result.scopes.server.metrics.cpu_usage).toMatchObject({ value: 25, resourceCount: 1, observedAt: '2026-08-31T00:40:00.000Z' });
    expect(result.scopes.server.metrics.memory_usage).toMatchObject({ value: null, resourceCount: 0, observedAt: null });
    expect(result.scopes.server.metrics.disk_usage).toMatchObject({ value: null, resourceCount: 0, observedAt: null });
    expect(result.scopes.server.metrics.load_1min).toMatchObject({ value: null, resourceCount: 0, observedAt: null });
    expect(result.dataQuality).toBe('partial');
  });

  it('returns partial when resources exist but no metric has a usable value', async () => {
    const now = new Date('2026-08-31T01:00:00.000Z');
    const ref = { type: 'network_device' as const, id: 11 };
    const service = new ResourceDiagnosticService({
      list: async () => [detail(ref.type, ref.id)],
      detail: async () => null,
      relations: async () => [],
      alerts: async () => [],
      observations: async () => [observation(ref, 'device_reachability', null, null, null, 'unknown')],
    });

    const result = await service.metricsSummary(actor, now);

    expect(result.dataQuality).toBe('partial');
    expect(result.scopes.network_device.metrics.device_reachability).toMatchObject({ value: null, resourceCount: 0 });
  });

  it('limits observation fan-out to the existing dashboard concurrency bound', async () => {
    const resources = Array.from({ length: 20 }, (_, index) => detail('server', index + 1));
    const now = new Date('2026-08-31T01:00:00.000Z');
    let active = 0;
    let maxActive = 0;
    const observations = vi.fn(async (ref: ResourceRef) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return [observation(ref, 'cpu_usage', 10, new Date('2026-08-31T00:59:00.000Z'), new Date('2026-08-31T01:10:00.000Z'))];
    });
    const service = new ResourceDiagnosticService({
      list: async () => resources,
      detail: async () => null,
      relations: async () => [],
      alerts: async () => [],
      observations,
    });

    await service.metricsSummary(actor, now);

    expect(observations).toHaveBeenCalledTimes(resources.length);
    expect(maxActive).toBeLessThanOrEqual(8);
  });

  it('uses the latest reachability state instead of averaging device states', async () => {
    const first = { type: 'network_device' as const, id: 21 };
    const second = { type: 'network_device' as const, id: 22 };
    const now = new Date('2026-08-31T01:00:00.000Z');
    const service = new ResourceDiagnosticService({
      list: async () => [detail(first.type, first.id), detail(second.type, second.id)],
      detail: async () => null,
      relations: async () => [],
      alerts: async () => [],
      observations: async (ref) => [
        observation(
          ref,
          'device_reachability',
          ref.id === first.id ? 1 : 0,
          ref.id === first.id ? new Date('2026-08-31T00:55:00.000Z') : new Date('2026-08-31T00:59:00.000Z'),
          new Date('2026-08-31T01:10:00.000Z'),
        ),
      ],
    });

    const result = await service.metricsSummary(actor, now);

    expect(result.scopes.network_device.metrics.device_reachability).toMatchObject({
      value: 0,
      resourceCount: 2,
      observedAt: '2026-08-31T00:59:00.000Z',
    });
  });
});
