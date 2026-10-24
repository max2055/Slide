import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook, OpenAIProvider, ToolRegistry, responseHash, type Message } from '@slide/agent-core';
import { investigationContextMessages, investigationExecutionEvidence } from './executor.js';
import { modelAnalysis } from './model-analysis.js';
const core = new URL('../../../../packages/agent-core/src/', import.meta.url);
const { ContextManager, sourceHash } = await import(new URL('runtime/context-manager.js', core).href);
const { RecoveryPolicy } = await import(new URL('runtime/recovery-policy.js', core).href);
const f = JSON.parse(readFileSync(new URL('./fixtures/ops-deadline-b16-20261023.json', import.meta.url), 'utf8'));
// The live projection of this recorded history now also carries the filesystem pair routes (completeRead/seriesSelection).
// The final request grows by 3979 estimated tokens, so the recorded 60152-token remainder no longer leaves the full
// 8192 output; raise the cap by exactly the amount that restores it.
const FS_ROUTE_TOKENS = 3979;
const raw: Message[] = [...f.initialMessages, ...f.history];
const execution = f.run.result_json.investigationExecution;
const binding = { runId: f.run.id, requestId: execution.requestId, jobId: execution.jobId, fencingToken: execution.fencingToken };
const receipt = execution.lastSummaryReceipt;
const record = { schemaVersion: 1 as const, sourceStart: 0, sourceEnd: f.summaryEnd, sourceHash: receipt.sourceHash,
  summary: JSON.parse(receipt.response.content), provenance: 'legacy/unknown', generation: 2,
  originalSourceIds: raw.slice(0, f.summaryEnd).flatMap(m => m.id ? [m.id] : []),
  previousSummary: { generation: 1, sourceHash: f.firstSummaryHash, summaryHash: sourceHash([{ role: 'tool', content: JSON.stringify(JSON.parse(f.responses[2].content)) }]) } };

it('binds both B16 summaries and all 22 canonical entries to the retained complete production source', () => {
  expect(raw).toHaveLength(24); expect(f.entries).toHaveLength(22);
  expect(sourceHash(raw.slice(0, f.summaryEnd))).toBe(receipt.sourceHash);
  expect(raw.some((_m, i) => sourceHash(raw.slice(0, i + 1)) === f.firstSummaryHash)).toBe(true);
  for (const m of f.history) { const e = f.entries.find((e: any) => m.role === 'tool' ? m.tool_call_id === e.tool_call_id : m.id === e.id); expect(m.content).toBe(e.content); }
  for (const [i, response] of f.responses.entries()) {
    const e = f.events.filter((e: any) => e.event === 'wire_response')[i];
    expect(createHash('sha256').update(JSON.stringify(response)).digest('hex')).toBe(e.responseHash);
    expect(response.usage).toEqual(e.usage);
  }
  const final = f.events.filter((e: any) => e.event === 'received').at(-1);
  expect(execution.deadlineAt - Date.parse(final.at)).toBe(71);
});

it.each([false, true])('admits the complete B16 final through loopback SDK with honest current omissions; violate=%s', async violate => {
  const before = JSON.stringify(raw), bodies: any[] = [], saved: any[] = [];
  const tools = new ToolRegistry(), execute = vi.fn(async () => { throw Error('NO_NEW_TOOLS'); });
  for (const tool of f.wires[5].tools) tools.register({ ...tool.function, execute, readOnly: true });
  const recovery = new RecoveryPolicy();
  const usage = f.responses.slice(0, 6).reduce((s: any, r: any) => ({ prompt_tokens: s.prompt_tokens + r.usage.prompt_tokens, completion_tokens: s.completion_tokens + r.usage.completion_tokens, cached_tokens: s.cached_tokens + (r.usage.cached_tokens ?? 0) }), { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 });
  Object.assign(recovery.state, { providerAttempts: 6, modelSteps: 4, toolCalls: 18, usage });
  expect(128000 - usage.prompt_tokens - usage.completion_tokens).toBe(60152);
  const answer = { analysisVersion: 1, summary: '本轮已有取证；当前部分原始回执因容量未提供，不能据摘要作数值判断。', claims: [], hypotheses: [], unresolvedQuestions: ['需核对当前未提供的原件；不能将省略解释为未采集、失败、空值或零值。'], recommendations: [{ action: '核对相同资源、时间与完整维度的证据后再判断。', priority: 'medium' }] };
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    const message = violate ? { role: 'assistant', content: null, tool_calls: [{ id: 'forbidden', type: 'function', function: { name: 'query_metrics', arguments: '{}' } }] } : { role: 'assistant', content: JSON.stringify(answer) };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message, finish_reason: violate ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20 } }));
  });
  await new Promise<void>(r => receiver.listen(0, '127.0.0.1', r));
  try {
    const actual = new OpenAIProvider({ apiKey: 'offline-unused', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${(receiver.address() as any).port}/v1`, capabilities: { model: 'deepseek-flash', contextWindowTokens: 1048576, maxOutputTokens: 393216, source: 'configuration', version: 'retained-B16' } });
    const provider = { getDefaultModel: actual.getDefaultModel.bind(actual), getModelCapabilities: actual.getModelCapabilities.bind(actual), countPromptTokens: actual.countPromptTokens.bind(actual), projectMessages: (m: Message[]) => investigationContextMessages(actual.projectMessages(m), 'ops'), chat: actual.chat.bind(actual), chatStream: actual.chatStream.bind(actual) };
    const result = await new AgentRunner(provider).run({ initialMessages: structuredClone(raw), tools, model: 'deepseek-flash', hook: new NoopHook(), maxIterations: 8, maxTokens: 8192, contextWindowTokens: 65536, maxToolResultChars: 128000,
      budgetLimits: { maxProviderAttempts: 8, maxToolCalls: 20, maxTotalTokens: 128000 + FS_ROUTE_TOKENS, maxNoProgressSteps: 8 },
      contextPolicy: { recentToolBatches: 1, evidenceReferences: 'canonical', summaryMaxTokens: 10240 },
      contextEvidence: (source, summary) => investigationExecutionEvidence(source, execution, binding, f.initialMessages.length, summary),
      resumeCheckpoint: { runtime_state_v1: recovery.snapshot(), context_summary_v1: record }, checkpointCallback: async c => { saved.push(structuredClone(c)); } });
    expect(bodies).toHaveLength(1); expect(bodies[0].tools ?? []).toEqual([]); expect(bodies[0].max_tokens).toBe(8192); expect(execute).not.toHaveBeenCalled();
    const scope = bodies[0].messages.filter((m: any) => m.role === 'tool').map((m: any) => { try { return JSON.parse(m.content.slice(m.content.indexOf('{'))); } catch { return null; } }).find((v: any) => v?.receipts && v.canonicalSource);
    expect(scope).toMatchObject({ runId: binding.runId, requestId: binding.requestId });
    expect(scope.use).toContain('returned in this execution');
    expect(scope.use).toContain('THIS request');
    expect(scope.use).toContain('not a collection failure');
    expect(scope.use).toContain('not assert whether an earlier model request saw');
    for (const r of scope.receipts) {
      expect(r.receiptHash).toBe(responseHash(execution.tools[r.toolCallId].result));
      if (!r.valuesProvided) { expect(r.reason).toBe('INPUT_BUDGET'); expect(r.observation).toBeUndefined(); }
    }
    const serverCall = f.history.flatMap((m: any) => m.tool_calls ?? []).find((c: any) => c.function.name === 'get_resource_observations' && JSON.parse(c.function.arguments).resourceType === 'server');
    expect(scope.receipts.find((r: any) => r.toolCallId === serverCall.id).valuesProvided).toBe(false);
    expect(JSON.stringify(raw)).toBe(before);
    if (violate) { expect(result.resolution?.reasonCode).toBe('MAX_PROVIDER_ATTEMPTS'); expect(saved.at(-1).phase).toBe('rejected_tool_batch'); }
    else { expect(result.stopReason).toBe('completed'); expect(modelAnalysis(result.finalContent!, [])).not.toBeNull(); expect(modelAnalysis(JSON.stringify({ ...answer, claims: [{ statement: 'unknown', supportingToolCallIds: ['unreturned'], contradictingToolCallIds: [] }] }), [])).toBeNull(); }
    const out = process.env.OPS_B16_EVIDENCE_DIR;
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(`${out}/b16-final-${violate}.json`, JSON.stringify({ scope: 'Full retained B16 source, local SDK scripted final; no product call, not autonomous analysis or live collector', bodies, result, saved }, null, 2)); }
  } finally { await new Promise<void>(r => receiver.close(() => r())); }
}, 30000);

// Replay observed wall-clock intervals without assigning the uninstrumented
// received→SDK gap to production or CLI. The 20ms phase costs below are an
// explicit local experiment, not measurements of the B16 database/ACL stages.
it('uses the full B16 chain and observed latency intervals to finish before optional reads consume the deadline', async () => {
  const events = f.events, sdks = events.filter((e: any) => e.event === 'sdk_request');
  const sent = events.filter((e: any) => e.event === 'send');
  const received = events.filter((e: any) => e.event === 'received');
  const start = execution.deadlineAt - 120000;
  let now = start, requestIndex = 0, previousReturn = start;
  const controller = new AbortController(), phases: any[] = [], bodies: any[] = [], saved: any[] = [];
  const tick = (phase: string, ms: number) => { now += ms; phases.push({ phase, ms, at: now }); if (now >= execution.deadlineAt) controller.abort(new Error('RUN_DEADLINE deadline')); };
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  let pending: any;
  const answer = { analysisVersion: 1, summary: '本地脚本收尾：当前证据边界保留，不能把省略当作无值。', claims: [], hypotheses: [], unresolvedQuestions: ['完整诊断仍需真实业务验收。'], recommendations: [] };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    const index = requestIndex++, isSummary = sent[index]?.purpose === 'summary';
    const final = !isSummary && !(body.tools?.length);
    const original = final ? f.responses[6] : f.responses[index];
    const delay = Date.parse(received[final ? 6 : index].at) - Date.parse(sdks[final ? 6 : index].at);
    tick(final ? 'final_provider_observed' : isSummary ? 'summary_provider_observed' : 'ordinary_provider_observed', delay);
    pending = final ? { ...original, content: JSON.stringify(answer), toolCalls: [], shouldExecuteTools: false, hasToolCalls: false, finishReason: 'stop' } : original;
    const message = { role: 'assistant', content: pending.content, ...(pending.toolCalls.length ? { tool_calls: pending.toolCalls.map((c: any) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}), ...(pending._extra ?? {}) };
    const value = { choices: [{ ...(body.stream ? { delta: message } : { message }), finish_reason: pending.finishReason }], usage: pending.usage };
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    res.end(body.stream ? 'data: ' + JSON.stringify(value) + '\n\ndata: [DONE]\n\n' : JSON.stringify(value));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const actual = new OpenAIProvider({ apiKey: 'offline-unused', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1`, capabilities: { model: 'deepseek-flash', contextWindowTokens: 1048576, maxOutputTokens: 393216, source: 'configuration', version: 'retained-B16' } });
    const state = structuredClone(execution); state.usageUnknown = false; delete state.lastSummaryReceipt;
    let summaryResponse: any;
    const admission = () => {
      const index = requestIndex;
      const originalGap = Date.parse(sdks[index].at) - (index ? Date.parse(received[index - 1].at) : start);
      // Production phases already charged after the last local provider reply
      // are part of, not additional to, the observed aggregate interval.
      tick('unallocated_observed_gap_including_CLI', Math.max(0, originalGap - (now - previousReturn)));
    };
    const provider = { getDefaultModel: actual.getDefaultModel.bind(actual), getModelCapabilities: actual.getModelCapabilities.bind(actual), countPromptTokens: actual.countPromptTokens.bind(actual), projectMessages: (m: Message[]) => investigationContextMessages(actual.projectMessages(m), 'ops'),
      chat: async (...args: Parameters<typeof actual.chat>) => { admission(); const r = await actual.chat(...args); previousReturn = now; return r; },
      chatStream: async (...args: Parameters<typeof actual.chatStream>) => { admission(); const r = await actual.chatStream(...args); previousReturn = now; summaryResponse = r; return r; } };
    const tools = new ToolRegistry(), executed: string[] = [];
    for (const t of f.wires[0].tools) tools.register({ ...t.function, readOnly: true, concurrencySafe: true, exclusive: false, execute: async (_a: any, ctx: any) => {
      const call = f.history.flatMap((m: any) => m.tool_calls ?? []).find((c: any) => c.function.name === t.function.name && responseHash(JSON.parse(c.function.arguments)) === responseHash(_a) && !executed.includes(c.id));
      if (!call) throw Error('UNEXPECTED_SCRIPTED_TOOL');
      executed.push(call.id); tick('local_tool_phase', 20); return structuredClone(state.tools[call.id].result);
    } });
    const hook = new NoopHook(); hook.beforeIteration = async () => tick('local_admission_hook', 20); hook.afterIteration = async () => tick('local_after_hook', 20);
    const result = await new AgentRunner(provider).run({ initialMessages: structuredClone(f.initialMessages), tools, model: 'deepseek-flash', hook, maxIterations: 8, maxTokens: 8192, contextWindowTokens: 65536, maxToolResultChars: 128000, concurrentTools: false, runTimeoutMs: 120000, signal: controller.signal,
      budgetLimits: { maxProviderAttempts: 8, maxToolCalls: 20, maxTotalTokens: 128000, maxNoProgressSteps: 8 },
      contextPolicy: { recentToolBatches: 1, evidenceReferences: 'canonical', summaryMaxTokens: 10240 },
      contextEvidence: (source, summary) => investigationExecutionEvidence(source, state, binding, f.initialMessages.length, summary),
      checkpointCallback: async c => {
        tick('local_checkpoint_' + (c.phase ?? 'counters'), 20);
        if ((c.context_request_v1 as any)?.status === 'accepted') state.lastSummaryReceipt = { ...c.context_request_v1 as any, response: summaryResponse };
        saved.push(structuredClone(c));
      } });
    if (process.env.OPS_B16_EVIDENCE_DIR) writeFileSync(process.env.OPS_B16_EVIDENCE_DIR + '/b16-time-debug.json', JSON.stringify({phases,bodies: bodies.map(b=>({tools:b.tools?.length,stream:b.stream,max:b.max_tokens})),result,executed,saved},null,2));
    expect(result.stopReason).toBe('completed'); expect(now).toBeLessThan(execution.deadlineAt);
    expect(bodies.at(-1).tools ?? []).toEqual([]); expect(bodies.at(-1).max_tokens).toBe(8192);
    expect(bodies.length).toBeLessThan(7);
    expect(executed).toHaveLength(14); // Fourth original batch is optional at the measured boundary.
    expect(saved.at(-1).runtime_state_v1.timing.cycleMs).toBeGreaterThan(20000);
    expect(modelAnalysis(result.finalContent!, [])).not.toBeNull();
    const out = process.env.OPS_B16_EVIDENCE_DIR;
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(out + '/b16-full-time-chain.json', JSON.stringify({ scope: 'Controlled SDK response scripts and phase clock; observed gaps include CLI, local phase costs synthetic; not real diagnosis or an attribution of B16 persistence latency', bodies, phases, result, deadline: execution.deadlineAt, finishedAt: now, executed, saved }, null, 2)); }
  } finally { clock.mockRestore(); await new Promise<void>(r => server.close(() => r())); }
}, 30000);
