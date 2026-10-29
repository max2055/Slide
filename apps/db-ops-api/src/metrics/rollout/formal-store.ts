import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { MetricDefinition, NormalizedObservation } from '../../contracts/metrics/index.js';
import { RefSchema, type Ref } from '../policy/model.js';
import { OBSERVATION_PAGE_MAX_LIMIT, type ObservationPageOptions, type ObservationPageResult } from '../observations/page.js';
import { MysqlMetricStorage, seriesHash, type Series } from '../storage.js';

const decode = <T>(v: T | string): T => typeof v === 'string' ? JSON.parse(v) : v;
const sqlTime = (at: string) => new Date(at).toISOString().slice(0, 23).replace('T', ' ');
// Publication keys are utf8mb4; observation keys are ascii_bin. Convert only the
// publication side to keep observation PRIMARY lookups. Byte equality also rejects
// lossy conversion, case folding and trailing-space aliases of evidence identities.
const formal = `FROM metric_publications p
  JOIN metric_observations o ON o.id = CONVERT(p.observation_id USING ascii) COLLATE ascii_bin
    AND o.series_hash = CONVERT(p.series_hash USING ascii) COLLATE ascii_bin
    AND CAST(o.id AS BINARY) = CAST(p.observation_id AS BINARY)
    AND CAST(o.series_hash AS BINARY) = CAST(p.series_hash AS BINARY)
  JOIN metric_rollout r ON r.series_hash = p.series_hash
  WHERE r.read_mode = 'semantic' AND r.applied_revision = r.published_revision
  AND r.source = 'semantic' AND p.generation = r.generation
  AND JSON_EXTRACT(o.payload, '$.versions.config_revision') = r.published_revision
  AND NOT EXISTS (SELECT 1 FROM metric_policy_bindings b WHERE b.resource_key = CONCAT(r.resource_type, ':', r.resource_id)
    AND JSON_EXTRACT(b.payload, '$.binding.revision') <> r.published_revision)
  AND o.stage = 'normalized' AND o.payload IS NOT NULL`;

/** Bounded reads: `page_rows` caps one statement, `max_rows` caps the whole series window. */
export interface WindowReadLimits { page_rows: number; max_rows: number }
/** 31 days at the 60s default interval is 44,640 samples; denser custom windows fail closed. */
export const DEFAULT_WINDOW_READ_LIMITS: WindowReadLimits = { page_rows: 1000, max_rows: 50_000 };

/** Formal consumers never fall back to unaccepted shadow evidence. Invalid/unknown values remain visible. */
export class MysqlFormalMetricStore {
  constructor(private readonly pool: Pool, private readonly limits: WindowReadLimits = DEFAULT_WINDOW_READ_LIMITS) {}

  /** Historical source states are migration facts, never a fallback to historical metric tables. */
  async sourceState(input: Ref): Promise<'legacy' | 'semantic' | 'pending'> {
    const ref = RefSchema.parse(input);
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT COUNT(*) AS total,
      SUM(source = 'legacy' AND read_mode = 'legacy' AND applied_revision = published_revision) AS legacy_count,
      SUM(source = 'semantic' AND read_mode = 'semantic' AND applied_revision = published_revision
        AND NOT EXISTS (SELECT 1 FROM metric_policy_bindings b WHERE b.resource_key = CONCAT(r.resource_type, ':', r.resource_id)
          AND JSON_EXTRACT(b.payload, '$.binding.revision') <> r.published_revision)) AS semantic_count
      FROM metric_rollout r WHERE resource_type = ? AND resource_id = ? AND source <> 'retired'`, [ref.type, String(ref.id)]);
    const total = Number(rows[0]?.total);
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('ROLLOUT_SOURCE_STATE');
    if (total === 0 || Number(rows[0].legacy_count) === total) return 'pending';
    return Number(rows[0].semantic_count) === total ? 'semantic' : 'pending';
  }

  inventory(type: Series['resource_type'], id: string) { return new MysqlMetricStorage(this.pool).inventory(type, id); }

  async baselineSamples(ref: Ref, definition: MetricDefinition, revision: number, from: string, to: string): Promise<NormalizedObservation[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT o.payload ${formal}
      AND r.resource_type=? AND r.resource_id=? AND r.published_revision=?
      AND JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.metric.id'))=? AND JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.metric.semantic_version'))=?
      AND p.observed_at>=? AND p.observed_at<? ORDER BY p.observed_at LIMIT 10001`,
    [ref.type,String(ref.id),revision,definition.id,definition.semantic_version,sqlTime(from),sqlTime(to)]);
    if(rows.length>10000)throw new Error('METRIC_BASELINE_SAMPLE_LIMIT');
    return rows.map(r=>decode<NormalizedObservation>(r.payload));
  }

  /** Latest accepted capacity only: shadow, rolled-back and old configuration samples are excluded. */
  async latestCapacity(ref: Ref, definition: MetricDefinition, to: string, revision: number): Promise<NormalizedObservation | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT o.payload ${formal}
      AND r.resource_type = ? AND r.resource_id = ?
      AND JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.metric.id')) = ?
      AND JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.metric.semantic_version')) = ?
      AND JSON_EXTRACT(o.payload, '$.versions.config_revision') = ? AND p.observed_at < ?
      ORDER BY p.observed_at DESC, p.observation_id DESC LIMIT 1`,
    [ref.type, String(ref.id), definition.id, definition.semantic_version, revision, sqlTime(to)]);
    return rows.length ? decode<NormalizedObservation>(rows[0].payload) : null;
  }

  async queryWindow(series: Series, from: string, to: string, limit = 1000): Promise<NormalizedObservation[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isFinite(Date.parse(from))
      || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from)
      || Date.parse(to) - Date.parse(from) > 31 * 86400000) throw new Error('ROLLOUT_QUERY_RANGE');
    // Consistent snapshot across prior/window/next, so a concurrent rollback cannot mix read modes.
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const [control] = await c.execute<RowDataPacket[]>('SELECT read_mode, published_revision, applied_revision FROM metric_rollout WHERE series_hash = ? FOR UPDATE', [seriesHash(series)]);
      if (!control.length || control[0].read_mode !== 'semantic' || control[0].published_revision !== control[0].applied_revision) {
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

  /**
   * Complete half-open [from, to) read of one series plus the predecessor and
   * successor samples the reducers need at the window edges. Rows are read in
   * deterministic ascending (observed_at, observation_id) keyset pages inside one
   * REPEATABLE READ snapshot with the rollout row locked: a page boundary cannot
   * duplicate or skip same-timestamp rows, and a concurrent switch or rollback
   * cannot mix read modes or leak a newer fact into a later page. The cursor is
   * internal to this call, never reused across requests, so every read runs the
   * caller's current authorization. Exceeding max_rows fails closed instead of
   * returning a silently truncated window.
   */
  async readWindow(series: Series, from: string, to: string): Promise<NormalizedObservation[]> {
    const { page_rows: pageRows, max_rows: maxRows } = this.limits;
    if (!Number.isInteger(pageRows) || pageRows < 1 || !Number.isInteger(maxRows) || maxRows < pageRows
      || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from)
      || Date.parse(to) - Date.parse(from) > 31 * 86400000) throw new Error('ROLLOUT_QUERY_RANGE');
    const key = seriesHash(series);
    // Same consistent snapshot as queryWindow, held across every page.
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const [control] = await c.execute<RowDataPacket[]>('SELECT read_mode, published_revision, applied_revision FROM metric_rollout WHERE series_hash = ? FOR UPDATE', [key]);
      if (!control.length || control[0].read_mode !== 'semantic' || control[0].published_revision !== control[0].applied_revision) {
        await c.commit(); return [];
      }
      const base = `SELECT o.payload, p.observation_id AS publication_id ${formal} AND p.series_hash = ?`;
      const [prior] = await c.execute<RowDataPacket[]>(`${base} AND p.observed_at < ?
        ORDER BY p.observed_at DESC, p.observation_id DESC LIMIT 1`, [key, sqlTime(from)]);
      const rows: NormalizedObservation[] = [];
      let cursor: { at: string; id: string } | null = null;
      for (;;) {
        const page = cursor
          ? (await c.execute<RowDataPacket[]>(`${base} AND p.observed_at >= ? AND p.observed_at < ?
              AND (p.observed_at > ? OR (p.observed_at = ? AND p.observation_id > ?))
              ORDER BY p.observed_at, p.observation_id LIMIT ${pageRows}`,
            [key, sqlTime(from), sqlTime(to), cursor.at, cursor.at, cursor.id]))[0]
          : (await c.execute<RowDataPacket[]>(`${base} AND p.observed_at >= ? AND p.observed_at < ?
              ORDER BY p.observed_at, p.observation_id LIMIT ${pageRows}`,
            [key, sqlTime(from), sqlTime(to)]))[0];
        const decoded = page.map(r => decode<NormalizedObservation>(r.payload));
        rows.push(...decoded);
        if (rows.length > maxRows) throw new Error('QUERY_LIMIT_EXCEEDED');
        if (page.length < pageRows) break;
        const last = decoded[decoded.length - 1];
        cursor = { at: sqlTime(last.observed_at), id: String(page[page.length - 1].publication_id) };
      }
      const [next] = await c.execute<RowDataPacket[]>(`${base} AND p.observed_at >= ?
        ORDER BY p.observed_at, p.observation_id DESC LIMIT 1`, [key, sqlTime(to)]);
      await c.commit();
      return [...prior.map(r => decode<NormalizedObservation>(r.payload)), ...rows, ...next.map(r => decode<NormalizedObservation>(r.payload))];
    } catch (error) { await c.rollback(); throw error; } finally { c.release(); }
  }

  /**
   * One authorized page of formal raw observations in the half-open [from, to).
   * The total, page and has_more share one REPEATABLE READ snapshot; the cursor is a
   * strict keyset (observed_at, observation_id), so a page boundary can neither repeat
   * nor skip rows that share a timestamp. There is no aggregate predecessor/successor,
   * no zero fill, and a window above max_rows fails closed instead of reporting a
   * truncated total.
   */
  async readObservationPage(series: Series, from: string, to: string, options: ObservationPageOptions): Promise<ObservationPageResult> {
    const { limit, after } = options;
    const { max_rows: maxRows } = this.limits;
    if (!Number.isInteger(limit) || limit < 1 || limit > OBSERVATION_PAGE_MAX_LIMIT || !Number.isSafeInteger(maxRows) || maxRows < 1
      || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from)
      || Date.parse(to) - Date.parse(from) > 31 * 86400000) throw new Error('ROLLOUT_QUERY_RANGE');
    const key = seriesHash(series);
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const [control] = await c.execute<RowDataPacket[]>('SELECT read_mode, published_revision, applied_revision FROM metric_rollout WHERE series_hash = ? FOR UPDATE', [key]);
      if (!control.length || control[0].read_mode !== 'semantic' || control[0].published_revision !== control[0].applied_revision) {
        await c.commit();
        return { observations: [], total: 0, has_more: false, next: null };
      }
      const [counted] = await c.execute<RowDataPacket[]>(`SELECT COUNT(*) AS total ${formal}
        AND p.series_hash = ? AND p.observed_at >= ? AND p.observed_at < ?`, [key, sqlTime(from), sqlTime(to)]);
      const total = Number(counted[0]?.total);
      if (!Number.isSafeInteger(total) || total < 0) throw new Error('ROLLOUT_QUERY_COUNT');
      if (total > maxRows) throw new Error('QUERY_LIMIT_EXCEEDED');
      const base = `SELECT o.payload, p.observation_id AS publication_id ${formal} AND p.series_hash = ?
        AND p.observed_at >= ? AND p.observed_at < ?`;
      const [page] = after
        ? await c.execute<RowDataPacket[]>(`${base}
            AND (p.observed_at > ? OR (p.observed_at = ? AND p.observation_id > ?))
            ORDER BY p.observed_at, p.observation_id LIMIT ${limit + 1}`,
          [key, sqlTime(from), sqlTime(to), after.at, after.at, after.id])
        : await c.execute<RowDataPacket[]>(`${base}
            ORDER BY p.observed_at, p.observation_id LIMIT ${limit + 1}`, [key, sqlTime(from), sqlTime(to)]);
      const rows = page.slice(0, limit), hasMore = page.length > limit;
      const observations = rows.map(r => decode<NormalizedObservation>(r.payload));
      const last = observations.at(-1);
      const result: ObservationPageResult = { observations, total, has_more: hasMore,
        next: hasMore && last ? { at: sqlTime(last.observed_at), id: String(rows[rows.length - 1].publication_id) } : null };
      await c.commit();
      return result;
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
