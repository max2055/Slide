import { createHash } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { ActorContext } from '../../auth/actor-context.js';
import type { ConfigurationAt } from '../../contracts/metrics/configuration-history.js';
import { StudyWindowSchema, StudyTrendSchema, StudyReplaySchema, StudyCapacitySchema } from '../../contracts/metrics/study.js';
import { validateDimensions, type NormalizedObservation, type MetricDefinition } from '../../contracts/metrics/index.js';
import { type TriggerSample, TriggerSampleSchema, TRIGGER_LIMITS } from '../../contracts/metrics/triggers.js';
import type { PolicyService } from '../policy/service.js';
import { refKey, rule, type Ref } from '../policy/model.js';
import { hasPermission } from '../../auth/require-permission.js';
import { canonicalDefinitions } from '../packages/builtins.js';
import type { PackageRegistry } from '../packages/model.js';
import { stable } from '../packages/model.js';
import { MysqlFormalMetricStore } from '../rollout/formal-store.js';
import { verifyTriggerSnapshot } from '../triggers/compile.js';
import { evaluateTriggerRule } from '../triggers/evaluate.js';
import { observationSelections, trendSelection, retentionPreview, configuredRetention, retentionSqlTime, DEFAULT_TREND_RETENTION_MS } from '../retention.js';
import { RetainedTrendStore, retainedHierarchy } from './retained-trends.js';
import { readHistoryContext } from './history-context.js';

const json = (v: unknown): any => typeof v==='string'?JSON.parse(v):v;
const digest = (v: unknown) => `sha256:${createHash('sha256').update(stable(v)).digest('hex')}`;
const numericSql = `JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.value.encoding')) IN ('float64','uint64','int64')`;
export const STUDY_ROW_BUDGET=200000;
/** Historical study owns only audit writes. Formal writer, episode and notification ports are absent. */
export class MetricStudyService {
  constructor(private pool:()=>Pool,private policy:Pick<PolicyService,'assertAccess'>,private registry:PackageRegistry,
    private reload:(actor:ActorContext)=>Promise<ActorContext>,
    private configuration:(actor:ActorContext,ref:Ref,revision:number)=>Promise<ConfigurationAt>,
    private clock=()=>new Date().toISOString()) {}
  private async access(actor:ActorContext,ref:Ref,manage=false) {
    const live=await this.reload(actor);await this.policy.assertAccess(live,ref,manage);
    rule(hasPermission(new Set(live.permissions),manage?'metric:manage':'metric:view'),'POLICY_FORBIDDEN',403);return live;
  }
  private window(q:{from:string;to:string}) {
    const from=new Date(q.from).toISOString(),to=new Date(q.to).toISOString();
    rule(Date.parse(to)>Date.parse(from) && Date.parse(to)-Date.parse(from)<=366*86400000 && Date.parse(to)<=Date.parse(this.clock()),'QUERY_WINDOW');
    return {from,to};
  }
  private formal() { return new MysqlFormalMetricStore(this.pool(),{page_rows:1000,max_rows:STUDY_ROW_BUDGET}); }
  private definitions() {return [...canonicalDefinitions,...this.registry.list().flatMap(r=>r.extensions)];}
  private async snapshots(ref:Ref) {
    const [rows]=await this.pool().execute<RowDataPacket[]>('SELECT payload FROM metric_trigger_snapshots WHERE resource_key=? ORDER BY config_revision DESC LIMIT 101',[refKey(ref)]);
    rule(rows.length<=100,'QUERY_LIMIT_EXCEEDED');
    return rows.map(r=>{const s=verifyTriggerSnapshot(json(r.payload));rule(s.resource.type===ref.type && s.resource.id===String(ref.id),'HISTORY_SNAPSHOT_IDENTITY');return s;});
  }
  async catalog(actor:ActorContext,input:unknown) {
    const q=StudyWindowSchema.parse(input),window=this.window(q);actor=await this.access(actor,q.resource);
    const refs=await this.formal().historyMetrics(q.resource,window.from,window.to);
    const retained=await new RetainedTrendStore(this.pool(),()=>Date.parse(this.clock())).metadata(refKey(q.resource),window.from,window.to,configuredRetention());
    for(const s of retained)if(!refs.some(r=>stable(r)===stable(s.metric)))refs.push(s.metric);
    rule(refs.length<=100,'QUERY_LIMIT_EXCEEDED');
    const metrics=refs.map(ref=>({metric:ref,definition:this.definitions().find(d=>d.resource_type===q.resource.type && d.id===ref.id && d.semantic_version===ref.semantic_version)??null}));
    const snapshots=await this.snapshots(q.resource);
    await this.access(actor,q.resource);return {resource:q.resource,window,metrics,snapshots,
      aggregation:{mode:'durable_exact_hierarchy',tiers:['5m','1h','1d'],max_rows:STUDY_ROW_BUDGET,max_days:366,retention_ms:configuredRetention().trendMs??DEFAULT_TREND_RETENTION_MS},
      raw_max_days:31};
  }
  private async points(ref:Ref,metric:{id:string;semantic_version:string},from:string,to:string,dimensions:Record<string,string>) {
    const definition=this.definitions().find(d=>d.resource_type===ref.type && d.id===metric.id && d.semantic_version===metric.semantic_version);
    rule(definition,'UNKNOWN_METRIC');validateDimensions(dimensions,definition);
    return this.formal().readStudyWindow({resource_type:ref.type,resource_id:String(ref.id),metric,dimensions},from,to);
  }
  async trend(actor:ActorContext,input:unknown) {
    const q=StudyTrendSchema.parse(input),window=this.window(q);actor=await this.access(actor,q.resource);
    const tierMs={'5m':300000,'1h':3600000,'1d':86400000}[q.tier];
    rule(Math.ceil((Date.parse(window.to)-Date.parse(window.from))/tierMs)+1<=10080,'QUERY_LIMIT_EXCEEDED');
    const c=await this.pool().getConnection();try{
      await c.beginTransaction();const [lock]=await c.query<RowDataPacket[]>('SELECT id FROM metric_policy_lock WHERE id=1 FOR UPDATE');rule(lock.length===1,'POLICY_LOCK_UNAVAILABLE',503);await this.access(actor,q.resource);
      // Serialize the two evidence stores with the atomic pruning transaction: no missing or doubled handover.
      const archive=new RetainedTrendStore(c as unknown as Pool,()=>Date.parse(this.clock()));
      const points=await archive.withoutPreserved(await this.points(q.resource,q.metric,window.from,window.to,q.dimensions),configuredRetention());
      const retained=await archive.read({resource_type:q.resource.type,resource_id:String(q.resource.id),metric:q.metric,dimensions:q.dimensions},window.from,window.to,configuredRetention());
      rule(points.length+retained.length<=STUDY_ROW_BUDGET,'QUERY_LIMIT_EXCEEDED');
      const buckets=retainedHierarchy(points,retained,window.from,window.to,q.interval_ms,q.tier);
      await this.access(actor,q.resource);await c.commit();
      return {resource:q.resource,metric:q.metric,dimensions:q.dimensions,window,tier:q.tier,buckets,
        evidence_hash:digest({points:points.filter(p=>Date.parse(p.observed_at)>=Date.parse(window.from) && Date.parse(p.observed_at)<Date.parse(window.to)),retained}),
        sampling:{interval_ms:q.interval_ms,basis:'explicit_measurement_assumption'},
        note:'原始值充分统计；计数器不是速率。保全趋势独立保留，不能用于原始对照或回放。缺口为保守上界；已过期5分钟桶无法精确裁剪时，排除该桶统计并标记不完整。'};
    }catch(e){await c.rollback();throw e;}finally{c.release();}
  }
  /** List dimensions through bounded 31-day portions of the same formal historical reader. */
  async dimensions(actor:ActorContext,input:unknown) {
    const q=StudyTrendSchema.parse(input),w=this.window(q);actor=await this.access(actor,q.resource);
    const d=this.definitions().find(d=>d.resource_type===q.resource.type && d.id===q.metric.id && d.semantic_version===q.metric.semantic_version);rule(d,'UNKNOWN_METRIC');
    const all=new Map<string,Record<string,string>>();
    for(let at=Date.parse(w.from);at<Date.parse(w.to);at+=30*86400000) {
      const ds=await this.formal().historyDimensions(q.resource,d,new Date(at).toISOString(),new Date(Math.min(at+30*86400000,Date.parse(w.to))).toISOString());
      ds.forEach(dim=>all.set(stable(dim),dim));rule(all.size<=100,'QUERY_SERIES_LIMIT');
    }
    for(const s of await new RetainedTrendStore(this.pool(),()=>Date.parse(this.clock())).metadata(refKey(q.resource),w.from,w.to,configuredRetention()))if(stable(s.metric)===stable(q.metric))all.set(stable(s.dimensions),s.dimensions);
    rule(all.size<=100,'QUERY_SERIES_LIMIT');
    await this.access(actor,q.resource);return {dimensions:[...all.values()]};
  }
  async replay(actor:ActorContext,input:unknown) {
    const q=StudyReplaySchema.parse(input),window=this.window(q);actor=await this.access(actor,q.resource);
    const snapshot=(await this.snapshots(q.resource)).find(s=>s.config_revision===q.revision && s.snapshot_hash===q.snapshot_hash);
    rule(snapshot,'HISTORY_SNAPSHOT_MISSING',404);
    const selected=snapshot.rules.find(r=>r.rule_id===q.rule_id && r.scope===q.scope);rule(selected,'HISTORY_RULE_MISSING',404);
    const config=await this.configuration(actor,q.resource,q.revision);
    const configurations=new Map<number,ConfigurationAt>([[q.revision,config]]);
    const evidenceConfiguration=async(revision:number)=>{
      if(!configurations.has(revision)){rule(configurations.size<100,'QUERY_LIMIT_EXCEEDED');configurations.set(revision,await this.configuration(actor,q.resource,revision));}
      const found=configurations.get(revision)!;
      rule(found.resource.type===q.resource.type && found.resource.id===q.resource.id && found.revision===revision,'HISTORY_CONFIGURATION_IDENTITY',503);
      return found;
    };
    await evidenceConfiguration(q.revision);
    const applied=config.state==='effective' && ['collect','derive'].includes(selected.decision)?{resource:q.resource,applied_revision:q.revision,application_status:'applied',plan_identity:config.resolution_identity}:null;
    const definition=this.definitions().find(d=>d.resource_type===q.resource.type && d.id===selected.metric.id && d.semantic_version===selected.metric.semantic_version);rule(definition,'UNKNOWN_METRIC');
    const ds=await this.dimensions(actor,{resource:q.resource,...window,metric:selected.metric});
    rule(ds.dimensions.length<=TRIGGER_LIMITS.max_series,'QUERY_SERIES_LIMIT');
    const runs=[];const evidenceHashes:string[]=[];let total=0,budget=0,evaluations=0;const deadline=Date.now()+30000;
    for(const dims of ds.dimensions) {
      const points=await this.points(q.resource,selected.metric,window.from,window.to,dims);
      budget+=points.length;rule(budget<=4096,'QUERY_LIMIT_EXCEEDED');
      const retained=await new RetainedTrendStore(this.pool(),()=>Date.parse(this.clock())).read({resource_type:q.resource.type,resource_id:String(q.resource.id),metric:selected.metric,dimensions:dims},window.from,window.to,configuredRetention());
      rule(!retained.length,'HISTORY_RAW_EXPIRED',409);
      const ordered=points.filter(p=>Date.parse(p.observed_at)<Date.parse(window.to)).sort((a,b)=>Date.parse(a.observed_at)-Date.parse(b.observed_at)||a.id.localeCompare(b.id));
      evidenceHashes.push(digest(ordered));
      total+=ordered.filter(p=>Date.parse(p.observed_at)>=Date.parse(window.from)).length;
      let previous:'problem'|'healthy'|'unknown'|null=null;const timeline=[];const samples:TriggerSample[]=[];
      let lastSeen:string|null=null,usable=false;
      const evaluate=(now:string)=>{
        rule(++evaluations<=16384 && Date.now()<=deadline,'QUERY_LIMIT_EXCEEDED');
        const e=evaluateTriggerRule(snapshot,{rule_id:selected.rule_id,scope:selected.scope},{applied,input:{now,last_seen_at:lastSeen,previous,samples:usable?samples:[]}});
        const result=e.nodata?{...e,business:'problem' as const,problem_open:true}:e;
        previous=result.problem_open?'problem':result.business;return result;
      };
      const windows=new Set<number>();
      const selectors=(e:typeof selected.problem):void=>{if(e.node==='compare'){if(e.select.aggregation!=='last')windows.add(e.select.window_ms);}else e.children.forEach(selectors);};
      selectors(selected.problem);selectors(selected.recovery);
      // Reject a provably over-budget schedule before repeatedly parsing a large
      // evidence array. The runtime counter also covers additional window edges.
      const scheduled=new Set<number>(),end=Date.parse(window.to),start=Date.parse(window.from);
      for(let i=0;i<ordered.length;i++){
        const at=Date.parse(ordered[i].observed_at),next=Math.min(end,Date.parse(ordered[i+1]?.observed_at??window.to));
        if(at<start){scheduled.add(start);continue;}scheduled.add(at);
        for(const ms of [selected.clock.stale_after_ms,...(selected.clock.nodata.enabled?[selected.clock.nodata.after_ms]:[])])if(at+ms<next)scheduled.add(at+ms);
        for(const ms of windows)if(at+ms<end)scheduled.add(at+ms);
      }
      rule(evaluations+scheduled.size+1<=16384,'QUERY_LIMIT_EXCEEDED');
      const clocks=new Set<number>();
      const advance=(until:number)=>{
        const pending=new Set(clocks);
        if(lastSeen){pending.add(Date.parse(lastSeen)+selected.clock.stale_after_ms);if(selected.clock.nodata.enabled)pending.add(Date.parse(lastSeen)+selected.clock.nodata.after_ms);}
        for(const at of [...pending].filter(t=>t<until && t>=(timeline.length?Date.parse(timeline.at(-1)!.evaluated_at)+1:Date.parse(window.from))).sort((a,b)=>a-b)){
          clocks.delete(at);if(at<Date.parse(window.from))continue;
          timeline.push({event_type:'clock' as const,sample_id:null,...evaluate(new Date(at).toISOString())});
        }
        // A sample at the boundary is evaluated with its fresh evidence first.
        clocks.delete(until);
      };
      for(let i=0;i<ordered.length;i++) {
        const p=ordered[i],prior=ordered[i-1];
        const sampling=await evidenceConfiguration(p.versions.config_revision);
        const parsed=TriggerSampleSchema.safeParse({metric:p.metric,unit:p.unit,value:p.value,observed_at:p.observed_at,dimensions:p.dimensions,
          quality:p.quality,accuracy:p.accuracy,coverage:1,window:prior?.value && prior.versions.config_revision===p.versions.config_revision && ['float64','uint64','int64'].includes(prior.value.encoding) && sampling.state==='effective' && Date.parse(p.observed_at)-Date.parse(prior.observed_at)<=sampling.settings.interval_ms*1.25 && Date.parse(p.observed_at)>Date.parse(prior.observed_at)?{from:prior.observed_at,to:p.observed_at}:null});
        if(Date.parse(p.observed_at)<Date.parse(window.from)){lastSeen=p.observed_at;clocks.add(Date.parse(window.from));continue;}
        advance(Date.parse(p.observed_at));
        if(parsed.success)samples.push(parsed.data);
        lastSeen=p.observed_at;usable=parsed.success;
        timeline.push({event_type:'sample' as const,sample_id:p.id,...evaluate(p.observed_at)});
        for(const ms of windows){clocks.add(Date.parse(p.observed_at)+ms);if(parsed.success && parsed.data.window)clocks.add(Date.parse(parsed.data.window.from)+ms+1);}
      }
      // Evaluate the end clock too: missing tail evidence must not appear recovered.
      advance(Date.parse(window.to));
      const tail=evaluate(window.to);
      runs.push({dimensions:dims,timeline,tail});
    }
    const context=await readHistoryContext(this.pool(),q.resource,window.from,window.to,[q.revision],hasPermission(new Set(actor.permissions),'alert:view'));
    const result={resource:q.resource,window,isolated:true,initial_state:'unknown',snapshot_hash:snapshot.snapshot_hash,revision:q.revision,
      rule:{rule_id:selected.rule_id,version:selected.version,scope:selected.scope,body_hash:selected.body_hash},evidence_count:total,
      evidence_hash:digest({window,hash:snapshot.snapshot_hash,evidenceHashes,configurations:[...configurations.values()]}),configuration:config,evidence_configurations:[...configurations.values()],runs,
      formal_events_readable:context.events_readable,formal_events:context.events.filter(e=>e.rule_id===selected.rule_id && e.version===selected.version && e.config_revision===q.revision)};
    await this.audit(actor,q.resource,'history.replay',{request:q,result_hash:digest(result)},false);
    const live=await this.access(actor,q.resource);
    if(!hasPermission(new Set(live.permissions),'alert:view')){result.formal_events=[];result.formal_events_readable=false;}
    return result;
  }
  async capacity(actor:ActorContext,input:unknown) {
    const q=StudyCapacitySchema.parse(input);actor=await this.access(actor,q.resource,true);
    const c=await this.pool().getConnection();
    try {
      await c.beginTransaction();const [lock]=await c.query<RowDataPacket[]>('SELECT id FROM metric_policy_lock WHERE id=1 FOR UPDATE');rule(lock.length===1,'POLICY_LOCK_UNAVAILABLE',503);await this.access(actor,q.resource,true);
      const scope="JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.resource_type'))=? AND JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.resource_id'))=?";
      const params=[q.resource.type,String(q.resource.id)],now=new Date(this.clock());
      const [rows]=await c.execute<RowDataPacket[]>(`SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.value.encoding')),'unknown') AS value_class,
        COUNT(*) AS rows_count,SUM(OCTET_LENGTH(o.payload)) AS payload_bytes FROM metric_observations o
        WHERE o.stage='normalized' AND o.payload IS NOT NULL AND ${scope} GROUP BY value_class`,params);
      const counts:Record<string,unknown>={};
      const configured=configuredRetention();
      const [trendRows]=await c.execute<RowDataPacket[]>('SELECT COUNT(*) AS n,COALESCE(SUM(OCTET_LENGTH(metadata)+OCTET_LENGTH(statistics)),0) AS bytes FROM metric_retained_trends WHERE resource_key=?',[refKey(q.resource)]);
      const [receiptRows]=await c.execute<RowDataPacket[]>('SELECT COUNT(*) AS n FROM metric_trend_receipts i JOIN metric_retained_trends t ON t.series_hash=i.series_hash AND t.bucket_ms=i.bucket_ms AND t.value_class=i.value_class WHERE t.resource_key=?',[refKey(q.resource)]);
      const trendHorizon=configured.trendMs??DEFAULT_TREND_RETENTION_MS;
      const projectedBuckets=Math.ceil(650*q.assumptions.series_per_resource*trendHorizon/Math.max(300000,q.assumptions.interval_ms));
      for(const [name,s] of Object.entries(observationSelections(now,configured))) {
        if(name==='attempts')continue;
        const policyExpiry=`CASE WHEN ${numericSql} THEN ? ELSE ? END`;
        // Preserve the accepted lineage/current-value protection; custom age can only narrow its candidates.
        const selection={...s,where:`(${s.where}) AND ${scope} AND JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.value.encoding')) IN ('float64','uint64','int64','histogram','summary')
          AND NOT EXISTS (SELECT 1 FROM metric_trigger_inputs i WHERE CAST(i.sample_id AS BINARY)=CAST(o.id AS BINARY))
          AND NOT EXISTS (SELECT 1 FROM metric_trigger_episodes e WHERE JSON_CONTAINS(JSON_EXTRACT(e.snapshot,'$.opening.sample_ids'),JSON_QUOTE(o.id)))
          AND o.stored_at < ${policyExpiry}`,params:[...s.params,...params,
          retentionSqlTime(new Date(now.getTime()-q.assumptions.numeric_days*86400000)),retentionSqlTime(new Date(now.getTime()-q.assumptions.non_numeric_days*86400000))]};
        counts[name]=(await retentionPreview(c,{[name]:selection},now))[name];
      }
      const expiry=trendSelection(now,configured);
      counts.retainedTrends=(await retentionPreview(c,{retainedTrends:{...expiry,where:`(${expiry.where}) AND t.resource_key=?`,params:[...expiry.params,refKey(q.resource)]}},now)).retainedTrends;
      const measured=rows.map(row=>{const n=Number(row.rows_count),bytes=Number(row.payload_bytes),known=['float64','uint64','int64','histogram','summary'].includes(row.value_class),days=['float64','uint64','int64'].includes(row.value_class)?q.assumptions.numeric_days:q.assumptions.non_numeric_days;
        const daily=650*q.assumptions.series_per_resource*86400000/q.assumptions.interval_ms;
        return {value_class:row.value_class,rows:n,payload_bytes:bytes,mean_payload_bytes:n?bytes/n:null,retention_days:days,
          projected_rows_650:known?Math.ceil(daily*days):null,projected_payload_bytes_650:known&&n?Math.ceil(bytes/n*daily*days):null};});
      const result={resource:q.resource,preview_only:true,assumptions:{...q.assumptions,resources:{server:500,instance:100,network_device:50},basis:'explicit_measurement_assumption'},
        measured,cleanup_candidates:counts,configured_retention:configured,
        retained_trends:{buckets:Number(trendRows[0]?.n??0),payload_bytes:Number(trendRows[0]?.bytes??0),receipts:Number(receiptRows[0]?.n??0),retention_ms:trendHorizon,
          projected_buckets_650:projectedBuckets,projected_receipts_650:Math.ceil(650*q.assumptions.series_per_resource*trendHorizon/q.assumptions.interval_ms),
          projected_statistics_bytes_650:Number(trendRows[0]?.n)>0?Math.ceil(Number(trendRows[0].bytes)/Number(trendRows[0].n)*projectedBuckets):null,
          basis:'650资源、所填序列/周期、统一趋势保留上限；假设桶持续占用并沿用选中资源实测类型混合及平均JSON大小。回执仅预测数量，不含其存储字节及索引/备份；不代表完整磁盘容量。'},
        boundary:'各类型单独假设650资源全部使用该类型，不能相加为混合容量；仅JSON载荷字节，不含索引、raw、备份或复制。保全策略保护当前/引用证据及触发器输入；候选取现有策略与所选保留期交集。未分类值和已清除载荷的身份保守排除。无样本类型预测未知。',
        baseline:{commit:'61b57ce7572dd6e683d9af42b21f33f073899e2c',resources:650,series_per_resource:1,interval_ms:60000,throughput_jobs_s:[13.09,12.02,11.16],history_p95_ms:[10.19,14.37,18.75],production_slo:false,
          p0_gate_source:'MAX-236/05-capacity-baseline-slo.md §5',stop_thresholds:{sampling_delay_p95_intervals:2,missing_rate:0.05,duplicate_events:0},gate_measured_here:false}};
      await this.access(actor,q.resource,true);
      await c.execute('INSERT INTO metric_history_study_audit(resource_key,action,created_at,payload) VALUES(?,?,?,?)',[refKey(q.resource),'history.cleanup_preview',retentionSqlTime(new Date(this.clock())),JSON.stringify({actor_id:actor.userId,request_id:actor.requestId,request:q,result_hash:digest(result)})]);
      await this.access(actor,q.resource,true);await c.commit();return result;
    }catch(e){await c.rollback();throw e;}finally{c.release();}
  }
  private async audit(actor:ActorContext,ref:Ref,action:string,evidence:unknown,manage:boolean) {
    const c=await this.pool().getConnection();try{await c.beginTransaction();const [lock]=await c.query<RowDataPacket[]>('SELECT id FROM metric_policy_lock WHERE id=1 FOR UPDATE');rule(lock.length===1,'POLICY_LOCK_UNAVAILABLE',503);
      await this.access(actor,ref,manage);await c.execute('INSERT INTO metric_history_study_audit(resource_key,action,created_at,payload) VALUES(?,?,?,?)',[refKey(ref),action,retentionSqlTime(new Date(this.clock())),JSON.stringify({actor_id:actor.userId,request_id:actor.requestId,evidence})]);
      await this.access(actor,ref,manage);await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}
  }
}
