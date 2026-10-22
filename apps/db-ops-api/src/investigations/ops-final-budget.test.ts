import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook, OpenAIProvider, ToolRegistry, type Message } from '@slide/agent-core';
import { investigationContextMessages, investigationExecutionEvidence } from './executor.js';
import { modelAnalysis } from './model-analysis.js';
const core = new URL('../../../../packages/agent-core/src/', import.meta.url);
const { ContextManager, sourceHash } = await import(new URL('runtime/context-manager.js', core).href);
const { RecoveryPolicy } = await import(new URL('runtime/recovery-policy.js', core).href);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/ops-budget-b12-20261022.json', import.meta.url), 'utf8'));

// Preserve original policy, initial history, all 24 facts, last inventory,
// accepted summary/response and original run/request/job/fence. Only the next
// response is scripted; every SDK request is sent to this loopback server.
async function finalRequest(violate = false) {
  const raw: Message[] = structuredClone([...fixture.initialMessages, ...fixture.history]);
  const execution = structuredClone(fixture.state), receipt = execution.lastSummaryReceipt;
  const source = raw.slice(0, fixture.summaryEnd);
  expect(sourceHash(source)).toBe(receipt.sourceHash);
  const record = { schemaVersion: 1, sourceStart: 0, sourceEnd: source.length, sourceHash: receipt.sourceHash,
    summary: JSON.parse(receipt.response.content) };
  const recovery = new RecoveryPolicy();
  Object.assign(recovery.state, { modelSteps: 5, providerAttempts: 7, toolCalls: 19,
    usage: { prompt_tokens: 64548, completion_tokens: 11994, cached_tokens: 12160 } });
  const binding = { runId: raw.at(-1)!.runId!, requestId: execution.requestId, jobId: execution.jobId, fencingToken: execution.fencingToken };
  const tools = new ToolRegistry(), execute = vi.fn(async () => { throw Error('No next tool may execute'); });
  for (const t of fixture.wire.tools) tools.register({ ...t.function, readOnly: true, concurrencySafe: false, exclusive: true, execute });
  const bodies: any[] = [], checkpoints: any[] = [], traces: any[] = [];
  const answer = { analysisVersion: 1, summary: '离线传输验证：保留当前证据与缺口，不代表真实模型分析。', claims: [], hypotheses: [], unresolvedQuestions: ['文件系统维度不能配对，网络失败不等于零。'], recommendations: [] };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    const response = violate ? fixture.responses[6] : { content: JSON.stringify(answer), toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 20, completion_tokens: 20 } };
    const message = { role: 'assistant', content: response.content, ...response._extra,
      ...(response.toolCalls.length ? { tool_calls: response.toolCalls.map((c: any) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) };
    const value = { choices: [{ index: 0, message, delta: message, finish_reason: response.finishReason }], usage: response.usage };
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    res.end(body.stream ? 'data: ' + JSON.stringify(value) + '\n\ndata: [DONE]\n\n' : JSON.stringify(value));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const actual = new OpenAIProvider({ apiKey: 'offline-unused', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    capabilities: { model: 'deepseek-flash', contextWindowTokens: 1048576, maxOutputTokens: 393216, source: 'configuration', version: 'retained-B12' } });
  const provider = { getDefaultModel: actual.getDefaultModel.bind(actual), getModelCapabilities: actual.getModelCapabilities.bind(actual), countPromptTokens: actual.countPromptTokens.bind(actual),
    projectMessages: (m: Message[]) => investigationContextMessages(actual.projectMessages(m), 'ops'), chat: actual.chat.bind(actual), chatStream: actual.chatStream.bind(actual) };
  const original = ContextManager.prototype.assertFits;
  const spy = vi.spyOn(ContextManager.prototype, 'assertFits').mockImplementation(function(this: any, messages: any, limit: any, definitions: any) {
    const trace: any = { input: this.tokens(messages, definitions), limit: limit ?? this.inputBudget, maxTokens: this.spec.maxTokens, messages, definitions: definitions ?? this.spec.tools.getDefinitions() };
    traces.push(trace);
    try { return original.call(this, messages, limit, definitions); } catch (e) { trace.error = String(e); throw e; }
  });
  try {
    const result = await new AgentRunner(provider).run({ initialMessages: raw, runtimeRunId: binding.runId, tools, hook: new NoopHook(), model: 'deepseek-flash',
      contextWindowTokens: 65536, maxTokens: 8192, maxIterations: 8, maxToolResultChars: 128000,
      contextPolicy: { recentToolBatches: 1, evidenceReferences: 'canonical', summaryMaxTokens: 10240 },
      contextEvidence: (s, summary) => investigationExecutionEvidence(s, execution, binding, 2, summary),
      budgetLimits: { maxProviderAttempts: 8, maxToolCalls: 20, maxTotalTokens: 128000, maxNoProgressSteps: 8 },
      resumeCheckpoint: { context_summary_v1: record, runtime_state_v1: recovery.snapshot(),
        context_state_v1: { schemaVersion: 1, compactCount: 2, successfulCompacts: 2, toolBatchesSinceCompact: 1, rapidRefills: 1 } },
      checkpointCallback: async c => { checkpoints.push(structuredClone(c)); },
    });
    const dir = process.env.OPS_FINAL_EVIDENCE_DIR;
    if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(dir + (violate ? '/b12-violate.json' : '/b12-answer.json'), JSON.stringify({ binding, originalSourceHash: receipt.sourceHash, bodies, checkpoints, traces, result }, null, 2)); }
    expect(execute).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].tools ?? []).toEqual([]);
    expect(bodies[0].messages[0].content).toBe(fixture.wire.messages[0].content);
    expect(bodies[0].messages.some((m: any) => m.tool_call_id === raw.at(-1)!.tool_call_id && m.content.includes('inventory'))).toBe(true);
    expect(bodies[0].messages.some((m: any) => m.content?.includes('remainingProviderAttempts=1'))).toBe(true);
    expect(bodies[0].messages.some((m: any) => m.content?.includes(JSON.stringify(record.summary)))).toBe(true);
    for (const m of bodies[0].messages) for (const call of m.tool_calls ?? []) expect(bodies[0].messages.filter((r: any) => r.tool_call_id === call.id)).toHaveLength(1);
    expect(result.runtimeState).toMatchObject({ providerAttempts: 8, toolCalls: 19, unknownRequests: 0, reservedTokens: 0 });
    if (violate) expect(result.resolution).toMatchObject({ kind: 'partial', reasonCode: 'MAX_PROVIDER_ATTEMPTS' });
    else { expect(result.stopReason).toBe('completed'); expect(modelAnalysis(result.finalContent!, [])).not.toBeNull(); }
    return result;
  } finally { spy.mockRestore(); await new Promise<void>(r => server.close(() => r())); }
}
it('admits the full original B12 final answer at 76542 tokens used without spending attempt eight on optional summary', async () => { await finalRequest(); }, 30000);
it('rejects a tool call on the original B12 final attempt without execution or request nine', async () => { await finalRequest(true); }, 30000);
