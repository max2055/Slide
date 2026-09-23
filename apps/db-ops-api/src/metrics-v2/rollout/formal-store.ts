import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { MetricDefinition, NormalizedObservation } from '../../contracts/metrics-v2/index.js';
import type { Ref } from '../policy/model.js';
import { MysqlMetricStorage, seriesHash, type Series } from '../storage.js';

const decode = <T>(v: T | string): T => typeof v === 'string' ? JSON.parse(v) : v;
const sqlTime = (at: string) => new Date(at).toISOString().slice(0, 23).replace('T', ' ');
const formal = `FROM metric_v2_publications p
  JOIN metric_v2_observations o ON o.id = p.observation_id AND o.series_hash = p.series_hash
  JOIN metric_v2_rollout r ON r.series_hash = p.series_hash
  WHERE r.read_mode = 'v2' AND r.applied_revision = r.published_revision
  AND o.stage = 'normalized' AND o.payload IS NOT NULL`;

/** Formal consumers never fall back to unaccepted shadow evidence. Invalid/unknown values remain visible. */
export class MysqlFormalMetricStore {
  constructor(private readonly pool: Pool) {}

  inventory(type: Series['resource_type'], id: string) { return new MysqlMetricStorage(this.pool).inventory(type, id); }

  async queryWindow(series: Series, from: string, to: string, limit = 1000): Promise<NormalizedObservation[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isFinite(Date.parse(from))
      || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from)
      || Date.parse(to) - Date.parse(from) > 31 * 86400000) throw new Error('ROLLOUT_QUERY_RANGE');
    // Consistent snapshot across prior/window/next, so a concurrent rollback cannot mix read modes.
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const [control] = await c.execute<RowDataPacket[]>('SELECT read_mode, published_revision, applied_revision FROM metric_v2_rollout WHERE series_hash = ? FOR UPDATE', [seriesHash(series)]);
      if (!control.length || control[0].read_mode !== 'v2' || control[0].published_revision !== control[0].applied_revision) {
        await c.commit(); return [];
      }
      const base = `SELECT o.payload ${formal} AND p.series_hash = ?`;
      const [prior] = await c.execute<RowDataPacket[]>(`${base} AND p.observed_at < ? ORDER BY p.observed_at DESC, p.observation_id DESC LIMIT 1`, [seriesHash(series), sqlTime(from)]);
      const [rows] = await c.execute<RowDataPacket[]>(`${base} AND p.observed_at >= ? AND p.observed_at < ? ORDER BY p.observed_at, p.observation_id LIMIT ${limit + 1}`, [seriesHash(series), sqlTime(from), sqlTime(to)]);
      if (rows.length > limit) throw new Error('QUERY_LIMIT_EXCEEDED');
      const [next] = await c.execute<RowDataPacket[]>(`${base} AND p.observed_at >= ? ORDER BY p.observed_at, p.observation_id DESC LIMIT 1`, [seriesHash(series), sqlTime(to)]);
      await c.commit();
      return [...prior, ...rows, ...next].map(r => decode<NormalizedObservation>(r.payload));
    } catch (error) { await c.rollback(); throw error; } finally { c.release(); }
  }

  async dimensions(ref: Ref, d: MetricDefinition, from: string, to: string): Promise<Record<string, string>[]> {
    if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from)
      || Date.parse(to) - Date.parse(from) > 31 * 86400000) throw new Error('ROLLOUT_QUERY_RANGE');
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT DISTINCT JSON_EXTRACT(o.payload, '$.dimensions') AS dimensions ${formal}
      AND r.resource_type = ? AND r.resource_id = ?
      AND JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.metric.id')) = ? AND JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.metric.semantic_version')) = ?
      AND p.observed_at >= ? AND p.observed_at < ? LIMIT 101`, [ref.type, String(ref.id), d.id, d.semantic_version,
      sqlTime(new Date(Date.parse(from) - 86400000).toISOString()), sqlTime(to)]);
    return rows.map(r => decode<Record<string, string>>(r.dimensions));
  }
}
