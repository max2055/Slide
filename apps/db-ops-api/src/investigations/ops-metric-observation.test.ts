import {reviewedSqlCatalog} from '../metrics/database/reviewed-sql-catalog.js';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {responseHash} from '@slide/agent-core';
import {createQueryMetricsTool} from '../tools/ops/query_metrics.js';
import {admin} from '../metrics/policy/test-support.js';
import {investigationContextMessages} from './executor.js';
import {investigationToolContract,investigationToolPolicy} from './tool-contract.js';

// Real retained semantic receipts; the service is offline, the handler and
// strict argument parsing and production model projection are actual code.
const fixture=JSON.parse(readFileSync(new URL('./fixtures/ops-post-query-fix-20261022.json',import.meta.url),'utf8'));
const retained=JSON.parse(fixture.entries.find((m:any)=>m.role==='tool'&&m.name==='query_metrics').content);
async function read(metric:any){
 const data={...structuredClone(retained.data),metrics:[structuredClone(metric)]};
 const service={query:async()=>data};
 const tool=createQueryMetricsTool(service as any);
 const args={resourceType:'instance',resourceId:1,metric_ids:[metric.definition.id],from:data.window.from,to:data.window.to};
 const receipt=await tool.handler(args,{actor:admin});
 expect(receipt.success).toBe(true);
 expect(await tool.handler({...args,maxRows:1},{actor:admin})).toMatchObject({success:false,errorCode:'INVALID_ARGUMENTS'});
 const raw:any[]=[{role:'tool',name:'query_metrics',tool_call_id:'single',content:JSON.stringify(receipt)}];
 const before=JSON.stringify(raw), view=investigationContextMessages(raw,'ops');
 expect(JSON.stringify(raw)).toBe(before);
 expect(investigationContextMessages(view,'ops')).toEqual(view);
 return {data,receipt,view:JSON.parse(String(view[0].content))};
}
describe('OPS-READ-01: a legal single metric is visible to Ops',()=>{
 it.each(retained.data.metrics.map((m:any)=>[m.definition.id,m]))('keeps the real %s definition, value and audited semantics',async(_id,metric)=>{
  const {data,receipt,view}=await read(metric);
  console.info('Offline single metric receipt',metric.definition.id,Buffer.byteLength(JSON.stringify(receipt)),'projection',Buffer.byteLength(JSON.stringify(view)));
  expect(view.data.metrics).toEqual(data.metrics);
  expect(view.data).toMatchObject({resource:data.resource,window:data.window,evaluated_at:data.evaluated_at,configuration_revision:data.configuration_revision});
  expect(view.data.evidenceOmitted).not.toBe(true);
  expect(view.data.contextReference).toMatchObject({toolCallId:'single',sha256:responseHash(receipt)});
  expect(view.status).toBe(receipt.status);
  expect(view.summary).toBe(receipt.summary);expect(view.next_actions).toEqual(receipt.next_actions);
 });
 it.each(['zero','unknown','temporary_failure','stale'])('preserves %s without fabricating a healthy value',async state=>{
  const metric=structuredClone(retained.data.metrics[0]),bucket=metric.series[0].buckets[0];
  if(state==='zero'){
   // Constructed offline boundary; never attribute this zero to r4 uptime.
   metric.definition=structuredClone((reviewedSqlCatalog[1] as any).definition);
   metric.capability={status:'supported',basis:[{kind:'resource',evidence:'offline fixture'}]};metric.attempt=null;
   bucket.metric={id:metric.definition.id,semantic_version:metric.definition.semantic_version};
   bucket.unit='count';bucket.value={encoding:'uint64',value:'0'};bucket.sources=[];
  }else if(state==='stale')bucket.freshness='stale';
  else{metric.state=state;bucket.value=null;bucket.accuracy='unknown';bucket.coverage=0;bucket.freshness='unknown';bucket.quality={status:'unknown',reason:'source_error'};
   if(state==='temporary_failure')metric.attempt={...metric.attempt,status:'failed',error:'timeout'};}
  const {data,view}=await read(metric);expect(view.data.metrics).toEqual(data.metrics);
  expect(view.data.metrics[0].series[0].buckets[0].value).toEqual(bucket.value);
 });
 it('only suggests arguments the strict query tool actually accepts',()=>{
  const policy=investigationToolPolicy([{type:'instance',id:1}],{maxRows:100,maxWindowMs:3600000});
  expect(policy).not.toContain('with maxRows=1 or limit=1');
  const contract=investigationToolContract(createQueryMetricsTool() as any,[{type:'instance',id:1}],{maxRows:100,maxWindowMs:3600000})!;
  expect(contract.description).toContain('metric_ids');expect(contract.description).toContain('from/to');
  expect(contract.parameters.properties.series_index).toEqual({type:'integer',minimum:0,maximum:99});
 });
 it('can select a real dimension series with a supported bounded argument',async()=>{
  const metric=structuredClone(retained.data.metrics[0]);
  metric.series.push(structuredClone(metric.series[0]));
  metric.series[0].dimensions={mount:'/'};metric.series[1].dimensions={mount:'/boot'};
  metric.series[1].buckets[0].dimensions={mount:'/boot'};
  const data={...structuredClone(retained.data),metrics:[metric]};
  const tool=createQueryMetricsTool({query:async()=>data} as any);
  const args={resourceType:'instance',resourceId:1,metric_ids:[metric.definition.id],from:data.window.from,to:data.window.to,series_index:1};
  const result=await tool.handler(args,{actor:admin});
  expect(result).toMatchObject({success:true,data:{metrics:[{series:[metric.series[1]]}]}});
  const projected=JSON.parse(String(investigationContextMessages([{role:'tool',name:'query_metrics',tool_call_id:'series',content:JSON.stringify(result)}],'ops')[0].content));
  expect(projected.data.metrics[0].series).toEqual([metric.series[1]]);
  expect(data.metrics[0].series).toHaveLength(2);
  for(const invalid of [-1,2,100,0.5])expect(await tool.handler({...args,series_index:invalid},{actor:admin})).toMatchObject({success:false});
  for(const invalid of [{...args,mode:'discover'},{...args,mode:'inventory'},{...args,metric_ids:undefined},{...args,metric_ids:[metric.definition.id,'db.other']}])
   expect(await tool.handler(invalid,{actor:admin})).toMatchObject({success:false,errorCode:'INVALID_ARGUMENTS'});
  const emptyMetric={...metric,state:'not_covered',series:[]};
  const empty=createQueryMetricsTool({query:async()=>({...data,metrics:[emptyMetric]})} as any);
  const missing=await empty.handler({...args,series_index:0},{actor:admin});
  expect(missing).toMatchObject({success:true,status:'warning',data:{selection:{series_index:0,total_series:0},metrics:[emptyMetric]}});
  const missingView=JSON.parse(String(investigationContextMessages([{role:'tool',name:'query_metrics',tool_call_id:'empty',content:JSON.stringify(missing)}],'ops')[0].content));
  expect(missingView.data.metrics).toEqual([emptyMetric]);
  expect(await tool.handler(args,{})).toMatchObject({success:false,errorCode:'AUTH_REQUIRED'});
 });
 it('retains warnings, recovery actions and artifacts when large diagnostics or alerts become references',()=>{
  const result={success:true,status:'warning',summary:'Collector partial; alert evidence requires review',warnings:['source missing'],
   next_actions:['verify collection; do not infer healthy'],artifacts:{audit:'case:1'},data:{rows:['x'.repeat(6000)]}};
  const view=JSON.parse(String(investigationContextMessages([{role:'tool',name:'get_server_metrics',tool_call_id:'diagnostic',content:JSON.stringify(result)}],'ops')[0].content));
  expect(view).toMatchObject({status:'warning',summary:result.summary,warnings:result.warnings,next_actions:result.next_actions,artifacts:result.artifacts});
  expect(view.data.evidenceOmitted).toBe(true);expect(result.data.rows[0]).toHaveLength(6000);
 });
});
