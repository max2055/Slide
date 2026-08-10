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

function pathId(name: 'id' | 'serverId') {
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

export function buildClientTypes(): string {
  return `// Generated by pnpm contracts:generate. Do not edit.\n\nexport type DatabaseType = 'mysql' | 'postgresql' | 'oracle' | 'dameng' | 'mongodb' | 'redis' | 'elasticsearch';\nexport type CapabilityState = 'declared' | 'configured' | 'verified' | 'degraded' | 'unsupported';\nexport type AdapterCapabilityName = 'connect' | 'query' | 'explain' | 'metrics' | 'health' | 'alerts' | 'reports' | 'writeApproval';\nexport type InstanceHostRole = 'standalone' | 'primary' | 'replica' | 'shard' | 'arbiter' | 'unknown';\nexport type EvidenceQuality = 'good' | 'partial' | 'unknown' | 'unsupported';\nexport type HostEvidenceSection = 'metrics' | 'filesystems' | 'systemLogs' | 'physicalFiles';\nexport type DiagnosticGapScope = 'instance' | 'host' | 'storage';\nexport type DiagnosticGapSection = 'instance' | 'realtime' | 'history' | 'alerts' | 'logs' | 'slowQueries' | 'storage' | 'relations' | 'hostEvidence' | 'evidencePack';\n\nexport interface HealthResponse {\n  status: 'ok';\n  timestamp: string;\n}\n\nexport interface AdapterCapability {\n  dbType: DatabaseType;\n  driver: string | null;\n  state: CapabilityState;\n  creatable: boolean;\n  capabilities: Partial<Record<AdapterCapabilityName, CapabilityState>>;\n  reason?: string;\n}\n\nexport interface AdapterCapabilitiesResponse {\n  adapters: AdapterCapability[];\n}\n\nexport interface DatabaseInstance {\n  id: number;\n  name: string;\n  db_type: DatabaseType;\n  db_version?: string | null;\n  data_size_gb?: number | null;\n  host: string;\n  port: number;\n  database_name: string;\n  username?: string | null;\n  health_status: 'healthy' | 'warning' | 'critical' | 'unknown';\n  health_score: number;\n  status: string;\n  created_at: string;\n  environment?: string | null;\n  description?: string | null;\n  hasCredential: boolean;\n  credentialVersion: number;\n  [key: string]: unknown;\n}\n\nexport type DatabaseInstancesResponse = DatabaseInstance[];\n\nexport interface InstanceHostMapping {\n  serverId: number;\n  role: InstanceHostRole;\n  notes?: string | null;\n}\n\nexport interface InstanceHost extends InstanceHostMapping {\n  host: string;\n  port: number;\n  label: string | null;\n  osType: string;\n  status: string;\n  collectionEnabled: boolean;\n  validFrom: string;\n}\n\nexport interface HostedInstance extends InstanceHostMapping {\n  instanceId: number;\n  name: string;\n  dbType: DatabaseType;\n  environment: string;\n  status: string;\n  healthStatus: string;\n  validFrom: string;\n}\n\nexport interface ReplaceInstanceHostsRequest {\n  hosts: InstanceHostMapping[];\n}\n\nexport interface InstanceHostsResponse {\n  hosts: InstanceHost[];\n}\n\nexport interface ReplaceInstanceHostsResponse extends InstanceHostsResponse {\n  ok: true;\n}\n\nexport interface HostedInstancesResponse {\n  instances: HostedInstance[];\n}\n\nexport interface EvidenceSection {\n  source: string[];\n  collectedAt: string;\n  quality: EvidenceQuality;\n  reason?: string;\n}\n\nexport interface FilesystemEvidence {\n  mount: string;\n  device: string;\n  fsType: string | null;\n  sizeBytes: number;\n  usedBytes: number;\n  availableBytes: number;\n  usagePercent: number;\n  inodeTotal: number | null;\n  inodeUsed: number | null;\n  inodeAvailable: number | null;\n  inodeUsagePercent: number | null;\n}\n\nexport interface JournalEvidence {\n  timestamp: string | null;\n  severity: string;\n  unit: string | null;\n  identifier: string | null;\n  pid: string | null;\n  message: string;\n}\n\nexport interface PhysicalFileEvidence {\n  path: string;\n  quality: EvidenceQuality;\n  reason?: string;\n  type?: string;\n  sizeBytes?: number;\n  allocatedBytes?: number;\n  modifiedAt?: string;\n  mode?: string;\n  owner?: string;\n  group?: string;\n  filesystem?: FilesystemEvidence;\n}\n\nexport interface HostEvidenceGap {\n  section: HostEvidenceSection;\n  reason: string;\n}\n\nexport interface LinuxHostEvidence {\n  schemaVersion: 1;\n  serverId: number;\n  collectedAt: string;\n  expiresAt: string;\n  quality: EvidenceQuality;\n  truncated: boolean;\n  metrics: EvidenceSection & { values: Record<string, number> };\n  filesystems: EvidenceSection & { items: FilesystemEvidence[] };\n  systemLogs: EvidenceSection & { entries: JournalEvidence[] };\n  physicalFiles: EvidenceSection & { items: PhysicalFileEvidence[] };\n  gaps: HostEvidenceGap[];\n}\n\nexport interface StorageDescriptor {\n  path: string;\n  kind: string;\n  source: string;\n  hostInspectable: boolean;\n  tablespace?: string;\n  objectName?: string;\n  logicalBytes?: number;\n}\n\nexport interface DiagnosticGap {\n  scope: DiagnosticGapScope;\n  section?: DiagnosticGapSection;\n  code: string;\n  resource?: { type: 'instance' | 'server'; id: number };\n  source?: string;\n}\n\nexport interface InstanceHostEvidenceResponse {\n  schemaVersion: 1;\n  subject: { type: 'instance'; id: number };\n  collectedAt: string;\n  database: {\n    instance: Record<string, unknown> | null;\n    realtimeMetrics: Record<string, unknown> | null;\n    metricHistory: Array<Record<string, unknown>>;\n    alerts: Array<Record<string, unknown>>;\n    logs: Array<Record<string, unknown>>;\n    slowQueries: Array<Record<string, unknown>>;\n  };\n  storage: StorageDescriptor[];\n  hosts: Array<{ server: InstanceHost; evidence: LinuxHostEvidence | null }>;\n  gaps: DiagnosticGap[];\n}\n`;
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
