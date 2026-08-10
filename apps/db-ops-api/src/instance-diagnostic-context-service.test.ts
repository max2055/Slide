import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from './auth/actor-context.js';
import {
  InstanceDiagnosticContextService,
  SafeInstanceMetadataProvider,
  instanceDiagnosticContextService,
  type DiagnosticContextDependencies,
} from './instance-diagnostic-context-service.js';

const actor: ActorContext = Object.freeze({
  userId: 3,
  username: 'dba',
  roles: Object.freeze(['dba']),
  permissions: Object.freeze(['instance:view', 'servers:view', 'metric:view', 'alert:view', 'log:view']),
  sessionVersion: 1,
  instanceScopes: Object.freeze({ 7: 'read-only' }),
  requestId: 'diagnostic-context-test',
});

function dependencies(overrides: Partial<DiagnosticContextDependencies> = {}): DiagnosticContextDependencies {
  return {
    getInstance: async () => ({ id: 7, name: 'orders', db_type: 'mysql', environment: 'production', health_status: 'warning' }),
    getRealtimeMetrics: async () => ({ qps: 120, connections: 40, recorded_at: new Date('2026-08-10T00:00:00Z') }),
    getMetricHistory: async () => [{ qps: 100, recorded_at: new Date('2026-08-09T23:55:00Z') }],
    getAlerts: async () => ({ items: [{ id: 31, level: 'warning', title: 'Connections high' }] }),
    getLogs: async () => ({ logs: [{ id: 41, log_level: 'error', message: 'Too many connections' }] }),
    getSlowQueries: async () => [{ id: 51, avg_time_ms: 900 }],
    listHosts: async () => [{
      serverId: 20, role: 'primary', host: 'db-a', port: 22, label: 'DB A', osType: 'RHEL 8',
      status: 'online', collectionEnabled: true, validFrom: new Date('2026-08-01T00:00:00Z'),
    }],
    discoverStorage: async () => ({
      descriptors: [{
        path: '/var/lib/mysql/ibdata1', kind: 'data-file', source: 'mysql:information_schema',
        hostInspectable: true,
      }],
      gaps: [],
    }),
    collectHostEvidence: async (_serverId, request) => ({
      collectedAt: '2026-08-10T00:00:00.000Z', quality: 'good',
      filesystems: [{ mount: '/var/lib/mysql', usedPercent: 88 }],
      logs: [{ source: 'journal:mysql', message: 'I/O warning' }],
      physicalFiles: request.paths.map((path) => ({ path, exists: true, sizeBytes: 1024, mount: '/var/lib/mysql' })),
    }),
    ...overrides,
  };
}

describe('InstanceDiagnosticContextService', () => {
  it('rejects missing instance scope before calling any evidence dependency', async () => {
    const base = dependencies();
    const guarded = Object.fromEntries(Object.entries(base).map(([name, dependency]) => [
      name,
      vi.fn(dependency),
    ])) as unknown as DiagnosticContextDependencies;
    const service = new InstanceDiagnosticContextService(guarded);
    const unauthorized = { ...actor, instanceScopes: Object.freeze({}) };

    await expect(service.collect(unauthorized, 7)).rejects.toThrow('RESOURCE_FORBIDDEN');
    for (const dependency of Object.values(guarded)) {
      expect(dependency).not.toHaveBeenCalled();
    }
  });

  it('requires instance:view before calling any evidence dependency', async () => {
    const base = dependencies();
    const guarded = Object.fromEntries(Object.entries(base).map(([name, dependency]) => [
      name,
      vi.fn(dependency),
    ])) as unknown as DiagnosticContextDependencies;
    const service = new InstanceDiagnosticContextService(guarded);
    const unauthorized = {
      ...actor,
      permissions: Object.freeze(['servers:view', 'metric:view', 'alert:view', 'log:view']),
    };

    await expect(service.collect(unauthorized, 7)).rejects.toThrow('RESOURCE_FORBIDDEN');
    for (const dependency of Object.values(guarded)) {
      expect(dependency).not.toHaveBeenCalled();
    }
  });

  it('aggregates database evidence and every related host into one bounded pack', async () => {
    const service = new InstanceDiagnosticContextService(dependencies());
    const result = await service.collect(actor, 7, new Date('2026-08-10T00:00:00Z'));

    expect(result.subject).toEqual({ type: 'instance', id: 7 });
    expect(result.database).toMatchObject({
      instance: { name: 'orders', db_type: 'mysql' },
      realtimeMetrics: { qps: 120 },
    });
    expect(result.database.metricHistory).toHaveLength(1);
    expect(result.database.alerts).toHaveLength(1);
    expect(result.database.logs).toHaveLength(1);
    expect(result.database.slowQueries).toHaveLength(1);
    expect(result.hosts).toEqual([
      expect.objectContaining({
        server: expect.objectContaining({ serverId: 20, role: 'primary' }),
        evidence: expect.objectContaining({ quality: 'good' }),
      }),
    ]);
    expect(result.storage).toEqual([{
      path: '/var/lib/mysql/ibdata1', kind: 'data-file', source: 'mysql:information_schema',
      hostInspectable: true,
    }]);
    expect(result.gaps).toEqual([]);
  });

  it('records an explicit gap instead of leaking host data when server access is denied', async () => {
    const collectHostEvidence = vi.fn(async () => ({ quality: 'good' }));
    const service = new InstanceDiagnosticContextService(dependencies({
      listHosts: async () => { throw new Error('RESOURCE_FORBIDDEN'); },
      collectHostEvidence,
    }));

    const result = await service.collect(actor, 7);

    expect(result.hosts).toEqual([]);
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: 'HOST_EVIDENCE_FORBIDDEN' }));
    expect(collectHostEvidence).not.toHaveBeenCalled();
  });

  it('records missing relations and per-host failures without discarding database evidence', async () => {
    const noHosts = new InstanceDiagnosticContextService(dependencies({ listHosts: async () => [] }));
    await expect(noHosts.collect(actor, 7)).resolves.toMatchObject({
      database: { realtimeMetrics: { qps: 120 } },
      gaps: [expect.objectContaining({ code: 'HOST_RELATION_MISSING' })],
    });

    const failedHost = new InstanceDiagnosticContextService(dependencies({
      collectHostEvidence: async () => { throw new Error('SSH_COMMAND_TIMEOUT'); },
    }));
    const result = await failedHost.collect(actor, 7);
    expect(result.hosts[0]).toMatchObject({ evidence: null });
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: 'SSH_COMMAND_TIMEOUT', resource: { type: 'server', id: 20 } }));
  });

  it('pushes every evidence limit into the real dependency boundary and unwraps service results', async () => {
    const getMetricHistory = vi.fn(async () => [{ qps: 101 }]);
    const getAlerts = vi.fn(async () => ({ items: [{ id: 32 }] }));
    const getLogs = vi.fn(async () => ({ logs: [{ id: 42, message: 'bounded' }] }));
    const getSlowQueries = vi.fn(async () => [{ id: 52 }]);
    const discoverStorage = vi.fn(async () => ({
      descriptors: [{ path: '/data/orders.db', kind: 'data-file', source: 'database', hostInspectable: true }],
      gaps: [{ code: 'STORAGE_DISCOVERY_LIMIT_REACHED', source: 'database' }],
    }));
    const service = new InstanceDiagnosticContextService(dependencies({
      getMetricHistory, getAlerts, getLogs, getSlowQueries, discoverStorage,
    } as unknown as Partial<DiagnosticContextDependencies>));
    const now = new Date('2026-08-10T00:00:00.000Z');
    const start = new Date('2026-08-09T00:00:00.000Z');

    const result = await service.collect(actor, 7, now);

    expect(getMetricHistory).toHaveBeenCalledWith(7, start, now, 288);
    expect(getAlerts).toHaveBeenCalledWith(7, 50);
    expect(getLogs).toHaveBeenCalledWith(7, start, now, 50);
    expect(getSlowQueries).toHaveBeenCalledWith(7, 20);
    expect(result.database.alerts).toEqual([{ id: 32 }]);
    expect(result.database.logs).toEqual([{ id: 42, message: 'bounded' }]);
    expect(result.storage).toHaveLength(1);
    expect(result.gaps).toContainEqual(expect.objectContaining({
      scope: 'storage', code: 'STORAGE_DISCOVERY_LIMIT_REACHED', source: 'database',
    }));
  });

  it('omits unauthorized database sections without calling their dependencies', async () => {
    const getRealtimeMetrics = vi.fn(async () => ({ qps: 120 }));
    const getMetricHistory = vi.fn(async () => [{ qps: 101 }]);
    const getAlerts = vi.fn(async () => ({ items: [{ id: 32 }] }));
    const getLogs = vi.fn(async () => ({ logs: [{ id: 42 }] }));
    const getSlowQueries = vi.fn(async () => [{ id: 52 }]);
    const service = new InstanceDiagnosticContextService(dependencies({
      getRealtimeMetrics,
      getMetricHistory,
      getAlerts,
      getLogs,
      getSlowQueries,
    }));
    const instanceOnlyActor = {
      ...actor,
      permissions: Object.freeze(['instance:view', 'servers:view']),
    };

    const result = await service.collect(instanceOnlyActor, 7);

    expect(getRealtimeMetrics).not.toHaveBeenCalled();
    expect(getMetricHistory).not.toHaveBeenCalled();
    expect(getAlerts).not.toHaveBeenCalled();
    expect(getLogs).not.toHaveBeenCalled();
    expect(getSlowQueries).not.toHaveBeenCalled();
    expect(result.database).toMatchObject({
      instance: { id: 7 },
      realtimeMetrics: null,
      metricHistory: [],
      alerts: [],
      logs: [],
      slowQueries: [],
    });
    expect(result.storage).toHaveLength(1);
    expect(result.hosts).toHaveLength(1);
    expect(result.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: 'realtime', code: 'METRIC_EVIDENCE_FORBIDDEN' }),
      expect.objectContaining({ section: 'history', code: 'METRIC_EVIDENCE_FORBIDDEN' }),
      expect.objectContaining({ section: 'slowQueries', code: 'METRIC_EVIDENCE_FORBIDDEN' }),
      expect.objectContaining({ section: 'alerts', code: 'ALERT_EVIDENCE_FORBIDDEN' }),
      expect.objectContaining({ section: 'logs', code: 'LOG_EVIDENCE_FORBIDDEN' }),
    ]));
  });

  it('records an explicit gap when realtime metrics are absent', async () => {
    const service = new InstanceDiagnosticContextService(dependencies({
      getRealtimeMetrics: async () => null,
    }));

    const result = await service.collect(actor, 7);

    expect(result.database.realtimeMetrics).toBeNull();
    expect(result.gaps).toContainEqual(expect.objectContaining({
      section: 'realtime', code: 'REALTIME_METRICS_UNAVAILABLE',
    }));
  });

  it.each([
    ['metadata', { getInstance: async () => { throw new Error('INSTANCE_METADATA_UNAVAILABLE'); } }, 'INSTANCE_METADATA_UNAVAILABLE', (result: any) => result.database.instance, null],
    ['realtime', { getRealtimeMetrics: async () => { throw new Error('METRICS_BACKEND_DOWN'); } }, 'METRICS_BACKEND_DOWN', (result: any) => result.database.realtimeMetrics, null],
    ['history', { getMetricHistory: async () => { throw new Error('HISTORY_QUERY_FAILED'); } }, 'HISTORY_QUERY_FAILED', (result: any) => result.database.metricHistory, []],
    ['alerts', { getAlerts: async () => { throw new Error('ALERT_QUERY_FAILED'); } }, 'ALERT_QUERY_FAILED', (result: any) => result.database.alerts, []],
    ['logs', { getLogs: async () => { throw new Error('LOG_QUERY_FAILED'); } }, 'LOG_QUERY_FAILED', (result: any) => result.database.logs, []],
    ['slowQueries', { getSlowQueries: async () => { throw new Error('SLOW_QUERY_FAILED'); } }, 'SLOW_QUERY_FAILED', (result: any) => result.database.slowQueries, []],
    ['storage', { discoverStorage: async () => { throw new Error('STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE'); } }, 'STORAGE_DISCOVERY_CONNECTION_UNAVAILABLE', (result: any) => result.storage, []],
  ])('degrades the %s section without discarding other evidence', async (_section, overrides, code, select, fallback) => {
    const service = new InstanceDiagnosticContextService(dependencies(
      overrides as unknown as Partial<DiagnosticContextDependencies>,
    ));

    const result = await service.collect(actor, 7);

    expect(select(result)).toEqual(fallback);
    expect(result.database.alerts).toEqual(_section === 'alerts' ? [] : [expect.objectContaining({ id: 31 })]);
    expect(result.gaps).toContainEqual(expect.objectContaining({ code }));
  });

  it('caps related hosts at 32 and collects with at most four concurrent SSH operations', async () => {
    const hosts = Array.from({ length: 40 }, (_, index) => ({
      serverId: index + 1,
      role: 'primary' as const,
      host: `db-${index + 1}`,
      port: 22,
      label: null,
      osType: 'RHEL 8',
      status: 'online',
      collectionEnabled: true,
      validFrom: new Date('2026-08-01T00:00:00.000Z'),
    }));
    let active = 0;
    let maxActive = 0;
    const collectHostEvidence = vi.fn(async (serverId: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return { serverId, collectedAt: '2026-08-10T00:00:00.000Z', quality: 'good' };
    });
    const service = new InstanceDiagnosticContextService(dependencies({
      listHosts: async () => hosts,
      collectHostEvidence,
    }));

    const result = await service.collect(actor, 7);

    expect(result.hosts).toHaveLength(32);
    expect(collectHostEvidence).toHaveBeenCalledTimes(32);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: 'HOST_EVIDENCE_LIMIT_REACHED' }));
  });

  it('only sends inspectable physical paths to primary and standalone hosts', async () => {
    const roles = ['primary', 'standalone', 'replica', 'shard', 'arbiter', 'unknown'] as const;
    const requests = new Map<number, string[]>();
    const service = new InstanceDiagnosticContextService(dependencies({
      listHosts: async () => roles.map((role, index) => ({
        serverId: index + 20,
        role,
        host: `db-${role}`,
        port: 22,
        label: null,
        osType: 'RHEL 8',
        status: 'online',
        collectionEnabled: true,
        validFrom: new Date('2026-08-01T00:00:00.000Z'),
      })),
      discoverStorage: async () => ({
        descriptors: [
          { path: '/data/orders.db', kind: 'data-file', source: 'database', hostInspectable: true },
          { path: '+DATA/ORDERS/DATAFILE/system.dbf', kind: 'data-file', source: 'database', hostInspectable: false },
        ],
        gaps: [],
      }),
      collectHostEvidence: async (serverId, request) => {
        requests.set(serverId, request.paths);
        return { collectedAt: '2026-08-10T00:00:00.000Z', quality: 'good' };
      },
    }));

    const result = await service.collect(actor, 7);

    expect(requests.get(20)).toEqual(['/data/orders.db']);
    expect(requests.get(21)).toEqual(['/data/orders.db']);
    for (const serverId of [22, 23, 24, 25]) expect(requests.get(serverId)).toEqual([]);
    expect(result.gaps.filter((gap) => gap.code === 'PHYSICAL_PATH_ROLE_UNCERTAIN')).toEqual(
      [22, 23, 24, 25].map((serverId) => expect.objectContaining({ resource: { type: 'server', id: serverId } })),
    );
  });

  it('recursively redacts credentials and common secret formats from the entire evidence pack', async () => {
    const service = new InstanceDiagnosticContextService(dependencies({
      getInstance: async () => ({
        id: 7,
        name: 'orders',
        db_type: 'mysql',
        password: 'hunter2',
        connection_string: 'postgresql://dba:uri-password@db/orders',
        description: 'token=plain-token',
      }),
      getRealtimeMetrics: async () => ({ nested: { authorization: 'Bearer bearer-secret' } }),
      getAlerts: async () => ({ items: [{ message: 'api_key=sk-ant-api-secret-value' }] }),
      getLogs: async () => ({ logs: [{ raw_content: 'aws key AKIAIOSFODNN7EXAMPLE' }] }),
      collectHostEvidence: async () => ({
        collectedAt: '2026-08-10T00:00:00.000Z',
        quality: 'partial',
        nested: [
          { credential: 'host-secret' },
          { message: 'mysql://root:host-password@db/orders' },
          { dynamic: { 'token=key-secret': 'must-redact-key' } },
        ],
      }),
    }));

    const serialized = JSON.stringify(await service.collect(actor, 7));

    for (const secret of [
      'hunter2', 'uri-password', 'plain-token', 'bearer-secret', 'sk-ant-api-secret-value',
      'AKIAIOSFODNN7EXAMPLE', 'host-secret', 'host-password', 'key-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('[REDACTED]');
  });

  it('deterministically truncates the serialized UTF-8 pack while preserving freshness and quality metadata', async () => {
    const collectedAt = '2026-08-10T00:00:00.000Z';
    const oversized = dependencies({
      getLogs: async () => ({
        logs: Array.from({ length: 50 }, (_, id) => ({ id, message: `数据库错误-${'x'.repeat(800)}` })),
      }),
      collectHostEvidence: async (serverId) => ({
        schemaVersion: 1,
        serverId,
        collectedAt,
        expiresAt: '2026-08-10T00:05:00.000Z',
        quality: 'partial',
        truncated: false,
        metrics: { source: ['procfs'], collectedAt, quality: 'good', values: { cpu: 10 } },
        filesystems: {
          source: ['df'], collectedAt, quality: 'good',
          items: Array.from({ length: 20 }, (_, id) => ({ mount: `/data/${id}`, detail: 'x'.repeat(500) })),
        },
        systemLogs: {
          source: ['journald'], collectedAt, quality: 'partial', reason: 'SYSTEM_LOG_SOURCE_PARTIAL',
          entries: Array.from({ length: 50 }, (_, id) => ({ id, message: 'y'.repeat(500) })),
        },
        physicalFiles: {
          source: ['stat'], collectedAt, quality: 'good',
          items: Array.from({ length: 20 }, (_, id) => ({ path: `/data/file-${id}`, detail: 'z'.repeat(500) })),
        },
        gaps: [{ section: 'systemLogs', reason: 'SYSTEM_LOG_SOURCE_PARTIAL' }],
      }),
    });
    const service = new InstanceDiagnosticContextService(oversized, { maxBytes: 4096 });
    const now = new Date(collectedAt);

    const first = await service.collect(actor, 7, now);
    const second = await service.collect(actor, 7, now);
    const serialized = JSON.stringify(first);

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(second)).toBe(serialized);
    expect(first.collectedAt).toBe(collectedAt);
    expect(first.gaps).toContainEqual(expect.objectContaining({ code: 'EVIDENCE_PACK_TRUNCATED' }));
    expect(first.hosts[0].evidence).toMatchObject({
      collectedAt,
      quality: 'partial',
      systemLogs: { source: ['journald'], collectedAt, quality: 'partial', reason: 'SYSTEM_LOG_SOURCE_PARTIAL' },
    });
  });

  it('rejects a missing instance before collecting secondary evidence', async () => {
    const service = new InstanceDiagnosticContextService(dependencies({ getInstance: async () => null }));
    const scopedActor = { ...actor, instanceScopes: Object.freeze({ 404: 'read-only' as const }) };
    await expect(service.collect(scopedActor, 404)).rejects.toThrow('INSTANCE_NOT_FOUND');
  });
});

describe('SafeInstanceMetadataProvider', () => {
  it('uses a fixed parameterized public-field query and projects away credential columns', async () => {
    const execute = vi.fn(async (_sql: string, _values: unknown[]): Promise<[Array<Record<string, unknown>>, unknown[]]> => [[{
      id: 7,
      name: 'orders',
      db_type: 'mysql',
      environment: 'production',
      health_status: 'warning',
      password: 'plaintext-secret',
      password_encrypted: 'ciphertext',
      connection_string: 'mysql://operator:secret@db/orders',
    }], []]);
    const provider = new SafeInstanceMetadataProvider(() => ({ execute }));

    const metadata = await provider.getInstance(7);

    const [sql, values] = execute.mock.calls[0];
    expect(sql).toContain('FROM database_instances');
    expect(sql).toContain('WHERE id = ?');
    expect(sql).toContain('LIMIT 1');
    expect(sql).not.toMatch(/password|connection_string|private_key|secret/i);
    expect(values).toEqual([7]);
    expect(metadata).toMatchObject({ id: 7, name: 'orders', db_type: 'mysql' });
    expect(metadata).not.toHaveProperty('password');
    expect(metadata).not.toHaveProperty('password_encrypted');
    expect(metadata).not.toHaveProperty('connection_string');
  });

  it('exports a reusable production diagnostic context singleton', () => {
    expect(instanceDiagnosticContextService).toBeInstanceOf(InstanceDiagnosticContextService);
  });
});
