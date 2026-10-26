import {expect, it} from 'vitest';
import {OpenAIProvider} from '../openai-provider.js';
import {autoCompact} from '../runtime/auto-compact.js';
import {ContextManager} from '../runtime/context-manager.js';
import {RecoveryPolicy} from '../runtime/recovery-policy.js';
import {RapidRefill} from '../runtime/rapid-refill.js';
import {ToolRegistry} from '../tool-registry.js';
import {NoopHook} from '../runner.js';
import type {AgentRunSpec, Message} from '../types.js';

function fixture(maxTokens=4096, summaryMaxTokens=10240) {
  const raw:Message[]=[{id:'policy',role:'system',content:'Read only.'},{id:'goal',role:'user',content:'inspect db-42'},
    {id:'history',role:'assistant',content:'observations '.repeat(1000)},{id:'latest',role:'user',content:'report evidence'}];
  const provider=new OpenAIProvider({apiKey:'fixture',model:'gpt-4.1'});
  const summary={goal:['inspect db-42'],constraints:['read only'],done:[],pending:['verify'],evidence:['record '.repeat(1400)],uncertain:['unknown; no replay']};
  const bodies:any[]=[];
  let finish='stop',incomplete=false,lost=false;
  const options:any[]=[];
  const chatStream=provider.chatStream.bind(provider);
  provider.chatStream=async(messages,tools,callbacks,option)=>{
    options.push(option?.maxTokens);return chatStream(messages,tools,callbacks,option);
  };
  (provider as any).client.chat.completions.create=async(body:any)=>{
    bodies.push(structuredClone(body));
    if(lost)throw new Error('synthetic lost response');
    return (async function*(){
      const content=JSON.stringify(summary);
      yield {choices:[{delta:{content:incomplete?content.slice(0,-1):content},finish_reason:null}]};
      yield {choices:[{delta:{},finish_reason:finish}],usage:{prompt_tokens:5000,completion_tokens:3000,prompt_tokens_details:{cached_tokens:0}}};
    })();
  };
  const spec:AgentRunSpec={initialMessages:raw,tools:new ToolRegistry(),model:'gpt-4.1',maxIterations:6,maxToolResultChars:128000,
    hook:new NoopHook(),contextWindowTokens:65536,maxTokens,checkpointCallback:async()=>{},
    ...(summaryMaxTokens===undefined?{}:{contextPolicy:{summaryMaxTokens}})};
  const recovery=new RecoveryPolicy(),receipts:any[]=[],reservations:number[]=[];
  const manager=new ContextManager(spec,provider);
  const run=()=>autoCompact(manager,raw,provider,recovery,new RapidRefill(),async(record,_state,receipt)=>{
    reservations.push(recovery.state.reservedTokens);if(receipt)receipts.push({record,receipt});
  });
  return {spec,provider,raw,manager,recovery,receipts,reservations,bodies,options,summary,run,setFinish:(value:string)=>{finish=value;},truncate:()=>{incomplete=true;},loseResponse:()=>{lost=true;}};
}

it.each([4096,8192])('reserves and sends a separate 10240-token summary with ordinary output %s',async ordinary=>{
  const f=fixture(ordinary);await f.run();
  expect(f.bodies).toHaveLength(1);expect(f.bodies[0].max_tokens).toBe(10240);
  expect(f.options).toEqual([10240]);
  expect(f.bodies[0].messages[0].content).toContain('10240 output tokens');
  expect(f.spec.maxTokens).toBe(ordinary);expect(f.manager.summary?.summary).toEqual(f.summary);
  expect(f.receipts[0].receipt.status).toBe('accepted');
  expect(f.reservations).toContain(65536);expect(f.recovery.state.reservedTokens).toBe(0);
  expect(f.recovery.state.unknownRequests).toBe(0);expect(f.recovery.state.usage.completion_tokens).toBe(3000);
  const restored=new ContextManager(f.spec,f.provider);restored.summary=structuredClone(f.manager.summary);
  restored.assertFits(restored.project(f.raw));expect(restored.project(f.raw)).toEqual(f.manager.project(f.raw));
  console.info(JSON.stringify({code:'SUMMARY_ALLOCATION_PROOF',transport:'mocked OpenAI SDK; no network',ordinaryOutput:ordinary,
    providerOptions:f.options[0],sdkMaxTokens:f.bodies[0].max_tokens,completionTokens:3000,accepted:true,
    windowReservation:65536,remainingReservation:f.recovery.state.reservedTokens,restoredProjectionEqual:true}));
});

it('keeps an explicit smaller summary allocation independent of ordinary output',async()=>{
  const f=fixture(4096,6000);await f.run();expect(f.bodies[0].max_tokens).toBe(6000);
});

it.each(['output','window','unknown','fallback','budget'])('rejects insufficient %s before SDK dispatch and preserves no-replay state',async kind=>{
  const f=fixture();const original=f.provider.getModelCapabilities.bind(f.provider);
  if(kind==='output')f.provider.getModelCapabilities=model=>({...original(model)!,maxOutputTokens:8192});
  if(kind==='unknown')f.provider.getModelCapabilities=()=>undefined;
  if(kind==='fallback')f.provider.getModelCapabilities=model=>({...original(model)!,source:'conservative-fallback'});
  if(kind==='window')f.spec.contextWindowTokens=12000;
  if(kind==='budget')f.spec.budgetLimits={maxTotalTokens:10240,maxProviderAttempts:6,maxToolCalls:8,maxNoProgressSteps:6};
  await expect(f.run()).rejects.toBeDefined();expect(f.bodies).toHaveLength(0);
  expect(f.recovery.state.providerAttempts).toBe(0);expect(f.recovery.state.unknownRequests).toBe(0);
  expect(f.manager.summary).toBeUndefined();
});

it('keeps the whole admitted window reserved when a 10240-token summary response is lost',async()=>{
  const f=fixture();f.loseResponse();await expect(f.run()).rejects.toBeDefined();
  expect(f.bodies).toHaveLength(1);expect(f.bodies[0].max_tokens).toBe(10240);
  expect(f.recovery.state.reservedTokens).toBe(65536);expect(f.recovery.state.unknownRequests).toBe(1);
  expect(f.receipts[0].receipt).toMatchObject({status:'rejected',reason:'provider'});
  expect(f.manager.summary).toBeUndefined();
});

it.each(['length','invalid-json'])('continues to reject %s despite larger output allocation',async kind=>{
  const f=fixture();if(kind==='length')f.setFinish('length');else f.truncate();
  await expect(f.run()).rejects.toMatchObject({code:'SUMMARY_INVALID'});
  expect(f.bodies).toHaveLength(1);expect(f.bodies[0].max_tokens).toBe(10240);
  expect(f.receipts[0].receipt.status).toBe('rejected');expect(f.manager.summary).toBeUndefined();
  expect(f.recovery.state.unknownRequests).toBe(0);
});


it('admits a complete 10240 summary within actual remaining tokens and settles its narrower envelope', async () => {
  const f = fixture();
  f.spec.budgetLimits = { maxTotalTokens: 30000, maxProviderAttempts: 6, maxToolCalls: 8, maxNoProgressSteps: 6 };
  await f.run();
  expect(f.bodies).toHaveLength(1); expect(f.bodies[0].max_tokens).toBe(10240);
  expect(f.reservations.some(n => n > 10240 && n <= 30000)).toBe(true);
  expect(f.recovery.state).toMatchObject({ providerAttempts: 1, unknownRequests: 0, reservedTokens: 0 });
  expect(f.manager.summary).toBeDefined();
});

it.each(['unknown', 'inflight', 'delegated', 'lost'])('preserves %s allocation during summary planning and recovery', async kind => {
  const f = fixture();
  f.spec.budgetLimits = { maxTotalTokens: 30000, maxProviderAttempts: 6, maxToolCalls: 8, maxNoProgressSteps: 6 };
  if (kind === 'unknown') { f.recovery.state.unknownRequests = 1; f.recovery.state.reservedTokens = 100; }
  if (kind === 'inflight') f.recovery.state.reservedTokens = 100;
  if (kind === 'delegated') f.recovery.state.delegated = { modelSteps: 1, providerAttempts: 1, toolCalls: 1, tokens: 25000 };
  if (kind === 'lost') f.loseResponse();
  const before = structuredClone(f.recovery.state);
  await expect(f.run()).rejects.toBeDefined();
  if (kind === 'lost') {
    expect(f.bodies).toHaveLength(1);
    expect(f.recovery.state.unknownRequests).toBe(1);
    expect(f.recovery.state.reservedTokens).toBeGreaterThan(10240);
    const reserved = f.recovery.state.reservedTokens;
    await expect(f.run()).rejects.toBeDefined();
    expect(f.bodies).toHaveLength(1); expect(f.recovery.state.reservedTokens).toBe(reserved);
  } else {
    expect(f.bodies).toHaveLength(0);
    expect(f.recovery.state).toEqual(before);
  }
});
