import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TSchema } from '@sinclair/typebox';
import { PublicApiSchemas } from './public-api.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const openApiPath = resolve(root, 'docs/slide/openapi.json');
const clientPath = resolve(root, 'frontend/src/api/generated/public-api.ts');

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function refSchema(schema: TSchema): Record<string, string> {
  return { $ref: `#/components/schemas/${schema.$id}` };
}

function pathId(name: 'id' | 'serverId' | 'backupId') {
  return { name, in: 'path', required: true, schema: { type: 'integer', minimum: 1 } };
}

export function buildOpenApiDocument() {
  return stable({
    openapi: '3.1.0',
    info: { title: 'Slide Public API', version: '0.9.0' },
    paths: {
      '/api/health': { get: { operationId: 'getHealth', responses: { '200': { description: 'Service health', content: { 'application/json': { schema: refSchema(PublicApiSchemas.HealthResponse) } } } } } },
      '/api/adapters/capabilities': { get: { operationId: 'getAdapterCapabilities', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Database adapter capabilities', content: { 'application/json': { schema: refSchema(PublicApiSchemas.AdapterCapabilitiesResponse) } } } } } },
      '/api/database/instances': { get: { operationId: 'listDatabaseInstances', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Redacted managed database instances', content: { 'application/json': { schema: refSchema(PublicApiSchemas.DatabaseInstancesResponse) } } } } } },
      '/api/network-devices': {
        get: { operationId: 'listNetworkDevices', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Redacted managed network devices', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDevicesResponse) } } } } },
        post: { operationId: 'createNetworkDevice', security: [{ bearerAuth: [] }], responses: { '201': { description: 'Network device created', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDevice) } } } } },
      },
      '/api/network-devices/test-connection': {
        post: {
          operationId: 'testNetworkDeviceConnection', security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceTestConnectionRequest) } } },
          responses: {
            '200': { description: 'Validated read-only SNMPv3 probe result', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceTestConnectionResponse) } } },
            '400': { description: 'Invalid or unsupported SNMPv3 payload', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '403': { description: 'Network-device manage permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '502': { description: 'Probe failed or target was denied', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
      '/api/network-devices/{id}': {
        get: { operationId: 'getNetworkDevice', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '200': { description: 'Redacted network device', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDevice) } } } } },
        put: { operationId: 'updateNetworkDevice', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '200': { description: 'Network device updated', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDevice) } } } } },
        delete: { operationId: 'deleteNetworkDevice', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '200': { description: 'Network device deleted', content: { 'application/json': { schema: refSchema(PublicApiSchemas.OkResponse) } } } } },
      },
      '/api/network-devices/{id}/probe': {
        post: {
          operationId: 'probeNetworkDevice', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
          responses: {
            '200': { description: 'Collected read-only device observations', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceProbeResponse) } } },
            '400': { description: 'Invalid resource identifier or collection request', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '403': { description: 'Network-device view permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '404': { description: 'Network device unavailable', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '502': { description: 'Collection failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
      '/api/network-devices/{id}/capabilities': {
        get: {
          operationId: 'getNetworkDeviceCapabilities', security: [{ bearerAuth: [] }], parameters: [pathId('id'), { name: 'key', in: 'query', required: false, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Capability state and bounded evidence', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceCapabilitiesResponse) } } },
            '400': { description: 'Invalid resource identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '403': { description: 'Network-device view permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '500': { description: 'Capability lookup failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
      '/api/network-devices/{id}/metrics': { get: { operationId: 'getNetworkDeviceMetrics', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '200': { description: 'Network device observations', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceMetricsResponse) } } } } } },
      '/api/network-devices/{id}/interfaces': { get: { operationId: 'listNetworkDeviceInterfaces', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '200': { description: 'Network device interfaces', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceInterfacesResponse) } } } } } },
      '/api/network-devices/{id}/config-backups': {
        get: { operationId: 'listNetworkDeviceConfigBackups', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '200': { description: 'Configuration backup summaries without raw content', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ConfigBackupSummariesResponse) } } } } },
        post: { operationId: 'captureNetworkDeviceConfigBackup', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '201': { description: 'New immutable configuration backup summary and redacted preview', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ConfigBackupDetail) } } }, '400': { description: 'Invalid backup request', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '403': { description: 'Network-device backup permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '502': { description: 'Backup collection failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } } } },
      },
      '/api/network-devices/{id}/config-backups/{backupId}': {
        get: { operationId: 'getNetworkDeviceConfigBackup', security: [{ bearerAuth: [] }], parameters: [pathId('id'), pathId('backupId'), { name: 'raw', in: 'query', required: false, schema: { type: 'boolean', default: false } }], responses: { '200': { description: 'Redacted backup detail by default; raw content only with backup permission', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ConfigBackupResponse) } } }, '400': { description: 'Invalid backup identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '403': { description: 'Raw backup permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '404': { description: 'Backup unavailable', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } } } },
      },
      '/api/network-devices/{id}/config-backups/{backupId}/diff': {
        get: { operationId: 'diffNetworkDeviceConfigBackups', security: [{ bearerAuth: [] }], parameters: [pathId('id'), pathId('backupId'), { name: 'from', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } }], responses: { '200': { description: 'Bounded redacted configuration diff', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ConfigBackupDiffResponse) } } }, '400': { description: 'Invalid diff identifiers', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '403': { description: 'Network-device view permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '404': { description: 'Backup unavailable', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } } } },
      },
      '/api/network-devices/{id}/relations': {
        get: { operationId: 'listNetworkDeviceRelations', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '200': { description: 'Visible active resource relations', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceRelationsResponse) } } }, '400': { description: 'Invalid resource identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '403': { description: 'Network-device view permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } } } },
        put: { operationId: 'replaceNetworkDeviceRelations', security: [{ bearerAuth: [] }], parameters: [pathId('id')], requestBody: { required: true, content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceRelationsRequest) } } }, responses: { '200': { description: 'Created active network-device relations', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceRelationsResponse) } } }, '400': { description: 'Invalid relation payload', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '403': { description: 'Network-device manage permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } } } },
      },
      '/api/database/instances/{id}/host-evidence': {
        get: {
          operationId: 'getInstanceHostEvidence', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
          responses: {
            '200': { description: 'Bounded and redacted database and Linux host evidence', content: { 'application/json': { schema: refSchema(PublicApiSchemas.InstanceHostEvidenceResponse) } } },
            '400': { description: 'Invalid resource identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '403': { description: 'Instance view permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '404': { description: 'Instance unavailable or unauthorized', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '500': { description: 'Evidence collection failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
      '/api/database/instances/{id}/hosts': {
        get: {
          operationId: 'listInstanceHosts', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
          responses: {
            '200': { description: 'Active Linux hosts related to the database instance', content: { 'application/json': { schema: refSchema(PublicApiSchemas.InstanceHostsResponse) } } },
            '400': { description: 'Invalid resource identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '404': { description: 'Instance unavailable or unauthorized', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '500': { description: 'Relationship operation failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
        put: {
          operationId: 'replaceInstanceHosts', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
          requestBody: { required: true, content: { 'application/json': { schema: refSchema(PublicApiSchemas.ReplaceInstanceHostsBody) } } },
          responses: {
            '200': { description: 'Atomically replaced and enriched active host mappings', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ReplaceInstanceHostsResponse) } } },
            '400': { description: 'Invalid mapping payload or missing target server', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '404': { description: 'Instance unavailable or unauthorized', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '500': { description: 'Relationship operation failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
      '/api/database/instances/{id}/hosts/{serverId}': {
        delete: {
          operationId: 'unlinkInstanceHost', security: [{ bearerAuth: [] }], parameters: [pathId('id'), pathId('serverId')],
          responses: {
            '200': { description: 'Expired active host mapping', content: { 'application/json': { schema: refSchema(PublicApiSchemas.OkResponse) } } },
            '400': { description: 'Invalid resource identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '404': { description: 'Mapping unavailable or unauthorized', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '500': { description: 'Relationship operation failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
      '/api/servers/{id}/instances': {
        get: {
          operationId: 'listServerInstances', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
          responses: {
            '200': { description: 'Database instances hosted by the server and visible to the actor', content: { 'application/json': { schema: refSchema(PublicApiSchemas.HostedInstancesResponse) } } },
            '400': { description: 'Invalid resource identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '404': { description: 'Server unavailable or unauthorized', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '500': { description: 'Relationship operation failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: PublicApiSchemas,
    },
  });
}

function buildLegacyClientTypes(): string {
  return `// Generated by pnpm contracts:generate. Do not edit.\n\nexport type DatabaseType = 'mysql' | 'postgresql' | 'oracle' | 'dameng' | 'mongodb' | 'redis' | 'elasticsearch';\nexport type CapabilityState = 'declared' | 'configured' | 'verified' | 'degraded' | 'unsupported';\nexport type AdapterCapabilityName = 'connect' | 'query' | 'explain' | 'metrics' | 'health' | 'alerts' | 'reports' | 'writeApproval';\nexport type InstanceHostRole = 'standalone' | 'primary' | 'replica' | 'shard' | 'arbiter' | 'unknown';\nexport type EvidenceQuality = 'good' | 'partial' | 'unknown' | 'unsupported';\nexport type HostEvidenceSection = 'metrics' | 'filesystems' | 'systemLogs' | 'physicalFiles';\nexport type DiagnosticGapScope = 'instance' | 'host' | 'storage';\nexport type DiagnosticGapSection = 'instance' | 'realtime' | 'history' | 'alerts' | 'logs' | 'slowQueries' | 'storage' | 'relations' | 'hostEvidence' | 'evidencePack';\n\nexport interface HealthResponse {\n  status: 'ok';\n  timestamp: string;\n}\n\nexport interface AdapterCapability {\n  dbType: DatabaseType;\n  driver: string | null;\n  state: CapabilityState;\n  creatable: boolean;\n  capabilities: Partial<Record<AdapterCapabilityName, CapabilityState>>;\n  reason?: string;\n}\n\nexport interface AdapterCapabilitiesResponse {\n  adapters: AdapterCapability[];\n}\n\nexport interface DatabaseInstance {\n  id: number;\n  name: string;\n  db_type: DatabaseType;\n  db_version?: string | null;\n  data_size_gb?: number | null;\n  host: string;\n  port: number;\n  database_name: string;\n  username?: string | null;\n  health_status: 'healthy' | 'warning' | 'critical' | 'unknown';\n  health_score: number;\n  status: string;\n  created_at: string;\n  environment?: string | null;\n  description?: string | null;\n  hasCredential: boolean;\n  credentialVersion: number;\n  [key: string]: unknown;\n}\n\nexport type DatabaseInstancesResponse = DatabaseInstance[];\n\nexport interface InstanceHostMapping {\n  serverId: number;\n  role: InstanceHostRole;\n  notes?: string | null;\n}\n\nexport interface InstanceHost extends InstanceHostMapping {\n  host: string;\n  port: number;\n  label: string | null;\n  osType: string;\n  status: string;\n  collectionEnabled: boolean;\n  validFrom: string;\n}\n\nexport interface HostedInstance extends InstanceHostMapping {\n  instanceId: number;\n  name: string;\n  dbType: DatabaseType;\n  environment: string;\n  status: string;\n  healthStatus: string;\n  validFrom: string;\n}\n\nexport interface ReplaceInstanceHostsRequest {\n  hosts: InstanceHostMapping[];\n}\n\nexport interface InstanceHostsResponse {\n  hosts: InstanceHost[];\n}\n\nexport interface ReplaceInstanceHostsResponse extends InstanceHostsResponse {\n  ok: true;\n}\n\nexport interface HostedInstancesResponse {\n  instances: HostedInstance[];\n}\n\nexport interface EvidenceSection {\n  source: string[];\n  collectedAt: string;\n  quality: EvidenceQuality;\n  reason?: string;\n}\n\nexport interface FilesystemEvidence {\n  mount: string;\n  device: string;\n  fsType: string | null;\n  sizeBytes: number;\n  usedBytes: number;\n  availableBytes: number;\n  usagePercent: number;\n  inodeTotal: number | null;\n  inodeUsed: number | null;\n  inodeAvailable: number | null;\n  inodeUsagePercent: number | null;\n}\n\nexport interface JournalEvidence {\n  timestamp: string | null;\n  severity: string;\n  unit: string | null;\n  identifier: string | null;\n  pid: string | null;\n  message: string;\n}\n\nexport interface PhysicalFileEvidence {\n  path: string;\n  quality: EvidenceQuality;\n  reason?: string;\n  type?: string;\n  sizeBytes?: number;\n  allocatedBytes?: number;\n  modifiedAt?: string;\n  mode?: string;\n  owner?: string;\n  group?: string;\n  filesystem?: FilesystemEvidence;\n}\n\nexport interface HostEvidenceGap {\n  section: HostEvidenceSection;\n  reason: string;\n}\n\nexport interface LinuxHostEvidence {\n  schemaVersion: 1;\n  serverId: number;\n  collectedAt: string;\n  expiresAt: string;\n  quality: EvidenceQuality;\n  truncated: boolean;\n  metrics: EvidenceSection & { values: Record<string, number> };\n  filesystems: EvidenceSection & { items: FilesystemEvidence[] };\n  systemLogs: EvidenceSection & { entries: JournalEvidence[] };\n  physicalFiles: EvidenceSection & { items: PhysicalFileEvidence[] };\n  gaps: HostEvidenceGap[];\n}\n\nexport interface StorageDescriptor {\n  path: string;\n  kind: string;\n  source: string;\n  hostInspectable: boolean;\n  tablespace?: string;\n  objectName?: string;\n  logicalBytes?: number;\n}\n\nexport interface DiagnosticGap {\n  scope: DiagnosticGapScope;\n  section?: DiagnosticGapSection;\n  code: string;\n  resource?: { type: 'instance' | 'server'; id: number };\n  source?: string;\n}\n\nexport interface InstanceHostEvidenceResponse {\n  schemaVersion: 1;\n  subject: { type: 'instance'; id: number };\n  collectedAt: string;\n  database: {\n    instance: Record<string, unknown> | null;\n    realtimeMetrics: Record<string, unknown> | null;\n    metricHistory: Array<Record<string, unknown>>;\n    alerts: Array<Record<string, unknown>>;\n    logs: Array<Record<string, unknown>>;\n    slowQueries: Array<Record<string, unknown>>;\n  };\n  storage: StorageDescriptor[];\n  hosts: Array<{ server: InstanceHost; evidence: LinuxHostEvidence | null }>;\n  gaps: DiagnosticGap[];\n}\n`;
}

const NETWORK_CLIENT_TYPES = `export type NetworkDeviceStatus = 'unknown' | 'online' | 'offline' | 'error' | 'unreachable';
export interface NetworkDevice { id: number; name: string; label: string | null; host: string; site: string | null; vendor: 'huawei'; model: string | null; os_version: string | null; serial_number: string | null; snmp_port: number; ssh_port: number; status: NetworkDeviceStatus; last_check_at: string | null; collection_enabled: boolean; created_at: string; updated_at: string; hasSnmpCredential: boolean; hasSshCredential: boolean; }
export type NetworkDevicesResponse = NetworkDevice[];
export type NetworkDeviceSnmpSecurityLevel = 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
export interface NetworkDeviceSnmpCredential { username: string; securityLevel: NetworkDeviceSnmpSecurityLevel; authProtocol?: 'MD5' | 'SHA' | 'SHA-256' | 'SHA-512'; authSecret?: string; privacyProtocol?: 'DES' | 'AES' | 'AES-128' | 'AES-192' | 'AES-256'; privacySecret?: string; }
export interface NetworkDeviceTestConnectionRequest { host: string; version?: 3; snmpPort?: number; snmp_port?: number; snmpv3?: NetworkDeviceSnmpCredential; snmp?: NetworkDeviceSnmpCredential; vendor?: 'huawei'; }
export interface NetworkDeviceProbeResult { reachable: boolean; quality: string; reason?: string | null; observedAt: string; sysName?: string | null; uptimeSeconds?: number; }
export interface NetworkDeviceTestConnectionResponse { success: boolean; probe?: NetworkDeviceProbeResult; error?: string; }
export interface NetworkDeviceProbeResponse { success: boolean; observations?: number; interfaces?: number; error?: string; }
export interface NetworkDeviceMetric { metricId: string; value: number | null; observedAt: string | null; quality: string; source: string; dimensions?: Record<string, string> | null; }
export interface NetworkDeviceMetricsResponse { deviceId: number; metrics: NetworkDeviceMetric[]; }
export interface NetworkDeviceInterface { id: number; deviceId: number; ifIndex: number; ifName: string; ifAlias: string | null; speedBps: number | null; adminStatus: string; operStatus: string; lastSeenAt: string | null; }
export interface NetworkDeviceInterfacesResponse { interfaces: NetworkDeviceInterface[]; }
export interface NetworkDeviceCapability { key: string; state: CapabilityState; evidence: Record<string, unknown> | null; reason: string | null; checkedAt: string | null; validUntil: string | null; }
export interface NetworkDeviceCapabilitiesResponse { deviceId: number; capabilities: NetworkDeviceCapability[]; }
export interface ConfigBackupSummary { id: number; deviceId: number; versionNo: number; contentSha256: string; sourceProtocol: 'ssh' | 'netconf'; collectedAt: string; sizeBytes: number; redactionStatus: 'redacted' | 'unredacted' | 'failed'; }
export interface ConfigBackupDetail extends ConfigBackupSummary { preview: string; }
export interface ConfigBackupRaw extends ConfigBackupSummary { content: string; }
export type ConfigBackupResponse = ConfigBackupDetail | ConfigBackupRaw;
export interface ConfigBackupDiffResponse { fromId: number; toId: number; diff: string; }
export interface ConfigBackupSummariesResponse { backups: ConfigBackupSummary[]; }
export type NetworkResourceType = 'instance' | 'server' | 'network_device';
export interface NetworkResourceRef { type: NetworkResourceType; id: number; }
export type NetworkDeviceRelationType = 'runs_on' | 'hosts' | 'replicates_to' | 'depends_on' | 'connected_to' | 'serves';
export interface NetworkDeviceRelation { source: NetworkResourceRef; target: NetworkResourceRef; relationType: NetworkDeviceRelationType; provenance: string; metadata: Record<string, unknown> | null; validFrom: string; validUntil: string | null; }
export interface NetworkDeviceRelationInput { target: { type: 'server' | 'network_device'; id: number }; relationType: 'connected_to' | 'serves'; provenance?: string; metadata?: Record<string, unknown> | null; validFrom?: string; validUntil?: string | null; }
export interface NetworkDeviceRelationsRequest { relations: NetworkDeviceRelationInput[]; }
export interface NetworkDeviceRelationsResponse { relations: NetworkDeviceRelation[]; }

`;

export function buildClientTypes(): string {
  return buildLegacyClientTypes()
    .replace('export interface HealthResponse {', `${NETWORK_CLIENT_TYPES}export interface HealthResponse {`)
    .replace("type: 'instance' | 'server'", "type: 'instance' | 'server' | 'network_device'");
}

export async function generatePublicApi(): Promise<void> {
  await Promise.all([mkdir(dirname(openApiPath), { recursive: true }), mkdir(dirname(clientPath), { recursive: true })]);
  await Promise.all([
    writeFile(openApiPath, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`),
    writeFile(clientPath, buildClientTypes()),
  ]);
}

export async function checkPublicApi(): Promise<boolean> {
  const expectedOpenApi = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
  const expectedClient = buildClientTypes();
  const [actualOpenApi, actualClient] = await Promise.all([readFile(openApiPath, 'utf8'), readFile(clientPath, 'utf8')]);
  return actualOpenApi === expectedOpenApi && actualClient === expectedClient;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  if (check) {
    const current = await checkPublicApi().catch(() => false);
    if (!current) {
      console.error('Generated API contracts are stale. Run pnpm contracts:generate.');
      process.exitCode = 1;
    }
  } else {
    await generatePublicApi();
  }
}
