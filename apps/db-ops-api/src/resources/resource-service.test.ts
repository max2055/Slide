import { describe, expect, it } from 'vitest';
import { latestObservation, ObservationService } from './observation-service.js';
import { ResourceService } from './resource-service.js';
import { CapabilityService } from './capability-service.js';
import type { ActorContext } from '../auth/actor-context.js';

describe('Observation freshness', () => {
  const resource = { type: 'instance' as const, id: 1 };
  it('marks stale and missing values unknown instead of healthy', () => {
    expect(latestObservation({ resource, metricId: 'cpu_usage', value: 10, observedAt: new Date(0), validForMs: 1, now: new Date(2), source: 'collector' })).toMatchObject({ quality: 'unknown', reason: 'stale_observation' });
    expect(latestObservation({ resource, metricId: 'cpu_usage', validForMs: 1, source: 'collector' })).toMatchObject({ quality: 'unknown', reason: 'missing_observation' });
  });

  it('normalizes instance and server rows with the same freshness semantics', async () => {
    const service = new ObservationService({
      latestInstanceMetric: async () => ({ value: 42, observedAt: new Date(100) }),
      latestServerMetric: async () => ({ value: 42, observedAt: new Date(100) }),
      rangeInstanceMetric: async () => [],
      rangeServerMetric: async () => [],
    });
    const privileged = actor({}, ['*']);
    await expect(service.latest(privileged, { type: 'instance', id: 1 }, 'cpu_usage', { now: new Date(101), validForMs: 10 }))
      .resolves.toMatchObject({ quality: 'good', value: 42 });
    await expect(service.latest(privileged, { type: 'server', id: 1 }, 'cpu_usage', { now: new Date(111), validForMs: 10 }))
      .resolves.toMatchObject({ quality: 'unknown', reason: 'stale_observation' });
  });

  it('keeps disk mount identity in canonical dimensions and bounds range results', async () => {
    const service = new ObservationService({
      latestInstanceMetric: async () => null,
      latestServerMetric: async () => null,
      rangeInstanceMetric: async () => [],
      rangeServerMetric: async () => [
        { metricId: 'disk_usage_/var/lib/mysql', value: 91, observedAt: new Date(100) },
        { metricId: 'cpu_usage', value: 20, observedAt: new Date(110) },
      ],
    });
    await expect(service.range(actor({}, ['servers:view']), { type: 'server', id: 1 }, 'disk_usage', {
      from: new Date(0), to: new Date(200), validForMs: 1_000, limit: 1,
    })).resolves.toEqual([expect.objectContaining({
      metricId: 'disk_usage', dimensions: { mount: '/var/lib/mysql' }, value: 91,
    })]);
  });
});

const actor = (scopes: Record<number, 'read-only' | 'read-write' | 'admin'>, permissions = ['instance:manage']): ActorContext => ({
  userId: 1, username: 'test', roles: [], permissions, sessionVersion: 1, instanceScopes: scopes, requestId: 'test',
});

describe('Resource relations', () => {
  it('creates explicit current relations only when both resources are in actor scope', async () => {
    const saved: unknown[] = [];
    const service = new ResourceService({
      exists: async () => true,
      insertRelation: async (relation) => { saved.push(relation); },
      listRelations: async () => [],
    });
    await service.createRelation(actor({ 1: 'admin', 2: 'read-write' }), {
      source: { type: 'instance', id: 1 }, target: { type: 'instance', id: 2 },
      relationType: 'replicates_to', provenance: 'manual', validFrom: new Date('2026-07-18T00:00:00Z'),
    });
    expect(saved).toHaveLength(1);
    await expect(service.createRelation(actor({ 1: 'admin' }), {
      source: { type: 'instance', id: 1 }, target: { type: 'instance', id: 2 },
      relationType: 'replicates_to', provenance: 'manual', validFrom: new Date(),
    })).rejects.toThrow('RESOURCE_FORBIDDEN');
  });

  it('rejects self relationships and ignores expired relationships', async () => {
    const service = new ResourceService({
      exists: async () => true,
      insertRelation: async () => {},
      listRelations: async () => [{
        source: { type: 'instance', id: 1 }, target: { type: 'instance', id: 2 }, relationType: 'runs_on',
        provenance: 'collector', validFrom: new Date(0), validUntil: new Date(1),
      }],
    });
    await expect(service.createRelation(actor({ 1: 'admin' }), {
      source: { type: 'instance', id: 1 }, target: { type: 'instance', id: 1 },
      relationType: 'depends_on', provenance: 'manual', validFrom: new Date(),
    })).rejects.toThrow('RESOURCE_RELATION_SELF');
    await expect(service.createRelation(actor({ 1: 'admin', 2: 'read-write' }), {
      source: { type: 'instance', id: 1 }, target: { type: 'instance', id: 2 },
      relationType: 'depends_on', provenance: 'manual', validFrom: new Date('invalid'),
    })).rejects.toThrow('RESOURCE_RELATION_WINDOW_INVALID');
    await expect(service.currentRelations(actor({ 1: 'read-only', 2: 'read-only' }), { type: 'instance', id: 1 }, new Date(2))).resolves.toEqual([]);
  });
});

describe('Resource authorization', () => {
  it('requires the established server permission rather than granting all authenticated users server access', () => {
    expect((new ObservationService({
      latestInstanceMetric: async () => null, latestServerMetric: async () => null,
      rangeInstanceMetric: async () => [], rangeServerMetric: async () => [],
    })).latest(actor({}), { type: 'server', id: 1 }, 'cpu_usage', { validForMs: 1 }))
      .rejects.toThrow('RESOURCE_FORBIDDEN');
  });
});

describe('Resource detail', () => {
  it('uses a common detail contract without returning credentials', async () => {
    const service = new ResourceService({
      exists: async () => true, insertRelation: async () => {}, listRelations: async () => [],
      describe: async (resource) => ({ resource, label: 'db-a', status: 'active', attributes: { host: 'db.example', port: 3306 } }),
    });
    await expect(service.detail(actor({ 1: 'read-only' }), { type: 'instance', id: 1 }))
      .resolves.toEqual(expect.objectContaining({ label: 'db-a', attributes: { host: 'db.example', port: 3306 } }));
  });
});

describe('Resource capabilities', () => {
  it('does not let an expired verified capability continue to claim verification', async () => {
    const service = new CapabilityService({
      get: async () => ({ resource: { type: 'instance' as const, id: 1 }, key: 'metrics', state: 'verified' as const,
        evidence: { probe: 'collector' }, checkedAt: new Date(0), validUntil: new Date(1) }),
      put: async () => {},
    });
    await expect(service.get(actor({ 1: 'read-only' }), { type: 'instance', id: 1 }, 'metrics', new Date(2)))
      .resolves.toMatchObject({ state: 'configured', reason: 'capability_verification_expired' });
  });

  it('requires probe evidence before writing verified state', async () => {
    const service = new CapabilityService({ get: async () => null, put: async () => {} });
    await expect(service.put(actor({ 1: 'admin' }), {
      resource: { type: 'instance', id: 1 }, key: 'metrics', state: 'verified', evidence: { source: 'config' }, checkedAt: new Date(),
    })).rejects.toThrow('CAPABILITY_VERIFICATION_EVIDENCE_REQUIRED');
    await expect(service.put(actor({ 1: 'admin' }), {
      resource: { type: 'instance', id: 1 }, key: 'metrics', state: 'invented' as any, checkedAt: new Date(),
    })).rejects.toThrow('CAPABILITY_STATE_INVALID');
  });
});
