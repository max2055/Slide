import { assertWorkflowActive } from '../../workflows/execution-context.js';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { mean, standardDeviation } from 'simple-statistics';
import { dbConnection } from '../../db-connection.js';
import type { BaselineResult } from '../../baseline-calculator.js';
import { metricConsumerService } from './runtime.js';
import { migrateReference } from './migration.js';
import { MysqlFormalMetricStore } from '../rollout/formal-store.js';
import { rule } from '../policy/model.js';

export class SemanticBaselineService {
  constructor(private pool:()=>Pool|null=()=>dbConnection.getPool(),private consumer=metricConsumerService){}
  private async context(instanceId:number,metricName:string){
    const ref={type:'instance' as const,id:instanceId},actor={userId:0,username:'metric-baseline',roles:[],sessionVersion:0,requestId:`baseline:${instanceId}`,
      permissions:['instance:view'],instanceScopes:{[instanceId]:'read-only' as const}};
    const catalog=await this.consumer.discover(actor,ref);
    const id=migrateReference(ref,catalog.effective?.resolved.plan.binding.package.id.split('-')[0]??'',metricName).metric_id;
    const definition=catalog.definitions.find(d=>d.id===id);
    rule(catalog.effective&&definition,'METRIC_BASELINE_REFERENCE_UNAVAILABLE');
    rule(definition.kind==='gauge'&&!definition.dimensions.keys.some(k=>k.required),'METRIC_BASELINE_SCOPE_REVIEW_REQUIRED');
    const template=catalog.effective.resolved.metric_templates.find(t=>t.metric.id===id);
    rule(template?.enabled&&catalog.effective.resolved.settings.enabled,'METRIC_BASELINE_DISABLED');
    return {ref,definition,revision:catalog.effective.published_revision};
  }
  async compute(instanceId:number,metricName:string,sigma=2,lookbackDays=7):Promise<{success:boolean;result?:BaselineResult;error?:string}>{
    try{
      rule(Number.isFinite(sigma)&&sigma>0&&sigma<=10&&Number.isInteger(lookbackDays)&&lookbackDays>=1&&lookbackDays<=31,'METRIC_BASELINE_INPUT');
      const pool=this.pool();rule(pool,'METRIC_STORE_UNAVAILABLE');
      const ctx=await this.context(instanceId,metricName),at=new Date(),from=new Date(at.getTime()-lookbackDays*86400000).toISOString();
      const samples=await new MysqlFormalMetricStore(pool).baselineSamples(ctx.ref,ctx.definition,ctx.revision,from,at.toISOString());
      const values=samples.filter(o=>o.quality.status==='good'&&o.value&&'value'in o.value&&o.accuracy==='exact').map(o=>{
        const value=o.value! as {encoding:string;value:string|number},n=Number(value.value);
        return Number.isFinite(n)&&(value.encoding==='float64'||Number.isSafeInteger(n))?n:null;
      }).filter((n):n is number=>n!==null);
      rule(values.length>=10,'METRIC_BASELINE_INSUFFICIENT_SAMPLES');
      const average=mean(values),deviation=standardDeviation(values);
      const result={instanceId,metricName,mean:average,stddev:deviation,lowerBound:average-sigma*deviation,upperBound:average+sigma*deviation,sampleCount:values.length,computedAt:at};
      assertWorkflowActive();
      await pool.execute(`INSERT INTO metric_semantic_baselines(resource_key,reference_id,revision,payload,computed_at) VALUES(?,?,?,?,?)
        ON DUPLICATE KEY UPDATE revision=VALUES(revision),payload=VALUES(payload),computed_at=VALUES(computed_at)`,
      [`instance:${instanceId}`,metricName,ctx.revision,JSON.stringify({result,metric:{id:ctx.definition.id,semantic_version:ctx.definition.semantic_version},unit:ctx.definition.unit,sigma,lookback_days:lookbackDays}),at]);
      return {success:true,result};
    }catch(e){assertWorkflowActive();return {success:false,error:e instanceof Error&&/^(METRIC_|POLICY_)/.test(e.message)?e.message:'METRIC_BASELINE_UNAVAILABLE'};}
  }
  async cached(instanceId:number,metricName:string){
    try{
      const pool=this.pool();if(!pool)return null;
      const ctx=await this.context(instanceId,metricName);
      const [rows]=await pool.execute<RowDataPacket[]>('SELECT payload FROM metric_semantic_baselines WHERE resource_key=? AND reference_id=? AND revision=?',
        [`instance:${instanceId}`,metricName,ctx.revision]);
      if(!rows[0])return null;const p=typeof rows[0].payload==='string'?JSON.parse(rows[0].payload):rows[0].payload;
      if(p.metric.id!==ctx.definition.id||p.metric.semantic_version!==ctx.definition.semantic_version||p.unit!==ctx.definition.unit)return null;
      const {mean,stddev,lowerBound,upperBound}=p.result;return {mean,stddev,lowerBound,upperBound};
    }catch{return null;}
  }
}
export const semanticBaselineService=new SemanticBaselineService();
