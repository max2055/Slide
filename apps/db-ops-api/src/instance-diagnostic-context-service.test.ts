import { describe, expect, it } from 'vitest';
import type { ActorContext } from './auth/actor-context.js';
import {
  InstanceDiagnosticContextService,
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
    getAlerts: async () => [{ id: 31, level: 'warning', title: 'Connections high' }],
    getLogs: async () => [{ id: 41, log_level: 'error', message: 'Too many connections' }],
    getSlowQueries: async () => [{ id: 51, avg_time_ms: 900 }],
    listHosts: async () => [{
      serverId: 20, role: 'primary', host: 'db-a', port: 22, label: 'DB A', osType: 'RHEL 8',
      status: 'online', collectionEnabled: true, validFrom: new Date('2026-08-01T00:00:00Z'),
    }],
    discoverStorage: async () => [{ path: '/var/lib/mysql/ibdata1', kind: 'data', source: 'mysql:information_schema' }],
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
    expect(result.storage).toEqual([{ path: '/var/lib/mysql/ibdata1', kind: 'data', source: 'mysql:information_schema' }]);
    expect(result.gaps).toEqual([]);
  });

  it('records an explicit gap instead of leaking host data when server access is denied', async () => {
    const service = new InstanceDiagnosticContextService(dependencies({
      listHosts: async () => { throw new Error('RESOURCE_FORBIDDEN'); },
    }));

    const result = await service.collect(actor, 7);

    expect(result.hosts).toEqual([]);
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: 'HOST_EVIDENCE_FORBIDDEN' }));
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
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: 'HOST_EVIDENCE_FAILED', resource: { type: 'server', id: 20 } }));
  });

  it('rejects a missing instance before collecting secondary evidence', async () => {
    const service = new InstanceDiagnosticContextService(dependencies({ getInstance: async () => null }));
    await expect(service.collect(actor, 404)).rejects.toThrow('INSTANCE_NOT_FOUND');
  });
});
