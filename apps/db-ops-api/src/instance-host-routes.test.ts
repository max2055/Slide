import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';
import { Value } from '@sinclair/typebox/value';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from './auth/actor-context.js';
import * as contracts from './contracts/public-api.js';
import { buildClientTypes, buildOpenApiDocument } from './contracts/generate-public-api.js';
import type { InstanceDiagnosticContext } from './instance-diagnostic-context-service.js';
import {
  type HostedInstanceDetail,
  type InstanceHostDetail,
  type InstanceHostMapping,
} from './resources/instance-host-service.js';

interface InstanceHostRouteService {
  listHosts(actor: ActorContext, instanceId: number): Promise<InstanceHostDetail[]>;
  replaceHosts(actor: ActorContext, instanceId: number, mappings: InstanceHostMapping[]): Promise<InstanceHostDetail[]>;
  unlinkHost(actor: ActorContext, instanceId: number, serverId: number): Promise<boolean>;
  listInstances(actor: ActorContext, serverId: number): Promise<HostedInstanceDetail[]>;
}

interface EvidenceService {
  collect(actor: ActorContext, instanceId: number): Promise<InstanceDiagnosticContext>;
}

type RegisterInstanceHostRoutes = (
  app: FastifyInstance,
  dependencies: {
    verifyToken: preHandlerHookHandler;
    service: InstanceHostRouteService;
    serverLookup: {
      getServerById(id: number): Promise<{ id: number } | null>;
    };
    evidenceService: EvidenceService;
  },
) => Promise<void>;

let registerInstanceHostRoutes: RegisterInstanceHostRoutes | undefined;

beforeAll(async () => {
  const modulePath = './instance-host-routes.js';
  registerInstanceHostRoutes = await import(modulePath)
    .then((module) => module.registerInstanceHostRoutes as RegisterInstanceHostRoutes)
    .catch(() => undefined);
});

function actor(
  permissions: string[],
  scopes: Record<number, 'read-only' | 'read-write' | 'admin'>,
): ActorContext {
  return Object.freeze({
    userId: 7,
    username: 'operator',
    roles: Object.freeze(['dba']),
    permissions: Object.freeze(permissions),
    sessionVersion: 1,
    instanceScopes: Object.freeze(scopes),
    requestId: 'instance-host-route-test',
  });
}

const actors: Record<string, ActorContext> = {
  manager: actor(['instance:manage', 'servers:manage'], { 10: 'admin' }),
  reader: actor(['servers:view'], { 10: 'read-only' }),
  evidenceReader: actor(
    ['instance:view', 'servers:view', 'metric:view', 'alert:view', 'log:view'],
    { 10: 'read-only' },
  ),
  noInstanceView: actor(['servers:view'], { 10: 'read-only' }),
  noScope: actor(['servers:view'], {}),
  noServer: actor([], { 10: 'read-only' }),
};

function hasPermission(authenticated: ActorContext, permission: string): boolean {
  const [resource] = permission.split(':');
  return authenticated.permissions.includes('*')
    || authenticated.permissions.includes(permission)
    || authenticated.permissions.includes(`${resource}:*`);
}

function requireRead(authenticated: ActorContext, instanceId: number): void {
  if (!authenticated.instanceScopes[instanceId] || !hasPermission(authenticated, 'servers:view')) {
    throw new Error('RESOURCE_FORBIDDEN');
  }
}

function requireManage(authenticated: ActorContext, instanceId: number): void {
  const scope = authenticated.instanceScopes[instanceId];
  if ((scope !== 'read-write' && scope !== 'admin')
    || !hasPermission(authenticated, 'instance:manage')
    || !hasPermission(authenticated, 'servers:manage')) {
    throw new Error('RESOURCE_FORBIDDEN');
  }
}

function host(mapping: InstanceHostMapping): InstanceHostDetail {
  return {
    ...mapping,
    host: `host-${mapping.serverId}.internal`,
    port: 22,
    label: mapping.serverId === 20 ? 'primary-host' : null,
    osType: 'rhel8',
    status: 'online',
    collectionEnabled: true,
    validFrom: new Date('2026-08-10T00:00:00.000Z'),
  };
}

function fakeService(): InstanceHostRouteService {
  let mappings: InstanceHostMapping[] = [];
  return {
    listHosts: vi.fn(async (authenticated, instanceId) => {
      requireRead(authenticated, instanceId);
      return mappings.map(host);
    }),
    replaceHosts: vi.fn(async (authenticated, instanceId, next) => {
      requireManage(authenticated, instanceId);
      mappings = next.map((mapping) => ({ ...mapping }));
      return mappings.map(host);
    }),
    unlinkHost: vi.fn(async (authenticated, instanceId, serverId) => {
      requireManage(authenticated, instanceId);
      const previousLength = mappings.length;
      mappings = mappings.filter((mapping) => mapping.serverId !== serverId);
      return mappings.length !== previousLength;
    }),
    listInstances: vi.fn(async (authenticated, serverId) => {
      if (!hasPermission(authenticated, 'servers:view')) throw new Error('RESOURCE_FORBIDDEN');
      return mappings
        .filter((mapping) => mapping.serverId === serverId && authenticated.instanceScopes[10])
        .map((mapping) => ({
          ...mapping,
          instanceId: 10,
          name: 'db-10',
          dbType: 'mysql',
          environment: 'production',
          status: 'active',
          healthStatus: 'healthy',
          validFrom: new Date('2026-08-10T00:00:00.000Z'),
        }));
    }),
  };
}

function evidencePack(gaps: InstanceDiagnosticContext['gaps'] = []): InstanceDiagnosticContext {
  const collectedAt = '2026-08-10T00:00:00.000Z';
  return {
    schemaVersion: 1,
    subject: { type: 'instance', id: 10 },
    collectedAt,
    database: {
      instance: { id: 10, name: 'orders', db_type: 'mysql' },
      realtimeMetrics: { qps: 12, recorded_at: collectedAt },
      metricHistory: [],
      alerts: [],
      logs: [],
      slowQueries: [],
    },
    storage: [{ path: '/data/orders.db', kind: 'data-file', source: 'mysql', hostInspectable: true }],
    hosts: [{
      server: host({ serverId: 20, role: 'primary' }),
      evidence: {
        schemaVersion: 1,
        serverId: 20,
        collectedAt,
        expiresAt: '2026-08-10T00:05:00.000Z',
        quality: 'partial',
        truncated: false,
        metrics: { source: ['procfs'], collectedAt, quality: 'good', values: { cpu: 12 } },
        filesystems: { source: ['df'], collectedAt, quality: 'good', items: [{
          mount: '/data', device: '/dev/mapper/data', fsType: 'xfs', sizeBytes: 1000,
          usedBytes: 750, availableBytes: 250, usagePercent: 75,
          inodeTotal: 100, inodeUsed: 20, inodeAvailable: 80, inodeUsagePercent: 20,
        }] },
        systemLogs: { source: ['journald'], collectedAt, quality: 'partial', entries: [{
          timestamp: collectedAt, severity: 'warning', unit: 'mysqld.service', identifier: 'mysqld',
          pid: '10', message: 'I/O warning',
        }] },
        physicalFiles: { source: ['stat'], collectedAt, quality: 'good', items: [{ path: '/data/orders.db', quality: 'good' }] },
        gaps: [{ section: 'systemLogs', reason: 'SYSTEM_LOG_SOURCE_PARTIAL' }],
      },
    }],
    gaps,
  };
}

async function buildApp(
  service: InstanceHostRouteService = fakeService(),
  evidenceService: EvidenceService = { collect: vi.fn(async () => evidencePack()) },
): Promise<FastifyInstance | null> {
  expect(registerInstanceHostRoutes).toBeTypeOf('function');
  if (!registerInstanceHostRoutes) return null;

  const app = Fastify();
  await app.register(rateLimit, { global: false });
  const verifyToken: preHandlerHookHandler = async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/, '');
    const authenticated = token ? actors[token] : undefined;
    if (!authenticated) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    (request as any).user = authenticated;
  };
  await registerInstanceHostRoutes(app, {
    verifyToken,
    service,
    serverLookup: {
      getServerById: async (id) => id === 20 || id === 21 ? { id } : null,
    },
    evidenceService,
  });
  await app.ready();
  return app;
}

describe('instance-host Fastify routes', () => {
  it('rate-limits repeated live host evidence collection', async () => {
    const collect = vi.fn(async () => evidencePack());
    const app = await buildApp(fakeService(), { collect });
    if (!app) return;

    const responses = [];
    for (let index = 0; index < 11; index++) {
      responses.push(await app.inject({
        method: 'GET',
        url: '/api/database/instances/10/host-evidence',
        headers: { authorization: 'Bearer evidenceReader' },
      }));
    }

    expect(responses.slice(0, 10).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[10].statusCode).toBe(429);
    expect(collect).toHaveBeenCalledTimes(10);
    await app.close();
  });

  it('returns bounded host evidence with the original actor and complete host section shape', async () => {
    const collect = vi.fn(async () => ({ ...evidencePack(), internalOnly: 'must-not-cross-contract' }) as any);
    const app = await buildApp(fakeService(), { collect });
    if (!app) return;

    const response = await app.inject({
      method: 'GET',
      url: '/api/database/instances/10/host-evidence',
      headers: { authorization: 'Bearer evidenceReader' },
    });

    expect(response.statusCode).toBe(200);
    expect(collect).toHaveBeenCalledWith(actors.evidenceReader, 10);
    expect(response.json()).not.toHaveProperty('internalOnly');
    expect(response.json()).toMatchObject({
      subject: { type: 'instance', id: 10 },
      hosts: [{
        server: { serverId: 20, role: 'primary', validFrom: '2026-08-10T00:00:00.000Z' },
        evidence: {
          collectedAt: '2026-08-10T00:00:00.000Z',
          expiresAt: '2026-08-10T00:05:00.000Z',
          quality: 'partial',
          filesystems: { source: ['df'], quality: 'good', items: [{ mount: '/data' }] },
          systemLogs: { source: ['journald'], quality: 'partial', entries: [{ message: 'I/O warning' }] },
          physicalFiles: { source: ['stat'], quality: 'good', items: [{ path: '/data/orders.db' }] },
          gaps: [{ reason: 'SYSTEM_LOG_SOURCE_PARTIAL' }],
        },
      }],
    });
    await app.close();
  });

  it('returns degraded evidence as 200 and maps stable request failures', async () => {
    const degraded = await buildApp(fakeService(), {
      collect: vi.fn(async () => evidencePack([{
        scope: 'host', section: 'hostEvidence', code: 'SSH_COMMAND_TIMEOUT',
        resource: { type: 'server', id: 20 },
      }])),
    });
    if (!degraded) return;
    const degradedResponse = await degraded.inject({
      method: 'GET', url: '/api/database/instances/10/host-evidence',
      headers: { authorization: 'Bearer evidenceReader' },
    });
    expect(degradedResponse.statusCode).toBe(200);
    expect(degradedResponse.json().gaps).toContainEqual(expect.objectContaining({ code: 'SSH_COMMAND_TIMEOUT' }));
    await degraded.close();

    for (const [token, url, failure, expectedStatus, expectedCode] of [
      ['evidenceReader', '/api/database/instances/not-a-number/host-evidence', null, 400, 'RESOURCE_REF_INVALID'],
      ['evidenceReader', '/api/database/instances/10/host-evidence', 'INSTANCE_NOT_FOUND', 404, 'INSTANCE_NOT_FOUND'],
      ['evidenceReader', '/api/database/instances/10/host-evidence', 'RESOURCE_FORBIDDEN', 404, 'RESOURCE_FORBIDDEN'],
      ['evidenceReader', '/api/database/instances/10/host-evidence', 'database connection details', 500, 'HOST_EVIDENCE_COLLECTION_FAILED'],
      ['noInstanceView', '/api/database/instances/10/host-evidence', null, 403, 'RESOURCE_FORBIDDEN'],
    ] as const) {
      const app = await buildApp(fakeService(), {
        collect: vi.fn(async () => {
          if (failure) throw new Error(failure);
          return evidencePack();
        }),
      });
      if (!app) continue;
      const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode, `${url} as ${token}`).toBe(expectedStatus);
      expect(response.json()).toEqual({ error: expectedCode });
      await app.close();
    }
  });

  it('supports PUT, GET, reverse GET, and DELETE without requiring servers:view for the write response', async () => {
    const app = await buildApp();
    if (!app) return;

    const replace = await app.inject({
      method: 'PUT',
      url: '/api/database/instances/10/hosts',
      headers: { authorization: 'Bearer manager' },
      payload: { hosts: [{ serverId: 20, role: 'primary', notes: 'writer' }] },
    });
    expect(replace.statusCode).toBe(200);
    expect(replace.json()).toMatchObject({
      ok: true,
      hosts: [{ serverId: 20, role: 'primary', host: 'host-20.internal' }],
    });

    const hosts = await app.inject({
      method: 'GET', url: '/api/database/instances/10/hosts',
      headers: { authorization: 'Bearer reader' },
    });
    expect(hosts.statusCode).toBe(200);
    expect(hosts.json().hosts).toHaveLength(1);

    const instances = await app.inject({
      method: 'GET', url: '/api/servers/20/instances',
      headers: { authorization: 'Bearer reader' },
    });
    expect(instances.statusCode).toBe(200);
    expect(instances.json()).toMatchObject({ instances: [{ instanceId: 10, role: 'primary' }] });

    const unlink = await app.inject({
      method: 'DELETE', url: '/api/database/instances/10/hosts/20',
      headers: { authorization: 'Bearer manager' },
    });
    expect(unlink.statusCode).toBe(200);
    expect(unlink.json()).toEqual({ ok: true });
    await app.close();
  });

  it('conceals instance scope and server permission failures as 404', async () => {
    const app = await buildApp();
    if (!app) return;

    for (const [token, method, url, payload] of [
      ['noScope', 'GET', '/api/database/instances/10/hosts', undefined],
      ['noServer', 'GET', '/api/database/instances/10/hosts', undefined],
      ['noServer', 'PUT', '/api/database/instances/10/hosts', { hosts: [] }],
      ['noScope', 'DELETE', '/api/database/instances/10/hosts/20', undefined],
      ['noServer', 'GET', '/api/servers/20/instances', undefined],
    ] as const) {
      const response = await app.inject({
        method, url, payload,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode, `${method} ${url} as ${token}`).toBe(404);
      expect(response.json()).toEqual({ error: 'RESOURCE_FORBIDDEN' });
    }
    await app.close();
  });

  it('returns 401 for every relationship route without authentication', async () => {
    const app = await buildApp();
    if (!app) return;

    for (const request of [
      { method: 'GET', url: '/api/database/instances/10/host-evidence' },
      { method: 'GET', url: '/api/database/instances/10/hosts' },
      { method: 'PUT', url: '/api/database/instances/10/hosts', payload: { hosts: [] } },
      { method: 'DELETE', url: '/api/database/instances/10/hosts/20' },
      { method: 'GET', url: '/api/servers/20/instances' },
    ] as const) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    await app.close();
  });

  it('rejects additional properties, invalid roles, and invalid types with a stable 400 code', async () => {
    const app = await buildApp();
    if (!app) return;

    for (const payload of [
      { hosts: [], unexpected: true },
      { hosts: [{ serverId: 20, role: 'writer' }] },
      { hosts: 'not-an-array' },
    ]) {
      const response = await app.inject({
        method: 'PUT', url: '/api/database/instances/10/hosts', payload,
        headers: { authorization: 'Bearer manager' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'INSTANCE_HOST_PAYLOAD_INVALID' });
    }
    await app.close();
  });

  it('returns a stable 404 when unlinking a relation that does not exist', async () => {
    const app = await buildApp();
    if (!app) return;

    const response = await app.inject({
      method: 'DELETE', url: '/api/database/instances/10/hosts/20',
      headers: { authorization: 'Bearer manager' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'INSTANCE_HOST_RELATION_NOT_FOUND' });
    await app.close();
  });
});

describe('instance-host public contract', () => {
  const exported = contracts as Record<string, any>;

  it('keeps strict payload schemas and documents actual authentication errors', () => {
    expect(Value.Check(exported.ReplaceInstanceHostsBodySchema, {
      hosts: [{ serverId: 20, role: 'primary' }],
    })).toBe(true);
    expect(Value.Check(exported.ReplaceInstanceHostsBodySchema, { hosts: [], unexpected: true })).toBe(false);

    const document = buildOpenApiDocument() as any;
    const relationshipPaths = [
      '/api/database/instances/{id}/host-evidence',
      '/api/database/instances/{id}/hosts',
      '/api/database/instances/{id}/hosts/{serverId}',
      '/api/servers/{id}/instances',
    ];
    for (const path of relationshipPaths) {
      for (const operation of Object.values(document.paths[path]) as any[]) {
        expect(operation.responses).toHaveProperty('401');
        expect(operation.responses).toHaveProperty('500');
      }
    }
    expect(document.paths['/api/database/instances/{id}/host-evidence'].get.responses).toHaveProperty('403');
    expect(buildClientTypes()).toContain('export interface InstanceHostMapping');
    expect(buildClientTypes()).toContain('export interface HostedInstance');
    expect(buildClientTypes()).toContain('export interface InstanceHostEvidenceResponse');
    expect(buildClientTypes()).toContain('systemLogs: EvidenceSection & { entries: JournalEvidence[] }');
  });

  it('keeps server deletion protection transactional', () => {
    const source = readFileSync(new URL('./server-database-service.ts', import.meta.url), 'utf8');
    const method = source.slice(source.indexOf('async deleteServer'), source.indexOf('async testConnection'));
    expect(method).toContain('beginTransaction()');
    expect(method).toMatch(/SELECT id FROM servers WHERE id = \? FOR UPDATE/);
    expect(method).toMatch(/relation_type = 'runs_on'.*valid_until IS NULL OR valid_until > NOW\(6\)/s);
    expect(method).not.toContain('valid_from <=');
    expect(method.indexOf('FOR UPDATE')).toBeLessThan(method.indexOf('DELETE FROM servers'));

    const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const deletionRoute = serverSource.slice(
      serverSource.indexOf("fastify.delete('/api/servers/:id'"),
      serverSource.indexOf("fastify.post('/api/servers/test-connection'"),
    );
    expect(deletionRoute).toContain("result.error === 'SERVER_HAS_INSTANCE_RELATIONS'");
    expect(deletionRoute).toContain('reply.code(409)');

    const testConnectionRoute = serverSource.slice(
      serverSource.indexOf("fastify.post('/api/servers/test-connection'"),
      serverSource.indexOf("fastify.post('/api/servers/:id/rotate-key'"),
    );
    expect(testConnectionRoute).not.toContain('if (!host_key_fingerprint)');
    expect(testConnectionRoute).toContain('host_key_fingerprint?: string');
  });
});
