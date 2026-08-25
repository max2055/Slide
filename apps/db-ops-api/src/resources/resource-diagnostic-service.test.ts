import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../auth/actor-context.js';
import type { ResourceDetail, ResourceRef, ResourceRelation, Observation } from './types.js';
import { ResourceDiagnosticService, type ResourceDiagnosticDependencies } from './resource-diagnostic-service.js';

const actor: ActorContext = Object.freeze({
  userId: 7,
  username: 'operator',
  roles: Object.freeze(['network-operator']),
  permissions: Object.freeze(['servers:view', 'network_devices:view', 'alert:view']),
  sessionVersion: 1,
  instanceScopes: Object.freeze({ 11: 'read-only' as const }),
  requestId: 'resource-diagnostic-test',
});

function detail(ref: ResourceRef): ResourceDetail {
  return { resource: ref, label: `${ref.type}-${ref.id}`, status: 'online', attributes: {} };
}

function observation(ref: ResourceRef, metricId: string, value: number | null, quality: Observation['quality'] = 'good'): Observation {
  const observedAt = new Date('2026-08-26T00:00:00.000Z');
  return { resource: ref, metricId, value, observedAt, validUntil: new Date('2026-08-26T00:05:00.000Z'), source: 'fixture', quality };
}

function dependencies(overrides: Partial<ResourceDiagnosticDependencies> = {}): ResourceDiagnosticDependencies {
  return {
    list: vi.fn(async () => [detail({ type: 'server', id: 3 }), detail({ type: 'network_device', id: 9 })]),
    detail: vi.fn(async (ref) => detail(ref)),
    observations: vi.fn(async (ref) => [observation(ref, 'device_cpu_percent', 82)]),
    relations: vi.fn(async () => []),
    alerts: vi.fn(async () => []),
    ...overrides,
  };
}

describe('ResourceDiagnosticService', () => {
  it('returns only resources visible to the actor and preserves evidence quality', async () => {
    const deps = dependencies();
    const service = new ResourceDiagnosticService(deps);
    const result = await service.listResources(actor);
    expect(result.items).toHaveLength(2);
    expect(result.items[1]).toMatchObject({ resource: { type: 'network_device', id: 9 }, status: 'online' });
    expect(deps.list).toHaveBeenCalledWith(actor);
  });

  it('builds a bounded diagnostic pack with relation and missing-evidence gaps', async () => {
    const ref = { type: 'network_device' as const, id: 9 };
    const deps = dependencies({
      observations: vi.fn(async () => [observation(ref, 'device_temperature_celsius', null, 'unknown')]),
      relations: vi.fn(async () => [{
        source: ref, target: { type: 'server', id: 3 }, relationType: 'connected_to', provenance: 'fixture',
        validFrom: new Date('2026-08-25T00:00:00.000Z'), validUntil: null,
      }] as ResourceRelation[]),
    });
    const service = new ResourceDiagnosticService(deps, { maxBytes: 4096 });
    const result = await service.diagnose(actor, ref);
    expect(result.schemaVersion).toBe(1);
    expect(result.subject).toEqual(ref);
    expect(result.relations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ metricId: 'device_temperature_celsius', quality: 'unknown' });
    expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'OBSERVATION_UNKNOWN' })]));
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(4096);
  });

  it('rejects invalid resource references before invoking dependencies', async () => {
    const deps = dependencies();
    const service = new ResourceDiagnosticService(deps);
    await expect(service.diagnose(actor, { type: 'network_device', id: 0 })).rejects.toThrow('RESOURCE_REF_INVALID');
    expect(deps.detail).not.toHaveBeenCalled();
  });
});
