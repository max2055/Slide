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
