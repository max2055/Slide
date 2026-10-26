import {expect,it} from 'vitest';
import {OpenAIProvider} from '../openai-provider.js';
import {autoCompact} from '../runtime/auto-compact.js';
import {ContextManager} from '../runtime/context-manager.js';
import {RecoveryPolicy} from '../runtime/recovery-policy.js';
import {RapidRefill} from '../runtime/rapid-refill.js';
import {ToolRegistry} from '../tool-registry.js';
import {AgentRunner, NoopHook} from '../runner.js';
import type {AgentRunSpec, Message} from '../types.js';

const summary={goal:['inspect db-42'],constraints:['read only'],done:[],pending:['verify'],evidence:['e-1'],uncertain:[]};

/** Chat-shaped spec: no contextPolicy, no explicit window, ordinary output resolved by capability. */
function fixture(summaryMaxTokens?:number,{maxOutputTokens=8192,maxTokens=4096,history='observations '.repeat(1000)}:{maxOutputTokens?:number;maxTokens?:number;history?:string}={}) {
  const raw:Message[]=[{id:'policy',role:'system',content:'Read only.'},{id:'goal',role:'user',content:'inspect db-42'},
    {id:'history',role:'assistant',content:history},{id:'latest',role:'user',content:'report evidence'}];
  const provider=new OpenAIProvider({apiKey:'fixture',model:'chat-model',baseURL:'https://llm.invalid/v1'});
  provider.getModelCapabilities=()=>({model:'chat-model',contextWindowTokens:32768,maxOutputTokens,preferredOutputTokens:4096,source:'configuration',version:'fixture'});
  const bodies:any[]=[],options:Array<number|undefined>=[];
  const chatStream=provider.chatStream.bind(provider);
  provider.chatStream=async(messages,tools,callbacks,option)=>{options.push(option?.maxTokens);return chatStream(messages,tools,callbacks,option);};
  (provider as any).client.chat.completions.create=async(body:any)=>{
    bodies.push(structuredClone(body));
    const content=String(body.messages?.[0]?.content).startsWith('Summarize historical data')?JSON.stringify(summary):'Final report.';
    if(!body.stream)return {id:'fixture',choices:[{message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:4000,completion_tokens:120}};
    return (async function*(){
      yield {choices:[{delta:{content},finish_reason:null}]};
      yield {choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:4000,completion_tokens:120,prompt_tokens_details:{cached_tokens:0}}};
    })();
  };
  const spec:AgentRunSpec={initialMessages:raw,tools:new ToolRegistry(),model:'chat-model',maxIterations:6,maxToolResultChars:128000,
    hook:new NoopHook(),maxTokens,checkpointCallback:async()=>{},
    ...(summaryMaxTokens===undefined?{}:{contextPolicy:{summaryMaxTokens}})};
  const recovery=new RecoveryPolicy(),receipts:any[]=[];
  const manager=new ContextManager(spec,provider);
  const run=()=>autoCompact(manager,raw,provider,recovery,new RapidRefill(),async(record,_state,receipt)=>{if(receipt)receipts.push({record,receipt});});
  return {spec,provider,raw,manager,recovery,receipts,bodies,options,run};
}

it('summarizes with a compatible default when a chat runtime has no explicit summary allocation',async()=>{
  const f=fixture();await f.run();
  expect(f.bodies).toHaveLength(1);expect(f.bodies[0].max_tokens).toBe(2048);
  expect(f.options).toEqual([2048]);
  expect(f.bodies[0].messages[0].content).toContain('2048 output tokens');
  expect(f.manager.summary?.summary).toEqual(summary);
  expect(f.receipts[0].receipt.status).toBe('accepted');
  // The ordinary output allocation is independent and unchanged by compaction.
  expect(f.spec.maxTokens).toBe(4096);
  expect(f.recovery.state).toMatchObject({providerAttempts:1,unknownRequests:0,reservedTokens:0,usage:{completion_tokens:120}});
});

it('bounds the default summary allocation by verified model output',async()=>{
  const f=fixture(undefined,{maxOutputTokens:1024,maxTokens:1024});await f.run();
  expect(f.bodies).toHaveLength(1);expect(f.bodies[0].max_tokens).toBe(1024);
  expect(f.manager.summary).toBeDefined();
});

it('rejects an explicit summary allocation above the model output limit before any transport',async()=>{
  const f=fixture(10240);
  const error=await f.run().catch(value=>value);
  expect(error).toMatchObject({code:'CONTEXT_UNRECOVERABLE'});
  expect(String(error.message)).toContain('8192');
  expect(f.bodies).toHaveLength(0);expect(f.options).toHaveLength(0);expect(f.receipts).toHaveLength(0);
  expect(f.recovery.state).toMatchObject({providerAttempts:0,unknownRequests:0,reservedTokens:0});
  expect(f.manager.summary).toBeUndefined();
});

it.each([1024,6000,8192])('sends an explicit summary allocation of %s unchanged',async allocation=>{
  const f=fixture(allocation);await f.run();
  expect(f.bodies).toHaveLength(1);expect(f.bodies[0].max_tokens).toBe(allocation);
  expect(f.bodies[0].messages[0].content).toContain(`${allocation} output tokens`);
});

it('compacts a chat-shaped run without an explicit summary allocation before the ordinary request',async()=>{
  // ~27k conservative input tokens exceed the default 80% watermark of this 32768 window.
  const f=fixture(undefined,{history:'historical record '.repeat(1500)});
  const saved:any[]=[];
  const result=await new AgentRunner(f.provider).run({...f.spec,checkpointCallback:async checkpoint=>{saved.push(structuredClone(checkpoint));}});
  expect(result.stopReason).toBe('completed');
  expect(f.bodies.map(body=>body.max_tokens)).toEqual([2048,4096]);
  expect(JSON.stringify(f.bodies[1].messages)).toContain('report evidence');
  const record=saved.find(checkpoint=>checkpoint.context_summary_v1)?.context_summary_v1;
  expect(record?.summary).toEqual(summary);
  expect(result.runtimeState).toMatchObject({providerAttempts:2,unknownRequests:0,reservedTokens:0});
});

it('fails an explicit oversized summary allocation before any send on a short ordinary history',async()=>{
  // No compaction is due, so only runtime startup can reject the frozen allocation.
  const f=fixture(10240,{history:'short history'});
  const saved:any[]=[];
  const error=await new AgentRunner(f.provider).run({...f.spec,checkpointCallback:async checkpoint=>{saved.push(structuredClone(checkpoint));}}).catch(value=>value);
  expect(error).toMatchObject({code:'CONTEXT_UNRECOVERABLE'});
  expect(String(error.message)).toContain('8192');
  expect(f.bodies).toHaveLength(0);expect(f.options).toHaveLength(0);
  expect(saved).toHaveLength(0);
});

it('fails an explicit oversized summary allocation on a resumed short history',async()=>{
  const f=fixture(10240,{history:'short history'});
  const runtime_state_v1={schemaVersion:1,modelSteps:0,providerAttempts:0,toolCalls:0,total:0,unknownRequests:0,reservedTokens:0,
    counts:{empty:0,continuation:0,stream:0,repetition:0,context:0},usage:{}};
  const error=await new AgentRunner(f.provider).run({...f.spec,resumeCheckpoint:{runtime_state_v1}}).catch(value=>value);
  expect(error).toMatchObject({code:'CONTEXT_UNRECOVERABLE'});
  expect(f.bodies).toHaveLength(0);
});

it('sends a short ordinary history with the compatible default allocation unchanged',async()=>{
  const f=fixture(undefined,{history:'short history'});
  const result=await new AgentRunner(f.provider).run(f.spec);
  expect(result.stopReason).toBe('completed');
  expect(f.bodies).toHaveLength(1);expect(f.bodies[0].max_tokens).toBe(4096);
  expect(result.runtimeState).toMatchObject({providerAttempts:1,unknownRequests:0,reservedTokens:0});
});

it('admits an explicit summary allocation within verified output on a short history',async()=>{
  const f=fixture(10240,{history:'short history',maxOutputTokens:16384});
  const result=await new AgentRunner(f.provider).run(f.spec);
  expect(result.stopReason).toBe('completed');
  expect(f.bodies).toHaveLength(1);expect(f.bodies[0].max_tokens).toBe(4096);
});
