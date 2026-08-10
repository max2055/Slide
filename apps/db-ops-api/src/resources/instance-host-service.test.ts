import { describe, expect, it } from 'vitest';
import type { ActorContext } from '../auth/actor-context.js';
import {
  InstanceHostService,
  MysqlInstanceHostStore,
  type InstanceHostMapping,
  type InstanceHostStore,
} from './instance-host-service.js';
import { readFileSync } from 'node:fs';

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
    return this.listInstanceHosts(instanceId);
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

  it('returns enriched mappings to a manager without requiring servers:view after the write', async () => {
    const service = new InstanceHostService(new MemoryStore());

    await expect(service.replaceHosts(actor({
      permissions: ['instance:manage', 'servers:manage'],
      scopes: { 10: 'admin' },
    }), 10, [{ serverId: 20, role: 'primary' }])).resolves.toMatchObject([
      { serverId: 20, role: 'primary', host: 'host-20' },
    ]);
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

describe('MysqlInstanceHostStore current relation integrity', () => {
  it('uses the same half-open current window for list, reverse-list, count, and unlink', async () => {
    const calls: string[] = [];
    const store = new MysqlInstanceHostStore(() => ({
      execute: async (sql: string) => {
        calls.push(sql);
        if (sql.includes('COUNT(*)')) return [[{ count: 0 }]];
        if (sql.startsWith('UPDATE')) return [{ affectedRows: 0 }];
        return [[]];
      },
    } as any));

    await store.listInstanceHosts(10);
    await store.listServerInstances(20);
    await store.countActiveForServer(20);
    await store.expireInstanceHost(10, 20, new Date('2026-08-10T00:00:00Z'));

    for (const sql of calls) {
      expect(sql).toContain('valid_from <=');
      expect(sql).toMatch(/valid_until IS NULL OR .*valid_until > /);
    }
  });

  it('locks desired servers inside replace and fails before insert when one disappeared', async () => {
    const calls: string[] = [];
    let rolledBack = false;
    const connection = {
      beginTransaction: async () => {},
      execute: async (sql: string) => {
        calls.push(sql);
        if (sql.includes('FROM database_instances')) return [[{ id: 10 }]];
        if (sql.includes('FROM servers')) return [[{ id: 20 }]];
        if (sql.includes('FROM resource_relations')) return [[]];
        return [{ affectedRows: 1 }];
      },
      commit: async () => {},
      rollback: async () => { rolledBack = true; },
      release: () => {},
    };
    const store = new MysqlInstanceHostStore(() => ({ getConnection: async () => connection } as any));

    await expect(store.replaceInstanceHosts(10, [
      { serverId: 20, role: 'primary' }, { serverId: 21, role: 'replica' },
    ], new Date('2026-08-10T00:00:00Z'))).rejects.toThrow('SERVER_NOT_FOUND');
    expect(calls.some((sql) => sql.includes('FROM servers') && sql.includes('FOR UPDATE'))).toBe(true);
    expect(calls.some((sql) => sql.includes('INSERT INTO resource_relations'))).toBe(false);
    expect(rolledBack).toBe(true);
  });

  it('converges duplicate current rows to one and never gives a future row an invalid window', async () => {
    const updates: unknown[][] = [];
    const deletes: unknown[][] = [];
    const now = new Date('2026-08-10T00:00:00Z');
    const connection = {
      beginTransaction: async () => {},
      execute: async (sql: string, values: unknown[] = []) => {
        if (sql.startsWith('UPDATE resource_relations')) {
          updates.push(values);
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('DELETE FROM resource_relations')) {
          deletes.push(values);
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('FROM database_instances')) return [[{ id: 10 }]];
        if (sql.includes('FROM servers')) return [[{ id: 20 }]];
        if (sql.includes('JOIN servers s')) return [[]];
        if (sql.includes('FROM resource_relations')) return [[
          { id: 1, server_id: 20, metadata: { role: 'primary', notes: null }, valid_from: new Date('2026-08-01T00:00:00Z') },
          { id: 2, server_id: 20, metadata: { role: 'primary', notes: null }, valid_from: new Date('2026-08-02T00:00:00Z') },
          { id: 3, server_id: 21, metadata: { role: 'replica', notes: null }, valid_from: new Date('2026-08-20T00:00:00Z') },
        ]];
        return [{ affectedRows: 1 }];
      },
      commit: async () => {}, rollback: async () => {}, release: () => {},
    };
    const store = new MysqlInstanceHostStore(() => ({ getConnection: async () => connection } as any));

    await store.replaceInstanceHosts(10, [{ serverId: 20, role: 'primary' }], now);

    expect(updates).toEqual([[now, 2]]);
    expect(deletes).toEqual([[3]]);
  });

  it('returns enriched mappings from the replace transaction before commit', async () => {
    let committed = false;
    const now = new Date('2026-08-10T00:00:00Z');
    const connection = {
      beginTransaction: async () => {},
      execute: async (sql: string) => {
        if (sql.includes('FROM database_instances')) return [[{ id: 10 }]];
        if (sql.includes('FROM servers')) return [[{ id: 20 }]];
        if (sql.includes('FROM resource_relations') && sql.includes('FOR UPDATE')) return [[]];
        if (sql.includes('JOIN servers s')) {
          expect(committed).toBe(false);
          return [[{
            server_id: 20,
            metadata: { role: 'primary', notes: null },
            valid_from: now,
            host: 'db-host.internal',
            port: 22,
            label: 'db-host',
            os_type: 'rhel8',
            status: 'online',
            collection_enabled: 1,
          }]];
        }
        return [{ affectedRows: 1 }];
      },
      commit: async () => { committed = true; },
      rollback: async () => {},
      release: () => {},
    };
    const store = new MysqlInstanceHostStore(() => ({ getConnection: async () => connection } as any));

    await expect(store.replaceInstanceHosts(10, [{ serverId: 20, role: 'primary' }], now))
      .resolves.toMatchObject([{ serverId: 20, host: 'db-host.internal' }]);
    expect(committed).toBe(true);
  });

  it('requires server deletion to lock the server and check current runs_on rows in the same transaction', () => {
    const source = readFileSync(new URL('../server-database-service.ts', import.meta.url), 'utf8');
    const method = source.slice(source.indexOf('async deleteServer'), source.indexOf('async testConnection'));
    expect(method).toContain('getConnection()');
    expect(method).toContain('beginTransaction()');
    expect(method).toMatch(/SELECT id FROM servers WHERE id = \? FOR UPDATE/);
    expect(method).toContain("relation_type = 'runs_on'");
    expect(method).toMatch(/valid_from <= .*valid_until IS NULL OR valid_until > /s);
    expect(method.indexOf('FOR UPDATE')).toBeLessThan(method.indexOf('DELETE FROM servers'));
  });
});
