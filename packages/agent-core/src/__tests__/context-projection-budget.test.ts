import {expect,it} from 'vitest';
import {OpenAIProvider} from '../openai-provider.js';
import {ContextManager} from '../runtime/context-manager.js';
import {ToolRegistry} from '../tool-registry.js';
import {NoopHook} from '../runner.js';
import type {AgentRunSpec,Message} from '../types.js';
const provider=new OpenAIProvider({apiKey:'test-only',model:'deepseek-flash'});
const messages:Message[]=[{role:'system',content:'read only',source:'runtime',contextAuthority:'policy'},{role:'user',content:'inspect server 3',id:'u1'}, {role:'assistant',content:null,tool_calls:[{id:'call-1',type:'function',function:{name:'read_only',arguments:'{"id":3}'}}],reasoning_content:'required thinking'}, {role:'tool',tool_call_id:'call-1',name:'read_only',content:'{"evidence":"unchanged"}'}];
const spec:AgentRunSpec={initialMessages:messages,tools:new ToolRegistry(),model:'deepseek-flash',maxIterations:3,maxToolResultChars:128000,hook:new NoopHook(),contextWindowTokens:16000,maxTokens:4096};
it('admission budgets the provider projection without local identity inflation',()=>{
 const manager=new ContextManager(spec,provider);
 const large=messages.map(m=>({...m,id:'local'.repeat(1000),runId:'run'.repeat(1000),turnId:'turn'.repeat(1000)}));
 expect(manager.tokens(large)).toBe(manager.tokens(messages));
 expect(new ContextManager(spec).tokens(large)).toBeGreaterThan(manager.inputBudget);
 manager.assertFits(large);expect(manager.inputBudget).toBe(10880);
});
it('OpenAI projection preserves tool protocol and reasoning while source facts stay intact',()=>{
 const before=JSON.stringify(messages);const projected=provider.projectMessages(messages);
 expect(projected[2].tool_calls).toEqual(messages[2].tool_calls);
 expect(projected[2].reasoning_content).toBe('required thinking');
 expect(projected[3].tool_call_id).toBe('call-1');expect(projected[3].content).toBe(messages[3].content);
 expect(projected.some(m=>m.id||m.source||m.runId||m.turnId)).toBe(false);
 expect(JSON.stringify(messages)).toBe(before);
});
it('the conservative UTF8 byte bound and genuine oversized content still fail closed',()=>{
 const manager=new ContextManager(spec,provider);
 expect(()=>manager.assertFits([{role:'user',content:'内容'.repeat(10000)}])).toThrow('Protected context');
 expect(manager.lastEstimate?.method).toBe('conservative-heuristic');
 expect(manager.lastEstimate?.margin.floorTokens).toBe(manager.lastEstimate?.tokens);
});

it('repeated projection keeps tool-turn reasoning across the runtime clock boundary',()=>{
 const withClock:Message[]=[...messages,{role:'user',source:'runtime',content:'Current Time: test clock'}];
 const first=provider.projectMessages(withClock);const second=provider.projectMessages(first);
 expect(first[2].reasoning_content).toBe('required thinking');
 expect(second[2].reasoning_content).toBe(first[2].reasoning_content);
});
