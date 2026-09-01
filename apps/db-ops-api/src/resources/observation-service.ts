import { canonicalDimensions, type Observation, type ObservationQuality, type ResourceRef } from './types.js';
import type { ActorContext } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import { canReadResource } from './resource-service.js';

export function latestObservation(input: { resource: ResourceRef; metricId: string; value?: number | null; observedAt?: Date | null; validForMs: number; now?: Date; source: string; }): Observation {
  const now = input.now ?? new Date();
  const observedAt = input.observedAt ?? null;
  if (input.value == null || !observedAt) return { resource: input.resource, metricId: input.metricId, value: null, observedAt, validUntil: null, source: input.source, quality: 'unknown', reason: 'missing_observation' };
  const validUntil = new Date(observedAt.getTime() + input.validForMs);
  const quality: ObservationQuality = validUntil <= now ? 'unknown' : 'good';
  return { resource: input.resource, metricId: input.metricId, value: input.value, observedAt, validUntil, source: input.source, quality, reason: quality === 'unknown' ? 'stale_observation' : undefined };
}

export interface ObservationStore {
  latestInstanceMetric(id: number, metricId: string): Promise<ObservationRow | null>;
  latestServerMetric(id: number, metricId: string): Promise<ObservationRow | null>;
  rangeInstanceMetric(id: number, metricId: string, from: Date, to: Date, limit: number): Promise<ObservationRow[]>;
  rangeServerMetric(id: number, metricId: string, from: Date, to: Date, limit: number): Promise<ObservationRow[]>;
  latestNetworkDeviceMetric?(id: number, metricId: string): Promise<ObservationRow | null>;
  rangeNetworkDeviceMetric?(id: number, metricId: string, from: Date, to: Date, limit: number): Promise<ObservationRow[]>;
}

export interface ObservationRow { metricId?: string; value: number | null; observedAt: Date | null; dimensions?: Record<string, string>; }

export function normalizeMetricIdentity(metricId: string): { metricId: string; dimensions?: Record<string, string> } {
  const canonicalId = metricId.replace(/^server_/, '');
  const disk = /^disk_usage_(.+)$/.exec(canonicalId);
  return disk ? { metricId: 'disk_usage', dimensions: canonicalDimensions({ mount: disk[1] }) } : { metricId: canonicalId };
}

export class ObservationService {
  constructor(private readonly store: ObservationStore) {}

  async latest(actor: ActorContext, resource: ResourceRef, metricId: string, options: { now?: Date; validForMs: number }): Promise<Observation> {
    if (!canReadResource(actor, resource)) throw new Error('RESOURCE_FORBIDDEN');
    const row = resource.type === 'instance'
      ? await this.store.latestInstanceMetric(resource.id, metricId)
      : resource.type === 'server'
        ? await this.store.latestServerMetric(resource.id, metricId)
        : await (this.store.latestNetworkDeviceMetric?.(resource.id, metricId) ?? Promise.resolve(null));
    const identity = normalizeMetricIdentity(row?.metricId ?? metricId);
    const source = resource.type === 'instance' ? 'metrics_history' : resource.type === 'server' ? 'server_metrics' : 'network_device_observations';
    return { ...latestObservation({ resource, metricId: identity.metricId, value: row?.value, observedAt: row?.observedAt, source, ...options }), dimensions: canonicalDimensions(row?.dimensions ?? identity.dimensions) };
  }

  async range(actor: ActorContext, resource: ResourceRef, metricId: string, options: { from: Date; to: Date; validForMs: number; limit?: number; now?: Date }): Promise<Observation[]> {
    if (!canReadResource(actor, resource)) throw new Error('RESOURCE_FORBIDDEN');
    if (Number.isNaN(options.from.getTime()) || Number.isNaN(options.to.getTime()) || options.to <= options.from || options.to.getTime() - options.from.getTime() > 31 * 86_400_000) throw new Error('OBSERVATION_RANGE_INVALID');
    const limit = Math.max(1, Math.min(options.limit ?? 200, 1_000));
    const rows = resource.type === 'instance'
      ? await this.store.rangeInstanceMetric(resource.id, metricId, options.from, options.to, limit)
      : resource.type === 'server'
        ? await this.store.rangeServerMetric(resource.id, metricId, options.from, options.to, limit)
        : await (this.store.rangeNetworkDeviceMetric?.(resource.id, metricId, options.from, options.to, limit) ?? Promise.resolve([]));
    const source = resource.type === 'instance' ? 'metrics_history' : resource.type === 'server' ? 'server_metrics' : 'network_device_observations';
    return rows.slice(0, limit).map((row) => {
      const identity = normalizeMetricIdentity(row.metricId ?? metricId);
      return { ...latestObservation({ resource, metricId: identity.metricId, value: row.value, observedAt: row.observedAt, source, validForMs: options.validForMs, now: options.now }), dimensions: canonicalDimensions(row.dimensions ?? identity.dimensions) };
    });
  }
}

interface SqlPool { execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>; }
const INSTANCE_METRICS = new Set(['cpu_usage', 'memory_usage', 'disk_usage', 'connections', 'qps', 'tps', 'active_transactions', 'slow_queries']);

export class MysqlObservationStore implements ObservationStore {
  constructor(private readonly poolProvider: () => SqlPool | null = () => dbConnection.getPool() as unknown as SqlPool | null) {}
  async latestInstanceMetric(id: number, metricId: string): Promise<ObservationRow | null> {
    if (!INSTANCE_METRICS.has(metricId)) throw new Error('METRIC_ID_UNSUPPORTED');
    const [rows] = await this.pool().execute<Array<any>>(`SELECT ${metricId} AS value, recorded_at AS observedAt FROM metrics_history WHERE instance_id = ? AND ${metricId} IS NOT NULL ORDER BY recorded_at DESC, id DESC LIMIT 1`, [id]);
    return rows[0] ? { value: rows[0].value == null ? null : Number(rows[0].value), observedAt: rows[0].observedAt ? new Date(rows[0].observedAt) : null } : null;
  }
  async latestServerMetric(id: number, metricId: string): Promise<ObservationRow | null> {
    const names = metricId === 'disk_usage' ? ['disk_usage', 'server_disk_usage'] : [metricId, `server_${metricId}`];
    const [rows] = await this.pool().execute<Array<any>>('SELECT metric_name AS metricId, dimensions, metric_value AS value, recorded_at AS observedAt FROM server_metrics WHERE server_id = ? AND (metric_name IN (?, ?) OR (? = \'disk_usage\' AND metric_name LIKE \'disk_usage_%\')) ORDER BY recorded_at DESC LIMIT 1', [id, names[0], names[1], metricId]);
    return rows[0] ? { metricId: rows[0].metricId, dimensions: parseDimensions(rows[0].dimensions), value: Number(rows[0].value), observedAt: rows[0].observedAt ? new Date(rows[0].observedAt) : null } : null;
  }
  async rangeInstanceMetric(id: number, metricId: string, from: Date, to: Date, limit: number): Promise<ObservationRow[]> {
    if (!INSTANCE_METRICS.has(metricId)) throw new Error('METRIC_ID_UNSUPPORTED');
    const [rows] = await this.pool().execute<Array<any>>(`SELECT ${metricId} AS value, recorded_at AS observedAt FROM metrics_history WHERE instance_id = ? AND ${metricId} IS NOT NULL AND recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at DESC, id DESC LIMIT ${limit}`, [id, from, to]);
    return rows.map((row) => ({ value: row.value == null ? null : Number(row.value), observedAt: row.observedAt ? new Date(row.observedAt) : null }));
  }
  async rangeServerMetric(id: number, metricId: string, from: Date, to: Date, limit: number): Promise<ObservationRow[]> {
    const names = metricId === 'disk_usage' ? ['disk_usage', 'server_disk_usage'] : [metricId, `server_${metricId}`];
    const [rows] = await this.pool().execute<Array<any>>(`SELECT metric_name AS metricId, dimensions, metric_value AS value, recorded_at AS observedAt FROM server_metrics WHERE server_id = ? AND recorded_at >= ? AND recorded_at <= ? AND (metric_name IN (?, ?) OR (? = 'disk_usage' AND metric_name LIKE 'disk_usage_%')) ORDER BY recorded_at DESC LIMIT ${limit}`, [id, from, to, names[0], names[1], metricId]);
    return rows.map((row) => ({ metricId: row.metricId, dimensions: parseDimensions(row.dimensions), value: Number(row.value), observedAt: row.observedAt ? new Date(row.observedAt) : null }));
  }
  async latestNetworkDeviceMetric(id: number, metricId: string): Promise<ObservationRow | null> {
    assertNetworkMetricId(metricId);
    const [rows] = await this.pool().execute<Array<any>>(
      `SELECT metric_id AS metricId, dimensions, metric_value AS value, observed_at AS observedAt
       FROM network_device_observations
       WHERE device_id = ? AND metric_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1`,
      [id, metricId],
    );
    return rows[0] ? { metricId: rows[0].metricId, dimensions: parseDimensions(rows[0].dimensions), value: rows[0].value == null ? null : Number(rows[0].value), observedAt: rows[0].observedAt ? new Date(rows[0].observedAt) : null } : null;
  }
  async rangeNetworkDeviceMetric(id: number, metricId: string, from: Date, to: Date, limit: number): Promise<ObservationRow[]> {
    assertNetworkMetricId(metricId);
    const [rows] = await this.pool().execute<Array<any>>(
      `SELECT metric_id AS metricId, dimensions, metric_value AS value, observed_at AS observedAt
       FROM network_device_observations
       WHERE device_id = ? AND metric_id = ? AND observed_at >= ? AND observed_at <= ?
       ORDER BY observed_at DESC, id DESC LIMIT ${limit}`,
      [id, metricId, from, to],
    );
    return rows.map((row) => ({ metricId: row.metricId, dimensions: parseDimensions(row.dimensions), value: row.value == null ? null : Number(row.value), observedAt: row.observedAt ? new Date(row.observedAt) : null }));
  }
  private pool(): SqlPool { const pool = this.poolProvider(); if (!pool) throw new Error('RESOURCE_STORE_UNAVAILABLE'); return pool; }
}

function assertNetworkMetricId(metricId: string): void {
  if (!/^(?:device_(?:reachability|uptime_seconds|cpu_percent|memory_percent|temperature_celsius)|interface_[a-z0-9_]+)$/.test(metricId)) {
    throw new Error('METRIC_ID_UNSUPPORTED');
  }
}

function parseDimensions(value: unknown): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    return Object.fromEntries(entries);
  } catch {
    return undefined;
  }
}

export const observationService = new ObservationService(new MysqlObservationStore());
