import { expect, it } from "vitest";
import { OpenAIProvider } from "../openai-provider.js";
import { NoopHook } from "../runner.js";
import { ContextManager } from "../runtime/context-manager.js";
import { ToolRegistry } from "../tool-registry.js";
import type { AgentRunSpec, Message } from "../types.js";
const provider = new OpenAIProvider({ apiKey: "test-only", model: "deepseek-flash" });
const messages: Message[] = [
  { role: "system", content: "read only", source: "runtime", contextAuthority: "policy" },
  { role: "user", content: "inspect server 3", id: "u1" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call-1", type: "function", function: { name: "read_only", arguments: '{"id":3}' } },
    ],
    reasoning_content: "required thinking",
  },
  { role: "tool", tool_call_id: "call-1", name: "read_only", content: '{"evidence":"unchanged"}' },
];
const spec: AgentRunSpec = {
  initialMessages: messages,
  tools: new ToolRegistry(),
  model: "deepseek-flash",
  maxIterations: 3,
  maxToolResultChars: 128000,
  hook: new NoopHook(),
  contextWindowTokens: 16000,
  maxTokens: 4096,
};
it("admission budgets the provider projection without local identity inflation", () => {
  const manager = new ContextManager(spec, provider);
  const large = messages.map((m) => ({
    ...m,
    id: "local".repeat(1000),
    runId: "run".repeat(1000),
    turnId: "turn".repeat(1000),
  }));
  expect(manager.tokens(large)).toBe(manager.tokens(messages));
  expect(new ContextManager(spec).tokens(large)).toBeGreaterThan(manager.inputBudget);
  manager.assertFits(large);
  expect(manager.inputBudget).toBe(10880);
});
it("OpenAI projection preserves tool protocol and reasoning while source facts stay intact", () => {
  const before = JSON.stringify(messages);
  const projected = provider.projectMessages(messages);
  expect(projected[2].tool_calls).toEqual(messages[2].tool_calls);
  expect(projected[2].reasoning_content).toBe("required thinking");
  expect(projected[3].tool_call_id).toBe("call-1");
  expect(projected[3].content).toBe(messages[3].content);
  expect(projected.some((m) => m.id || m.runId || m.turnId)).toBe(false);
  expect(JSON.stringify(messages)).toBe(before);
});
it("the conservative UTF8 byte bound and genuine oversized content still fail closed", () => {
  const manager = new ContextManager(spec, provider);
  expect(() => manager.assertFits([{ role: "user", content: "内容".repeat(10000) }])).toThrow(
    "Protected context",
  );
  expect(manager.lastEstimate?.method).toBe("conservative-heuristic");
  expect(manager.lastEstimate?.margin.floorTokens).toBe(manager.lastEstimate?.tokens);
});

it("repeated projection keeps tool-turn reasoning across the runtime clock boundary", () => {
  const withClock: Message[] = [
    ...messages,
    { role: "user", source: "runtime", content: "Current Time: test clock" },
  ];
  const first = provider.projectMessages(withClock);
  const second = provider.projectMessages(first);
  expect(first[2].reasoning_content).toBe("required thinking");
  expect(second[2].reasoning_content).toBe(first[2].reasoning_content);
});

it('budgets reasoning once when the opaque transport extra overrides the local copy',()=>{
  const manager=new ContextManager(spec,provider);
  const withExtra=structuredClone(messages);
  (withExtra[2] as any)._extra={reasoning_content:'effective wire reasoning '.repeat(20),custom_field:'preserved'};
  const extraOnly=structuredClone(withExtra);delete extraOnly[2].reasoning_content;
  // toOpenAIMessage spreads extras last: the overwritten local value never goes on the wire.
  expect(manager.tokens(withExtra)).toBe(manager.tokens(extraOnly));
  expect((provider.projectMessages(withExtra)[2] as any)._extra).toEqual((withExtra[2] as any)._extra);
  expect(withExtra[2].reasoning_content).toBe('required thinking');
});

it('repeated projection preserves the real SDK body for every reasoning override',async()=>{
  const http=await import('node:http');
  const bodies:any[]=[];
  const server=http.createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{
    const p=new OpenAIProvider({apiKey:'test-only',model:'deepseek-flash',baseURL:`http://127.0.0.1:${(server.address() as any).port}/v1`});
    for(const override of ['required thinking','overridden wire reasoning','',null,undefined]){
      const raw=structuredClone(messages);
      (raw[2] as any)._extra={reasoning_content:override,custom_field:'preserved'};
      raw.push({role:'user',source:'runtime',content:'Current Time: test clock'});
      const before=JSON.stringify(raw);
      await p.chat(raw,[],{maxTokens:8});
      await p.chat(p.projectMessages(p.projectMessages(raw)),[],{maxTokens:8});
      expect(bodies.at(-1).messages).toEqual(bodies.at(-2).messages);
      expect(JSON.stringify(raw)).toBe(before);
    }
    expect(bodies).toHaveLength(10);
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

it('the UTF8 floor counts actual SDK message and tool representations',async()=>{
  const {conservativePromptEstimate}=await import('../token-estimation.js');
  const http=await import('node:http');let body:any;
  const server=http.createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);body=JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{
    const p=new OpenAIProvider({apiKey:'test-only',model:'deepseek-flash',baseURL:`http://127.0.0.1:${(server.address() as any).port}/v1`});
    const tools=new ToolRegistry();tools.register({name:'read_only',description:'read metadata',parameters:{type:'object',properties:{id:{type:'integer'}},required:['id']},readOnly:true,concurrencySafe:true,exclusive:false,scope:['ops'],ownerOnly:true,group:'local-routing'.repeat(100),dangerLevel:0,execute:async()=>null});
    const defs=structuredClone(tools.getDefinitions());const raw=structuredClone(messages);
    (raw[2] as any)._extra={reasoning_content:'effective reasoning',custom_field:'opaque wire extra'};
    raw.push({role:'user',source:'runtime',content:'Current Time: test clock'});
    const before=JSON.stringify(raw);const projected=p.projectMessages(raw);
    await p.chat(projected,defs,{maxTokens:8});
    const manager=new ContextManager({...spec,tools},p);const estimate=manager.estimate(raw);
    expect(estimate.method).toBe('conservative-heuristic');
    expect(estimate.tokens).toBe(conservativePromptEstimate(body.messages,body.tools,'deepseek-flash').tokens);
    expect(estimate.margin.floorTokens).toBe(estimate.tokens);
    expect(body.tools[0]).toEqual({type:'function',function:{name:defs[0].name,description:defs[0].description,parameters:defs[0].parameters}});
    expect(JSON.stringify(raw)).toBe(before);expect(tools.getDefinitions()).toEqual(defs);
    expect(tools.get('read_only')!.ownerOnly).toBe(true);
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

it('protected evidence references encode repeated field names once without losing calls or uncertainty',()=>{
  const calls=Array.from({length:5},(_,i)=>({id:'call_'+String(i).repeat(30),type:'function' as const,function:{name:'get_server_metrics',arguments:JSON.stringify({serverId:i+1,maxRows:1,from:'2026-10-20T00:00:00Z'})}}));
  const raw:Message[]=[messages[0],messages[1],{role:'assistant',content:null,tool_calls:calls},...calls.slice(0,4).map(call=>({role:'tool' as const,tool_call_id:call.id,content:'untrusted evidence'}))];
  const before=JSON.stringify(raw);const refs=new ContextManager(spec,provider).pins(raw,raw.length).find(m=>m.role==='tool'&&m.name==='runtime_evidence_references')!;
  const payload=JSON.parse(String(refs.content).split('\n').slice(1).join('\n'));
  const expected=calls.map((call,i)=>({sourceIndex:2,toolCallId:call.id,toolName:call.function.name,arguments:call.function.arguments,status:i<4?'result_recorded_not_success_assertion':'uncertain_do_not_replay'}));
  const decoded=Array.isArray(payload)?payload:payload.rows.map((row:any[])=>Object.fromEntries(payload.columns.map((key:string,i:number)=>[key==='statusIndex'?'status':key,key==='statusIndex'?payload.statuses[row[i]]:row[i]])));
  expect(decoded).toEqual(expected);
  expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(Buffer.byteLength(JSON.stringify(expected)));
  expect(JSON.stringify(raw)).toBe(before);
});
