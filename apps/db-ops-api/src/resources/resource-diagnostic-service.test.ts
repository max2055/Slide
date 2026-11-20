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

  it('builds a cross-resource overview with freshness, alert and impact scope', async () => {
    const serverRef = { type: 'server' as const, id: 3 };
    const deviceRef = { type: 'network_device' as const, id: 9 };
    const deps = dependencies({
      list: vi.fn(async () => [detail(serverRef), detail(deviceRef)]),
      observations: vi.fn(async (ref) => ref.type === 'server'
        ? [observation(ref, 'cpu_percent', 12)]
        : []),
      alerts: vi.fn(async (ref) => ref.type === 'server'
        ? [{ id: 1, status: 'firing' }]
        : []),
      relations: vi.fn(async (ref) => ref.type === 'server'
        ? [{ source: serverRef, target: deviceRef, relationType: 'connected_to' as const, provenance: 'fixture', validFrom: new Date('2026-08-25T00:00:00.000Z'), validUntil: null }]
        : []),
    });
    const service = new ResourceDiagnosticService(deps);
    const result = await service.overview(actor, new Date('2026-08-26T00:01:00.000Z'));
    expect(result.schemaVersion).toBe(1);
    expect(result.summary).toMatchObject({ total: 2, fresh: 1, missing: 1, unresolvedAlerts: 1, impactedResources: 1 });
    expect(result.items[0]).toMatchObject({ freshness: 'fresh', unresolvedAlerts: 1, relationCount: 1, impactScope: [deviceRef] });
    expect(result.items[1]).toMatchObject({ freshness: 'missing', gaps: ['OBSERVATIONS_EMPTY'] });
    expect(result.dataQuality).toBe('partial');
  });

  it('does not treat expired or future observations as fresh', async () => {
    const expiredRef = { type: 'server' as const, id: 31 };
    const futureRef = { type: 'server' as const, id: 32 };
    const now = new Date('2026-08-26T00:01:00.000Z');
    const deps = dependencies({
      list: vi.fn(async () => [detail(expiredRef), detail(futureRef)]),
      observations: vi.fn(async (ref): Promise<Observation[]> => ref.id === expiredRef.id
        ? [{ resource: ref, metricId: 'cpu_usage', value: 10, observedAt: new Date('2026-08-26T00:00:30.000Z'), validUntil: new Date('2026-08-26T00:00:45.000Z'), source: 'fixture', quality: 'good' }]
        : [{ resource: ref, metricId: 'cpu_usage', value: 20, observedAt: new Date('2026-08-26T00:02:00.000Z'), validUntil: new Date('2026-08-26T00:10:00.000Z'), source: 'fixture', quality: 'good' }]),
    });
    const service = new ResourceDiagnosticService(deps);

    const result = await service.overview(actor, now);

    expect(result.items[0]).toMatchObject({ freshness: 'stale', observedAt: '2026-08-26T00:00:30.000Z' });
    expect(result.items[0].gaps).toContain('OBSERVATIONS_EXPIRED');
    expect(result.items[1]).toMatchObject({ freshness: 'missing', observedAt: null });
    expect(result.items[1].gaps).toContain('OBSERVATIONS_FUTURE');
  });

  it.each([
    { label: 'fresh formal metrics alongside a missing legacy alias', status: 'healthy', quality: 'good', stored: 'unknown' },
    { label: 'stored healthy without the uptime sample', status: 'unknown', quality: 'partial', uptime: 'missing' },
    { label: 'read failure on the compatibility projection', status: 'healthy', quality: 'good', compatibilityUnavailable: true },
    { label: 'read failure on the formal projection', status: 'unknown', quality: 'unknown', formalUnavailable: true, freshness: 'missing' },
    { label: 'old uptime alongside a fresh connection count', status: 'unknown', quality: 'good', uptime: 'expired', freshness: 'stale' },
    { label: 'uptime expired according to the formal collector policy', status: 'unknown', quality: 'partial', uptime: 'formal-stale', freshness: 'stale' },
    { label: 'future uptime', status: 'unknown', quality: 'good', uptime: 'future' },
    { label: 'degraded connection count', status: 'unknown', quality: 'degraded', connectionQuality: 'degraded' as const },
    { label: 'no formal observations', status: 'unknown', quality: 'unknown', noFormal: true, freshness: 'missing' },
    { label: 'active warning', status: 'warning', quality: 'good', severity: 'warning' },
    { label: 'active critical alert with missing uptime', status: 'critical', quality: 'partial', severity: 'critical', uptime: 'missing' },
    { label: 'unavailable alerts', status: 'unknown', quality: 'good', alertsUnavailable: true },
    { label: 'truncated resolved alerts', status: 'unknown', quality: 'good', alertsTruncated: true },
    { label: 'paused resource with recent samples', status: 'unknown', quality: 'good', connection: 'inactive' },
    { label: 'explicit connection outage without current metrics', status: 'unavailable', quality: 'unknown', connection: 'error', noFormal: true, freshness: 'missing' },
  ])('derives MySQL overview health from formal evidence: $label', async ({
    status, quality, stored = 'healthy', uptime, connectionQuality, noFormal, freshness = 'fresh',
    severity, alertsUnavailable, alertsTruncated, connection = 'active', compatibilityUnavailable, formalUnavailable,
  }) => {
    const ref = { type: 'instance' as const, id: 11 };
    const now = new Date('2026-08-26T00:02:00.000Z');
    const mysql = { ...detail(ref), status: connection, attributes: { dbType: 'mysql', healthStatus: stored } };
    const legacyAlias = observation(ref, 'qps', null, 'unknown');
    const ready = observation(ref, 'db.uptime_seconds', 7200);
    if (uptime === 'expired') ready.validUntil = new Date(now.getTime() - 1);
    if (uptime === 'future') ready.observedAt = new Date(now.getTime() + 1);
    if (uptime === 'formal-stale') Object.assign(ready, { reason: 'stale_observation', quality: 'unknown', value: null });
    const count = { ...observation(ref, 'mysql.processlist.count', 3, connectionQuality),
      observedAt: new Date('2026-08-26T00:01:30.000Z') };
    const deps = dependencies({
      list: async () => [mysql],
      observations: vi.fn(async (_ref, _actor, options) => {
        if (!options?.metricIds) {
          if (compatibilityUnavailable) throw new Error('fixture compatibility projection unavailable');
          return [legacyAlias];
        }
        if (formalUnavailable) throw new Error('fixture formal projection unavailable');
        return noFormal ? [] : [count, ...(uptime === 'missing' ? [] : [ready])];
      }),
      alerts: async () => {
        if (alertsUnavailable) throw new Error('fixture alerts unavailable');
        if (alertsTruncated) return Array.from({ length: 100 }, (_, id) => ({ id, status: 'resolved' }));
        return severity ? [{ id: 1, status: 'active', level: severity }] : [];
      },
    });
    const overview = await new ResourceDiagnosticService(deps).overview(actor, now);
    expect(overview.items).toHaveLength(1);
    const [item] = overview.items;
    expect(item).toMatchObject({ status, quality, freshness });
    if (!compatibilityUnavailable) expect(item.observations).toContain(legacyAlias);
    expect(deps.observations).toHaveBeenCalledWith(ref, actor, expect.objectContaining({
      metricIds: ['db.uptime_seconds', 'mysql.processlist.count'],
    }));
    if (status === 'healthy') {
      expect(item.observedAt).toBe(ready.observedAt?.toISOString());
      expect(item.gaps).toEqual(compatibilityUnavailable ? ['COMPATIBILITY_OBSERVATIONS_UNAVAILABLE'] : []);
    }
  });

  it('orders bounded related evidence so an interface drop is visible beside database and host evidence', async () => {
    const subject = { type: 'instance' as const, id: 11 };
    const serverRef = { type: 'server' as const, id: 3 };
    const deviceRef = { type: 'network_device' as const, id: 9 };
    const relation = (target: ResourceRef, relationType: ResourceRelation['relationType']): ResourceRelation => ({
      source: subject,
      target,
      relationType,
      provenance: 'fixture',
      validFrom: new Date('2026-08-25T00:00:00.000Z'),
      validUntil: null,
    });
    const deps = dependencies({
      detail: vi.fn(async (ref) => ({
        ...detail(ref),
        status: ref.type === 'server' ? 'online' : ref.type === 'network_device' ? 'degraded' : 'warning',
      })),
      observations: vi.fn(async (ref) => {
        if (ref.type === 'instance') return [observation(ref, 'slow_queries', 42)];
        if (ref.type === 'server') return [observation(ref, 'cpu_percent', 12)];
        return [{
          ...observation(ref, 'interface_drop_rate', 4),
          dimensions: { direction: 'in', if_index: '7' },
        }];
      }),
      relations: vi.fn(async (ref) => ref.type === 'instance'
        ? [relation(serverRef, 'runs_on'), relation(deviceRef, 'connected_to')]
        : []),
      alerts: vi.fn(async (ref) => ref.type === 'instance' ? [{ id: 1, status: 'firing', level: 'critical' }] : []),
    });
    const service = new ResourceDiagnosticService(deps);
    const result = await service.diagnose(actor, subject);

    expect(result.relatedEvidence.map((entry) => entry.resource.resource)).toEqual([deviceRef, serverRef]);
    expect(result.relatedEvidence[0]).toMatchObject({
      observations: [expect.objectContaining({ metricId: 'interface_drop_rate', dimensions: { direction: 'in', if_index: '7' } })],
      priority: expect.any(Number),
    });
    expect(result.relatedEvidence[0].priority).toBeGreaterThan(result.relatedEvidence[1].priority);
    expect(result.relatedEvidence[1].gaps).toEqual([]);
  });
});

describe('overview completeness and alarm identity', () => {
  it('deduplicates acknowledged unresolved IDs across resources and flags bounded reads', async () => {
    const deps = dependencies({ alerts: vi.fn(async () => [{ id: 1, status: 'acknowledged', level: 'critical' }, { id: 1, status: 'acknowledged' }, { id: 2, status: 'resolved' }]) });
    const result = await new ResourceDiagnosticService(deps).overview(actor, new Date('2026-08-26T00:01:00Z'));
    expect(result.summary.unresolvedAlerts).toBe(1);
    expect(result.items.every(item => item.unresolvedAlerts === 1 && item.alertIds?.[0] === '1')).toBe(true);
    expect(result.items[0].alertSeverity).toBe('critical');
    deps.alerts = vi.fn(async () => Array.from({ length: 100 }, (_, id) => ({ id, status: 'resolved' })));
    const capped = await new ResourceDiagnosticService(deps).overview(actor);
    expect(capped.items[0].alertsTruncated).toBe(true);
    expect(capped.items[0].gaps).toContain('ALERTS_TRUNCATED');
  });
  it('exposes inventory truncation, preserves null and zero, and retains collection errors', async () => {
    const deps = dependencies({
      list: vi.fn(async () => Array.from({ length: 501 }, (_, id) => detail({ type: 'server', id: id + 1 }))),
      observations: vi.fn(async ref => { if (ref.id === 1) throw new Error('failed'); return [observation(ref, 'cpu_usage', 0), observation(ref, 'memory_usage', null)]; }),
    });
    const result = await new ResourceDiagnosticService(deps).overview(actor);
    expect(result.truncated).toBe(true); expect(result.items).toHaveLength(500);
    expect(result.items[0].gaps).toContain('OBSERVATIONS_UNAVAILABLE');
    expect(result.items[1].observations?.map(metric => metric.value)).toEqual([0, null]);
  });
  it('does not include an unauthorized related resource in the impact summary', async () => {
    const deps = dependencies({ relations: vi.fn(async ref => [{ source: ref, target: { type: 'instance' as const, id: 999 }, relationType: 'depends_on' as const, provenance: 'fixture', validFrom: new Date(0), validUntil: null }]) });
    const result = await new ResourceDiagnosticService(deps).overview(actor);
    expect(result.items.every(item => item.impactScope.length === 0)).toBe(true);
  });
});

describe('partial inventory', () => {
  it('distinguishes failed inventory from successfully empty inventory', async () => {
    const deps = dependencies({ list: vi.fn(async () => Object.assign([], { unavailableTypes: ['server'] })) });
    const service = new ResourceDiagnosticService(deps);
    expect(await service.overview(actor)).toMatchObject({ dataQuality: 'partial', unavailableTypes: ['server'], items: [] });
    expect(await service.listResources(actor)).toMatchObject({ dataQuality: 'partial', unavailableTypes: ['server'], items: [] });
  });
});

it('rejects the full diagnostic pack after a swallowed inner metric revocation', async () => {
  let live = actor;
  const service = new ResourceDiagnosticService(dependencies({ semantic: async () => {
    live = { ...actor, permissions: [], instanceScopes: {} }; throw new Error('revoked');
  } }), { reloadActor: async () => live });
  await expect(service.diagnose(actor, { type: 'server', id: 3 })).rejects.toThrow('POLICY_FORBIDDEN');
});
it('rejects the summary after a best-effort metric read loses resource access', async () => {
  let live = actor;
  const service = new ResourceDiagnosticService(dependencies({ observations: async () => {
    live = { ...actor, permissions: [], instanceScopes: {} }; throw new Error('revoked');
  } }), { reloadActor: async () => live });
  await expect(service.metricsSummary(actor)).rejects.toThrow('POLICY_FORBIDDEN');
});

// GitHub #366: callers bypassing HTTP must also reject invalid numeric limits.
describe('observation service limit validation', () => {
  it.each([NaN, Infinity, -Infinity, 3.5, Number.MAX_SAFE_INTEGER + 1])('rejects %s without observation reads', async limit => {
    const deps = dependencies();
    await expect(new ResourceDiagnosticService(deps).getObservations(actor, { type: 'server', id: 3 }, { limit }))
      .rejects.toThrow('OBSERVATION_LIMIT_INVALID');
    expect(deps.observations).not.toHaveBeenCalled();
  });
});
