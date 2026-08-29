import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { listAdapterCapabilities } from '../adapters/capability-matrix.js';
import { publicInstanceDto } from '../security/public-dto.js';
import {
  AdapterCapabilitiesResponseSchema,
  DatabaseInstanceSchema,
  DatabaseInstancesResponseSchema,
  HealthResponseSchema,
  HostedInstancesResponseSchema,
  InstanceHostEvidenceResponseSchema,
  InstanceHostsResponseSchema,
  OkResponseSchema,
  ReplaceInstanceHostsBodySchema,
  ReplaceInstanceHostsResponseSchema,
  ServerDiagnosticsSchema,
  CollectServerDiagnosticsResponseSchema,
  NetworkDeviceRelationInputSchema,
  NetworkDeviceTestConnectionRequestSchema,
  NetworkDeviceTestConnectionResponseSchema,
} from './public-api.js';
import { buildClientTypes, buildOpenApiDocument } from './generate-public-api.js';

describe('generated public API contract', () => {
  it('accepts actual health and adapter capability responses', () => {
    expect(Value.Check(HealthResponseSchema, { status: 'ok', timestamp: new Date().toISOString() })).toBe(true);
    expect(Value.Check(AdapterCapabilitiesResponseSchema, { adapters: listAdapterCapabilities() })).toBe(true);
  });

  it('accepts redacted instance DTOs and rejects missing credential metadata', () => {
    const dto = publicInstanceDto({
      id: 1, name: 'primary', db_type: 'mysql', host: '127.0.0.1', port: 3306,
      database_name: 'slide', health_status: 'healthy', health_score: 100, status: 'active',
      created_at: '2026-07-23T00:00:00.000Z', password_encrypted: 'ciphertext',
    });
    expect(Value.Check(DatabaseInstanceSchema, dto)).toBe(true);
    expect(Value.Check(DatabaseInstanceSchema, { ...dto, hasCredential: undefined })).toBe(false);
    expect(dto).not.toHaveProperty('password_encrypted');
  });

  it('generates deterministic documented operations and frontend types', () => {
    const document = buildOpenApiDocument() as any;
    expect(Object.keys(document.paths)).toEqual([
      '/api/adapters/capabilities',
      '/api/database/instances',
      '/api/database/instances/{id}/host-evidence',
      '/api/database/instances/{id}/hosts',
      '/api/database/instances/{id}/hosts/{serverId}',
      '/api/health',
      '/api/network-devices',
      '/api/network-devices/{id}',
      '/api/network-devices/{id}/capabilities',
      '/api/network-devices/{id}/config-backups',
      '/api/network-devices/{id}/config-backups/{backupId}',
      '/api/network-devices/{id}/config-backups/{backupId}/diff',
      '/api/network-devices/{id}/interfaces',
      '/api/network-devices/{id}/metrics',
      '/api/network-devices/{id}/probe',
      '/api/network-devices/{id}/relations',
      '/api/network-devices/test-connection',
      '/api/resources',
      '/api/resources/{type}/{id}/diagnose',
      '/api/resources/{type}/{id}/diagnose-agent',
      '/api/resources/{type}/{id}/observations',
      '/api/resources/overview',
      '/api/servers/{id}/collect-diagnostics',
      '/api/servers/{id}/diagnostics',
      '/api/servers/{id}/instances',
    ]);
    expect(buildClientTypes()).toContain('export interface DatabaseInstance');
    expect(buildClientTypes()).toContain('export interface InstanceHostEvidenceResponse');
    expect(buildClientTypes()).toContain('export interface FilesystemEvidence');
    expect(buildClientTypes()).toContain('export interface JournalEvidence');
    expect(buildClientTypes()).toContain('export interface PhysicalFileEvidence');
    expect(buildClientTypes()).toContain('export interface DiagnosticGap');
    expect(buildClientTypes()).toContain('export interface ServerDiagnostics');
    expect(buildClientTypes()).toContain('export interface CollectServerDiagnosticsResponse');
    expect(buildClientTypes()).toBe(buildClientTypes());
  });

  it('documents optional SSH host-key probing and the server-only relation boundary', () => {
    expect(Value.Check(NetworkDeviceTestConnectionRequestSchema, {
      host: '192.0.2.10', version: 3, snmpPort: 161, sshPort: 22,
      snmpv3: { username: 'monitor', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: '12345678', privacyProtocol: 'AES', privacySecret: '12345678' },
      ssh: { credentialType: 'password', username: 'readonly', credentialValue: 'secret', hostKeyFingerprint: `SHA256:${'A'.repeat(43)}` },
    })).toBe(true);
    expect(Value.Check(NetworkDeviceTestConnectionResponseSchema, { success: true, ssh: { verified: true } })).toBe(true);
    expect(Value.Check(NetworkDeviceRelationInputSchema, { target: { type: 'server', id: 3 }, relationType: 'connected_to' })).toBe(true);
    expect(Value.Check(NetworkDeviceRelationInputSchema, { target: { type: 'instance', id: 11 }, relationType: 'serves' })).toBe(false);
  });

  it('types complete host freshness, filesystems, journals, physical files, roles, and gaps', () => {
    const collectedAt = '2026-08-10T00:00:00.000Z';
    const response = {
      schemaVersion: 1,
      subject: { type: 'instance', id: 10 },
      collectedAt,
      database: {
        instance: { id: 10, name: 'orders', db_type: 'mysql' },
        realtimeMetrics: null,
        metricHistory: [], alerts: [], logs: [], slowQueries: [],
      },
      storage: [{ path: '/data/orders.db', kind: 'data-file', source: 'mysql', hostInspectable: true }],
      hosts: [{
        server: {
          serverId: 20, role: 'primary', host: 'db-a', port: 22, label: 'DB A', osType: 'RHEL 8',
          status: 'online', collectionEnabled: true, validFrom: collectedAt,
        },
        evidence: {
          schemaVersion: 1, serverId: 20, collectedAt, expiresAt: '2026-08-10T00:05:00.000Z',
          quality: 'partial', truncated: false,
          metrics: { source: ['procfs'], collectedAt, quality: 'good', values: { cpu: 12 } },
          filesystems: {
            source: ['df'], collectedAt, quality: 'good', items: [{
              mount: '/data', device: '/dev/mapper/data', fsType: 'xfs', sizeBytes: 1000,
              usedBytes: 750, availableBytes: 250, usagePercent: 75,
              inodeTotal: 100, inodeUsed: 20, inodeAvailable: 80, inodeUsagePercent: 20,
            }],
          },
          systemLogs: {
            source: ['journald'], collectedAt, quality: 'partial', reason: 'SYSTEM_LOG_SOURCE_PARTIAL',
            entries: [{ timestamp: collectedAt, severity: 'warning', unit: 'mysqld.service', identifier: 'mysqld', pid: '10', message: 'I/O warning' }],
          },
          physicalFiles: {
            source: ['stat'], collectedAt, quality: 'good', items: [{
              path: '/data/orders.db', quality: 'good', sizeBytes: 100,
            }],
          },
          gaps: [{ section: 'systemLogs', reason: 'SYSTEM_LOG_SOURCE_PARTIAL' }],
        },
      }],
      gaps: [{
        scope: 'host', section: 'hostEvidence', code: 'SSH_COMMAND_TIMEOUT',
        resource: { type: 'server', id: 20 },
      }],
    };

    expect(Value.Check(InstanceHostEvidenceResponseSchema, response)).toBe(true);
    const missingFreshness = structuredClone(response);
    delete (missingFreshness.hosts[0].evidence.systemLogs as any).collectedAt;
    expect(Value.Check(InstanceHostEvidenceResponseSchema, missingFreshness)).toBe(false);
  });

  it('compiles all response schemas in Fastify', async () => {
    const app = Fastify();
    app.get('/health', { schema: { response: { 200: HealthResponseSchema } } }, async () => ({ status: 'ok', timestamp: new Date().toISOString() }));
    app.get('/capabilities', { schema: { response: { 200: AdapterCapabilitiesResponseSchema } } }, async () => ({ adapters: listAdapterCapabilities() }));
    app.get('/instances', { schema: { response: { 200: DatabaseInstancesResponseSchema } } }, async () => []);
    app.get('/instance-hosts', { schema: { response: { 200: InstanceHostsResponseSchema } } }, async () => ({ hosts: [] }));
    app.get('/instance-host-evidence', { schema: { response: { 200: InstanceHostEvidenceResponseSchema } } }, async () => ({
      schemaVersion: 1,
      subject: { type: 'instance', id: 1 },
      collectedAt: new Date().toISOString(),
      database: { instance: null, realtimeMetrics: null, metricHistory: [], alerts: [], logs: [], slowQueries: [] },
      storage: [], hosts: [], gaps: [],
    }));
    app.put('/instance-hosts', { schema: { body: ReplaceInstanceHostsBodySchema, response: { 200: ReplaceInstanceHostsResponseSchema } } }, async () => ({ ok: true, hosts: [] }));
    app.delete('/instance-hosts', { schema: { response: { 200: OkResponseSchema } } }, async () => ({ ok: true }));
    app.get('/hosted-instances', { schema: { response: { 200: HostedInstancesResponseSchema } } }, async () => ({ instances: [] }));
    app.get('/server-diagnostics', { schema: { response: { 200: ServerDiagnosticsSchema } } }, async () => ({}));
    app.post('/server-diagnostics/collect', { schema: { response: { 200: CollectServerDiagnosticsResponseSchema } } }, async () => ({}));
    await expect(app.ready()).resolves.toBe(app);
    await app.close();
  });
});
