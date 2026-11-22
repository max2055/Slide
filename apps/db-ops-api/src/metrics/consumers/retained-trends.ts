import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { NormalizedObservationSchema } from '../../contracts/metrics/observations.js';
import { StudyTrendResultSchema } from '../../contracts/metrics/study.js';
import type { NormalizedObservation } from '../../contracts/metrics/index.js';
import { historySelection } from '../rollout/formal-store.js';
import { seriesHash, type Series } from '../storage.js';
import { DEFAULT_TREND_RETENTION_MS, itemRetentionSql, trendCutoff, trendSelection, type RetentionPolicy } from '../retention.js';
import { mergeTrend, trendHierarchy, TREND_TIERS, usableTrendSample, type TrendBucket } from './trends.js';

const parse=(v:any)=>typeof v==='string'?JSON.parse(v):v;
const MS=300000;
export type RetainedTrend={bucket:TrendBucket;metadata:Series; valueClass?: string};
const receiptCount = `(SELECT COUNT(*) FROM metric_trend_receipts r
  WHERE r.series_hash=t.series_hash AND r.bucket_ms=t.bucket_ms AND r.value_class=t.value_class)`;
// Older housekeeping could commit a partial deletion without marking the bucket.
const archiveAvailable = `COALESCE(t.statistics->>'$.statistics_complete', 'true') <> 'false'
  AND CAST(t.statistics->>'$.count' AS UNSIGNED) = ${receiptCount}`;
const markExpiring = `UPDATE metric_retained_trends SET statistics=JSON_SET(statistics,'$.statistics_complete',CAST('false' AS JSON))
  WHERE series_hash=? AND bucket_ms=? AND value_class=?`;
export function retainedRange(bucket: Pick<TrendBucket, 'from' | 'to' | 'first_at' | 'last_at'>, from: number, to: number) {
  const first = Date.parse(bucket.first_at ?? ''), last = Date.parse(bucket.last_at ?? '');
  if (last < from || first >= to) return 'outside';
  if ((first >= from && last < to) || (Date.parse(bucket.from) >= from && Date.parse(bucket.to) <= to)) return 'inside';
  return 'clipped';
}
export function retainedHierarchy(points:NormalizedObservation[],retained:RetainedTrend[],from:string,to:string,interval:number,tier:keyof typeof TREND_TIERS,
  chart?: { trendOnly: NormalizedObservation[]; plottableDetail: ReadonlySet<string> }) {
  const buckets=trendHierarchy(chart ? [...points, ...chart.trendOnly] : points,from,to,interval,tier,chart?.plottableDetail)[tier]
    .map(b=>({...b,raw_status:'available' as 'available'|'partial_expired'|'expired'|'boundary_unavailable',retained_count:0,statistics_complete:true}));
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  const start=Math.floor(Date.parse(from)/TREND_TIERS[tier])*TREND_TIERS[tier];
  for (const p of chart?.trendOnly ?? []) {
    const at = Date.parse(p.observed_at);
    if (at >= fromMs && at < toMs) buckets[Math.floor((at - start) / TREND_TIERS[tier])].retained_count++;
  }
  for(const {bucket:s} of retained){
    const i=Math.floor((Math.max(Date.parse(from),Date.parse(s.from))-start)/TREND_TIERS[tier]),b=buckets[i];if(!b)continue;
    const range = retainedRange(s, fromMs, toMs);
    if (range === 'outside') continue;
    if (range === 'clipped') { b.statistics_complete=false;b.raw_status='boundary_unavailable';continue; }
    if(!b.count)b.max_gap_ms=0;
    const merged=!b.first_at||Date.parse(s.first_at!)<Date.parse(b.first_at)?mergeTrend(s,b):mergeTrend(b,s);
    const times=[b.first_at,s.first_at].filter(Boolean).map(t=>Date.parse(t!)),ends=[b.last_at,s.last_at].filter(Boolean).map(t=>Date.parse(t!));
    buckets[i]={...b,...merged,from:b.from,to:b.to,first_at:new Date(Math.min(...times)).toISOString(),last_at:new Date(Math.max(...ends)).toISOString(),
      statistics_complete:b.statistics_complete,retained_count:b.retained_count+s.count,raw_status:b.raw_status==='boundary_unavailable'?b.raw_status:b.count>b.retained_count?'partial_expired':'expired'};
  }
  for(const b of buckets){const a=Date.parse(b.from),z=Date.parse(b.to);b.max_gap_ms=Math.max(b.max_gap_ms,b.first_at?Date.parse(b.first_at)-a:z-a,b.last_at?z-Date.parse(b.last_at):z-a);
    b.coverage=Math.min(1,b.count/Math.max(1,Math.ceil((z-a)/interval)));
    b.quality=!b.statistics_complete||!b.count?'unknown':b.invalid_count||b.estimated_count||b.max_gap_ms>interval*1.25||b.coverage<1?'partial':'good';}
  return buckets;
}
/** Called inside the existing policy-lock pruning transaction. Any failure rejects deletion.
 * Receipts, exact statistics and source deletion commit together; retries cannot add twice. */
export async function preserveBeforePrune(c:PoolConnection,ids:string[],now:Date,policy:RetentionPolicy) {
  if(!ids.length)return ids;
  const deferred = new Set<string>();
  const [rows]=await c.query<RowDataPacket[]>(`SELECT o.payload,p.series_hash,${itemRetentionSql('trends_ms', 'o.payload')} AS item_trends_ms
    ${historySelection} AND o.id IN (${ids.map(()=>'?').join(',')}) ORDER BY p.observed_at,p.observation_id`,ids);
  const groups=new Map<string,{key:string;epoch:number;metadata:Series;valueClass:string;points:NormalizedObservation[]}>();
  for(const row of rows){
    const p=NormalizedObservationSchema.parse(parse(row.payload)),epoch=Math.floor(Date.parse(p.observed_at)/MS)*MS;
    const valueClass=p.value?.encoding??'unknown';
    const duration = row.item_trends_ms == null
      ? (policy.trendValueTypeMs as Record<string,number>|undefined)?.[valueClass] ?? policy.trendMs ?? DEFAULT_TREND_RETENTION_MS
      : Number(row.item_trends_ms);
    if(duration === 0 || epoch + MS <= now.getTime() - duration)continue;
    const metadata={resource_type:p.resource_type,resource_id:p.resource_id,metric:p.metric,dimensions:p.dimensions};
    const key=seriesHash(metadata);if(key!==row.series_hash)throw new Error('TREND_SERIES_FENCE');
    const groupKey=`${key}:${epoch}:${valueClass}`;let g=groups.get(groupKey);if(!g){g={key,epoch,metadata,valueClass,points:[]};groups.set(groupKey,g);}g.points.push(p);
  }
  for(const g of groups.values()){
    const key = [g.key, g.epoch, g.valueClass];
    const [prior] = await c.query<RowDataPacket[]>(`SELECT statistics, (${archiveAvailable}) AS available
      FROM metric_retained_trends t WHERE series_hash=? AND bucket_ms=? AND value_class=? FOR UPDATE`, key);
    if (prior.length && !prior[0].available) {
      await c.execute(markExpiring, key);
      // Retention can drain the old receipts in bounded batches before these observations move.
      for (const p of g.points) deferred.add(p.id);
      continue;
    }
    const pending: NormalizedObservation[] = [];
    for (const p of g.points) {
      const [receipt] = await c.query<RowDataPacket[]>('SELECT observation_id FROM metric_trend_receipts WHERE observation_id=? FOR UPDATE', [p.id]);
      if (receipt.length) continue;
      await c.execute(`INSERT INTO metric_trend_receipts(observation_id,series_hash,bucket_ms,value_class,archive_invalid,archive_estimated)
        VALUES(?,?,?,?,?,?)`, [p.id, ...key, !usableTrendSample(p), p.accuracy === 'estimated']);
      pending.push(p);
    }
    if (!pending.length) continue;
    const from=new Date(g.epoch).toISOString(),to=new Date(g.epoch+MS).toISOString();
    let bucket=trendHierarchy(pending,from,to,60000,'5m')['5m'][0];
    const times=pending.map(p=>Date.parse(p.observed_at)).sort((a,b)=>a-b);
    bucket.max_gap_ms=times.reduce((m,t,i)=>i?Math.max(m,t-times[i-1]):m,0);
    if(prior.length){const old=StudyTrendResultSchema.shape.buckets.element.parse(parse(prior[0].statistics)) as TrendBucket;
      bucket=Date.parse(old.first_at!)<=Date.parse(bucket.first_at!)?mergeTrend(old,bucket):mergeTrend(bucket,old);
      bucket.first_at=new Date(Math.min(Date.parse(old.first_at!),times[0])).toISOString();bucket.last_at=new Date(Math.max(Date.parse(old.last_at!),times.at(-1)!)).toISOString();
    }
    await c.execute(`INSERT INTO metric_retained_trends(series_hash,bucket_ms,value_class,resource_key,metadata,statistics) VALUES(?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE statistics=VALUES(statistics)`,[g.key,g.epoch,g.valueClass,`${g.metadata.resource_type}:${g.metadata.resource_id}`,JSON.stringify(g.metadata),JSON.stringify(bucket)]);
  }
  return ids.filter(id => !deferred.has(id));
}
/** Mark the whole bucket unavailable before draining a bounded batch of receipts. */
export async function expireRetainedTrends(c:PoolConnection,now:Date,policy:RetentionPolicy,limit:number){
  const selection=trendSelection(now,policy);
  const [rows]=await c.query<RowDataPacket[]>(`SELECT t.series_hash,t.bucket_ms,t.value_class FROM ${selection.table} WHERE ${selection.where} ORDER BY bucket_ms,series_hash,value_class LIMIT ${limit} FOR UPDATE`,selection.params);
  let receipts = 0, deleted = 0;
  for (const row of rows) {
    const key = [row.series_hash, row.bucket_ms, row.value_class];
    await c.execute(markExpiring, key);
    const [result] = await c.execute<ResultSetHeader>(
      `DELETE FROM metric_trend_receipts WHERE series_hash=? AND bucket_ms=? AND value_class=? LIMIT ${limit - receipts}`, key);
    receipts += result.affectedRows;
    const [rest] = await c.query<RowDataPacket[]>(
      'SELECT 1 FROM metric_trend_receipts WHERE series_hash=? AND bucket_ms=? AND value_class=? LIMIT 1', key);
    if (!rest.length) {
      await c.execute('DELETE FROM metric_retained_trends WHERE series_hash=? AND bucket_ms=? AND value_class=?', key);
      deleted++;
    }
    if (receipts >= limit) break;
  }
  return { retainedTrends: deleted, trendReceipts: receipts };
}
export class RetainedTrendStore {
  constructor(private pool:Pick<Pool,'execute'|'query'>,private now=()=>Date.now(),private deadline=Date.now()+30000){}
  private budget(){if(Date.now()>this.deadline)throw new Error('QUERY_LIMIT_EXCEEDED');}
  async metadata(resourceKey:string,from:string,to:string,policy:Pick<RetentionPolicy,'trendMs'|'trendValueTypeMs'>={}){
    this.budget();const expiry=trendCutoff(new Date(this.now()),policy);
    const [rows]=await this.pool.execute<RowDataPacket[]>(`SELECT /*+ MAX_EXECUTION_TIME(10000) */ DISTINCT metadata FROM metric_retained_trends t WHERE resource_key=? AND bucket_ms<? AND bucket_ms+300000>? AND bucket_ms>${expiry.sql} AND ${archiveAvailable} LIMIT 101`,[resourceKey,Date.parse(to),Date.parse(from),...expiry.params]);
    this.budget();if(rows.length>100)throw new Error('QUERY_SERIES_LIMIT');return rows.map(r=>parse(r.metadata) as Series);
  }
  async read(series:Series,from:string,to:string,policy:Pick<RetentionPolicy,'trendMs'|'trendValueTypeMs'>={}, includeValueClass = false):Promise<RetainedTrend[]>{
    this.budget();const expiry=trendCutoff(new Date(this.now()),policy);
    const [rows]=await this.pool.execute<RowDataPacket[]>(`SELECT /*+ MAX_EXECUTION_TIME(10000) */ metadata,statistics,value_class FROM metric_retained_trends t WHERE series_hash=? AND bucket_ms<? AND bucket_ms+300000>? AND bucket_ms>${expiry.sql} AND ${archiveAvailable} ORDER BY bucket_ms,value_class LIMIT 200001`,[seriesHash(series),Date.parse(to),Date.parse(from),...expiry.params]);
    this.budget();if(rows.length>200000)throw new Error('QUERY_LIMIT_EXCEEDED');
    return rows.map(r=>({metadata:parse(r.metadata),bucket:StudyTrendResultSchema.shape.buckets.element.parse(parse(r.statistics)) as TrendBucket,
      ...(includeValueClass ? { valueClass: String(r.value_class) } : {})}));
  }
  async readChart(series: Series, from: string, to: string, policy: RetentionPolicy,
    points: NormalizedObservation[], trendOnly: NormalizedObservation[]) {
    const retained = await this.read(series, from, to, policy, true);
    if (!retained.length) return { points, trendOnly, retained };
    const window = { from: Date.parse(from), to: Date.parse(to) };
    const groups = new Map(retained.map(trend => [`${Date.parse(trend.bucket.from)}:${trend.valueClass}`, trend.bucket]));
    const invalidCounts = new Map([...groups.entries()].map(([key, statistic]) => [key, statistic.invalid_count === statistic.count]));
    const detail = await this.withoutPreserved(points, policy, { ...window, replaceInvalid: (key, invalid, estimated) => {
      const statistic = groups.get(key);
      if (!statistic?.invalid_count || !(invalid ?? invalidCounts.get(key))) return false;
      // Restore the original ID as detail only when its receipt proves it contributed no value.
      // Counts prove this for old all-invalid buckets as well.
      statistic.count--;
      statistic.invalid_count--;
      statistic.estimated_count = estimated === null
        ? Math.min(statistic.estimated_count, statistic.count) : statistic.estimated_count - Number(estimated);
      return true;
    } });
    return { points: detail, trendOnly: await this.withoutPreserved(trendOnly, policy, window),
      retained: retained.filter(({ bucket }) => bucket.count > 0) };
  }
  async withoutPreserved(points:NormalizedObservation[],policy:Pick<RetentionPolicy,'trendMs'|'trendValueTypeMs'>={},
    window?: { from: number; to: number; replaceInvalid?: (bucketKey: string, invalid: boolean | null, estimated: boolean | null) => boolean }) {
    const archived=new Set<string>(),expiry=trendCutoff(new Date(this.now()),policy);
    for (let at = 0; at < points.length; at += 1000) {
      this.budget();
      const ids = points.slice(at, at + 1000).map(p => p.id);
      const bounds = window ? `, t.bucket_ms, t.value_class, t.statistics->>'$.first_at' AS first_at, t.statistics->>'$.last_at' AS last_at,
        r.archive_invalid, r.archive_estimated` : '';
      const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT r.observation_id${bounds} FROM metric_trend_receipts r
        JOIN metric_retained_trends t USING (series_hash, bucket_ms, value_class)
        WHERE r.observation_id IN (${ids.map(() => '?').join(',')}) AND t.bucket_ms > ${expiry.sql} AND ${archiveAvailable}`, [...ids, ...expiry.params]);
      for (const row of rows) {
        if (window && retainedRange({ from: new Date(Number(row.bucket_ms)).toISOString(),
          to: new Date(Number(row.bucket_ms) + MS).toISOString(), first_at: row.first_at, last_at: row.last_at },
        window.from, window.to) !== 'inside') continue;
        if (window?.replaceInvalid?.(`${row.bucket_ms}:${row.value_class}`,
          row.archive_invalid === null ? null : Boolean(row.archive_invalid),
          row.archive_estimated === null ? null : Boolean(row.archive_estimated))) continue;
        archived.add(row.observation_id);
      }
    }
    return points.filter(p=>!archived.has(p.id));
  }
}
