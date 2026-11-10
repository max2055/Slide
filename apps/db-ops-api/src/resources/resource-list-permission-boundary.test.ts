/**
 * MAX-366 / GitHub #367 (OCR-0232).
 *
 * The production list entry is resourceDiagnosticService.listResources, whose
 * default dependency calls the real inventory services. These tests stub those
 * services and actor revalidation. They do not verify JWT signature checks or
 * a live database.
 */
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../auth/actor-context.js';
import { canReadResource } from './resource-service.js';
import { resourceDiagnosticService } from './resource-diagnostic-service.js';
import { registerResourceRoutes } from './resource-routes.js';

const calls = vi.hoisted(() => ({
  instances: vi.fn(),
  servers: vi.fn(),
  devices: vi.fn(),
}));

vi.mock('../instance-database-service.js', () => ({
  instanceDatabaseService: { getManagedInstances: calls.instances },
}));
vi.mock('../server-database-service.js', () => ({
  serverDatabaseService: { getAllServers: calls.servers },
}));
vi.mock('../network-devices/network-device-database-service.js', () => ({
  networkDeviceDatabaseService: { getAllDevices: calls.devices },
}));
vi.mock('../auth/actor-context.js', async () => {
  const actual = await vi.importActual<typeof import('../auth/actor-context.js')>('../auth/actor-context.js');
  return {
    ...actual,
    actorContextService: {
      revalidateActor: vi.fn(async (actor: ActorContext) => actor),
    },
  };
});

type Boundary = NonNullable<ActorContext['resourceBoundary']>;

const apps: ReturnType<typeof Fastify>[] = [];

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    userId: 366,
    username: 'max366-list',
    roles: [],
    permissions: [],
    sessionVersion: 1,
    instanceScopes: {},
    requestId: 'max-366-list',
    ...overrides,
  };
}

function boundary(overrides: Partial<Boundary> = {}): Boundary {
  return { instanceIds: [], serverIds: [], networkDeviceIds: [], ...overrides };
}

function instanceRow(id: number) {
  return {
    id, name: `db-${id}`, status: 'active', db_type: 'mysql', environment: 'test',
    host: `10.2.0.${id}`, port: 3308, health_status: 'healthy', username: 'reader',
    password: 'instance-secret', password_encrypted: 'instance-ciphertext', connection_string: 'mysql://secret',
  };
}

function serverRow(id: number) {
  return {
    id, host: `10.0.0.${id}`, port: 22, label: `server-${id}`, os_type: 'linux', status: 'online',
    collection_enabled: true, credential_encrypted: 'server-ciphertext', password: 'server-secret',
  };
}

function deviceRow(id: number) {
  return {
    id, name: `device-${id}`, label: `nd-${id}`, host: `10.1.0.${id}`, site: 'lab', vendor: 'sample',
    model: 'sim', status: 'online', collection_enabled: true, community: 'snmp-secret',
    snmp_community: 'snmp-secret', credential_encrypted: 'device-ciphertext', sshCredentialType: 'password',
  };
}

function refsOf(items: Array<{ resource: { type: string; id: number } }>) {
  return items.map((item) => `${item.resource.type}:${item.resource.id}`);
}

beforeEach(() => {
  calls.instances.mockReset();
  calls.servers.mockReset();
  calls.devices.mockReset();
  calls.instances.mockResolvedValue([instanceRow(1), instanceRow(2)]);
  calls.servers.mockResolvedValue([serverRow(1), serverRow(2)]);
  calls.devices.mockResolvedValue([deviceRow(1), deviceRow(2)]);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('MAX-366 production resource list boundary', () => {
  it('lists a server and network device whose boundary contains 2 and omits 1', async () => {
    const current = actor({
      permissions: ['servers:view', 'network_devices:view'],
      resourceBoundary: boundary({ serverIds: [2], networkDeviceIds: [2] }),
    });
    expect(canReadResource(current, { type: 'server', id: 1 })).toBe(false);
    expect(canReadResource(current, { type: 'server', id: 2 })).toBe(true);
    expect(canReadResource(current, { type: 'network_device', id: 1 })).toBe(false);
    expect(canReadResource(current, { type: 'network_device', id: 2 })).toBe(true);

    const result = await resourceDiagnosticService.listResources(current);

    expect(calls.servers).toHaveBeenCalledTimes(1);
    expect(calls.servers).toHaveBeenCalledWith({ strict: true });
    expect(calls.devices).toHaveBeenCalledTimes(1);
    expect(calls.instances).not.toHaveBeenCalled();
    expect(refsOf(result.items)).toEqual(['server:2', 'network_device:2']);
    expect(result.unavailableTypes).toEqual([]);
    expect(result.dataQuality).toBe('complete');
    expect(JSON.stringify(result)).not.toMatch(/secret|ciphertext|community|password/i);
    expect(result.items[0]).toMatchObject({
      label: 'server-2', status: 'online',
      attributes: { host: '10.0.0.2', port: 22, osType: 'linux', collectionEnabled: true },
    });
    expect(result.items[1]).toMatchObject({
      label: 'nd-2', status: 'online',
      attributes: { host: '10.1.0.2', site: 'lab', vendor: 'sample', model: 'sim', collectionEnabled: true },
    });
  });

  it('serves the same filtered list from the default HTTP route', async () => {
    const current = actor({
      permissions: ['servers:view', 'network_devices:view'],
      resourceBoundary: boundary({ serverIds: [2], networkDeviceIds: [2] }),
    });
    const app = Fastify();
    apps.push(app);
    await registerResourceRoutes(app, async (request) => {
      (request as { user?: ActorContext }).user = current;
    });

    const response = await app.inject('/api/resources');

    expect(response.statusCode).toBe(200);
    expect(refsOf(response.json().items)).toEqual(['server:2', 'network_device:2']);
    expect(response.json().dataQuality).toBe('complete');
    expect(response.json().unavailableTypes).toEqual([]);
    expect(calls.servers).toHaveBeenCalledWith({ strict: true });
    expect(calls.devices).toHaveBeenCalledTimes(1);
  });

  it('does not query when the boundary lists no positive resource id', async () => {
    const current = actor({
      permissions: ['servers:view', 'network_devices:view', '*'],
      resourceBoundary: boundary(),
    });

    const result = await resourceDiagnosticService.listResources(current);

    expect(calls.servers).not.toHaveBeenCalled();
    expect(calls.devices).not.toHaveBeenCalled();
    expect(calls.instances).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([]);
    expect(result.unavailableTypes).toEqual([]);
    expect(result.dataQuality).toBe('empty');
  });

  it('does not query a type the actor cannot view', async () => {
    const current = actor({
      permissions: ['servers:view'],
      resourceBoundary: boundary({ serverIds: [1, 2], networkDeviceIds: [1, 2] }),
    });

    const result = await resourceDiagnosticService.listResources(current);

    expect(calls.servers).toHaveBeenCalledTimes(1);
    expect(calls.devices).not.toHaveBeenCalled();
    expect(refsOf(result.items)).toEqual(['server:1', 'server:2']);
    expect(result.dataQuality).toBe('complete');
  });

  it.each([
    ['servers:views'],
    ['server:view'],
    ['SERVERS:view'],
    ['servers:view '],
    ['servers:manage'],
    ['network_devices:view'],
  ])('does not query servers for permission %j', async (permission) => {
    const current = actor({
      permissions: [permission],
      resourceBoundary: boundary({ serverIds: [2], networkDeviceIds: [2] }),
    });

    const result = await resourceDiagnosticService.listResources(current);

    expect(calls.servers).not.toHaveBeenCalled();
    expect(result.items.filter((item) => item.resource.type === 'server')).toEqual([]);
  });

  it('queries a wildcard type permission and still drops ids outside the boundary', async () => {
    const current = actor({
      permissions: ['servers:*', 'network_devices:*'],
      resourceBoundary: boundary({ serverIds: [2], networkDeviceIds: [2, 99] }),
    });

    const result = await resourceDiagnosticService.listResources(current);

    expect(calls.servers).toHaveBeenCalledTimes(1);
    expect(calls.devices).toHaveBeenCalledTimes(1);
    expect(refsOf(result.items)).toEqual(['server:2', 'network_device:2']);
  });

  it('queries every readable id when no resource boundary is set', async () => {
    const current = actor({ permissions: ['*', 'servers:view', 'network_devices:view'] });

    const result = await resourceDiagnosticService.listResources(current);

    expect(calls.instances).toHaveBeenCalledTimes(1);
    expect(calls.servers).toHaveBeenCalledTimes(1);
    expect(calls.devices).toHaveBeenCalledTimes(1);
    expect(refsOf(result.items)).toEqual([
      'instance:1', 'instance:2', 'server:1', 'server:2', 'network_device:1', 'network_device:2',
    ]);
    expect(result.dataQuality).toBe('complete');
    expect(JSON.stringify(result)).not.toMatch(/secret|ciphertext|community|password/i);
  });

  it('keeps the existing instance scope intersection and mixes it with a server boundary', async () => {
    const current = actor({
      permissions: ['servers:view'],
      instanceScopes: { 2: 'read-only' },
      resourceBoundary: boundary({ instanceIds: [2], serverIds: [2], networkDeviceIds: [2] }),
    });

    const result = await resourceDiagnosticService.listResources(current);

    expect(calls.instances).toHaveBeenCalledTimes(1);
    expect(calls.servers).toHaveBeenCalledTimes(1);
    expect(calls.devices).not.toHaveBeenCalled();
    expect(refsOf(result.items)).toEqual(['instance:2', 'server:2']);
    expect(result.items[0].attributes).toMatchObject({
      dbType: 'mysql', environment: 'test', host: '10.2.0.2', port: 3308, healthStatus: 'healthy',
    });
  });

  it('does not query a boundary made only of ids the reader would reject', async () => {
    const current = actor({
      permissions: ['servers:view', 'network_devices:view'],
      resourceBoundary: boundary({
        serverIds: [0, -1, 1.5, Number.NaN],
        networkDeviceIds: ['2'] as unknown as number[],
      }),
    });

    const result = await resourceDiagnosticService.listResources(current);

    expect(calls.servers).not.toHaveBeenCalled();
    expect(calls.devices).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
    expect(result.dataQuality).toBe('empty');
    expect(result.unavailableTypes).toEqual([]);
  });

  it('reports an inventory failure without turning a denied type into an outage', async () => {
    calls.servers.mockRejectedValue(new Error('SERVER_ENUMERATION_UNAVAILABLE'));
    const current = actor({
      permissions: ['servers:view', 'network_devices:view'],
      resourceBoundary: boundary({ serverIds: [2], networkDeviceIds: [2] }),
    });

    const result = await resourceDiagnosticService.listResources(current);

    expect(refsOf(result.items)).toEqual(['network_device:2']);
    expect(result.unavailableTypes).toEqual(['server']);
    expect(result.dataQuality).toBe('partial');
  });

  it('allows a global permission to read instances while an empty server boundary skips servers', async () => {
    const current = actor({
      permissions: ['*'],
      resourceBoundary: boundary({ instanceIds: [2] }),
    });

    const result = await resourceDiagnosticService.listResources(current);

    expect(calls.instances).toHaveBeenCalledTimes(1);
    expect(calls.servers).not.toHaveBeenCalled();
    expect(calls.devices).not.toHaveBeenCalled();
    expect(refsOf(result.items)).toEqual(['instance:2']);
  });
});
