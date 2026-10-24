import {it} from 'vitest';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
it('fenced executor and real Runner atomically settle summary receipts',async()=>{const previousInfo=console.info;try{

const {InvestigationExecutor}=await import(new URL('./executor.js',import.meta.url).href);
const {responseHash}=await import('@slide/agent-core');
const {AgentRunner,NoopHook}=await import('@slide/agent-core');
const {ToolRegistry}=await import('@slide/agent-core');
const valid={goal:['inspect db-42'],constraints:['read only'],done:[],pending:['review'],evidence:['e-1'],uncertain:['no replay']};
const reply=(content=JSON.stringify(valid))=>({content,finishReason:'stop',toolCalls:[],hasToolCalls:false,shouldExecuteTools:false,usage:{prompt_tokens:11,completion_tokens:7}});
const results:any[]=[];const diagnostics:any[]=[];console.info=(value:any)=>{diagnostics.push(JSON.parse(value));};
for(const mode of ['accepted','rejected','write-failed','lease-failed','unknown-usage','wrong-hash','wrong-source','forged-accept','stale-receipt','sent']){
 const id='11111111-1111-4111-8111-111111111111',sourceHash='a'.repeat(64);const response:any=reply(mode==='rejected'||mode==='forged-accept'?'{}':undefined);
 if(mode==='unknown-usage')response.usage={};
 let database:any={investigationExecution:{provider:{id,purpose:'summary',sourceHash,status:mode==='sent'?'sent':'received',messageId:null,response}}};
 const before=structuredClone(database);let checkpoint:any;
 const executor:any=Object.create(InvestigationExecutor.prototype);
 executor.transaction=async(work:any)=>{const snapshot=structuredClone(database),old=checkpoint;try{return await work({query:async(_q:any,args:any)=>{if(mode==='write-failed')throw Error('WRITE_FAILED');database=JSON.parse(args[0]);}});}catch(e){database=snapshot;checkpoint=old;throw e;}};
 executor.canonical={lockInvestigationExecution:async()=>({run:{result_json:structuredClone(database)},messageId:'turn'}),appendInvestigationToolFacts:async(_c:any,_a:any,_b:any,_f:any,_i:any,cp:any)=>{checkpoint=structuredClone(cp);},assertInvestigationLease:async()=>{if(mode==='lease-failed')throw Error('LEASE_FAILED');}};
 const receipt:any={id,purpose:'summary',sourceHash,responseHash:responseHash(response),status:mode==='rejected'?'rejected':'accepted',...(mode==='rejected'?{reason:'schema'}:{})};
 const payload:any={context_request_v1:receipt,...(mode==='rejected'?{}:{context_summary_v1:{sourceHash,summary:valid}})};
 if(mode==='wrong-hash')receipt.responseHash='b'.repeat(64);if(mode==='wrong-source')receipt.sourceHash='b'.repeat(64);if(mode==='stale-receipt')receipt.id='22222222-2222-4222-8222-222222222222';
 let error:any;try{await executor.persistCheckpoint({}, {runId:'run'},payload);}catch(e){error=e;}
 if(mode==='accepted'||mode==='rejected'){assert(!error);assert.equal(database.investigationExecution.provider,null);assert.deepEqual(database.investigationExecution.lastSummaryReceipt.response,response);assert.equal(checkpoint.context_request_v1.status,receipt.status);}
 else {assert.deepEqual(database,before);if(!['unknown-usage','stale-receipt'].includes(mode))assert(error);}
 results.push({mode,ok:true});
}
for(const mode of ['valid','invalid','lost','checkpoint-failed']){
 let providerState:any=null,summaries=0,ordinary=0,lastCheckpoint:any,crash=false;
 const response=reply(mode==='invalid'?'{}':undefined);
 const provider:any={getDefaultModel:()=> 'same-model',chatStream:async(_m:any,_t:any,_c:any,o:any)=>{assert.equal(providerState,null);assert(o.requestIdentity);providerState={...o.requestIdentity,status:'sent',messageId:null};summaries++;if(mode==='lost')throw Error('lost');providerState.status='received';providerState.response=response;return response;},chat:async()=>{assert.equal(providerState,null,'summary receipt must be acknowledged before ordinary send');ordinary++;return reply('Read only final answer');}};
 const executor:any=Object.create(InvestigationExecutor.prototype);
 executor.transaction=async(work:any)=>{const old=structuredClone(providerState),cp=lastCheckpoint;try{return await work({query:async(_q:any,args:any)=>{providerState=JSON.parse(args[0]).investigationExecution.provider;}});}catch(e){providerState=old;lastCheckpoint=cp;throw e;}};
 executor.canonical={lockInvestigationExecution:async()=>({run:{result_json:{investigationExecution:{provider:structuredClone(providerState)}}},messageId:'turn'}),appendInvestigationToolFacts:async(_c:any,_a:any,_b:any,_f:any,_i:any,cp:any)=>{if(mode==='checkpoint-failed'&&cp.context_request_v1){crash=true;throw Error('CHECKPOINT_FAILURE');}lastCheckpoint=structuredClone(cp);},assertInvestigationLease:async()=>{}};
 const result=await new AgentRunner(provider).run({initialMessages:[{role:'system',content:'Read only.'},{role:'user',content:'inspect db-42'},{role:'assistant',content:'historical record '.repeat(650)},{role:'user',content:'report evidence'}],tools:new ToolRegistry(),model:'same-model',maxIterations:6,maxToolResultChars:1000,hook:new NoopHook(),contextWindowTokens:15000,maxTokens:500,contextPolicy:{watermark:.6,summaryMaxTokens:500},recoveryLimits:{total:0,context:0},checkpointCallback:async payload=>{await executor.persistCheckpoint({}, {runId:'run'},payload);}} as any);
 assert.equal(summaries,1);
 if(mode==='valid'){assert.equal(result.stopReason,'completed');assert.equal(ordinary,1);assert.equal(providerState,null);assert(lastCheckpoint.context_summary_v1);}
 else {assert.equal(ordinary,0);assert.notEqual(result.stopReason,'completed');if(mode==='invalid'){assert.equal(result.runtimeError?.code,'SUMMARY_INVALID');assert.equal(providerState,null);assert.equal(lastCheckpoint.context_request_v1.reason,'schema');}else assert(providerState);if(mode==='checkpoint-failed')assert(crash);}
 results.push({mode:'real AgentRunner and executor checkpoint: '+mode,ok:true,summaries,ordinary,stopReason:result.stopReason});
}
}finally{console.info=previousInfo;}},20000);
