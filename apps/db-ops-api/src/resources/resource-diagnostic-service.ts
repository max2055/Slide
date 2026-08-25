import type { ActorContext } from '../auth/actor-context.js';
import { canReadResource, resourceService } from './resource-service.js';
import type { Observation, ResourceDetail, ResourceRef, ResourceRelation } from './types.js';
import { dbConnection } from '../db-connection.js';
import { instanceDatabaseService } from '../instance-database-service.js';
import { serverDatabaseService } from '../server-database-service.js';
import { networkDeviceDatabaseService } from '../network-devices/network-device-database-service.js';
import { alertDatabaseService } from '../alert-database-service.js';
import { publicInstanceDto, publicNetworkDeviceDto, publicServerDto } from '../security/public-dto.js';
import { observationService } from './observation-service.js';

export interface ResourceDiagnosticDependencies {
  list(actor: ActorContext): Promise<ResourceDetail[]>;
  detail(ref: ResourceRef, actor: ActorContext): Promise<ResourceDetail | null>;
  observations(ref: ResourceRef, actor: ActorContext, options?: { metricIds?: string[]; limit?: number }): Promise<Observation[]>;
  relations(ref: ResourceRef, actor: ActorContext): Promise<ResourceRelation[]>;
  alerts(ref: ResourceRef, actor: ActorContext, limit?: number): Promise<Array<Record<string, unknown>>>;
}

export interface ResourceDiagnosticPack {
  schemaVersion: 1;
  subject: ResourceRef;
  collectedAt: string;
  resource: ResourceDetail;
  observations: Observation[];
  relations: ResourceRelation[];
  alerts: Array<Record<string, unknown>>;
  gaps: Array<{ scope: string; code: string; metricId?: string }>;
  truncated: boolean;
}

export interface ResourceListResult {
  items: ResourceDetail[];
  collectedAt: string;
  dataQuality: 'complete' | 'partial' | 'empty';
}

const MAX_LIST_ITEMS = 500;
const MAX_OBSERVATIONS = 200;
const MAX_ALERTS = 100;
const DEFAULT_PACK_BYTES = 256 * 1024;

function validateRef(ref: ResourceRef): void {
  if (!ref || !['instance', 'server', 'network_device'].includes(ref.type)
    || !Number.isSafeInteger(ref.id) || ref.id <= 0) throw new Error('RESOURCE_REF_INVALID');
}

function safeJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function trimPack(pack: ResourceDiagnosticPack, maxBytes: number): ResourceDiagnosticPack {
  if (safeJsonBytes(pack) <= maxBytes) return pack;
  pack.truncated = true;
  pack.gaps.push({ scope: 'diagnostic', code: 'EVIDENCE_PACK_TRUNCATED' });
  while (pack.alerts.length && safeJsonBytes(pack) > maxBytes) pack.alerts.pop();
  while (pack.observations.length && safeJsonBytes(pack) > maxBytes) pack.observations.pop();
  while (pack.relations.length && safeJsonBytes(pack) > maxBytes) pack.relations.pop();
  if (safeJsonBytes(pack) <= maxBytes) return pack;
  return {
    schemaVersion: 1,
    subject: pack.subject,
    collectedAt: pack.collectedAt,
    resource: pack.resource,
    observations: [],
    relations: [],
    alerts: [],
    gaps: [{ scope: 'diagnostic', code: 'EVIDENCE_PACK_TRUNCATED' }],
    truncated: true,
  };
}

export class ResourceDiagnosticService {
  constructor(
    private readonly dependencies: ResourceDiagnosticDependencies,
    private readonly options: { maxBytes?: number } = {},
  ) {}

  async listResources(actor: ActorContext): Promise<ResourceListResult> {
    const items = (await this.dependencies.list(actor)).slice(0, MAX_LIST_ITEMS);
    return {
      items,
      collectedAt: new Date().toISOString(),
      dataQuality: items.length ? 'complete' : 'empty',
    };
  }

  async getObservations(actor: ActorContext, ref: ResourceRef, options: { metricIds?: string[]; limit?: number } = {}): Promise<Observation[]> {
    validateRef(ref);
    if (!canReadResource(actor, ref)) throw new Error('RESOURCE_FORBIDDEN');
    const metricIds = options.metricIds?.filter((id) => /^[a-z][a-z0-9_]{0,127}$/.test(id)).slice(0, 32);
    if (options.metricIds && metricIds?.length !== options.metricIds.length) throw new Error('METRIC_ID_INVALID');
    return (await this.dependencies.observations(ref, actor, {
      metricIds,
      limit: Math.min(Math.max(options.limit ?? MAX_OBSERVATIONS, 1), MAX_OBSERVATIONS),
    })).slice(0, MAX_OBSERVATIONS);
  }

  async getRelations(actor: ActorContext, ref: ResourceRef): Promise<ResourceRelation[]> {
    validateRef(ref);
    if (!canReadResource(actor, ref)) throw new Error('RESOURCE_FORBIDDEN');
    return (await this.dependencies.relations(ref, actor)).slice(0, 128);
  }

  async diagnose(actor: ActorContext, ref: ResourceRef): Promise<ResourceDiagnosticPack> {
    validateRef(ref);
    if (!canReadResource(actor, ref)) throw new Error('RESOURCE_FORBIDDEN');
    const collectedAt = new Date().toISOString();
    const resource = await this.dependencies.detail(ref, actor);
    if (!resource) throw new Error('RESOURCE_NOT_FOUND');
    const [observations, relations, alerts] = await Promise.all([
      this.dependencies.observations(ref, actor, { limit: MAX_OBSERVATIONS }),
      this.dependencies.relations(ref, actor),
      this.dependencies.alerts(ref, actor, MAX_ALERTS),
    ]);
    const gaps: ResourceDiagnosticPack['gaps'] = [];
    for (const observation of observations) {
      if (observation.quality === 'unknown' || observation.value === null) {
        gaps.push({ scope: 'observation', code: 'OBSERVATION_UNKNOWN', metricId: observation.metricId });
      } else if (observation.quality === 'degraded' || observation.quality === 'invalid') {
        gaps.push({ scope: 'observation', code: 'OBSERVATION_DEGRADED', metricId: observation.metricId });
      }
    }
    if (!observations.length) gaps.push({ scope: 'observation', code: 'OBSERVATIONS_EMPTY' });
    if (!relations.length) gaps.push({ scope: 'relation', code: 'RELATIONS_EMPTY' });
    if (!alerts.length) gaps.push({ scope: 'alert', code: 'ALERTS_EMPTY' });
    return trimPack({
      schemaVersion: 1,
      subject: ref,
      collectedAt,
      resource,
      observations: observations.slice(0, MAX_OBSERVATIONS),
      relations: relations.slice(0, 128),
      alerts: alerts.slice(0, MAX_ALERTS),
      gaps,
      truncated: false,
    }, this.options.maxBytes ?? DEFAULT_PACK_BYTES);
  }
}

async function defaultList(actor: ActorContext): Promise<ResourceDetail[]> {
  const [instances, servers, devices] = await Promise.all([
    instanceDatabaseService.getManagedInstances(),
    serverDatabaseService.getAllServers(),
    networkDeviceDatabaseService.getAllDevices(),
  ]);
  const result: ResourceDetail[] = [];
  for (const instance of instances) {
    const ref = { type: 'instance' as const, id: Number(instance.id) };
    if (!canReadResource(actor, ref)) continue;
    const dto = publicInstanceDto(instance as unknown as Record<string, unknown>) as Record<string, any>;
    result.push({ resource: ref, label: String(dto.name ?? `instance-${ref.id}`), status: String(dto.status ?? 'unknown'), attributes: {
      dbType: dto.db_type ?? null, environment: dto.environment ?? null, host: dto.host ?? null,
      port: dto.port == null ? null : Number(dto.port), healthStatus: dto.health_status ?? 'unknown',
    } });
  }
  for (const server of servers) {
    const ref = { type: 'server' as const, id: Number(server.id) };
    if (!canReadResource(actor, ref)) continue;
    const dto = publicServerDto(server as unknown as Record<string, unknown>) as Record<string, any>;
    result.push({ resource: ref, label: String(dto.label ?? dto.host ?? `server-${ref.id}`), status: String(dto.status ?? 'unknown'), attributes: {
      host: dto.host ?? null, port: dto.port == null ? null : Number(dto.port), osType: dto.os_type ?? null,
      collectionEnabled: Boolean(dto.collection_enabled),
    } });
  }
  for (const device of devices) {
    const ref = { type: 'network_device' as const, id: Number(device.id) };
    if (!canReadResource(actor, ref)) continue;
    const dto = publicNetworkDeviceDto(device as unknown as Record<string, unknown>) as Record<string, any>;
    result.push({ resource: ref, label: String(dto.label ?? dto.name ?? dto.host ?? `network-device-${ref.id}`), status: String(dto.status ?? 'unknown'), attributes: {
      host: dto.host ?? null, site: dto.site ?? null, vendor: dto.vendor ?? null, model: dto.model ?? null,
      collectionEnabled: Boolean(dto.collection_enabled),
    } });
  }
  return result.slice(0, MAX_LIST_ITEMS);
}

async function defaultObservations(ref: ResourceRef, actor: ActorContext, options: { metricIds?: string[]; limit?: number } = {}): Promise<Observation[]> {
  const limit = Math.min(options.limit ?? MAX_OBSERVATIONS, MAX_OBSERVATIONS);
  const metricIds = options.metricIds;
  if (metricIds?.length) {
    const values = await Promise.all(metricIds.slice(0, 32).map(async (metricId) => {
      try {
        return await observationService.latest(actor, ref, metricId, { validForMs: 5 * 60_000 });
      } catch {
        return null;
      }
    }));
    return values.filter((value): value is Observation => value !== null);
  }
  const pool = dbConnection.getPool();
  if (!pool) return [];
  const table = ref.type === 'instance' ? 'metrics_history' : ref.type === 'server' ? 'server_metrics' : 'network_device_observations';
  const idColumn = ref.type === 'instance' ? 'instance_id' : ref.type === 'server' ? 'server_id' : 'device_id';
  const metricColumn = ref.type === 'instance' ? null : ref.type === 'server' ? 'metric_name' : 'metric_id';
  const timeColumn = ref.type === 'instance' ? 'recorded_at' : ref.type === 'server' ? 'recorded_at' : 'observed_at';
  if (ref.type === 'instance') {
    const [rows] = await pool.execute<any[]>(
      `SELECT recorded_at, cpu_usage, memory_usage, disk_usage, connections, qps, tps, slow_queries
       FROM metrics_history WHERE instance_id = ? ORDER BY recorded_at DESC LIMIT 1`, [ref.id]);
    const row = rows[0];
    if (!row) return [];
    return ['cpu_usage', 'memory_usage', 'disk_usage', 'connections', 'qps', 'tps', 'slow_queries'].map((metricId) => ({
      resource: ref, metricId, value: row[metricId] == null ? null : Number(row[metricId]),
      observedAt: row.recorded_at ? new Date(row.recorded_at) : null,
      validUntil: row.recorded_at ? new Date(new Date(row.recorded_at).getTime() + 5 * 60_000) : null,
      source: 'metrics_history', quality: row[metricId] == null ? 'unknown' as const : 'good' as const,
      reason: row[metricId] == null ? 'missing_observation' : undefined,
    })).slice(0, limit);
  }
  const [rows] = await pool.execute<any[]>(
    `SELECT x.metric_id AS metricId, x.metric_value AS value, x.${timeColumn} AS observedAt, x.quality, x.source, x.dimensions
     FROM ${table} x JOIN (SELECT ${metricColumn} AS metric_id, MAX(${timeColumn}) AS latest_at FROM ${table} WHERE ${idColumn} = ? GROUP BY ${metricColumn}) latest
       ON latest.metric_id = x.${metricColumn} AND latest.latest_at = x.${timeColumn}
     WHERE x.${idColumn} = ? ORDER BY x.${timeColumn} DESC LIMIT ?`, [ref.id, ref.id, limit]);
  return rows.map((row) => {
    let dimensions: Record<string, string> | undefined;
    try { dimensions = typeof row.dimensions === 'string' ? JSON.parse(row.dimensions) : row.dimensions ?? undefined; } catch { dimensions = undefined; }
    const observedAt = row.observedAt ? new Date(row.observedAt) : null;
    return { resource: ref, metricId: String(row.metricId), value: row.value == null ? null : Number(row.value), observedAt,
      validUntil: observedAt ? new Date(observedAt.getTime() + 5 * 60_000) : null, dimensions, source: String(row.source ?? table),
      quality: row.quality ?? (row.value == null ? 'unknown' : 'good'), } as Observation;
  });
}

async function defaultAlerts(ref: ResourceRef, actor: ActorContext, limit = MAX_ALERTS): Promise<Array<Record<string, unknown>>> {
  if (ref.type === 'instance') {
    const result = await alertDatabaseService.getAlerts({ instance_id: ref.id, limit, strict: true });
    return Array.isArray(result) ? result : result.items ?? [];
  }
  if (ref.type === 'server') {
    const result = await alertDatabaseService.getAlerts({ server_id: ref.id, limit, strict: true });
    return Array.isArray(result) ? result : result.items ?? [];
  }
  const pool = dbConnection.getPool();
  if (!pool) return [];
  const [rows] = await pool.execute<any[]>(
    `SELECT id, target_type AS targetType, network_device_id AS networkDeviceId, level, title, message, status, metric_name AS metricName, metric_value AS metricValue, created_at AS createdAt
     FROM alerts WHERE network_device_id = ? ORDER BY created_at DESC LIMIT ?`, [ref.id, limit]);
  return rows;
}

export const resourceDiagnosticService = new ResourceDiagnosticService({
  list: defaultList,
  detail: async (ref, actor) => resourceService.detail(actor, ref),
  observations: defaultObservations,
  relations: async (ref, actor) => resourceService.currentRelations(actor, ref),
  alerts: defaultAlerts,
});
