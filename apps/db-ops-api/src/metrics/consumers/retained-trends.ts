import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { NormalizedObservationSchema } from '../../contracts/metrics/observations.js';
import { StudyTrendResultSchema } from '../../contracts/metrics/study.js';
import type { NormalizedObservation } from '../../contracts/metrics/index.js';
import { historySelection } from '../rollout/formal-store.js';
import { seriesHash, type Series } from '../storage.js';
import { DEFAULT_TREND_RETENTION_MS, trendCutoff, trendSelection, type RetentionPolicy } from '../retention.js';
import { mergeTrend, trendHierarchy, TREND_TIERS, type TrendBucket } from './trends.js';

const parse=(v:any)=>typeof v==='string'?JSON.parse(v):v;
const MS=300000;
export type RetainedTrend={bucket:TrendBucket;metadata:Series};
export function retainedHierarchy(points:NormalizedObservation[],retained:RetainedTrend[],from:string,to:string,interval:number,tier:keyof typeof TREND_TIERS){
  const buckets=trendHierarchy(points,from,to,interval,tier)[tier].map(b=>({...b,raw_status:'available' as 'available'|'partial_expired'|'expired'|'boundary_unavailable',retained_count:0,statistics_complete:true}));
  const start=Math.floor(Date.parse(from)/TREND_TIERS[tier])*TREND_TIERS[tier];
  for(const {bucket:s} of retained){
    const i=Math.floor((Math.max(Date.parse(from),Date.parse(s.from))-start)/TREND_TIERS[tier]),b=buckets[i];if(!b)continue;
    if(Date.parse(s.from)<Date.parse(from)||Date.parse(s.to)>Date.parse(to)){b.statistics_complete=false;b.raw_status='boundary_unavailable';continue;}
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
  if(!ids.length)return;
  const [rows]=await c.query<RowDataPacket[]>(`SELECT o.payload,p.series_hash ${historySelection} AND o.id IN (${ids.map(()=>'?').join(',')}) ORDER BY p.observed_at,p.observation_id`,ids);
  const groups=new Map<string,{key:string;epoch:number;metadata:Series;valueClass:string;points:NormalizedObservation[]}>();
  for(const row of rows){
    const p=NormalizedObservationSchema.parse(parse(row.payload)),epoch=Math.floor(Date.parse(p.observed_at)/MS)*MS;
    const valueClass=p.value?.encoding??'unknown',cutoff=now.getTime()-((policy.trendValueTypeMs as Record<string,number>|undefined)?.[valueClass]??policy.trendMs??DEFAULT_TREND_RETENTION_MS);
    if(epoch+MS<=cutoff)continue; // Explicit independent trend expiry, never inferred from raw retention.
    const [receipt]=await c.query<RowDataPacket[]>('SELECT observation_id FROM metric_trend_receipts WHERE observation_id=? FOR UPDATE',[p.id]);
    if(receipt.length)continue;
    const metadata={resource_type:p.resource_type,resource_id:p.resource_id,metric:p.metric,dimensions:p.dimensions};
    const key=seriesHash(metadata);if(key!==row.series_hash)throw new Error('TREND_SERIES_FENCE');
    const groupKey=`${key}:${epoch}:${valueClass}`;let g=groups.get(groupKey);if(!g){g={key,epoch,metadata,valueClass,points:[]};groups.set(groupKey,g);}g.points.push(p);
    await c.execute('INSERT INTO metric_trend_receipts(observation_id,series_hash,bucket_ms,value_class) VALUES(?,?,?,?)',[p.id,key,epoch,valueClass]);
  }
  for(const g of groups.values()){
    const from=new Date(g.epoch).toISOString(),to=new Date(g.epoch+MS).toISOString();
    let bucket=trendHierarchy(g.points,from,to,60000,'5m')['5m'][0];
    const times=g.points.map(p=>Date.parse(p.observed_at)).sort((a,b)=>a-b);
    bucket.max_gap_ms=times.reduce((m,t,i)=>i?Math.max(m,t-times[i-1]):m,0);
    const [prior]=await c.query<RowDataPacket[]>('SELECT statistics FROM metric_retained_trends WHERE series_hash=? AND bucket_ms=? AND value_class=? FOR UPDATE',[g.key,g.epoch,g.valueClass]);
    if(prior.length){const old=StudyTrendResultSchema.shape.buckets.element.parse(parse(prior[0].statistics)) as TrendBucket;
      bucket=Date.parse(old.first_at!)<=Date.parse(bucket.first_at!)?mergeTrend(old,bucket):mergeTrend(bucket,old);
      bucket.first_at=new Date(Math.min(Date.parse(old.first_at!),times[0])).toISOString();bucket.last_at=new Date(Math.max(Date.parse(old.last_at!),times.at(-1)!)).toISOString();
    }
    await c.execute(`INSERT INTO metric_retained_trends(series_hash,bucket_ms,value_class,resource_key,metadata,statistics) VALUES(?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE statistics=VALUES(statistics)`,[g.key,g.epoch,g.valueClass,`${g.metadata.resource_type}:${g.metadata.resource_id}`,JSON.stringify(g.metadata),JSON.stringify(bucket)]);
  }
}
/** Expire statistics and receipts together, bounded and under the caller's policy lock. */
export async function expireRetainedTrends(c:PoolConnection,now:Date,policy:RetentionPolicy,limit:number){
  const selection=trendSelection(now,policy);
  const [rows]=await c.query<RowDataPacket[]>(`SELECT t.series_hash,t.bucket_ms,t.value_class FROM ${selection.table} WHERE ${selection.where} ORDER BY bucket_ms,series_hash,value_class LIMIT ${limit} FOR UPDATE`,selection.params);
  let remaining=limit,deleted=0;
  for(const row of rows){const [r]=await c.execute<any>(`DELETE FROM metric_trend_receipts WHERE series_hash=? AND bucket_ms=? AND value_class=? LIMIT ${remaining}`,[row.series_hash,row.bucket_ms,row.value_class]);remaining-=Number(r.affectedRows);
    const [rest]=await c.query<RowDataPacket[]>('SELECT observation_id FROM metric_trend_receipts WHERE series_hash=? AND bucket_ms=? AND value_class=? LIMIT 1',[row.series_hash,row.bucket_ms,row.value_class]);
    if(!rest.length){await c.execute('DELETE FROM metric_retained_trends WHERE series_hash=? AND bucket_ms=? AND value_class=?',[row.series_hash,row.bucket_ms,row.value_class]);deleted++;}if(!remaining)break;}
  return {retainedTrends:deleted,trendReceipts:limit-remaining};
}
export class RetainedTrendStore {
  constructor(private pool:Pool,private now=()=>Date.now(),private deadline=Date.now()+30000){}
  private budget(){if(Date.now()>this.deadline)throw new Error('QUERY_LIMIT_EXCEEDED');}
  async metadata(resourceKey:string,from:string,to:string,policy:Pick<RetentionPolicy,'trendMs'|'trendValueTypeMs'>={}){
    this.budget();const expiry=trendCutoff(new Date(this.now()),policy);
    const [rows]=await this.pool.execute<RowDataPacket[]>(`SELECT /*+ MAX_EXECUTION_TIME(10000) */ DISTINCT metadata FROM metric_retained_trends t WHERE resource_key=? AND bucket_ms<? AND bucket_ms+300000>? AND bucket_ms>${expiry.sql} LIMIT 101`,[resourceKey,Date.parse(to),Date.parse(from),...expiry.params]);
    this.budget();if(rows.length>100)throw new Error('QUERY_SERIES_LIMIT');return rows.map(r=>parse(r.metadata) as Series);
  }
  async read(series:Series,from:string,to:string,policy:Pick<RetentionPolicy,'trendMs'|'trendValueTypeMs'>={}):Promise<RetainedTrend[]>{
    this.budget();const expiry=trendCutoff(new Date(this.now()),policy);
    const [rows]=await this.pool.execute<RowDataPacket[]>(`SELECT /*+ MAX_EXECUTION_TIME(10000) */ metadata,statistics FROM metric_retained_trends t WHERE series_hash=? AND bucket_ms<? AND bucket_ms+300000>? AND bucket_ms>${expiry.sql} ORDER BY bucket_ms,value_class LIMIT 200001`,[seriesHash(series),Date.parse(to),Date.parse(from),...expiry.params]);
    this.budget();if(rows.length>200000)throw new Error('QUERY_LIMIT_EXCEEDED');
    return rows.map(r=>({metadata:parse(r.metadata),bucket:StudyTrendResultSchema.shape.buckets.element.parse(parse(r.statistics)) as TrendBucket}));
  }
  async withoutPreserved(points:NormalizedObservation[],policy:Pick<RetentionPolicy,'trendMs'|'trendValueTypeMs'>={}){
    const archived=new Set<string>(),expiry=trendCutoff(new Date(this.now()),policy);
    for(let at=0;at<points.length;at+=1000){this.budget();const ids=points.slice(at,at+1000).map(p=>p.id);const [rows]=await this.pool.query<RowDataPacket[]>(`SELECT observation_id FROM metric_trend_receipts t WHERE observation_id IN (${ids.map(()=>'?').join(',')}) AND bucket_ms>${expiry.sql}`,[...ids,...expiry.params]);rows.forEach(r=>archived.add(r.observation_id));}
    return points.filter(p=>!archived.has(p.id));
  }
}
