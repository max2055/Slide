import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OpenAIProvider, ToolRegistry, type Message } from '@slide/agent-core';
import { NoopHook } from '@slide/agent-core';
import { investigationContextMessages } from './executor.js';
import { investigationPrompt, INVESTIGATION_PROFILES } from './profiles.js';
import { investigationToolContract } from './tool-contract.js';
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
function setup() {
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
  const raw:Message[] = [{role:'system',source:'runtime',contextAuthority:'policy',content:investigationPrompt(profile)},
    ...fixture.users, ...fixture.entries];
  const spec:any = {initialMessages:raw, tools, model:'deepseek-flash', maxIterations:8,
    maxToolResultChars:128000, contextWindowTokens:16000, maxTokens:4096, hook:new NoopHook(),
    checkpointCallback:async()=>{}, contextPolicy:{recentToolBatches:1}};
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
        expect(projected).toEqual(business);
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
