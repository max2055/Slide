import type { ActorContext } from './auth/actor-context.js';
import { hasPermission } from './auth/require-permission.js';
import { alertDatabaseService } from './alert-database-service.js';
import { databaseLogService } from './database-log-service.js';
import { databaseStorageDiscoveryService } from './database-storage-discovery-service.js';
import { dbConnection } from './db-connection.js';
import { linuxHostEvidenceService } from './linux-host-evidence-service.js';
import { metricsDatabaseService } from './metrics-database-service.js';
import { redactSensitiveText } from './security/log-redaction.js';
import { instanceHostService, type InstanceHostDetail } from './resources/instance-host-service.js';

const SAFE_INSTANCE_METADATA_SQL = `
  SELECT id, name, environment, db_type, host, port, database_name,
         max_connections, connection_timeout_ms, status, health_score,
         health_status, last_health_check_at, db_version, data_size_gb,
         tags, description, created_at, updated_at
  FROM database_instances
  WHERE id = ?
  LIMIT 1
`;

const SAFE_INSTANCE_METADATA_FIELDS = Object.freeze([
  'id', 'name', 'environment', 'db_type', 'host', 'port', 'database_name',
  'max_connections', 'connection_timeout_ms', 'status', 'health_score',
  'health_status', 'last_health_check_at', 'db_version', 'data_size_gb',
  'tags', 'description', 'created_at', 'updated_at',
] as const);

function hasReadOnlyInstanceAccess(actor: ActorContext, instanceId: number): boolean {
  if (actor.permissions.includes('*') || actor.permissions.includes('instance:*')) return true;
  return Object.prototype.hasOwnProperty.call(actor.instanceScopes, instanceId);
}

interface InstanceMetadataPool {
  execute(sql: string, values: unknown[]): Promise<unknown>;
}

export class SafeInstanceMetadataProvider {
  constructor(
    private readonly poolProvider: () => InstanceMetadataPool | null = () => (
      dbConnection.getPool() as unknown as InstanceMetadataPool | null
    ),
  ) {}

  async getInstance(instanceId: number): Promise<Record<string, unknown> | null> {
    const pool = this.poolProvider();
    if (!pool) throw new Error('INSTANCE_METADATA_UNAVAILABLE');

    try {
      const result = await pool.execute(SAFE_INSTANCE_METADATA_SQL, [instanceId]);
      const rows = Array.isArray(result) ? result[0] : null;
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const row = rows[0];
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error('INSTANCE_METADATA_UNAVAILABLE');
      }
      return Object.fromEntries(SAFE_INSTANCE_METADATA_FIELDS.flatMap((field) => (
        Object.prototype.hasOwnProperty.call(row, field)
          ? [[field, (row as Record<string, unknown>)[field]]]
          : []
      )));
    } catch (error) {
      if (error instanceof Error && error.message === 'INSTANCE_METADATA_UNAVAILABLE') throw error;
      throw new Error('INSTANCE_METADATA_UNAVAILABLE');
    }
  }
}

export interface StorageDescriptor {
  path: string;
  kind: string;
  source: string;
  hostInspectable: boolean;
  tablespace?: string;
  objectName?: string;
  logicalBytes?: number;
}

export interface StorageDiscoveryGap {
  code: string;
  source: string;
}

export interface StorageDiscoveryResult {
  descriptors: StorageDescriptor[];
  gaps: StorageDiscoveryGap[];
}

export interface HostEvidenceRequest {
  databaseType: string;
  services: string[];
  paths: string[];
}

export interface DiagnosticContextDependencies {
  getInstance(instanceId: number): Promise<Record<string, unknown> | null>;
  getRealtimeMetrics(instanceId: number): Promise<Record<string, unknown> | null>;
  getMetricHistory(instanceId: number, start: Date, end: Date, limit: number): Promise<Array<Record<string, unknown>>>;
  getAlerts(instanceId: number, limit: number): Promise<{ items: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>;
  getLogs(instanceId: number, start: Date, end: Date, limit: number): Promise<{ logs: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>;
  getSlowQueries(instanceId: number, limit: number): Promise<Array<Record<string, unknown>>>;
  listHosts(actor: ActorContext, instanceId: number): Promise<InstanceHostDetail[]>;
  discoverStorage(instanceId: number): Promise<StorageDiscoveryResult>;
  collectHostEvidence(serverId: number, request: HostEvidenceRequest): Promise<Record<string, unknown>>;
}

export interface DiagnosticGap {
  scope: 'instance' | 'host' | 'storage';
  section?: 'instance' | 'realtime' | 'history' | 'alerts' | 'logs' | 'slowQueries' | 'storage' | 'relations' | 'hostEvidence' | 'evidencePack';
  code: string;
  resource?: { type: 'instance' | 'server'; id: number };
  source?: string;
}

export interface InstanceDiagnosticContext {
  schemaVersion: 1;
  subject: { type: 'instance'; id: number };
  collectedAt: string;
  database: {
    instance: Record<string, unknown> | null;
    realtimeMetrics: Record<string, unknown> | null;
    metricHistory: Array<Record<string, unknown>>;
    alerts: Array<Record<string, unknown>>;
    logs: Array<Record<string, unknown>>;
    slowQueries: Array<Record<string, unknown>>;
  };
  storage: StorageDescriptor[];
  hosts: Array<{ server: InstanceHostDetail; evidence: Record<string, unknown> | null }>;
  gaps: DiagnosticGap[];
}

const limits = Object.freeze({ metricHistory: 288, alerts: 50, logs: 50, slowQueries: 20 });
const MAX_RELATED_HOSTS = 32;
const HOST_COLLECTION_CONCURRENCY = 4;
export const EVIDENCE_PACK_MAX_BYTES = 256 * 1024;
const MIN_EVIDENCE_PACK_MAX_BYTES = 1024;
const EVIDENCE_SENSITIVE_KEY = /password|passwd|secret|token|authorization|api[_-]?key|credential|private[_-]?key|webhook|connection[_-]?string|dsn/i;
const EVIDENCE_TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|oracle):\/\/)[^@\s/]+@/gi, '$1[REDACTED]@'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bASIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]'],
]);

export interface InstanceDiagnosticContextOptions {
  maxBytes?: number;
}

function servicesForDatabaseType(databaseType: string): string[] {
  switch (databaseType.toLowerCase()) {
    case 'mysql': return ['mysqld', 'mysql'];
    case 'postgresql': return ['postgresql'];
    case 'oracle': return ['oracle'];
    case 'dameng': return ['dmserver'];
    default: return [];
  }
}

function stableErrorCode(error: unknown): string {
  const coded = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
  const message = coded ?? (error instanceof Error ? error.message : String(error));
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'COLLECTION_FAILED';
}

interface SettledSection<T> {
  value: T;
  gap: DiagnosticGap | null;
}

async function settleSection<T>(
  operation: () => Promise<T>,
  fallback: T,
  gap: Omit<DiagnosticGap, 'code'>,
  fallbackCode: string,
): Promise<SettledSection<T>> {
  try {
    return { value: await operation(), gap: null };
  } catch (error) {
    const stable = stableErrorCode(error);
    return { value: fallback, gap: { ...gap, code: stable === 'COLLECTION_FAILED' ? fallbackCode : stable } };
  }
}

function settleAuthorizedSection<T>(
  authorized: boolean,
  operation: () => Promise<T>,
  fallback: T,
  gap: Omit<DiagnosticGap, 'code'>,
  fallbackCode: string,
  forbiddenCode: string,
): Promise<SettledSection<T>> {
  return authorized
    ? settleSection(operation, fallback, gap, fallbackCode)
    : Promise.resolve({ value: fallback, gap: { ...gap, code: forbiddenCode } });
}

function alertItems(result: { items: Array<Record<string, unknown>> } | Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result : Array.isArray(result.items) ? result.items : [];
}

function logItems(result: { logs: Array<Record<string, unknown>> } | Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result : Array.isArray(result.logs) ? result.logs : [];
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker(),
  ));
  return results;
}

function redactEvidenceText(value: string): string {
  return EVIDENCE_TEXT_PATTERNS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    redactSensitiveText(value),
  );
}

function sanitizeEvidenceValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactEvidenceText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value;
  if (value instanceof Error) return { name: value.name, message: redactEvidenceText(value.message) };
  if (!value || typeof value !== 'object') return value;
  if (ancestors.has(value)) return '[CIRCULAR]';
  ancestors.add(value);
  let sanitized: unknown;
  if (Array.isArray(value)) {
    sanitized = value.map((entry) => sanitizeEvidenceValue(entry, ancestors));
  } else {
    sanitized = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      redactEvidenceText(key),
      EVIDENCE_SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeEvidenceValue(entry, ancestors),
    ]));
  }
  ancestors.delete(value);
  return sanitized;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function sectionSummary(section: unknown, itemsKey: 'entries' | 'items' | 'values'): Record<string, unknown> | undefined {
  if (!section || typeof section !== 'object' || Array.isArray(section)) return undefined;
  const source = section as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ['source', 'collectedAt', 'quality', 'reason']) {
    if (source[key] !== undefined) summary[key] = source[key];
  }
  summary[itemsKey] = itemsKey === 'values' ? {} : [];
  return summary;
}

function hostEvidenceSummary(evidence: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of ['schemaVersion', 'serverId', 'collectedAt', 'expiresAt', 'quality']) {
    if (evidence[key] !== undefined) summary[key] = evidence[key];
  }
  summary.truncated = true;
  const metrics = sectionSummary(evidence.metrics, 'values');
  const filesystems = sectionSummary(evidence.filesystems, 'items');
  const systemLogs = sectionSummary(evidence.systemLogs, 'entries');
  const physicalFiles = sectionSummary(evidence.physicalFiles, 'items');
  if (metrics) summary.metrics = metrics;
  if (filesystems) summary.filesystems = filesystems;
  if (systemLogs) summary.systemLogs = systemLogs;
  if (physicalFiles) summary.physicalFiles = physicalFiles;
  summary.gaps = Array.isArray(evidence.gaps) ? evidence.gaps : [];
  return summary;
}

function halveArray(values: unknown[], keepNewestAtEnd = false): void {
  if (values.length <= 1) {
    values.length = 0;
    return;
  }
  const keep = Math.floor(values.length / 2);
  if (keepNewestAtEnd) values.splice(0, values.length - keep);
  else values.splice(keep);
}

function truncateLongStrings(value: unknown, maxBytes: number, ancestors = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || value instanceof Date || ancestors.has(value)) return;
  ancestors.add(value);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && Buffer.byteLength(entry, 'utf8') > maxBytes) {
      const bytes = Buffer.from(entry, 'utf8');
      (value as Record<string, unknown>)[key] = `${bytes.subarray(0, maxBytes).toString('utf8')}[TRUNCATED]`;
    } else {
      truncateLongStrings(entry, maxBytes, ancestors);
    }
  }
  ancestors.delete(value);
}

function boundEvidencePack(pack: InstanceDiagnosticContext, maxBytes: number): InstanceDiagnosticContext {
  if (serializedBytes(pack) <= maxBytes) return pack;
  if (!pack.gaps.some((gap) => gap.code === 'EVIDENCE_PACK_TRUNCATED')) {
    pack.gaps.push({
      scope: 'instance', section: 'evidencePack', code: 'EVIDENCE_PACK_TRUNCATED',
      resource: { type: 'instance', id: pack.subject.id },
    });
  }

  const targets: Array<{ values: unknown[]; keepNewestAtEnd?: boolean }> = [
    { values: pack.database.logs },
    { values: pack.database.alerts },
    { values: pack.database.slowQueries },
    { values: pack.database.metricHistory, keepNewestAtEnd: true },
    { values: pack.storage },
  ];
  for (const host of pack.hosts) {
    const evidence = host.evidence as Record<string, any> | null;
    if (!evidence) continue;
    if (Array.isArray(evidence.systemLogs?.entries)) targets.push({ values: evidence.systemLogs.entries });
    if (Array.isArray(evidence.physicalFiles?.items)) targets.push({ values: evidence.physicalFiles.items });
    if (Array.isArray(evidence.filesystems?.items)) targets.push({ values: evidence.filesystems.items });
  }
  for (const target of targets) {
    while (target.values.length > 0 && serializedBytes(pack) > maxBytes) {
      halveArray(target.values, target.keepNewestAtEnd);
    }
  }

  if (serializedBytes(pack) > maxBytes) {
    for (let index = pack.hosts.length - 1; index >= 0 && serializedBytes(pack) > maxBytes; index--) {
      const evidence = pack.hosts[index].evidence;
      if (evidence) pack.hosts[index].evidence = hostEvidenceSummary(evidence);
    }
  }
  if (serializedBytes(pack) > maxBytes) truncateLongStrings(pack, 512);
  if (serializedBytes(pack) <= maxBytes) return pack;

  return {
    schemaVersion: 1,
    subject: pack.subject,
    collectedAt: pack.collectedAt,
    database: {
      instance: null,
      realtimeMetrics: null,
      metricHistory: [],
      alerts: [],
      logs: [],
      slowQueries: [],
    },
    storage: [],
    hosts: [],
    gaps: [{
      scope: 'instance', section: 'evidencePack', code: 'EVIDENCE_PACK_TRUNCATED',
      resource: { type: 'instance', id: pack.subject.id },
    }],
  };
}

export class InstanceDiagnosticContextService {
  private readonly maxBytes: number;

  constructor(
    private readonly dependencies: DiagnosticContextDependencies,
    options: InstanceDiagnosticContextOptions = {},
  ) {
    this.maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes! >= MIN_EVIDENCE_PACK_MAX_BYTES
      ? options.maxBytes!
      : EVIDENCE_PACK_MAX_BYTES;
  }

  async collect(actor: ActorContext, instanceId: number, now = new Date()): Promise<InstanceDiagnosticContext> {
    if (!Number.isSafeInteger(instanceId) || instanceId <= 0) throw new Error('RESOURCE_REF_INVALID');
    const actorPermissions = new Set(actor.permissions);
    if (!hasPermission(actorPermissions, 'instance:view')) throw new Error('RESOURCE_FORBIDDEN');
    if (!hasReadOnlyInstanceAccess(actor, instanceId)) throw new Error('RESOURCE_FORBIDDEN');
    const resource = { type: 'instance' as const, id: instanceId };
    const gaps: DiagnosticGap[] = [];
    const metadata = await settleSection(
      () => this.dependencies.getInstance(instanceId),
      null,
      { scope: 'instance', section: 'instance', resource },
      'INSTANCE_METADATA_FAILED',
    );
    if (metadata.gap) gaps.push(metadata.gap);
    const instance = metadata.value;
    if (!metadata.gap && !instance) throw new Error('INSTANCE_NOT_FOUND');

    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const canViewMetrics = hasPermission(actorPermissions, 'metric:view');
    const canViewAlerts = hasPermission(actorPermissions, 'alert:view');
    const canViewLogs = hasPermission(actorPermissions, 'log:view');
    const [realtime, history, alertSection, logSection, slowQuerySection, storageSection] = await Promise.all([
      settleAuthorizedSection(
        canViewMetrics,
        () => this.dependencies.getRealtimeMetrics(instanceId), null,
        { scope: 'instance', section: 'realtime', resource },
        'REALTIME_METRICS_FAILED', 'METRIC_EVIDENCE_FORBIDDEN',
      ),
      settleAuthorizedSection(
        canViewMetrics,
        () => this.dependencies.getMetricHistory(instanceId, start, now, limits.metricHistory), [],
        { scope: 'instance', section: 'history', resource },
        'METRIC_HISTORY_FAILED', 'METRIC_EVIDENCE_FORBIDDEN',
      ),
      settleAuthorizedSection(
        canViewAlerts,
        async () => alertItems(await this.dependencies.getAlerts(instanceId, limits.alerts)), [],
        { scope: 'instance', section: 'alerts', resource },
        'ALERTS_FAILED', 'ALERT_EVIDENCE_FORBIDDEN',
      ),
      settleAuthorizedSection(
        canViewLogs,
        async () => logItems(await this.dependencies.getLogs(instanceId, start, now, limits.logs)), [],
        { scope: 'instance', section: 'logs', resource },
        'LOGS_FAILED', 'LOG_EVIDENCE_FORBIDDEN',
      ),
      settleAuthorizedSection(
        canViewMetrics,
        () => this.dependencies.getSlowQueries(instanceId, limits.slowQueries), [],
        { scope: 'instance', section: 'slowQueries', resource },
        'SLOW_QUERIES_FAILED', 'METRIC_EVIDENCE_FORBIDDEN',
      ),
      settleSection(
        () => this.dependencies.discoverStorage(instanceId), { descriptors: [], gaps: [] },
        { scope: 'storage', section: 'storage', resource }, 'STORAGE_DISCOVERY_FAILED',
      ),
    ]);

    for (const section of [realtime, history, alertSection, logSection, slowQuerySection, storageSection]) {
      if (section.gap) gaps.push(section.gap);
    }
    if (!realtime.gap && realtime.value === null) {
      gaps.push({ scope: 'instance', section: 'realtime', code: 'REALTIME_METRICS_UNAVAILABLE', resource });
    }
    for (const gap of storageSection.value.gaps) {
      gaps.push({ scope: 'storage', section: 'storage', code: gap.code, source: gap.source, resource });
    }

    let relatedHosts: InstanceHostDetail[] = [];
    try {
      relatedHosts = await this.dependencies.listHosts(actor, instanceId);
      if (relatedHosts.length === 0) {
        gaps.push({ scope: 'host', code: 'HOST_RELATION_MISSING', resource: { type: 'instance', id: instanceId } });
      }
    } catch (error) {
      const code = stableErrorCode(error) === 'RESOURCE_FORBIDDEN' ? 'HOST_EVIDENCE_FORBIDDEN' : 'HOST_RELATION_LOOKUP_FAILED';
      gaps.push({ scope: 'host', code, resource: { type: 'instance', id: instanceId } });
    }

    const databaseType = typeof instance?.db_type === 'string' ? instance.db_type : 'unknown';
    const storage = storageSection.value.descriptors;
    if (relatedHosts.length > MAX_RELATED_HOSTS) {
      gaps.push({
        scope: 'host', section: 'relations', code: 'HOST_EVIDENCE_LIMIT_REACHED', resource,
      });
    }
    const boundedHosts = relatedHosts.slice(0, MAX_RELATED_HOSTS);
    const inspectablePaths = [...new Set(storage
      .filter((descriptor) => descriptor.hostInspectable === true)
      .map((descriptor) => descriptor.path))];
    const collectedHosts = await mapWithConcurrency(
      boundedHosts,
      HOST_COLLECTION_CONCURRENCY,
      async (server) => {
        const hostGaps: DiagnosticGap[] = [];
        const mayInspectPhysicalPaths = server.role === 'primary' || server.role === 'standalone';
        if (!mayInspectPhysicalPaths) {
          hostGaps.push({
            scope: 'host', section: 'hostEvidence', code: 'PHYSICAL_PATH_ROLE_UNCERTAIN',
            resource: { type: 'server', id: server.serverId },
          });
        }
        try {
          const evidence = await this.dependencies.collectHostEvidence(server.serverId, {
            databaseType,
            services: servicesForDatabaseType(databaseType),
            paths: mayInspectPhysicalPaths ? inspectablePaths : [],
          });
          return {
            host: { server, evidence },
            gaps: hostGaps,
          };
        } catch (error) {
          const code = stableErrorCode(error);
          hostGaps.push({
            scope: 'host',
            section: 'hostEvidence',
            code: code === 'COLLECTION_FAILED' ? 'HOST_EVIDENCE_FAILED' : code,
            resource: { type: 'server', id: server.serverId },
          });
          return { host: { server, evidence: null }, gaps: hostGaps };
        }
      },
    );
    const hosts = collectedHosts.map((result) => result.host);
    for (const result of collectedHosts) gaps.push(...result.gaps);

    const pack = {
      schemaVersion: 1,
      subject: { type: 'instance', id: instanceId },
      collectedAt: now.toISOString(),
      database: {
        instance,
        realtimeMetrics: realtime.value,
        metricHistory: history.value,
        alerts: alertSection.value,
        logs: logSection.value,
        slowQueries: slowQuerySection.value,
      },
      storage,
      hosts,
      gaps,
    } satisfies InstanceDiagnosticContext;
    const sanitized = sanitizeEvidenceValue(pack) as InstanceDiagnosticContext;
    return boundEvidencePack(sanitized, this.maxBytes);
  }
}

export const safeInstanceMetadataProvider = new SafeInstanceMetadataProvider();

export const instanceDiagnosticContextService = new InstanceDiagnosticContextService({
  getInstance: (instanceId) => safeInstanceMetadataProvider.getInstance(instanceId),
  getRealtimeMetrics: async (instanceId) => (
    await metricsDatabaseService.getRealtimeMetrics(instanceId) as unknown as Record<string, unknown> | null
  ),
  getMetricHistory: async (instanceId, start, end, limit) => {
    const records = await metricsDatabaseService.getHistoricalMetrics(
      instanceId, start, end, undefined, limit, { strict: true },
    );
    return records as unknown as Array<Record<string, unknown>>;
  },
  getAlerts: (instanceId, limit) => alertDatabaseService.getAlerts({
    instance_id: instanceId, limit, offset: 0, strict: true,
  }),
  getLogs: async (instanceId, start, end, limit) => (
    await databaseLogService.getLogs(instanceId, {
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      limit,
      offset: 0,
      strict: true,
    }) as unknown as { logs: Array<Record<string, unknown>> }
  ),
  getSlowQueries: async (instanceId, limit) => (
    await metricsDatabaseService.getSlowQueries(instanceId, limit, { strict: true }) as unknown as Array<Record<string, unknown>>
  ),
  listHosts: (actor, instanceId) => instanceHostService.listHosts(actor, instanceId),
  discoverStorage: (instanceId) => databaseStorageDiscoveryService.discover(instanceId),
  collectHostEvidence: (serverId, request) => linuxHostEvidenceService.collectHostEvidence(serverId, request),
});

export default instanceDiagnosticContextService;
