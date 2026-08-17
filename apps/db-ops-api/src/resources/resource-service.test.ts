import { describe, expect, it } from 'vitest';
import { latestObservation, ObservationService } from './observation-service.js';
import { MysqlResourceRelationStore, ResourceService, canManageResource, canReadResource } from './resource-service.js';
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
  it('does not treat instance-wide permissions as server permissions', () => {
    const instanceAdmin = actor({ 1: 'admin' }, ['instance:*']);
    expect(canReadResource(instanceAdmin, { type: 'server', id: 20 })).toBe(false);
    expect(canManageResource(instanceAdmin, { type: 'server', id: 20 })).toBe(false);
    expect(canReadResource(actor({}, ['servers:*']), { type: 'server', id: 20 })).toBe(true);
    expect(canManageResource(actor({}, ['servers:*']), { type: 'server', id: 20 })).toBe(true);
  });

  it('requires server management permission for generic runs_on creation', async () => {
    const service = new ResourceService({
      exists: async () => true,
      insertRelation: async () => {},
      listRelations: async () => [],
    });
    await expect(service.createRelation(actor({ 1: 'admin' }, ['instance:*']), {
      source: { type: 'instance', id: 1 }, target: { type: 'server', id: 20 }, relationType: 'runs_on',
      provenance: 'manual', validFrom: new Date('2026-08-10T00:00:00Z'),
    })).rejects.toThrow('RESOURCE_FORBIDDEN');
  });

  it('filters current relations whose other endpoint is not readable by the actor', async () => {
    const hiddenServer = {
      source: { type: 'instance' as const, id: 1 }, target: { type: 'server' as const, id: 20 },
      relationType: 'runs_on' as const, provenance: 'manual', validFrom: new Date(0), validUntil: null,
    };
    const visibleInstance = {
      source: { type: 'instance' as const, id: 1 }, target: { type: 'instance' as const, id: 2 },
      relationType: 'replicates_to' as const, provenance: 'manual', validFrom: new Date(0), validUntil: null,
    };
    const service = new ResourceService({
      exists: async () => true,
      insertRelation: async () => {},
      listRelations: async () => [hiddenServer, visibleInstance],
    });

    await expect(service.currentRelations(actor({ 1: 'read-only', 2: 'read-only' }, ['instance:view']), { type: 'instance', id: 1 }, new Date(1)))
      .resolves.toEqual([visibleInstance]);
  });

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

  it('enforces canonical relation topology and hides future relations', async () => {
    const service = new ResourceService({
      exists: async () => true,
      insertRelation: async () => {},
      listRelations: async () => [{
        source: { type: 'instance', id: 1 }, target: { type: 'server', id: 2 }, relationType: 'runs_on',
        provenance: 'manual', validFrom: new Date(20), validUntil: null,
      }],
    });
    const manager = actor({ 1: 'admin', 2: 'admin' }, ['instance:manage', 'servers:manage']);
    await expect(service.createRelation(manager, {
      source: { type: 'instance', id: 1 }, target: { type: 'instance', id: 2 }, relationType: 'runs_on',
      provenance: 'manual', validFrom: new Date(1),
    })).rejects.toThrow('RESOURCE_RELATION_TOPOLOGY_INVALID');
    await expect(service.createRelation(manager, {
      source: { type: 'server', id: 2 }, target: { type: 'instance', id: 1 }, relationType: 'hosts',
      provenance: 'manual', validFrom: new Date(1),
    })).rejects.toThrow('RESOURCE_RELATION_TOPOLOGY_INVALID');
    await expect(service.currentRelations(actor({ 1: 'read-only' }, ['servers:view']), { type: 'instance', id: 1 }, new Date(10)))
      .resolves.toEqual([]);
  });
});

describe('MysqlResourceRelationStore', () => {
  it('locks both endpoints and rejects an overlapping canonical relation in one transaction', async () => {
    const calls: string[] = [];
    let rolledBack = false;
    const connection = {
      beginTransaction: async () => { calls.push('BEGIN'); },
      execute: async (sql: string) => {
        calls.push(sql);
        if (sql.includes('FROM resource_relations')) return [[{ id: 9 }]];
        return [[{ id: 1 }]];
      },
      commit: async () => { calls.push('COMMIT'); },
      rollback: async () => { rolledBack = true; },
      release: () => {},
    };
    const store = new MysqlResourceRelationStore(() => ({
      execute: connection.execute,
      getConnection: async () => connection,
    } as any));

    await expect(store.insertRelation({
      source: { type: 'instance', id: 1 }, target: { type: 'server', id: 20 }, relationType: 'runs_on',
      provenance: 'manual', validFrom: new Date('2026-08-10T00:00:00Z'), validUntil: new Date('2026-08-11T00:00:00Z'),
    })).rejects.toThrow('RESOURCE_RELATION_OVERLAP');
    expect(calls[0]).toBe('BEGIN');
    expect(calls.some((sql) => sql.includes('database_instances') && sql.includes('FOR UPDATE'))).toBe(true);
    expect(calls.some((sql) => sql.includes('servers') && sql.includes('FOR UPDATE'))).toBe(true);
    expect(calls.find((sql) => sql.includes('FROM resource_relations'))).toContain('valid_until > ?');
    expect(rolledBack).toBe(true);
    expect(calls.some((sql) => sql.includes('INSERT INTO resource_relations'))).toBe(false);
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
