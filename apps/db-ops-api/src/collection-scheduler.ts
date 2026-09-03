export type SchedulableMetric = { id: string; default_interval: number };
export type CollectionScheduleEntry = { metricId: string; lastSuccessMs?: number; nextDueMs: number; lastResult?: 'success' | 'failure' | 'skipped' };
export type CollectionResourceType = 'instance' | 'server' | 'network_device';

export interface CollectionScheduleStore {
  list(resourceType: CollectionResourceType, resourceId: number, providerId: string): Promise<CollectionScheduleEntry[]>;
  record(resourceType: CollectionResourceType, resourceId: number, providerId: string, metric: SchedulableMetric, nowMs: number, succeeded: boolean): Promise<void>;
}

export async function dueStoredMetricIds(store: CollectionScheduleStore, resourceType: CollectionResourceType, resourceId: number, providerId: string, definitions: readonly SchedulableMetric[], nowMs: number): Promise<string[]> {
  const existing = new Map((await store.list(resourceType, resourceId, providerId)).map((entry) => [entry.metricId, entry]));
  return definitions.filter((definition) => {
    const entry = existing.get(definition.id);
    if (!entry) return true;
    if (entry.lastResult === 'failure') return entry.nextDueMs <= nowMs;
    const nextDueMs = entry.lastSuccessMs === undefined
      ? entry.nextDueMs
      : entry.lastSuccessMs + definition.default_interval * 1000;
    return nextDueMs <= nowMs;
  }).map((definition) => definition.id);
}

interface SqlPool { execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>; }

export class MysqlCollectionScheduleStore implements CollectionScheduleStore {
  constructor(private readonly poolProvider: () => SqlPool | null) {}

  async list(resourceType: CollectionResourceType, resourceId: number, providerId: string): Promise<CollectionScheduleEntry[]> {
    const [rows] = await this.pool().execute<Array<any>>(
      'SELECT metric_id AS metricId, last_success_at AS lastSuccessAt, next_due_at AS nextDueAt, last_result AS lastResult FROM collection_schedule_state WHERE resource_type = ? AND resource_id = ? AND provider_id = ?',
      [resourceType, resourceId, providerId],
    );
    return rows.map((row) => ({ metricId: row.metricId, lastSuccessMs: row.lastSuccessAt ? new Date(row.lastSuccessAt).getTime() : undefined, nextDueMs: new Date(row.nextDueAt).getTime(), lastResult: row.lastResult ?? undefined }));
  }

  async record(resourceType: CollectionResourceType, resourceId: number, providerId: string, metric: SchedulableMetric, nowMs: number, succeeded: boolean): Promise<void> {
    const now = new Date(nowMs);
    const nextDue = succeeded ? new Date(nowMs + metric.default_interval * 1000) : now;
    await this.pool().execute(
      `INSERT INTO collection_schedule_state (resource_type, resource_id, provider_id, metric_id, last_success_at, next_due_at, last_result)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE last_success_at = IF(VALUES(last_result) = 'success', VALUES(last_success_at), last_success_at), next_due_at = VALUES(next_due_at), last_result = VALUES(last_result)`,
      [resourceType, resourceId, providerId, metric.id, succeeded ? now : null, nextDue, succeeded ? 'success' : 'failure'],
    );
  }

  private pool(): SqlPool {
    const pool = this.poolProvider();
    if (!pool) throw new Error('COLLECTION_SCHEDULE_STORE_UNAVAILABLE');
    return pool;
  }
}

export function dueMetricIds(definitions: readonly SchedulableMetric[], lastSuccessMs: ReadonlyMap<string, number>, nowMs: number): string[] {
  return definitions
    .filter((definition) => {
      const last = lastSuccessMs.get(definition.id);
      return last === undefined || nowMs - last >= definition.default_interval * 1000;
    })
    .map((definition) => definition.id);
}

export function recordCollectionResult(lastSuccessMs: Map<string, number>, metricId: string, nowMs: number, succeeded: boolean): void {
  if (succeeded) lastSuccessMs.set(metricId, nowMs);
}
