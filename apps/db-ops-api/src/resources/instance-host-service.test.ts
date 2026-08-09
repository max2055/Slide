import { describe, expect, it } from 'vitest';
import type { ActorContext } from '../auth/actor-context.js';
import {
  InstanceHostService,
  type InstanceHostMapping,
  type InstanceHostStore,
} from './instance-host-service.js';

function actor(options: {
  permissions?: string[];
  scopes?: Record<number, 'read-only' | 'read-write' | 'admin'>;
} = {}): ActorContext {
  return Object.freeze({
    userId: 7,
    username: 'operator',
    roles: Object.freeze(['dba']),
    permissions: Object.freeze(options.permissions ?? ['instance:manage', 'instance:view', 'servers:manage', 'servers:view']),
    sessionVersion: 1,
    instanceScopes: Object.freeze(options.scopes ?? { 10: 'admin', 11: 'read-only' }),
    requestId: 'instance-host-test',
  });
}

class MemoryStore implements InstanceHostStore {
  instances = new Set([10, 11]);
  servers = new Set([20, 21, 22]);
  mappings = new Map<number, InstanceHostMapping[]>();

  async instanceExists(id: number) { return this.instances.has(id); }
  async serversExist(ids: number[]) { return ids.filter((id) => this.servers.has(id)); }
  async replaceInstanceHosts(instanceId: number, mappings: InstanceHostMapping[]) {
    this.mappings.set(instanceId, mappings.map((mapping) => ({ ...mapping })));
  }
  async expireInstanceHost(instanceId: number, serverId: number) {
    const current = this.mappings.get(instanceId) ?? [];
    const next = current.filter((mapping) => mapping.serverId !== serverId);
    this.mappings.set(instanceId, next);
    return next.length !== current.length;
  }
  async listInstanceHosts(instanceId: number) {
    return (this.mappings.get(instanceId) ?? []).map((mapping) => ({
      ...mapping,
      host: `host-${mapping.serverId}`,
      port: 22,
      label: null,
      osType: 'RHEL 8',
      status: 'online',
      collectionEnabled: true,
      validFrom: new Date('2026-08-09T00:00:00Z'),
    }));
  }
  async listServerInstances(serverId: number) {
    return [...this.mappings.entries()].flatMap(([instanceId, mappings]) => mappings
      .filter((mapping) => mapping.serverId === serverId)
      .map((mapping) => ({
        ...mapping,
        instanceId,
        name: `db-${instanceId}`,
        dbType: 'mysql',
        environment: 'production',
        status: 'active',
        healthStatus: 'healthy',
        validFrom: new Date('2026-08-09T00:00:00Z'),
      })));
  }
  async countActiveForServer(serverId: number) {
    return (await this.listServerInstances(serverId)).length;
  }
}

describe('InstanceHostService', () => {
  it('replaces an instance mapping with multiple Linux hosts and roles', async () => {
    const store = new MemoryStore();
    const service = new InstanceHostService(store);

    await service.replaceHosts(actor(), 10, [
      { serverId: 20, role: 'primary', notes: 'writer' },
      { serverId: 21, role: 'replica' },
    ]);

    await expect(service.listHosts(actor(), 10)).resolves.toMatchObject([
      { serverId: 20, role: 'primary', host: 'host-20' },
      { serverId: 21, role: 'replica', host: 'host-21' },
    ]);
  });

  it('rejects duplicate, missing, invalid-role, and oversized mappings', async () => {
    const service = new InstanceHostService(new MemoryStore());
    await expect(service.replaceHosts(actor(), 10, [
      { serverId: 20, role: 'primary' },
      { serverId: 20, role: 'replica' },
    ])).rejects.toThrow('INSTANCE_HOST_DUPLICATE');
    await expect(service.replaceHosts(actor(), 10, [{ serverId: 99, role: 'primary' }]))
      .rejects.toThrow('SERVER_NOT_FOUND');
    await expect(service.replaceHosts(actor(), 10, [{ serverId: 20, role: 'writer' as any }]))
      .rejects.toThrow('INSTANCE_HOST_ROLE_INVALID');
    await expect(service.replaceHosts(actor(), 10, Array.from({ length: 33 }, (_, index) => ({ serverId: index + 100, role: 'unknown' as const }))))
      .rejects.toThrow('INSTANCE_HOST_LIMIT');
  });

  it('requires instance and server permissions without deriving access from the relation', async () => {
    const service = new InstanceHostService(new MemoryStore());
    await expect(service.listHosts(actor({ permissions: ['instance:view'], scopes: { 10: 'read-only' } }), 10))
      .rejects.toThrow('RESOURCE_FORBIDDEN');
    await expect(service.replaceHosts(actor({ permissions: ['instance:view', 'servers:view'], scopes: { 10: 'read-only' } }), 10, []))
      .rejects.toThrow('RESOURCE_FORBIDDEN');
  });

  it('expires mappings and blocks deletion while a server hosts instances', async () => {
    const store = new MemoryStore();
    const service = new InstanceHostService(store);
    await service.replaceHosts(actor(), 10, [{ serverId: 20, role: 'standalone' }]);

    await expect(service.assertServerDeletable(20)).rejects.toThrow('SERVER_HAS_INSTANCE_RELATIONS');
    await expect(service.unlinkHost(actor(), 10, 20)).resolves.toBe(true);
    await expect(service.assertServerDeletable(20)).resolves.toBeUndefined();
  });

  it('filters reverse relations by instance scope', async () => {
    const store = new MemoryStore();
    const service = new InstanceHostService(store);
    const manager = actor({ scopes: { 10: 'admin', 11: 'admin' } });
    await service.replaceHosts(manager, 10, [{ serverId: 20, role: 'primary' }]);
    await service.replaceHosts(manager, 11, [{ serverId: 20, role: 'replica' }]);

    await expect(service.listInstances(actor({ permissions: ['instance:view', 'servers:view'], scopes: { 10: 'read-only' } }), 20))
      .resolves.toEqual([expect.objectContaining({ instanceId: 10 })]);
  });
});
