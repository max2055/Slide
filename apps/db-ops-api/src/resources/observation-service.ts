import type { Observation, ObservationQuality, ResourceRef } from './types.js';
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
  latestInstanceMetric(id: number, metricId: string): Promise<{ value: number | null; observedAt: Date | null } | null>;
  latestServerMetric(id: number, metricId: string): Promise<{ value: number | null; observedAt: Date | null } | null>;
}

export class ObservationService {
  constructor(private readonly store: ObservationStore) {}

  async latest(actor: ActorContext, resource: ResourceRef, metricId: string, options: { now?: Date; validForMs: number }): Promise<Observation> {
    if (!canReadResource(actor, resource)) throw new Error('RESOURCE_FORBIDDEN');
    const row = resource.type === 'instance'
      ? await this.store.latestInstanceMetric(resource.id, metricId)
      : await this.store.latestServerMetric(resource.id, metricId);
    return latestObservation({ resource, metricId, value: row?.value, observedAt: row?.observedAt, source: resource.type === 'instance' ? 'metrics_history' : 'server_metrics', ...options });
  }
}

interface SqlPool { execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>; }
const INSTANCE_METRICS = new Set(['cpu_usage', 'memory_usage', 'disk_usage', 'connections', 'qps', 'tps', 'active_transactions', 'slow_queries']);

export class MysqlObservationStore implements ObservationStore {
  constructor(private readonly poolProvider: () => SqlPool | null = () => dbConnection.getPool() as unknown as SqlPool | null) {}
  async latestInstanceMetric(id: number, metricId: string): Promise<{ value: number | null; observedAt: Date | null } | null> {
    if (!INSTANCE_METRICS.has(metricId)) throw new Error('METRIC_ID_UNSUPPORTED');
    const [rows] = await this.pool().execute<Array<any>>(`SELECT ${metricId} AS value, recorded_at AS observedAt FROM metrics_history WHERE instance_id = ? ORDER BY recorded_at DESC LIMIT 1`, [id]);
    return rows[0] ? { value: rows[0].value == null ? null : Number(rows[0].value), observedAt: rows[0].observedAt ? new Date(rows[0].observedAt) : null } : null;
  }
  async latestServerMetric(id: number, metricId: string): Promise<{ value: number | null; observedAt: Date | null } | null> {
    const [rows] = await this.pool().execute<Array<any>>('SELECT metric_value AS value, recorded_at AS observedAt FROM server_metrics WHERE server_id = ? AND metric_name = ? ORDER BY recorded_at DESC LIMIT 1', [id, metricId]);
    return rows[0] ? { value: Number(rows[0].value), observedAt: rows[0].observedAt ? new Date(rows[0].observedAt) : null } : null;
  }
  private pool(): SqlPool { const pool = this.poolProvider(); if (!pool) throw new Error('RESOURCE_STORE_UNAVAILABLE'); return pool; }
}

export const observationService = new ObservationService(new MysqlObservationStore());
