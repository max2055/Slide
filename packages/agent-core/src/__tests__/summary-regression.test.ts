import {it} from 'vitest';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
it('summary responses require durable matched disposition',async()=>{
const base=new URL('../',import.meta.url).href;

const {autoCompact}=await import(base+'runtime/auto-compact.js');
const {ContextManager}=await import(base+'runtime/context-manager.ts');
const {RecoveryPolicy}=await import(base+'runtime/recovery-policy.ts');
const {RapidRefill}=await import(base+'runtime/rapid-refill.ts');
const {ToolRegistry}=await import(base+'tool-registry.ts');
const {NoopHook}=await import(base+'runner.ts');
const valid={goal:['inspect db-42'],constraints:['read only'],done:[],pending:['review'],evidence:['e-1'],uncertain:['no replay']};
const results:any[]=[];const diagnostics:any[]=[];const originalInfo=console.info;console.info=(value:any)=>{diagnostics.push(JSON.parse(value));};
for(const kind of ['valid','json','schema','length','tool','error','lost','save','rejected-save']) {
 const response:any={content:JSON.stringify(valid),finishReason:'stop',toolCalls:[],hasToolCalls:false,shouldExecuteTools:false,usage:{prompt_tokens:11,completion_tokens:7}};
 if(kind==='json')response.content='```json\n'+response.content+'\n```';
 if(kind==='schema'||kind==='rejected-save')response.content='{}';
 if(kind==='length')response.finishReason='length';
 if(kind==='tool'){response.hasToolCalls=true;response.toolCalls=[{id:'x',name:'read_only',arguments:{}}];}
 if(kind==='error'){response.error='synthetic transport';response.finishReason='error';}
 let options:any,sends=0;const receipts:any[]=[];
 const provider:any={getDefaultModel:()=> 'same-model',chat:async()=>{throw Error('ordinary dispatch forbidden');},chatStream:async(_m:any,_t:any,_c:any,o:any)=>{options=o;sends++;if(kind==='lost')throw Error('synthetic lost');return response;}};
 const raw:any[]=[{role:'system',content:'Read only.'},{role:'user',content:'inspect db-42'},{role:'assistant',content:'historical record '.repeat(650)},{role:'user',content:'report evidence'}];
 const spec:any={initialMessages:raw,tools:new ToolRegistry(),model:'same-model',maxIterations:6,maxToolResultChars:1000,hook:new NoopHook(),contextWindowTokens:15000,maxTokens:500,checkpointCallback:async()=>{}};
 const manager=new ContextManager(spec,provider);let error:any;
 try{await autoCompact(manager,raw,provider,new RecoveryPolicy(),new RapidRefill(),async(record:any,_state:any,receipt:any)=>{if(receipt){receipts.push(structuredClone(receipt));if(kind==='save'||kind==='rejected-save')throw Error('synthetic checkpoint unavailable');}});}catch(e){error=e;}
 try{
  assert.equal(sends,1);assert.equal(options?.requestIdentity?.purpose,'summary');assert.match(options?.requestIdentity?.id??'',/^[a-f0-9-]{36}$/);
  if(kind==='lost'){assert(error);assert.equal(receipts.length,0);assert.equal(manager.summary,undefined);}
  else {
   assert.equal(receipts.length,1);const receipt=receipts[0];assert.equal(receipt.id,options.requestIdentity.id);assert.match(receipt.responseHash,/^[a-f0-9]{64}$/);
   assert.equal(receipt.status,kind==='valid'||kind==='save'?'accepted':'rejected');
   if(kind==='valid'){assert(!error);assert.deepEqual(manager.summary.summary,valid);}
   else {assert(error);assert.equal(manager.summary,undefined);if(!kind.includes('save'))assert.equal(error.code,'SUMMARY_INVALID');}
   if(kind==='json')assert.equal(receipt.reason,'json');if(kind==='schema')assert.equal(receipt.reason,'schema');if(kind==='length')assert.equal(receipt.reason,'incomplete');
  }
  results.push({kind,ok:true});
 }catch(e){results.push({kind,ok:false,error:String(e)});}
}

console.info=originalInfo;assert(results.every(r=>r.ok),JSON.stringify(results));
});
