import type { ActorContext } from '../auth/actor-context.js';
import { canReadResource, resourceService } from './resource-service.js';
import type { Observation, ResourceDetail, ResourceRef, ResourceRelation, ResourceType } from './types.js';
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
  relatedEvidence: RelatedResourceEvidence[];
  gaps: Array<{ scope: string; code: string; metricId?: string }>;
  truncated: boolean;
}

export interface RelatedResourceEvidence {
  resource: ResourceDetail;
  relations: ResourceRelation[];
  observations: Observation[];
  alerts: Array<Record<string, unknown>>;
  gaps: Array<{ scope: string; code: string; metricId?: string }>;
  /** Deterministic signal score used to order evidence for an Agent. */
  priority: number;
}

export interface ResourceListResult {
  items: ResourceDetail[];
  collectedAt: string;
  dataQuality: 'complete' | 'partial' | 'empty';
}

export type ResourceFreshness = 'fresh' | 'stale' | 'missing';

export interface ResourceOverviewItem {
  resource: ResourceRef;
  label: string;
  status: string;
  quality: Observation['quality'] | 'partial';
  freshness: ResourceFreshness;
  observedAt: string | null;
  unresolvedAlerts: number;
  relationCount: number;
  impactScope: ResourceRef[];
  gaps: string[];
}

export interface ResourceOverviewResult {
  schemaVersion: 1;
  collectedAt: string;
  dataQuality: 'complete' | 'partial' | 'empty';
  summary: {
    total: number;
    byType: Record<ResourceType, number>;
    byStatus: Record<string, number>;
    fresh: number;
    stale: number;
    missing: number;
    unresolvedAlerts: number;
    impactedResources: number;
  };
  items: ResourceOverviewItem[];
}

const MAX_LIST_ITEMS = 500;
const MAX_OBSERVATIONS = 200;
const MAX_ALERTS = 100;
const MAX_RELATED_RESOURCES = 16;
const MAX_RELATED_OBSERVATIONS = 64;
const MAX_RELATED_ALERTS = 32;
const DEFAULT_PACK_BYTES = 256 * 1024;
const OVERVIEW_CONCURRENCY = 8;
const OBSERVATION_FRESHNESS_MS = 5 * 60_000;

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
  while (pack.relatedEvidence.length && safeJsonBytes(pack) > maxBytes) pack.relatedEvidence.pop();
  if (safeJsonBytes(pack) <= maxBytes) return pack;
  return {
    schemaVersion: 1,
    subject: pack.subject,
    collectedAt: pack.collectedAt,
    resource: pack.resource,
    observations: [],
    relations: [],
    alerts: [],
    relatedEvidence: [],
    gaps: [{ scope: 'diagnostic', code: 'EVIDENCE_PACK_TRUNCATED' }],
    truncated: true,
  };
}

function activeAlert(alert: Record<string, unknown>): boolean {
  const status = String(alert.status ?? alert.state ?? '').toLowerCase();
  return !['resolved', 'closed', 'recovered', 'cleared'].includes(status);
}

function evidencePriority(observations: Observation[], alerts: Array<Record<string, unknown>>): number {
  let score = alerts.filter(activeAlert).length * 100;
  for (const observation of observations) {
    const metric = observation.metricId.toLowerCase();
    if (/(drop|loss|discard|error|down|unreachable)/.test(metric)) score += 80;
    else if (/(cpu|memory|temperature|uptime)/.test(metric)) score += 40;
    else score += 20;
    if (observation.quality === 'degraded' || observation.quality === 'invalid') score += 60;
    else if (observation.quality === 'unknown' || observation.value === null) score += 10;
  }
  return score;
}

function observationGaps(observations: Observation[], scope: string): RelatedResourceEvidence['gaps'] {
  const gaps: RelatedResourceEvidence['gaps'] = [];
  for (const observation of observations) {
    if (observation.quality === 'unknown' || observation.value === null) {
      gaps.push({ scope, code: 'OBSERVATION_UNKNOWN', metricId: observation.metricId });
    } else if (observation.quality === 'degraded' || observation.quality === 'invalid') {
      gaps.push({ scope, code: 'OBSERVATION_DEGRADED', metricId: observation.metricId });
    }
  }
  if (!observations.length) gaps.push({ scope, code: 'OBSERVATIONS_EMPTY' });
  return gaps;
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
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
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

  /**
   * Build one bounded, permission-filtered snapshot for the operations
   * dashboard. Every secondary lookup is best-effort: a missing observation,
   * alert query, or relation query becomes an explicit gap instead of making
   * the resource appear healthy or hiding the rest of the inventory.
   */
  async overview(actor: ActorContext, now = new Date()): Promise<ResourceOverviewResult> {
    const resources = (await this.dependencies.list(actor)).slice(0, MAX_LIST_ITEMS);
    const items = await mapWithConcurrency(resources, OVERVIEW_CONCURRENCY, async (resource) => {
      const gaps: string[] = [];
      const [observationResult, alertResult, relationResult] = await Promise.all([
        this.dependencies.observations(resource.resource, actor, { limit: 32 })
          .then((value) => ({ value, error: false }))
          .catch(() => ({ value: [] as Observation[], error: true })),
        this.dependencies.alerts(resource.resource, actor, MAX_ALERTS)
          .then((value) => ({ value, error: false }))
          .catch(() => ({ value: [] as Array<Record<string, unknown>>, error: true })),
        this.dependencies.relations(resource.resource, actor)
          .then((value) => ({ value, error: false }))
          .catch(() => ({ value: [] as ResourceRelation[], error: true })),
      ]);

      if (observationResult.error) gaps.push('OBSERVATIONS_UNAVAILABLE');
      if (alertResult.error) gaps.push('ALERTS_UNAVAILABLE');
      if (relationResult.error) gaps.push('RELATIONS_UNAVAILABLE');

      const observed = observationResult.value
        .filter((entry) => entry.observedAt instanceof Date && !Number.isNaN(entry.observedAt.getTime()))
        .sort((left, right) => right.observedAt!.getTime() - left.observedAt!.getTime())[0];
      const observedAt = observed?.observedAt?.toISOString() ?? null;
      const freshness: ResourceFreshness = !observed
        ? 'missing'
        : now.getTime() - observed.observedAt!.getTime() <= OBSERVATION_FRESHNESS_MS
          ? 'fresh'
          : 'stale';
      if (freshness === 'missing') gaps.push('OBSERVATIONS_EMPTY');
      else if (freshness === 'stale') gaps.push('OBSERVATIONS_STALE');

      const quality = observationResult.value.length === 0
        ? 'unknown' as const
        : observationResult.value.some((entry) => entry.quality === 'invalid' || entry.quality === 'degraded')
          ? 'degraded' as const
          : observationResult.value.some((entry) => entry.quality === 'unknown' || entry.value === null)
            ? 'partial' as const
            : 'good' as const;
      const unresolvedAlerts = alertResult.value.filter((alert) => {
        const status = String(alert.status ?? alert.state ?? '').toLowerCase();
        return !['resolved', 'closed', 'recovered', 'cleared'].includes(status);
      }).length;
      const impactScope = relationResult.value
        .map((relation) => relation.source.type === resource.resource.type && relation.source.id === resource.resource.id
          ? relation.target : relation.source)
        .filter((candidate) => !(candidate.type === resource.resource.type && candidate.id === resource.resource.id))
        .filter((candidate, index, all) => all.findIndex((item) => item.type === candidate.type && item.id === candidate.id) === index)
        .slice(0, 64);

      return {
        resource: resource.resource,
        label: resource.label,
        status: resource.status || 'unknown',
        quality,
        freshness,
        observedAt,
        unresolvedAlerts,
        relationCount: relationResult.value.length,
        impactScope,
        gaps,
      } satisfies ResourceOverviewItem;
    });

    const byType: Record<ResourceType, number> = { instance: 0, server: 0, network_device: 0 };
    const byStatus: Record<string, number> = {};
    for (const item of items) {
      byType[item.resource.type] += 1;
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    }
    const unresolvedAlerts = items.reduce((total, item) => total + item.unresolvedAlerts, 0);
    const impactedResources = new Set(items.flatMap((item) => item.impactScope.map((ref) => `${ref.type}:${ref.id}`))).size;
    const hasGaps = items.some((item) => item.gaps.length > 0);
    return {
      schemaVersion: 1,
      collectedAt: now.toISOString(),
      dataQuality: items.length === 0 ? 'empty' : hasGaps ? 'partial' : 'complete',
      summary: {
        total: items.length,
        byType,
        byStatus,
        fresh: items.filter((item) => item.freshness === 'fresh').length,
        stale: items.filter((item) => item.freshness === 'stale').length,
        missing: items.filter((item) => item.freshness === 'missing').length,
        unresolvedAlerts,
        impactedResources,
      },
      items,
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
    const relatedRefs = relations
      .map((relation) => relation.source.type === ref.type && relation.source.id === ref.id ? relation.target : relation.source)
      .filter((candidate) => candidate.type !== ref.type || candidate.id !== ref.id)
      .filter((candidate, index, all) => all.findIndex((item) => item.type === candidate.type && item.id === candidate.id) === index)
      .slice(0, MAX_RELATED_RESOURCES);
    const relatedItems = await mapWithConcurrency(relatedRefs, 4, async (relatedRef) => {
      // Relationship visibility is never a substitute for target visibility.
      if (!canReadResource(actor, relatedRef)) return null;
      const relatedRelations = relations.filter((relation) =>
        (relation.source.type === relatedRef.type && relation.source.id === relatedRef.id)
        || (relation.target.type === relatedRef.type && relation.target.id === relatedRef.id));
      try {
        const relatedResource = await this.dependencies.detail(relatedRef, actor);
        if (!relatedResource) return null;
        const [relatedObservations, relatedAlerts] = await Promise.all([
          this.dependencies.observations(relatedRef, actor, { limit: MAX_RELATED_OBSERVATIONS }),
          this.dependencies.alerts(relatedRef, actor, MAX_RELATED_ALERTS),
        ]);
        return {
          resource: relatedResource,
          relations: relatedRelations,
          observations: relatedObservations.slice(0, MAX_RELATED_OBSERVATIONS),
          alerts: relatedAlerts.slice(0, MAX_RELATED_ALERTS),
          gaps: observationGaps(relatedObservations, 'related_observation'),
          priority: evidencePriority(relatedObservations, relatedAlerts),
        } satisfies RelatedResourceEvidence;
      } catch {
        return {
          resource: { resource: relatedRef, label: `${relatedRef.type}-${relatedRef.id}`, status: 'unknown', attributes: {} },
          relations: relatedRelations,
          observations: [],
          alerts: [],
          gaps: [{ scope: 'related_resource', code: 'RELATED_EVIDENCE_UNAVAILABLE' }],
          priority: 0,
        } satisfies RelatedResourceEvidence;
      }
    });
    const relatedEvidence = relatedItems
      .filter((item): item is RelatedResourceEvidence => item !== null)
      .sort((left, right) => right.priority - left.priority
        || `${left.resource.resource.type}:${left.resource.resource.id}`.localeCompare(`${right.resource.resource.type}:${right.resource.resource.id}`));
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
      relatedEvidence,
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
  const networkQualityColumns = ref.type === 'network_device' ? ', x.quality, x.source' : '';
  const [rows] = await pool.execute<any[]>(
    `SELECT x.${metricColumn} AS metricId, x.metric_value AS value, x.${timeColumn} AS observedAt${networkQualityColumns}, x.dimensions
     FROM ${table} x JOIN (SELECT ${metricColumn} AS metric_id, MAX(${timeColumn}) AS latest_at FROM ${table} WHERE ${idColumn} = ? GROUP BY ${metricColumn}) latest
       ON latest.metric_id = x.${metricColumn} AND latest.latest_at = x.${timeColumn}
     WHERE x.${idColumn} = ? ORDER BY x.${timeColumn} DESC LIMIT ${limit}`, [ref.id, ref.id]);
  return rows.map((row) => {
    let dimensions: Record<string, string> | undefined;
    try { dimensions = typeof row.dimensions === 'string' ? JSON.parse(row.dimensions) : row.dimensions ?? undefined; } catch { dimensions = undefined; }
    const observedAt = row.observedAt ? new Date(row.observedAt) : null;
    return { resource: ref, metricId: String(row.metricId), value: row.value == null ? null : Number(row.value), observedAt,
      validUntil: observedAt ? new Date(observedAt.getTime() + 5 * 60_000) : null, dimensions, source: String(row.source ?? table),
      quality: ref.type === 'network_device' ? (row.quality ?? (row.value == null ? 'unknown' : 'good')) : (row.value == null ? 'unknown' : 'good'), } as Observation;
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
     FROM alerts WHERE network_device_id = ? ORDER BY created_at DESC LIMIT ${limit}`, [ref.id]);
  return rows;
}

export const resourceDiagnosticService = new ResourceDiagnosticService({
  list: defaultList,
  detail: async (ref, actor) => resourceService.detail(actor, ref),
  observations: defaultObservations,
  relations: async (ref, actor) => resourceService.currentRelations(actor, ref),
  alerts: defaultAlerts,
});
