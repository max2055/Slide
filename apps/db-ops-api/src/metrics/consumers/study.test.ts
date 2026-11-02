import { beforeEach, expect, it, vi } from 'vitest';
import { RetainedTrendStore } from './retained-trends.js';
import { MetricStudyService } from './study.js';
import { MysqlFormalMetricStore } from '../rollout/formal-store.js';
import { baseline, thresholdRule, fixtureRegistry, portOf } from '../triggers/test-support.js';
import { resolveTriggerRules } from '../triggers/resolve.js';
import { compileTriggerSnapshot } from '../triggers/compile.js';
import { admin } from '../policy/test-support.js';
import { sample, identify } from '../../contracts/metrics/fixtures.js';
import { registerMetricStudyRoutes } from './study-routes.js';
import Fastify from 'fastify';
import { StudyTrendResultSchema,StudyReplayResultSchema,StudyCapacityResultSchema } from '../../contracts/metrics/study.js';
import type { NormalizedObservation } from '../../contracts/metrics/index.js';

const ref={type:'instance' as const,id:7},from='2026-10-01T00:00:00Z',to='2026-10-01T00:05:00Z';
let service:MetricStudyService,snapshot:any,config:any,rows:NormalizedObservation[],denied=false;
let extraConfigurations:Record<number,any>;
let execute:ReturnType<typeof vi.fn>,query:ReturnType<typeof vi.fn>,rollback:ReturnType<typeof vi.fn>,commit:ReturnType<typeof vi.fn>;
let reads:ReturnType<typeof vi.spyOn>;
beforeEach(async()=>{
  vi.restoreAllMocks();vi.spyOn(RetainedTrendStore.prototype,'metadata').mockResolvedValue([]);vi.spyOn(RetainedTrendStore.prototype,'read').mockResolvedValue([]);vi.spyOn(RetainedTrendStore.prototype,'withoutPreserved').mockImplementation(async rows=>rows);denied=false;extraConfigurations={};const base=await baseline();snapshot=compileTriggerSnapshot(await resolveTriggerRules(base.resolution,base.catalog,portOf([base.version]).port));
  const metric=snapshot.rules[0].metric;
  rows=[0,60000,120000].map(ms=>identify({...sample('db.uptime_seconds'),resource_type:'instance',resource_id:'7',metric,
    versions:{...sample('db.uptime_seconds').versions,config_revision:snapshot.config_revision},observed_at:new Date(Date.parse(from)+ms).toISOString(),value:{encoding:'float64',value:95},unit:snapshot.rules[0].unit}));
  config={resource:ref,revision:snapshot.config_revision,state:'effective',resolution_identity:snapshot.plan_identity,
    snapshot_digest:`sha256:${'a'.repeat(64)}`,published_at:from,
    settings:{enabled:true,interval_ms:60000,timeout_ms:5000,stale_after_ms:180000,max_counter_gap_ms:180000,max_rows:100,max_concurrency:1,max_series_per_resource:10},evidence:[]};
  reads=vi.spyOn(MysqlFormalMetricStore.prototype,'readStudyWindow').mockImplementation(async()=>rows);
  vi.spyOn(MysqlFormalMetricStore.prototype,'historyDimensions').mockResolvedValue([{}]);
  vi.spyOn(MysqlFormalMetricStore.prototype,'historyMetrics').mockResolvedValue([metric]);
  execute=vi.fn(async(sql:string)=>sql.includes('metric_trigger_snapshots')?[[{payload:snapshot}]]:sql.includes('metric_trigger_episodes')?[[]]:sql.includes('value_class')?[[{value_class:'uint64',rows_count:10,payload_bytes:1000}]]:[[]]);
  query=vi.fn(async(sql:string)=>sql.includes('COUNT(*)')?[[{count:0,oldest:null}]]:[[{id:1}]]);
  rollback=vi.fn();commit=vi.fn();const connection={execute,query,beginTransaction:vi.fn(),commit,rollback,release:vi.fn()};
  const pool={execute,getConnection:async()=>connection} as any;
  service=new MetricStudyService(()=>pool,{assertAccess:async(a,r)=>{if(denied||r.id!==7)throw new Error('FORBIDDEN_TEST');}},fixtureRegistry(),async a=>a,async(_a,_r,revision)=>extraConfigurations[revision]??config,()=>to);
});
const request=()=>({resource:ref,from,to,metric:snapshot.rules[0].metric});
const replay=()=>({resource:ref,from,to,revision:snapshot.config_revision,snapshot_hash:snapshot.snapshot_hash,rule_id:snapshot.rules[0].rule_id,scope:snapshot.rules[0].scope});
it('normalizes offset windows and reads only formal evidence through the long-window port',async()=>{
  const r=await service.trend(admin,{...request(),from:'2026-10-01T08:00:00+08:00',to:'2026-10-01T08:05:00+08:00'});
  expect(r.window).toEqual({from:'2026-10-01T00:00:00.000Z',to:'2026-10-01T00:05:00.000Z'});expect(r.buckets[0].count).toBe(3);
  expect(reads).toHaveBeenCalledWith(expect.objectContaining({resource_id:'7'}),r.window.from,r.window.to);
  expect(StudyTrendResultSchema.safeParse(r).success).toBe(true);
});
it('rejects cross-resource access before storage',async()=>{await expect(service.trend(admin,{...request(),resource:{...ref,id:8}})).rejects.toThrow('FORBIDDEN_TEST');expect(reads).not.toHaveBeenCalled();});
it('rejects permission revoked during a trend read',async()=>{reads.mockImplementation(async()=>{denied=true;return rows;});await expect(service.trend(admin,request())).rejects.toThrow('FORBIDDEN_TEST');});
it.each([{from:to,to:from},{from:'2024-01-01T00:00:00Z',to},{from,to:'2027-01-01T00:00:00Z'}])('rejects invalid or future window %j',async w=>{await expect(service.trend(admin,{...request(),...w})).rejects.toThrow('QUERY_WINDOW');expect(reads).not.toHaveBeenCalled();});
it('reuses frozen rule evaluator in isolation and audits exact rule/window without formal writes',async()=>{
  const r=await service.replay(admin,replay());expect(r.isolated).toBe(true);expect(r.runs[0].timeline.filter(t=>t.event_type==='sample')).toHaveLength(3);expect(r.runs[0].timeline.every(t=>t.reason!=='not_applied')).toBe(true);
  expect(r.rule.version).toBe(snapshot.rules[0].version);expect(r.evidence_hash).toMatch(/^sha256:/);
  expect(StudyReplayResultSchema.parse(r)).toMatchObject({isolated:true});
  const writes=execute.mock.calls.filter(([s])=>/^INSERT|^UPDATE|^DELETE/.test(s));expect(writes).toHaveLength(1);expect(writes[0][0]).toContain('metric_history_study_audit');expect(commit).toHaveBeenCalledOnce();
});
it('does not invent applied proof from a published historical rule',async()=>{config.state='published';const r=await service.replay(admin,replay());expect(r.runs[0].timeline.every(t=>t.reason==='not_applied')).toBe(true);});
it('rejects another revision or snapshot hash instead of silently selecting the current rule',async()=>{await expect(service.replay(admin,{...replay(),snapshot_hash:`sha256:${'f'.repeat(64)}`})).rejects.toThrow('HISTORY_SNAPSHOT_MISSING');});
it('never recovers at the tail by falling back past a null newest sample',async()=>{rows[2].value=null;const r=await service.replay(admin,replay());expect(r.runs[0].tail.business).toBe('unknown');});
it('refuses a replay over the original evaluator input budget',async()=>{rows=Array.from({length:4097},()=>rows[0]);await expect(service.replay(admin,replay())).rejects.toThrow('QUERY_LIMIT_EXCEEDED');expect(commit).not.toHaveBeenCalled();});
it('permission revoked after the audit lock rolls back without committing a receipt',async()=>{query.mockImplementation(async()=>{denied=true;return [[{id:1}]];});await expect(service.replay(admin,replay())).rejects.toThrow('FORBIDDEN_TEST');expect(rollback).toHaveBeenCalledOnce();expect(commit).not.toHaveBeenCalled();});
it('capacity preview uses explicit 650-resource assumptions and lineage-preserving scoped selection',async()=>{
  const r=await service.capacity(admin,{resource:ref,assumptions:{numeric_days:45,non_numeric_days:8,interval_ms:60000,series_per_resource:2}});
  expect(r.preview_only).toBe(true);expect(r.measured[0].projected_rows_650).toBe(650*2*1440*45);expect(r.measured[0].projected_payload_bytes_650).toBe(650*2*1440*45*100);
  expect(StudyCapacityResultSchema.parse(r)).toMatchObject({preview_only:true});
  expect(query.mock.calls.filter(([s])=>s.includes('COUNT(*)')).every(([s])=>(s.includes('resource_type')&&s.includes('resource_id'))||s.includes('resource_key'))).toBe(true);
  expect(execute.mock.calls.filter(([s])=>/^DELETE|^UPDATE/.test(s))).toEqual([]);
});
it('an empty evidence window never evaluates the predecessor as a healthy current sample',async()=>{rows=[{...rows[0],observed_at:'2026-09-30T23:59:59Z'}];const r=await service.replay(admin,replay());expect(r.evidence_count).toBe(0);expect(r.runs[0].timeline.every(t=>t.event_type==='clock'&&t.business!=='healthy')).toBe(true);expect(r.runs[0].tail.business).not.toBe('healthy');});
it('uses each evidence revision cadence rather than the selected rule cadence to prove contiguous windows',async()=>{
  config.settings.interval_ms=120000;extraConfigurations[99]={...config,revision:99,settings:{...config.settings,interval_ms:15000}};
  rows=rows.slice(0,2).map(p=>({...p,versions:{...p.versions,config_revision:99}}));
  const average=snapshot.rules.find((r:any)=>r.rule_id.includes('average'));expect(average).toBeDefined();
  const result=await service.replay(admin,{...replay(),rule_id:average.rule_id,scope:average.scope});
  expect(result.runs[0].timeline[1].reason).toBe('gap');expect(result.evidence_configurations.map(c=>c.revision)).toEqual([snapshot.config_revision,99]);
});
it('rejects a configuration proof belonging to another resource',async()=>{config.resource={...ref,id:8};await expect(service.replay(admin,replay())).rejects.toThrow('HISTORY_CONFIGURATION_IDENTITY');expect(commit).not.toHaveBeenCalled();});
it('audit failure rolls back the preview and never acknowledges success',async()=>{const original=execute.getMockImplementation() as (...args:any[])=>Promise<any>;execute.mockImplementation(async(s,...rest)=>{if(s.includes('INSERT INTO metric_history_study_audit'))throw new Error('audit down');return original(s,...rest);});await expect(service.capacity(admin,{resource:ref})).rejects.toThrow('audit down');expect(commit).not.toHaveBeenCalled();expect(rollback).toHaveBeenCalledOnce();});
it('routes reject malformed input and unauthenticated callers without leaking errors',async()=>{
  const app=Fastify();await registerMetricStudyRoutes(app,async req=>{if(req.headers.authorization)(req as any).user=admin;},service);
  expect((await app.inject({method:'POST',url:'/api/metrics/study/trend',payload:{}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/api/metrics/study/trend',headers:{authorization:'test'},payload:{...request(),secret:'not-accepted'}})).statusCode).toBe(400);await app.close();
});
it('Chief R4: emits a nodata clock at 00:03 before 00:04 evidence recovers, without inventing samples',async()=>{
  const healthy=rows[0];rows=[{...healthy,observed_at:'2026-09-30T23:58:00Z',value:{encoding:'float64',value:60}},{...healthy,id:'sha256:'+ 'b'.repeat(64),observed_at:'2026-10-01T00:04:00Z',value:{encoding:'float64',value:60}}];
  const r=await service.replay(admin,{...replay(),from:'2026-09-30T23:57:00Z',rule_id:snapshot.rules.find((r:any)=>r.rule_id==='alpha-threshold').rule_id,scope:'item:alpha'});const t=r.runs[0].timeline;
  expect(t.find(t=>t.nodata)).toMatchObject({event_type:'clock',sample_id:null,evaluated_at:'2026-10-01T00:03:00.000Z'});
  expect(t.filter(t=>t.event_type==='sample')).toHaveLength(2);expect(t.at(-1)).toMatchObject({event_type:'sample',recovery:true});
});
it('Chief R4: an arrival at the nodata boundary takes precedence; disabled nodata still reports stale',async()=>{
  const healthy=rows[0];rows=[{...healthy,observed_at:from},{...healthy,observed_at:'2026-10-01T00:04:59Z'}];
  const r=await service.replay(admin,replay());expect(r.runs[0].timeline.some(t=>t.nodata)).toBe(false);
  expect(r.runs[0].timeline.some(t=>t.event_type==='clock'&&t.reason==='stale')).toBe(true);
});
async function frozenRule(rule:ReturnType<typeof thresholdRule>){
 const b=await baseline({rules:[rule],triggers:[{rule_id:rule.rule_id,scope:rule.scope,version:rule.version}]});snapshot=compileTriggerSnapshot(await resolveTriggerRules(b.resolution,b.catalog,portOf([b.version]).port));config.resolution_identity=snapshot.plan_identity;
}
it('Chief R4: nodata disabled preserves an intervening unknown stale period without opening a problem',async()=>{
 await frozenRule(thresholdRule({clock:{stale_after_ms:120000,nodata:{enabled:false}}}));
 rows=[{...rows[0],observed_at:from,value:{encoding:'float64',value:60}},{...rows[0],observed_at:'2026-10-01T00:04:00Z',value:{encoding:'float64',value:60}}];
 const r=await service.replay(admin,replay());expect(r.runs[0].timeline.some(t=>t.reason==='stale'&&t.event_type==='clock')).toBe(true);expect(r.runs[0].timeline.some(t=>t.nodata||t.recovery)).toBe(false);
});
it('Chief R4: independent clock evaluation budget rejects before audit, even within raw sample budget',async()=>{
 const rule=thresholdRule();await frozenRule(thresholdRule({problem:{...rule.problem as any,select:{aggregation:'avg',window_ms:60000}}}));
 rows=Array.from({length:4096},(_,i)=>({...rows[0],id:`clock-budget-${i}`,observed_at:new Date(Date.parse(to)-(4096-i)*600000).toISOString()}));
 await expect(service.replay(admin,{...replay(),from:rows[0].observed_at})).rejects.toThrow('QUERY_LIMIT_EXCEEDED');expect(commit).not.toHaveBeenCalled();
});
it('Chief R5: archived-only history remains discoverable but cannot become replay evidence',async()=>{
 vi.spyOn(RetainedTrendStore.prototype,'metadata').mockResolvedValue([{resource_type:ref.type,resource_id:String(ref.id),metric:snapshot.rules[0].metric,dimensions:{}}]);
 vi.spyOn(RetainedTrendStore.prototype,'read').mockResolvedValue([{bucket:{} as any,metadata:{} as any}]);
 await expect(service.replay(admin,replay())).rejects.toThrow('HISTORY_RAW_EXPIRED');expect(commit).not.toHaveBeenCalled();
});
