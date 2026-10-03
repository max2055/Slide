import { configuredRetention, validateRetention, observationSelections, retentionPreview, retentionIds, deleteRetentionIds, type RetentionGuard, type RetentionCounts } from './retention.js';
export { DEFAULT_RETENTION } from './retention.js';
import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { ResourceSchema, type Resource, type MetricDefinition } from '../contracts/metrics-v2/definitions.js';
import { CollectionAttemptSchema, type CollectionAttempt, type RawObservation, type NormalizedObservation } from '../contracts/metrics-v2/observations.js';
import { seriesIdentity, validateObservation, validateAttempt, validateAttemptTransition } from '../contracts/metrics-v2/validation.js';

export type StoredObservation = RawObservation | NormalizedObservation;
export type Series = Pick<NormalizedObservation, 'resource_type' | 'resource_id' | 'metric' | 'dimensions'>;
const DAY = 86_400_000;


function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const seriesHash = (series: Series) => hash(seriesIdentity(series));
const decode = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value;
// Use UTC SQL strings, independent of the mysql2 pool's timezone setting.
const sqlTime = (value: string | Date) => new Date(value).toISOString().slice(0, 23).replace('T', ' ');
const duplicate = (error: unknown) => (error as { code?: string }).code === 'ER_DUP_ENTRY';
function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('STORAGE_LIMIT');
  return limit;
}

/** Internal persistence adapter. Resource authorization remains at the calling service boundary. */
export class MysqlMetricStorage {
  private readonly retention: import('./retention.js').RetentionPolicy;
  constructor(private readonly pool: Pool, private readonly clock = () => new Date(), retention = configuredRetention()) {
    this.retention = validateRetention(retention);
  }

  async write(input: StoredObservation, definition: MetricDefinition): Promise<void> {
    // Validate before overwriting stored_at, so invalid supplied timestamps are not silently accepted.
    const parsed = validateObservation(input, definition);
    const now = this.clock();
    const observation = validateObservation({ ...parsed, observed_at: new Date(parsed.observed_at).toISOString(),
      collected_at: new Date(parsed.collected_at).toISOString(), stored_at: now.toISOString() }, definition);
    const digest = hash(stable({ ...observation, stored_at: null }));
    const payload = JSON.stringify(observation);
    if (Buffer.byteLength(payload) > 65536) throw new Error('OBSERVATION_TOO_LARGE');
    const insert = async (connection: Pool | PoolConnection) => {
      try {
        await connection.execute(`INSERT INTO metric_v2_observations
          (id, series_hash, stage, observed_at, stored_at, valid_value, payload, payload_hash, evidence_expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [observation.id, seriesHash(observation), observation.stage,
          sqlTime(observation.observed_at), sqlTime(now), observation.value !== null && ['good', 'partial'].includes(observation.quality.status),
          payload, digest, observation.stage === 'raw' ? sqlTime(new Date(now.getTime() + this.retention.rawMs)) : null]);
      } catch (error) {
        if (!duplicate(error)) throw error;
        const [rows] = await connection.execute<RowDataPacket[]>('SELECT payload_hash FROM metric_v2_observations WHERE id = ?', [observation.id]);
        if (rows[0]?.payload_hash !== digest) throw new Error('IDEMPOTENCY_PAYLOAD_CONFLICT');
        // Retried writes never refresh time or revive expired evidence.
      }
    };
    if (typeof this.pool.getConnection === 'function') await this.transaction(insert);
    else await insert(this.pool);
  }

  async latest(series: Series): Promise<NormalizedObservation | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT payload FROM metric_v2_observations
      WHERE series_hash = ? AND stage = 'normalized' AND valid_value = 1
      ORDER BY observed_at DESC, id DESC LIMIT 1`, [seriesHash(series)]);
    return rows[0] ? decode<NormalizedObservation>(rows[0].payload) : null;
  }

  async range(series: Series, from: string, to: string, limit = 200): Promise<NormalizedObservation[]> {
    boundedLimit(limit);
    if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from)
      || Date.parse(to) - Date.parse(from) > 31 * DAY) throw new Error('STORAGE_RANGE');
    // The latest index inserts valid_value before time; MySQL may choose it and filesort a long history.
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT payload FROM metric_v2_observations FORCE INDEX (idx_metric_v2_range)
      WHERE series_hash = ? AND stage = 'normalized' AND observed_at >= ? AND observed_at <= ?
      ORDER BY observed_at DESC, id DESC LIMIT ${limit}`, [seriesHash(series), sqlTime(from), sqlTime(to)]);
    return rows.map(row => decode<NormalizedObservation>(row.payload));
  }

  /** V2 aggregation uses half-open windows and needs the last prior sample for intervals crossing from. */
  async queryWindow(series: Series, from: string, to: string, limit = 1000): Promise<NormalizedObservation[]> {
    boundedLimit(limit);
    if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from)
      || Date.parse(to) - Date.parse(from) > 31 * DAY) throw new Error('STORAGE_RANGE');
    const key = seriesHash(series);
    const [prior] = await this.pool.execute<RowDataPacket[]>(`SELECT payload FROM metric_v2_observations FORCE INDEX (idx_metric_v2_range)
      WHERE series_hash = ? AND stage = 'normalized' AND observed_at < ?
      ORDER BY observed_at DESC, id DESC LIMIT 1`, [key, sqlTime(from)]);
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT payload FROM metric_v2_observations FORCE INDEX (idx_metric_v2_range)
      WHERE series_hash = ? AND stage = 'normalized' AND observed_at >= ? AND observed_at < ?
      ORDER BY observed_at ASC, id ASC LIMIT ${limit + 1}`, [key, sqlTime(from), sqlTime(to)]);
    if (rows.length > limit) throw new Error('QUERY_LIMIT_EXCEEDED');
    const [next] = await this.pool.execute<RowDataPacket[]>(`SELECT payload FROM metric_v2_observations FORCE INDEX (idx_metric_v2_range)
      WHERE series_hash = ? AND stage = 'normalized' AND observed_at >= ?
      ORDER BY observed_at ASC, id DESC LIMIT 1`, [key, sqlTime(to)]);
    return [...prior, ...rows, ...next].map(row => decode<NormalizedObservation>(row.payload));
  }

  async evidence(id: string): Promise<{ status: 'available'; observation: StoredObservation } | { status: 'expired' | 'not_retained'; tombstone?: Record<string, unknown> }> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT payload, tombstone,
      (stage = 'raw' AND (evidence_expires_at <= ? OR stored_at <= ?)) AS expired
      FROM metric_v2_observations WHERE id = ?`, [sqlTime(this.clock()), sqlTime(new Date(this.clock().getTime() - this.retention.rawMs)), id]);
    if (!rows[0]) return { status: 'not_retained' };
    if (!rows[0].payload || rows[0].expired) return { status: 'expired', ...(rows[0].tombstone ? { tombstone: decode<Record<string, unknown>>(rows[0].tombstone) } : {}) };
    return { status: 'available', observation: decode<StoredObservation>(rows[0].payload) };
  }

  async writeAttempt(input: CollectionAttempt): Promise<void> {
    validateAttempt(input);
    const next = CollectionAttemptSchema.parse(input);
    await this.transaction(async connection => {
      // Unique insert serializes competing initial states, including absent-row races.
      await connection.execute(`INSERT INTO metric_v2_attempts (id, payload, stored_at) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE id = metric_v2_attempts.id`, [next.id, JSON.stringify(next), sqlTime(this.clock())]);
      const [rows] = await connection.execute<RowDataPacket[]>('SELECT payload FROM metric_v2_attempts WHERE id = ? FOR UPDATE', [next.id]);
      validateAttemptTransition(decode(rows[0].payload), next);
      await connection.execute('UPDATE metric_v2_attempts SET payload = ? WHERE id = ?', [JSON.stringify(next), next.id]);
    });
  }

  async attempt(id: string): Promise<CollectionAttempt | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT payload FROM metric_v2_attempts WHERE id = ?', [id]);
    return rows[0] ? decode<CollectionAttempt>(rows[0].payload) : null;
  }

  async writeInventory(input: Resource): Promise<void> {
    const resource = ResourceSchema.parse(input);
    const key = hash(stable([resource.type, resource.id]));
    await this.transaction(async connection => {
      await connection.execute(`INSERT INTO metric_v2_inventory (resource_hash, payload) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE resource_hash = metric_v2_inventory.resource_hash`, [key, JSON.stringify(resource)]);
      const [rows] = await connection.execute<RowDataPacket[]>('SELECT payload FROM metric_v2_inventory WHERE resource_hash = ? FOR UPDATE', [key]);
      const previous = decode<Resource>(rows[0].payload);
      for (const [name, attribute] of Object.entries(resource.attributes)) {
        const old = previous.attributes[name];
        if (!old || Date.parse(attribute.observed_at) > Date.parse(old.observed_at)) previous.attributes[name] = attribute;
        else if (Date.parse(attribute.observed_at) === Date.parse(old.observed_at) && stable(attribute) !== stable(old)) throw new Error('INVENTORY_CONFLICT');
      }
      await connection.execute('UPDATE metric_v2_inventory SET payload = ? WHERE resource_hash = ?', [JSON.stringify(previous), key]);
    });
  }

  async inventory(type: Resource['type'], id: string): Promise<Resource | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT payload FROM metric_v2_inventory WHERE resource_hash = ?', [hash(stable([type, id]))]);
    return rows[0] ? decode<Resource>(rows[0].payload) : null;
  }

  /** Preview uses the same reference-aware predicates as execution; never reads raw values. */
  async preview(): Promise<RetentionCounts> {
    return this.transaction(c => retentionPreview(c, observationSelections(this.clock(), this.retention), this.clock()));
  }

  /** Every statement is bounded. Expiry drains before history; live references retain identity only. */
  async prune(limit = 1000, guard?: RetentionGuard): Promise<Record<string, number>> {
    boundedLimit(limit);
    return this.transaction(async c => {
      await guard?.(c);
      const selections = observationSelections(this.clock(), this.retention);
      const result: Record<string, number> = {};
      for (const [name, selection] of Object.entries(selections)) {
        await guard?.(c);
        const ids = await retentionIds(c, selection, limit);
        if (name === 'rawPayload' && ids.length) {
          const [updated] = await c.execute<any>(`UPDATE metric_v2_observations SET tombstone = JSON_OBJECT(
            'id', id, 'stage', stage, 'resource_type', JSON_EXTRACT(payload, '$.resource_type'),
            'resource_id', JSON_EXTRACT(payload, '$.resource_id'), 'metric', JSON_EXTRACT(payload, '$.metric'),
            'source', JSON_EXTRACT(payload, '$.source'), 'versions', JSON_EXTRACT(payload, '$.versions'),
            'observed_at', JSON_EXTRACT(payload, '$.observed_at'),
            'expired_at', LEAST(evidence_expires_at, TIMESTAMPADD(MICROSECOND, ?, stored_at)),
            'reason', 'raw_retention_expired'), payload = NULL, valid_value = 0
            WHERE id IN (${ids.map(() => '?').join(',')})`, [this.retention.rawMs * 1000, ...ids]);
          result[name] = Number(updated.affectedRows);
        } else result[name] = await deleteRetentionIds(c, selection, ids);
        // Do not delete identity/history while any full batch of raw payload expiry remains.
        if (name === 'rawPayload' && ids.length === limit) break;
      }
      await guard?.(c);
      return result;
    });
  }

  private async transaction<T>(action: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [lock] = await connection.query<RowDataPacket[]>('SELECT id FROM metric_v2_policy_lock WHERE id = 1 FOR UPDATE');
      if (lock.length !== 1) throw new Error('ROLLOUT_LOCK_UNAVAILABLE');
      const result = await action(connection);
      await connection.commit();
      return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
}
