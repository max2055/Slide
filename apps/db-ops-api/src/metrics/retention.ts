import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { TemplateItemRetention } from '../contracts/metrics/templates.js';
import { metricKey } from './policy/model.js';
import type { MetricRef } from './templates/model.js';

export const DEFAULT_RETENTION = { rawMs: 7 * 86400000, historyMs: 30 * 86400000, attemptMs: 7 * 86400000 };
export const DEFAULT_TREND_RETENTION_MS = 365 * 86400000;
export const RETENTION_VALUE_TYPES = ['float64','int64','uint64','histogram','summary'] as const;
export type RetentionPolicy = typeof DEFAULT_RETENTION & { trendMs?: number; trendValueTypeMs?: Partial<Record<typeof RETENTION_VALUE_TYPES[number],number>>; valueTypeMs?: Partial<Record<typeof RETENTION_VALUE_TYPES[number],number>> };
export type RetentionCounts = Record<string, { count: number; oldestAt: string | null; oldestAgeMs: number | null }>;
/** Checks must not hold the lease row during mutations; commit fences ownership through COMMIT. */
export type RetentionGuard = (connection: PoolConnection, phase: 'check' | 'commit') => Promise<void>;
export const retentionSqlTime = (date: Date) => date.toISOString().slice(0, 23).replace('T', ' ');
export function validateRetention(policy: RetentionPolicy): RetentionPolicy {
  if(policy.trendMs!==undefined && (!Number.isSafeInteger(policy.trendMs)||policy.trendMs<300000||policy.trendMs>3650*86400000))throw new Error('RETENTION_INVALID');
  if ([policy.rawMs, policy.historyMs, policy.attemptMs].some(v => !Number.isSafeInteger(v) || v <= 0 || v > 3650 * 86400000) || policy.rawMs > policy.historyMs) throw new Error('RETENTION_INVALID');
  if(policy.valueTypeMs!==undefined && (policy.valueTypeMs===null || typeof policy.valueTypeMs!=='object' || Array.isArray(policy.valueTypeMs) || Object.entries(policy.valueTypeMs).some(([key,v])=>!RETENTION_VALUE_TYPES.includes(key as typeof RETENTION_VALUE_TYPES[number]) || !Number.isSafeInteger(v) || v===undefined || v<=0 || v>policy.historyMs)))throw new Error('RETENTION_INVALID');
  if(policy.trendValueTypeMs!==undefined && (policy.trendValueTypeMs===null || typeof policy.trendValueTypeMs!=='object' || Array.isArray(policy.trendValueTypeMs) || Object.entries(policy.trendValueTypeMs).some(([key,v])=>!RETENTION_VALUE_TYPES.includes(key as typeof RETENTION_VALUE_TYPES[number]) || !Number.isSafeInteger(v) || v===undefined || v<300000 || v>(policy.trendMs??DEFAULT_TREND_RETENTION_MS))))throw new Error('RETENTION_INVALID');
  return { rawMs: policy.rawMs, historyMs: policy.historyMs, attemptMs: policy.attemptMs,
    ...(policy.trendMs===undefined?{}:{trendMs:policy.trendMs}),
    ...(policy.trendValueTypeMs?{trendValueTypeMs:{...policy.trendValueTypeMs}}:{}),
    ...(policy.valueTypeMs?{valueTypeMs:{...policy.valueTypeMs}}:{}) };
}
export function configuredRetention(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  if (env.METRICS_RETENTION_ENABLED !== 'true') return { ...DEFAULT_RETENTION };
  let valueTypeMs:RetentionPolicy['valueTypeMs'];
  if(env.METRICS_RETENTION_VALUE_TYPES_JSON){try{valueTypeMs=JSON.parse(env.METRICS_RETENTION_VALUE_TYPES_JSON);if(!valueTypeMs)throw new Error();}catch{throw new Error('RETENTION_INVALID');}}
  let trendValueTypeMs:RetentionPolicy['trendValueTypeMs'];
  if(env.METRICS_RETENTION_TREND_VALUE_TYPES_JSON){try{trendValueTypeMs=JSON.parse(env.METRICS_RETENTION_TREND_VALUE_TYPES_JSON);if(!trendValueTypeMs)throw new Error();}catch{throw new Error('RETENTION_INVALID');}}
  return validateRetention({ rawMs: Number(env.METRICS_RETENTION_RAW_MS), historyMs: Number(env.METRICS_RETENTION_HISTORY_MS), attemptMs: Number(env.METRICS_RETENTION_ATTEMPT_MS),...(env.METRICS_RETENTION_TREND_MS?{trendMs:Number(env.METRICS_RETENTION_TREND_MS)}:{}),...(valueTypeMs?{valueTypeMs}:{}),...(trendValueTypeMs?{trendValueTypeMs}:{}) });
}
export type RetentionSelection = { table: string; key: string; time: string; where: string; params: unknown[] };

/** Under the binding writer's policy lock, activate overrides only for the applied items.
 * Removed metrics keep their last applied policy for any samples still on disk. */
export async function applyItemRetention(c: PoolConnection, resourceKey: string, selected: MetricRef[],
  overrides: Array<{ metric: MetricRef } & TemplateItemRetention>): Promise<void> {
  const keys = [...new Set(selected.map(metricKey))];
  if (!keys.length) return;
  const selection = `resource_key = ? AND metric_key IN (${keys.map(() => '?').join(',')})`;
  const [existing] = await c.execute<RowDataPacket[]>(
    `SELECT metric_key, history_ms, trends_ms FROM metric_item_retention WHERE ${selection}`, [resourceKey, ...keys]);
  const byKey = new Map(existing.map(row => [row.metric_key, row]));
  if (existing.length === overrides.length && overrides.every(({ metric, history_ms, trends_ms }) => {
    const current = byKey.get(metricKey(metric));
    return current && (current.history_ms == null ? undefined : Number(current.history_ms)) === history_ms
      && (current.trends_ms == null ? undefined : Number(current.trends_ms)) === trends_ms;
  })) return;

  await c.execute(`DELETE FROM metric_item_retention WHERE ${selection}`, [resourceKey, ...keys]);
  const values = overrides.map(({ metric, history_ms, trends_ms }) =>
    [resourceKey, metricKey(metric), history_ms ?? null, trends_ms ?? null]);
  if (values.length) {
    await c.execute(`INSERT INTO metric_item_retention (resource_key, metric_key, history_ms, trends_ms)
      VALUES ${values.map(() => '(?,?,?,?)').join(',')}`, values.flat());
  }
  await c.execute('UPDATE metric_retention_state SET item_policy_revision = item_policy_revision + 1 WHERE id = 1');
}

function itemRetentionLookup(json: 'o.payload' | 't.metadata', expression: string): string {
  const extract = (path: string) => `JSON_UNQUOTE(JSON_EXTRACT(${json}, '$.${path}'))`;
  const resource = json === 't.metadata' ? 't.resource_key' : `CONCAT(${extract('resource_type')}, ':', ${extract('resource_id')})`;
  const metric = `CONCAT(${extract('metric.id')}, '@', ${extract('metric.semantic_version')})`;
  const ascii = (input: string) => `CONVERT(${input} USING ascii) COLLATE ascii_bin`;
  return `(SELECT ${expression} FROM metric_item_retention ip
    WHERE ip.resource_key = ${ascii(resource)} AND ip.metric_key = ${ascii(metric)})`;
}

export function itemRetentionSql(field: keyof TemplateItemRetention, json: 'o.payload' | 't.metadata'): string {
  return itemRetentionLookup(json, `ip.${field}`);
}

const trendBucketMs = 300000;
const itemHistoryExpired = itemRetentionLookup('o.payload', `ip.history_ms = 0 OR
  o.observed_at < TIMESTAMPADD(MICROSECOND, -1000 * CAST(ip.history_ms AS SIGNED), CAST(? AS DATETIME(3)))`);

/** Historical reads exclude expired items while live alerts and lineage keep their evidence. */
export function itemHistoryVisible(now: Date): { sql: string; params: string[] } {
  return { sql: `NOT COALESCE(${itemHistoryExpired}, FALSE)`, params: [retentionSqlTime(now)] };
}

/** Live trend calculation uses the same bucket end as persisted trends. */
export function itemTrendVisible(now: Date, policy?: RetentionPolicy): { sql: string; params: (string | number)[] } {
  const offset = "TIMESTAMPDIFF(MICROSECOND, '1970-01-01', p.observed_at)";
  if (policy) {
    const cutoff = trendCutoff(now, policy, 'o.payload');
    return { sql: `FLOOR(${offset} / ${trendBucketMs * 1000}) * ${trendBucketMs} > ${cutoff.sql}`, params: cutoff.params };
  }
  const visible = itemRetentionLookup('o.payload', `ip.trends_ms <> 0 AND
    (FLOOR(${offset} / ${trendBucketMs * 1000}) + 1) * ${trendBucketMs} > ? - CAST(ip.trends_ms AS SIGNED)`);
  return { sql: `COALESCE(${visible}, TRUE)`, params: [now.getTime()] };
}

export function trendSelection(now:Date,policy:RetentionPolicy):RetentionSelection {
  const cutoff=trendCutoff(now,policy);
  return {table:'metric_retained_trends t',key:'series_hash',time:'bucket_ms',
    where:`(t.statistics->>'$.statistics_complete' = 'false' OR t.bucket_ms <= ${cutoff.sql})`,params:cutoff.params};
}
export function trendCutoff(now:Date,policy:Pick<RetentionPolicy,'trendMs'|'trendValueTypeMs'>, json: 'o.payload' | 't.metadata' = 't.metadata'){
  const types=Object.entries(policy.trendValueTypeMs??{});
  const valueClass = json === 't.metadata' ? 't.value_class' : "JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.value.encoding'))";
  const fallback = types.length ? `CASE ${valueClass} ${types.map(() => 'WHEN ? THEN ?').join(' ')} ELSE ? END` : '?';
  const custom = itemRetentionLookup(json, `IF(ip.trends_ms = 0, 8640000000000000,
    ? - CAST(ip.trends_ms AS SIGNED) - ${trendBucketMs})`);
  const time = now.getTime();
  return { sql: `COALESCE(${custom}, ${fallback})`,
    params: [time, ...types.flatMap(([type, ms]) => [type, time - ms! - trendBucketMs]),
      time - (policy.trendMs ?? DEFAULT_TREND_RETENTION_MS) - trendBucketMs] };
}
// References protect identity rows, never raw payloads. JSON lineage is the legacy on-disk contract,
// so this also protects pre-migration observations without inventing a new reference format.
const observationUnreferenced = `NOT EXISTS (SELECT 1 FROM metric_rollout r WHERE JSON_UNQUOTE(JSON_EXTRACT(r.latest_payload, '$.id')) = o.id)
  AND NOT EXISTS (SELECT 1 FROM metric_trigger_inputs i WHERE CAST(i.sample_id AS BINARY) = CAST(o.id AS BINARY))
  AND NOT EXISTS (SELECT 1 FROM metric_trigger_episodes e WHERE JSON_CONTAINS(JSON_EXTRACT(e.snapshot, '$.opening.sample_ids'), JSON_QUOTE(o.id)))
  AND NOT EXISTS (SELECT 1 FROM metric_alert_transitions t WHERE JSON_UNQUOTE(JSON_EXTRACT(t.evidence, '$.observation')) = o.id)
  AND NOT EXISTS (SELECT 1 FROM metric_observations n WHERE n.stage = 'normalized' AND n.id <> o.id
    AND JSON_CONTAINS(JSON_EXTRACT(n.payload, '$.lineage[*].id'), JSON_QUOTE(o.id)))
  AND NOT EXISTS (SELECT 1 FROM metric_attempts a WHERE JSON_CONTAINS(JSON_EXTRACT(a.payload, '$.observation_ids'), JSON_QUOTE(o.id)))`;
export function observationSelections(now: Date, policy: RetentionPolicy): Record<string, RetentionSelection> {
  const history = retentionSqlTime(new Date(now.getTime() - policy.historyMs));
  const typed=Object.entries(policy.valueTypeMs??{});
  const cutoff=typed.length ? `CASE JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.value.encoding')) ${typed.map(()=> 'WHEN ? THEN ?').join(' ')} ELSE ? END` : '?';
  const params=typed.flatMap(([type,ms])=>[type,retentionSqlTime(new Date(now.getTime()-ms!))]);
  return {
    rawPayload: { table: 'metric_observations o', key: 'id', time: 'stored_at', where: "o.stage = 'raw' AND o.payload IS NOT NULL AND (o.evidence_expires_at <= ? OR o.stored_at <= ?)", params: [retentionSqlTime(now), retentionSqlTime(new Date(now.getTime() - policy.rawMs))] },
    normalized: { table: 'metric_observations o', key: 'id', time: 'stored_at',
      where: `o.stage = 'normalized' AND COALESCE(${itemHistoryExpired}, o.stored_at < ${cutoff}) AND ${observationUnreferenced}`,
      params: [retentionSqlTime(now), ...params,history] },
    rawIdentity: { table: 'metric_observations o', key: 'id', time: 'stored_at', where: `o.stage = 'raw' AND o.payload IS NULL AND o.stored_at < ? AND ${observationUnreferenced}`, params: [history] },
    attempts: { table: 'metric_attempts a', key: 'id', time: 'stored_at', where: "a.stored_at < ? AND JSON_UNQUOTE(JSON_EXTRACT(a.payload, '$.status')) <> 'running'", params: [retentionSqlTime(new Date(now.getTime() - policy.attemptMs))] },
  };
}
export function rolloutSelections(now: Date, historyMs: number): Record<string, RetentionSelection> {
  return {
    publications: { table: 'metric_publications p', key: 'observation_id', time: 'observed_at', where: `NOT EXISTS (SELECT 1 FROM metric_observations o WHERE o.id = p.observation_id)
      AND NOT EXISTS (SELECT 1 FROM metric_rollout r WHERE JSON_UNQUOTE(JSON_EXTRACT(r.latest_payload, '$.id')) = p.observation_id)
      AND NOT EXISTS (SELECT 1 FROM metric_alert_transitions t WHERE JSON_UNQUOTE(JSON_EXTRACT(t.evidence, '$.observation')) = p.observation_id)`, params: [] },
    transitions: { table: 'metric_alert_transitions t', key: 'transition_key', time: 'window_ms', where: `t.window_ms < ? AND NOT EXISTS
      (SELECT 1 FROM metric_alert_state s WHERE s.identity_hash = t.identity_hash AND NOT EXISTS
        (SELECT 1 FROM metric_alert_transitions newer WHERE newer.identity_hash = t.identity_hash AND newer.window_ms > t.window_ms))`, params: [now.getTime() - historyMs] },
  };
}
export async function retentionPreview(c: PoolConnection, selections: Record<string, RetentionSelection>, now: Date): Promise<RetentionCounts> {
  const result: RetentionCounts = {};
  for (const [name, s] of Object.entries(selections)) {
    const [rows] = await c.query<RowDataPacket[]>(`SELECT COUNT(*) AS count, ${['window_ms','bucket_ms'].includes(s.time) ? `MIN(${s.time})` : `CAST(MIN(${s.time}) AS CHAR)`} AS oldest FROM ${s.table} WHERE ${s.where}`, s.params);
    const oldest = rows[0].oldest;
    const ms = oldest == null ? null : ['window_ms','bucket_ms'].includes(s.time) ? Number(oldest) : oldest instanceof Date ? oldest.getTime() : Date.parse(`${String(oldest).replace(' ', 'T')}Z`);
    result[name] = { count: Number(rows[0].count), oldestAt: ms == null ? null : new Date(ms).toISOString(), oldestAgeMs: ms == null ? null : Math.max(0, now.getTime() - ms) };
  }
  return result;
}
export async function retentionIds(c: PoolConnection, s: RetentionSelection, limit: number): Promise<string[]> {
  const [rows] = await c.query<RowDataPacket[]>(`SELECT ${s.key} AS id FROM ${s.table} WHERE ${s.where} ORDER BY ${s.time}, ${s.key} LIMIT ${limit}`, s.params);
  return rows.map(r => r.id);
}
export async function deleteRetentionIds(c: PoolConnection, s: RetentionSelection, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const [result] = await c.execute<any>(`DELETE FROM ${s.table.split(' ')[0]} WHERE ${s.key} IN (${ids.map(() => '?').join(',')})`, ids);
  return Number(result.affectedRows);
}
