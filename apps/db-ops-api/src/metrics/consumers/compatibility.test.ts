import {it,expect,vi} from 'vitest';
import {FormalObservationService} from './observations.js';
import {resourceMetricRead} from './resource-api.js';
import {canonicalDefinitions} from '../packages/builtins.js';
import {admin} from '../policy/test-support.js';
const resource={type:'server' as const,id:1},now=new Date('2026-10-16T12:00:00.000Z');
function fixture(value:any={encoding:'uint64',value:'42'},dimensions:Record<string,string>={}){
 const definition={...canonicalDefinitions.find(d=>d.id==='host.filesystem.used_bytes')!};
 const metric:any={definition,observed_at:now.toISOString(),series:[{dimensions,buckets:[
  {window:{from:'2026-10-16T11:59:00.000Z',to:now.toISOString()},observed_at:'2026-10-16T11:59:30.000Z',value,unit:'By',quality:{status:'good',reason:'none'},freshness:'fresh'},
 ]}]};
 const service={discover:vi.fn(async()=>({effective:null,definitions:[definition]})),query:vi.fn(async()=>({metrics:[metric]}))};
 return {metric,service};
}
it('resource compatibility API retains exact encoded values, dimensions and actual observation time',async()=>{
 const {service}=fixture({encoding:'uint64',value:'9007199254740993'},{mount:'/data'});
 const result=await resourceMetricRead(admin,resource,{},service as any);
 expect(result.metrics[0]).toMatchObject({value:{encoding:'uint64',value:'9007199254740993'},dimensions:{mount:'/data'},recorded_at:'2026-10-16T11:59:30.000Z'});
 expect(result.recorded_at).toBe('2026-10-16T11:59:30.000Z');
});
it('old numeric observation DTO refuses lossy numbers and ambiguous dimensions without a fallback',async()=>{
 const {service,metric}=fixture({encoding:'uint64',value:'9007199254740993'});
 const observations=new FormalObservationService(service as any);
 expect(await observations.latest(admin,resource,'host.filesystem.used_bytes',{now,validForMs:60000})).toMatchObject({quality:'unknown',value:null,reason:'precision_or_value_unavailable'});
 metric.series.push({...metric.series[0],dimensions:{mount:'/other'}});
 expect(await observations.latest(admin,resource,'host.filesystem.used_bytes',{now,validForMs:60000})).toMatchObject({quality:'unknown',value:null,reason:'DIMENSIONS_REQUIRED'});
});
it('history compatibility uses each bucket actual time, preserves stale unknown, and propagates formal-store failure',async()=>{
 const {service,metric}=fixture();
 const observations=new FormalObservationService(service as any);
 metric.series[0].buckets.push({...metric.series[0].buckets[0],observed_at:'2026-10-16T11:58:00.000Z',freshness:'stale'});
 const rows=await observations.range(admin,resource,'host.filesystem.used_bytes',{now,validForMs:60000,from:new Date('2026-10-16T11:00:00Z'),to:now});
 expect(rows.map(o=>o.observedAt?.toISOString())).toEqual(['2026-10-16T11:59:30.000Z','2026-10-16T11:58:00.000Z']);
 expect(rows[1]).toMatchObject({value:null,quality:'unknown',reason:'stale_observation'});
 service.query.mockRejectedValueOnce(new Error('FORMAL_STORE_FAILED'));
 await expect(observations.latest(admin,resource,'host.filesystem.used_bytes',{now,validForMs:60000})).rejects.toThrow('FORMAL_STORE_FAILED');
});
