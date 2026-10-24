import type { ActorContext } from '../../auth/actor-context.js';
import { canReadResource } from '../../resources/resource-service.js';
import type { Observation, ResourceRef } from '../../resources/types.js';
import { metricConsumerService } from './runtime.js';
import { migrateReference } from './migration.js';
import type { ConsumerMetric } from './service.js';

type QueryService = Pick<typeof metricConsumerService,'discover'|'query'>;
/** Compatibility observation shape, backed exclusively by the accepted semantic store. */
export class FormalObservationService {
  constructor(private service:QueryService=metricConsumerService){}
  private async resolve(actor:ActorContext,resource:ResourceRef,id:string){
    if(!canReadResource(actor,resource))throw new Error('RESOURCE_FORBIDDEN');
    const catalog=await this.service.discover(actor,resource);
    const engine=catalog.effective?.resolved.plan.binding.package.id.split('-')[0]??'';
    const mapped=migrateReference(resource,engine,id.replace(/^server_/,''));
    return mapped.metric_id&&catalog.definitions.some(d=>d.id===mapped.metric_id)?mapped.metric_id:null;
  }
  private unknown(resource:ResourceRef,metricId:string,reason='missing_observation'):Observation{
    return {resource,metricId,value:null,observedAt:null,validUntil:null,source:'metrics',quality:'unknown',reason};
  }
  private points(resource:ResourceRef,metricId:string,metric:ConsumerMetric,validForMs:number,now:Date):Observation[]{
    if(metric.definition.kind==='counter')return [this.unknown(resource,metricId,'USE_SEMANTIC_METRIC_API')];
    return metric.series.flatMap(s=>s.buckets.map(b=>{
      // The old DTO cannot carry exact uint64 values outside the safe Number range.
      const scalar=b.value&&'value'in b.value?Number(b.value.value):null;
      const exact=scalar!==null&&Number.isFinite(scalar)&&(b.value!.encoding==='float64'||Number.isSafeInteger(scalar));
      const actualAt=b.observed_at;
      const observedAt=actualAt?new Date(actualAt):null,validUntil=observedAt?new Date(observedAt.getTime()+validForMs):null;
      const good=exact&&b.quality.status==='good'&&b.freshness==='fresh'&&observedAt!==null&&observedAt<=now&&validUntil!==null&&validUntil>now;
      return {resource,metricId,value:good?scalar:null,observedAt,validUntil,source:'metrics',quality:good?'good' as const:'unknown' as const,
        dimensions:s.dimensions,reason:good?undefined:b.value===null?(b.quality.reason&&b.quality.reason!=='none'?b.quality.reason:'missing_observation')
          :!exact?'precision_loss':observedAt!==null&&observedAt>now?'future_observation'
          :b.freshness==='stale'||validUntil!==null&&validUntil<=now?'stale_observation':b.quality.reason};
    })).sort((a,b)=>(b.observedAt?.getTime()??0)-(a.observedAt?.getTime()??0));
  }
  async latest(actor:ActorContext,resource:ResourceRef,metricId:string,options:{now?:Date;validForMs:number}):Promise<Observation>{
    const now=options.now??new Date();
    if(!Number.isFinite(now.getTime())||!Number.isSafeInteger(options.validForMs)||options.validForMs<=0||options.validForMs>31*86400000)throw new Error('OBSERVATION_RANGE_INVALID');
    const id=await this.resolve(actor,resource,metricId);if(!id)return this.unknown(resource,metricId,'MIGRATION_REVIEW_REQUIRED');
    // The caller's validity bound is an explicit lookup window, not a global
    // extension of freshness or permission to relabel old samples as current.
    const response=await this.service.query(actor,{resource,metric_ids:[id],from:new Date(now.getTime()-options.validForMs).toISOString(),to:now.toISOString()});
    const metric=response.metrics[0];
    if(metric.series.length>1)return this.unknown(resource,metricId,'DIMENSIONS_REQUIRED');
    return this.points(resource,metricId,metric,options.validForMs,now)[0]??this.unknown(resource,metricId);
  }
  async range(actor:ActorContext,resource:ResourceRef,metricId:string,options:{from:Date;to:Date;validForMs:number;limit?:number;now?:Date}):Promise<Observation[]>{
    if(!Number.isFinite(options.from.getTime())||!Number.isFinite(options.to.getTime())||options.to<=options.from||options.to.getTime()-options.from.getTime()>31*86400000)throw new Error('OBSERVATION_RANGE_INVALID');
    const id=await this.resolve(actor,resource,metricId);if(!id)return [this.unknown(resource,metricId,'MIGRATION_REVIEW_REQUIRED')];
    const response=await this.service.query(actor,{resource,metric_ids:[id],from:options.from.toISOString(),to:options.to.toISOString()});
    return this.points(resource,metricId,response.metrics[0],options.validForMs,options.now??new Date()).slice(0,Math.max(1,Math.min(options.limit??200,1000)));
  }
}
