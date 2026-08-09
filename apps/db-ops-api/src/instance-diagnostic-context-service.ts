import type { ActorContext } from './auth/actor-context.js';
import { redactLogValue } from './security/log-redaction.js';
import type { InstanceHostDetail } from './resources/instance-host-service.js';

export interface StorageDescriptor {
  path: string;
  kind: string;
  source: string;
  tablespace?: string | null;
}

export interface HostEvidenceRequest {
  databaseType: string;
  services: string[];
  paths: string[];
}

export interface DiagnosticContextDependencies {
  getInstance(instanceId: number): Promise<Record<string, unknown> | null>;
  getRealtimeMetrics(instanceId: number): Promise<Record<string, unknown> | null>;
  getMetricHistory(instanceId: number, start: Date, end: Date): Promise<Array<Record<string, unknown>>>;
  getAlerts(instanceId: number): Promise<Array<Record<string, unknown>>>;
  getLogs(instanceId: number, start: Date, end: Date): Promise<Array<Record<string, unknown>>>;
  getSlowQueries(instanceId: number): Promise<Array<Record<string, unknown>>>;
  listHosts(actor: ActorContext, instanceId: number): Promise<InstanceHostDetail[]>;
  discoverStorage(instanceId: number): Promise<StorageDescriptor[]>;
  collectHostEvidence(serverId: number, request: HostEvidenceRequest): Promise<Record<string, unknown>>;
}

export interface DiagnosticGap {
  scope: 'instance' | 'host' | 'storage';
  code: string;
  resource?: { type: 'instance' | 'server'; id: number };
}

export interface InstanceDiagnosticContext {
  schemaVersion: 1;
  subject: { type: 'instance'; id: number };
  collectedAt: string;
  database: {
    instance: Record<string, unknown>;
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

const limits = Object.freeze({ metricHistory: 288, alerts: 50, logs: 50, slowQueries: 20, storage: 128 });

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
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'COLLECTION_FAILED';
}

export class InstanceDiagnosticContextService {
  constructor(private readonly dependencies: DiagnosticContextDependencies) {}

  async collect(actor: ActorContext, instanceId: number, now = new Date()): Promise<InstanceDiagnosticContext> {
    if (!Number.isSafeInteger(instanceId) || instanceId <= 0) throw new Error('RESOURCE_REF_INVALID');
    const instance = await this.dependencies.getInstance(instanceId);
    if (!instance) throw new Error('INSTANCE_NOT_FOUND');

    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [realtimeMetrics, metricHistory, alerts, logs, slowQueries, storageResult] = await Promise.all([
      this.dependencies.getRealtimeMetrics(instanceId),
      this.dependencies.getMetricHistory(instanceId, start, now),
      this.dependencies.getAlerts(instanceId),
      this.dependencies.getLogs(instanceId, start, now),
      this.dependencies.getSlowQueries(instanceId),
      this.dependencies.discoverStorage(instanceId).then(
        (storage) => ({ storage, gap: null as DiagnosticGap | null }),
        (error) => ({ storage: [] as StorageDescriptor[], gap: { scope: 'storage' as const, code: stableErrorCode(error), resource: { type: 'instance' as const, id: instanceId } } }),
      ),
    ]);

    const gaps: DiagnosticGap[] = storageResult.gap ? [storageResult.gap] : [];
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

    const databaseType = typeof instance.db_type === 'string' ? instance.db_type : 'unknown';
    const storage = storageResult.storage.slice(0, limits.storage);
    const hosts = await Promise.all(relatedHosts.map(async (server) => {
      try {
        const evidence = await this.dependencies.collectHostEvidence(server.serverId, {
          databaseType,
          services: servicesForDatabaseType(databaseType),
          paths: storage.map((descriptor) => descriptor.path),
        });
        return { server, evidence: redactLogValue(evidence) as Record<string, unknown> };
      } catch (error) {
        gaps.push({
          scope: 'host',
          code: 'HOST_EVIDENCE_FAILED',
          resource: { type: 'server', id: server.serverId },
        });
        return { server, evidence: null };
      }
    }));

    return {
      schemaVersion: 1,
      subject: { type: 'instance', id: instanceId },
      collectedAt: now.toISOString(),
      database: {
        instance,
        realtimeMetrics,
        metricHistory: metricHistory.slice(-limits.metricHistory),
        alerts: alerts.slice(0, limits.alerts),
        logs: redactLogValue(logs.slice(0, limits.logs)) as Array<Record<string, unknown>>,
        slowQueries: slowQueries.slice(0, limits.slowQueries),
      },
      storage,
      hosts,
      gaps,
    };
  }
}
