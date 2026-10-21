import {it} from 'vitest';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
it('bounded tool context preserves durable evidence and full batches',async()=>{

const mod=await import(new URL('./executor.js',import.meta.url).href);
// The predecessor returned successful Ops objects unchanged.
const project=mod.investigationToolContextResult??((value:any)=>value);
const {responseHash}=await import('@slide/agent-core');
const base=new URL('../../../../packages/agent-core/src/',import.meta.url).href;
const {ContextManager}=await import(base+'runtime/context-manager.ts');
const {ToolRegistry}=await import(base+'tool-registry.ts');
const {NoopHook}=await import(base+'runner.ts');
const metric={metric_name:'filesystem_size_bytes',metric_value:12345,dimensions:{device:'disk0',mountpoint:'/'},recorded_at:'2026-10-20T01:04:52Z',unit:'bytes',quality:{status:'good',gaps:[]}};
const large={success:true,status:'ok',data:{latest:Array.from({length:11},()=>({...metric})),history:Array.from({length:22},()=>({...metric}))},summary:'bounded metric read',next_actions:[]};
const before=JSON.stringify(large),messages:any[]=[{role:'system',content:'Read only. Missing evidence is unknown.'},{role:'user',content:'protected goal '+ 'x'.repeat(5800)}];
for(let batch=0;batch<2;batch++){
 const calls=Array.from({length:4},(_,i)=>({id:`b${batch}t${i}`,type:'function',function:{name:'get_server_metrics',arguments:'{"serverId":3,"maxRows":100}'}}));
 messages.push({role:'assistant',content:'',tool_calls:calls});
 for(let i=0;i<calls.length;i++){
  const raw=i===3?large:{success:true,status:'ok',data:{observations:[metric]},summary:'read only'};
  const view=project(raw,calls[i].id,'ops');
  messages.push({role:'tool',tool_call_id:calls[i].id,name:'get_server_metrics',content:typeof view==='string'?view:JSON.stringify(view,null,2)});
 }
}
const spec:any={initialMessages:messages,tools:new ToolRegistry(),model:'fixture',maxIterations:3,maxToolResultChars:128000,hook:new NoopHook(),contextWindowTokens:16000,maxTokens:4096};
const manager=new ContextManager(spec);
manager.assertFits(manager.project(messages));
assert.equal(JSON.stringify(large),before,'full SQL receipt must not mutate');
const reference=JSON.parse(project(large,'current-tool','ops'));
assert.equal(reference.data.contextReference.toolCallId,'current-tool');
assert.equal(reference.data.contextReference.sha256,responseHash(large));
assert.equal(reference.data.contextReference.bytes,Buffer.byteLength(before));
const reordered=Object.fromEntries(Object.entries(large).reverse());assert.equal(JSON.parse(project(reordered,'current-tool','ops')).data.contextReference.sha256,reference.data.contextReference.sha256,'MySQL JSON object key normalization must retain the same receipt reference');
assert.equal(reference.data.evidenceOmitted,true);assert.equal(reference.data.requiresNarrowerRead,true);
assert.match(reference.summary,/maxRows=1/);assert.equal(reference.status,'warning');
const small={success:true,status:'ok',data:{latest:[metric],history:[metric],freshness:metric.recorded_at,gaps:[]}};
assert.deepEqual(JSON.parse(project(small,'small','ops')),small,'narrowed live evidence remains exact');
const failure={success:false,status:'error',error:'DENIED'};
assert.equal(project(failure,'failed','ops'),failure,'ToolExecutor must retain object failure semantics');
assert.deepEqual(JSON.parse(project(large,'system','system')),large,'unchanged System lossless projection');
});

it('model references remain ephemeral and repeated projection preserves full canonical input', async () => {
 const {investigationContextMessages}=await import('./executor.js');
 const {OpenAIProvider}=await import('@slide/agent-core');
 const raw:any[]=[{role:'tool',tool_call_id:'receipt',content:JSON.stringify({success:true,data:{rows:Array(200).fill('bounded-row')}})}];
 const before=JSON.stringify(raw);
 const view=investigationContextMessages(raw,'ops');
 assert.equal(JSON.stringify(raw),before);
 assert.equal(JSON.parse(String(view[0].content)).data.evidenceOmitted,true);
 assert.deepEqual(investigationContextMessages(view,'ops'),view);
 assert.equal(investigationContextMessages(raw,'system'),raw);
 const provider=new OpenAIProvider({apiKey:'fixture',model:'deepseek-flash'});
 assert.deepEqual(investigationContextMessages(provider.projectMessages(view),'ops').map(m=>m.content),view.map(m=>m.content));
});

it('post-execution failure projection preserves denial details and all business error fields', async () => {
 const {investigationContextMessages,investigationToolContextResult}=await import('./executor.js');
 const business={success:false,status:'error',errorCode:'METRIC_REFERENCE_REVIEW_REQUIRED',error:'Cannot read legacy metric',data:{state:'unknown'},next_actions:['review migration']};
 const allowed={...business,policyDecision:{allow:true,reasonCode:'ALLOW',actor:{userId:1},requestId:'receipt'}};
 const denied={...business,policyDecision:{allow:false,reasonCode:'RESOURCE_SCOPE_DENIED',resource:{type:'server',id:3}}};
 const messages:any[]=[{role:'tool',tool_call_id:'allowed',content:JSON.stringify(allowed,null,2)},
   {role:'tool',tool_call_id:'denied',content:JSON.stringify(denied,null,2)}];
 const before=JSON.stringify(messages);
 const view=investigationContextMessages(messages,'ops');
 assert.deepEqual(JSON.parse(String(view[0].content)),business);
 assert.deepEqual(JSON.parse(String(view[1].content)),denied);
 assert.equal(investigationToolContextResult(allowed,'allowed','ops'),allowed,'executor failure object stays unchanged');
 assert.equal(JSON.stringify(messages),before);
 assert.equal(investigationContextMessages(messages,'system'),messages);
 assert.deepEqual(investigationContextMessages(view,'ops'),view);
});
