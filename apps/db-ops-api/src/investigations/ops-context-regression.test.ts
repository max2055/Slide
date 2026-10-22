import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OpenAIProvider, ToolRegistry, type Message } from '@slide/agent-core';
import { NoopHook } from '@slide/agent-core';
import { investigationContextMessages } from './executor.js';
import { investigationPrompt, INVESTIGATION_PROFILES } from './profiles.js';
import { investigationToolContract, investigationToolPolicy } from './tool-contract.js';
import { toolCatalog } from '../tools/catalog.js';
import '../tools/ops/index.js';
import '../tools/generated/slide-self-mgmt/resource_tools.js';
import '../tools/generated/slide-self-mgmt/server_tools.js';

// Runtime internals are exercised through file URLs, as in the existing
// projection tests; they are outside the API compiler's rootDir.
const core = new URL('../../../../packages/agent-core/src/', import.meta.url);
const {ContextManager,sourceHash} = await import(new URL('runtime/context-manager.js',core).href);
const {ModelStep} = await import(new URL('runtime/model-step.js',core).href);
const {currentTime,projectContextBlocks,runtimeBlock} = await import(new URL('context-block.js',core).href);

// Retained canonical facts from run 0b4413e1, main45fe437b. Diagnostic
// reconstruction, not original wire telemetry. No handlers or network invoked.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/ops-six-tool-20261021.json', import.meta.url), 'utf8'));
function setup(retained = fixture) {
  const tools = new ToolRegistry(), profile = INVESTIGATION_PROFILES.ops;
  for (const name of profile.toolAllowlist) {
    const tool = toolCatalog.get(name)!;
    const contract = investigationToolContract(tool as any, [{type:'instance',id:1},{type:'server',id:3}], profile.budget)!;
    tools.register({...contract, readOnly:true, concurrencySafe:false, exclusive:true,
      execute: async () => { throw new Error('offline only'); }});
  }
  const actual = new OpenAIProvider({apiKey:'offline-unused',model:'deepseek-flash'});
  const provider = {
    getDefaultModel: () => 'deepseek-flash',
    countPromptTokens: actual.countPromptTokens.bind(actual),
    projectMessages: (m:Message[]) => investigationContextMessages(actual.projectMessages(m), 'ops'),
  };
  const raw:Message[] = [{role:'system',source:'runtime',contextAuthority:'policy',content:investigationPrompt(profile)+investigationToolPolicy([{type:'instance',id:1},{type:'server',id:3}],profile.budget)},
    ...retained.users, ...retained.entries];
  const spec:any = {initialMessages:raw, tools, model:'deepseek-flash', maxIterations:8,
    maxToolResultChars:128000, contextWindowTokens:16000, maxTokens:4096, hook:new NoopHook(),
    checkpointCallback:async()=>{}, contextPolicy:{recentToolBatches:1,evidenceReferences:'canonical'}};
  return {raw,spec,provider};
}

describe('normal Ops first six-tool batch admission', () => {
  it('fits the real retained batch including clock and all seven scoped schemas without mutating evidence', async () => {
    const {raw,spec,provider} = setup(), before = JSON.stringify(raw), digest = sourceHash(raw);
    const manager = new ContextManager(spec, provider as any);
    const request = [...manager.project(raw), ...projectContextBlocks([runtimeBlock('runtime', currentTime(new Date('2026-10-21T15:52:41.400Z')))])];
    const projection = provider.projectMessages(request);
    console.info('Offline Ops admission estimate', manager.tokens(request), '/', manager.inputBudget);
    expect(manager.split(raw).end).toBe(2); // Only system/user can precede the protected batch.
    expect(spec.tools.getDefinitions()).toHaveLength(7);
    expect(projection.filter(m=>m.role==='tool')).toHaveLength(6);
    expect(projection.filter(m=>m.role==='assistant')[0].tool_calls).toHaveLength(6);
    expect(manager.tokens(request)).toBeLessThanOrEqual(manager.inputBudget);
    manager.assertFits(projection);
    // Exercise the actual final admission boundary with a local recording sink.
    let sends = 0;
    const sink:any = {...provider, chat:async (messages:Message[]) => {
      sends++;
      expect(messages).toEqual(provider.projectMessages(projection));
      return {content:'offline receipt',toolCalls:[],usage:{},finishReason:'stop'};
    }};
    await new ModelStep(sink).request(spec,request,spec.hook,{} as any);
    expect(sends).toBe(1);
    expect(JSON.stringify(raw)).toBe(before);
    expect(sourceHash(raw)).toBe(digest);
    expect(provider.projectMessages(projection)).toEqual(projection);
    for (const receipt of raw.filter(m=>m.role==='tool')) {
      const value=JSON.parse(String(receipt.content));
      const projected=JSON.parse(String(projection.find(m=>m.tool_call_id===receipt.tool_call_id)!.content));
      if (!projected.data?.evidenceOmitted) {
        const {policyDecision: _audit,...business}=value;
        expect(projected.data).toEqual(business.data);
        expect(projected.status).toEqual(business.status);
        expect(projected.success).toBe(true);
        expect(value.policyDecision.allow).toBe(true);
      }
    }
  });

  it('still rejects irreducible protected growth before the recording sink', async () => {
    const {raw,spec,provider} = setup();
    const request = [...raw,{role:'user' as const,content:'x'.repeat(20000)}];
    let sends=0;
    await expect(new ModelStep({...provider,chat:async()=>{sends++;}} as any)
      .request(spec,request,spec.hook,{} as any)).rejects.toMatchObject({code:'CONTEXT_UNRECOVERABLE'});
    expect(sends).toBe(0);
  });
});


describe('post-query-fix Ops second batch admission', () => {
  it('leaves room for a durable summary with the actual six-tool batch, reasoning and all seven schemas', async () => {
    const retained = JSON.parse(readFileSync(new URL('./fixtures/ops-post-query-fix-20261022.json', import.meta.url), 'utf8'));
    const { raw, spec, provider } = setup(retained), before = JSON.stringify(raw), digest = sourceHash(raw);
    const manager = new ContextManager(spec, provider as any), split = manager.split(raw);
    manager.summary = { schemaVersion: 1, sourceStart: 0, sourceEnd: split.end,
      sourceHash: sourceHash(raw.slice(0, split.end)),
      summary: { goal: ['pending'], constraints: [], done: [], pending: [], evidence: [], uncertain: [] } };
    const request = [...manager.project(raw), ...projectContextBlocks([runtimeBlock('runtime', currentTime(new Date('2026-10-22T01:05:34Z')))])];
    console.info('Offline r4 retained admission', manager.tokens(request), '/', manager.inputBudget);
    expect(spec.tools.getDefinitions()).toHaveLength(7);
    const view = provider.projectMessages(request);
    const liveCalls = retained.entries.filter((m: Message) => m.role === 'assistant').at(-1).tool_calls;
    for (const call of liveCalls) expect(view.filter(m => m.role === 'tool' && m.tool_call_id === call.id)).toHaveLength(1);
    expect(view.find(m => m.role === 'assistant' && m.tool_calls?.[0].id === liveCalls[0].id)?._extra)
      .toEqual(retained.entries.filter((m: Message) => m.role === 'assistant').at(-1)._extra);
    manager.assertFits(request);
    // The summary envelope needs positive planning headroom; no context or output cap changes.
    expect(manager.inputBudget - manager.tokens(request)).toBeGreaterThan(128);
    let sends = 0;
    await new ModelStep({ ...provider, chat: async (messages: Message[]) => {
      sends++;
      expect(messages).toEqual(provider.projectMessages(view));
      return { content: 'offline only', toolCalls: [], usage: {}, finishReason: 'stop' };
    } } as any).request(spec, request, spec.hook, {} as any);
    expect(sends).toBe(1);
    expect(JSON.stringify(raw)).toBe(before);
    expect(sourceHash(raw)).toBe(digest);
    expect(provider.projectMessages(view)).toEqual(view);
  });
});

it('compacts and restores three completed batches through the real SDK using only a local receiver', async () => {
  const {createServer}=await import('node:http');
  const {autoCompact}=await import(new URL('runtime/auto-compact.js',core).href);
  const {RecoveryPolicy}=await import(new URL('runtime/recovery-policy.js',core).href);
  const {RapidRefill}=await import(new URL('runtime/rapid-refill.js',core).href);
  const retained=JSON.parse(readFileSync(new URL('./fixtures/ops-post-query-fix-20261022.json',import.meta.url),'utf8'));
  const {raw,spec}=setup(retained), before=JSON.stringify(raw), bodies:any[]=[];
  const summary={goal:['inspect instance1/server3'],constraints:['read only'],done:[],pending:['narrow reads'],evidence:[],uncertain:['coverage gaps; no replay']};
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks).toString());bodies.push(body);
    res.setHeader('content-type',body.stream?'text/event-stream':'application/json');
    const content=body.tools?.length?'offline analysis; root cause unverified':JSON.stringify(summary);
    const response={id:'local',choices:[{index:0,message:{role:'assistant',content},delta:{content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10}};
    res.end(body.stream?'data: '+JSON.stringify(response)+'\n\ndata: [DONE]\n\n':JSON.stringify(response));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    const actual=new OpenAIProvider({apiKey:'offline-unused',model:'deepseek-flash',baseURL:`http://127.0.0.1:${(server.address() as any).port}/v1`});
    const p:any={getDefaultModel:()=>actual.getDefaultModel(),countPromptTokens:actual.countPromptTokens.bind(actual),
      projectMessages:(m:Message[])=>investigationContextMessages(actual.projectMessages(m),'ops'),
      chat:actual.chat.bind(actual),chatStream:actual.chatStream.bind(actual)};
    const manager=new ContextManager(spec,p), recovery=new RecoveryPolicy(), tracker=new RapidRefill();
    const checkpoints:any[]=[];
    const persist=async(record:any)=>{if(record)checkpoints.push(structuredClone(record));};
    const suffix=projectContextBlocks([runtimeBlock('runtime',currentTime(new Date('2026-10-22T01:05:34Z')))]);
    await autoCompact(manager,raw,p,recovery,tracker,persist,false,suffix);
    manager.assertFits([...manager.project(raw),...suffix]);
    const originalBatch=raw.slice(manager.split(raw).end);
    // Six real retained receipts per subsequent batch: 11+6+3=20 calls, the Ops ceiling.
    for(const [batch,count] of [[2,6],[3,3]]) {
      const copied=structuredClone(originalBatch).map((m:Message)=>{const {messageParts,...fact}=m;return {...fact,...(m.id?{id:`${m.id}_b${batch}`}:{})};});
      const calls=copied[0].tool_calls!.slice(0,count);
      const ids=new Map(calls.map(c=>[c.id,`${c.id}_b${batch}`]));
      copied[0].tool_calls=calls.map(c=>({...c,id:ids.get(c.id)!}));
      const receipts=copied.slice(1).filter(m=>ids.has(m.tool_call_id!)).map(m=>({...m,tool_call_id:ids.get(m.tool_call_id!)!}));
      raw.push(copied[0],...receipts);
      tracker.completeBatch();
      await autoCompact(manager,raw,p,recovery,tracker,persist,false,suffix);
      const view=[...manager.project(raw),...suffix];manager.assertFits(view);
      console.info('Offline multi-batch admission',batch,manager.tokens(view),'/',manager.inputBudget);
      // Durable recovery must reconstruct the identical request from full canonical facts.
      const restored=new ContextManager(spec,p);restored.summary=structuredClone(checkpoints.at(-1));
      expect(p.projectMessages([...restored.project(raw),...suffix])).toEqual(p.projectMessages(view));
      for(const call of copied[0].tool_calls!) expect(p.projectMessages(view).filter((m:Message)=>m.tool_call_id===call.id)).toHaveLength(1);
      await new ModelStep(p).request(spec,view,spec.hook,{} as any);
      expect(raw.filter(m=>m.role==='tool')).toHaveLength(batch===2?17:20);
    }
    expect(JSON.stringify(raw.slice(0,retained.entries.length+retained.users.length+1))).toBe(before);
    expect(checkpoints).toHaveLength(3);expect(bodies).toHaveLength(5);
    expect(bodies.filter(b=>b.tools?.length)).toHaveLength(2);
    for(const body of bodies) {
      expect(body.max_tokens).toBe(body.tools?.length?4096:2048);
      for(const m of body.messages.filter((m:any)=>m.role==='assistant'&&m.tool_calls)) {
        for(const call of m.tool_calls) expect(body.messages.filter((r:any)=>r.role==='tool'&&r.tool_call_id===call.id)).toHaveLength(1);
      }
    }
    const changed=structuredClone(raw);changed[1].content='changed source';
    expect(()=>manager.project(changed)).toThrow('Summary source no longer matches history');
  } finally {await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});
