import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

export const DEFAULT_RETENTION = { rawMs: 7 * 86400000, historyMs: 30 * 86400000, attemptMs: 7 * 86400000 };
export const DEFAULT_TREND_RETENTION_MS = 365 * 86400000;
export const RETENTION_VALUE_TYPES = ['float64','int64','uint64','histogram','summary'] as const;
export type RetentionPolicy = typeof DEFAULT_RETENTION & { trendMs?: number; trendValueTypeMs?: Partial<Record<typeof RETENTION_VALUE_TYPES[number],number>>; valueTypeMs?: Partial<Record<typeof RETENTION_VALUE_TYPES[number],number>> };
export type RetentionCounts = Record<string, { count: number; oldestAt: string | null; oldestAgeMs: number | null }>;
export type RetentionGuard = (connection: PoolConnection) => Promise<void>;
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
export function trendSelection(now:Date,policy:RetentionPolicy):RetentionSelection {
  const cutoff=trendCutoff(now,policy);
  return {table:'metric_retained_trends t',key:'series_hash',time:'bucket_ms',where:`t.bucket_ms <= ${cutoff.sql}`,params:cutoff.params};
}
export function trendCutoff(now:Date,policy:Pick<RetentionPolicy,'trendMs'|'trendValueTypeMs'>){
  const types=Object.entries(policy.trendValueTypeMs??{});
  return {sql:types.length?`CASE t.value_class ${types.map(()=> 'WHEN ? THEN ?').join(' ')} ELSE ? END`:'?',
    params:[...types.flatMap(([type,ms])=>[type,now.getTime()-ms!-300000]),now.getTime()-(policy.trendMs??DEFAULT_TREND_RETENTION_MS)-300000]};
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
    normalized: { table: 'metric_observations o', key: 'id', time: 'stored_at', where: `o.stage = 'normalized' AND o.stored_at < ${cutoff} AND ${observationUnreferenced}`, params: [...params,history] },
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
