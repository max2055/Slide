import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook, OpenAIProvider, ToolRegistry, type Message } from '@slide/agent-core';
import { investigationContextMessages, investigationExecutionEvidence } from './executor.js';
import { modelAnalysis } from './model-analysis.js';
const core = new URL('../../../../packages/agent-core/src/', import.meta.url);
const { ContextManager, sourceHash } = await import(new URL('runtime/context-manager.js', core).href);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/ops-budget-b13-20261023.json', import.meta.url), 'utf8'));

// The live projection of this recorded history now also carries the filesystem pair routes (completeRead/seriesSelection).
// Without extra window the post-six replay stops on CONTEXT_UNRECOVERABLE before it can reach the TOKEN_BUDGET stop
// under test. 67500 is the smallest window tried that restores it (67250 does not).
const FS_ROUTE_WINDOW_TOKENS = 1964;
// Full retained B13 input and receipts. Only the next reply is scripted, over
// loopback HTTP; this neither sends to the product Provider nor resumes its DB.
async function replay(before: boolean, violate = false) {
  const raw: Message[] = structuredClone([...fixture.initialMessages, ...fixture.history].slice(0, before ? 21 : 26));
  const execution = structuredClone(fixture.state), receipt = execution.lastSummaryReceipt;
  expect(sourceHash(raw.slice(0, fixture.summaryEnd))).toBe(receipt.sourceHash);
  const record = structuredClone(fixture.summaryRecord);
  const { RecoveryPolicy } = await import(new URL('runtime/recovery-policy.js', core).href);
  const recovery = new RecoveryPolicy();
  Object.assign(recovery.state, { providerAttempts: before ? 5 : 6, toolCalls: before ? 16 : 20, modelSteps: before ? 3 : 4,
    usage: before ? { prompt_tokens: 51243, completion_tokens: 8943, cached_tokens: 7168 } : { prompt_tokens: 69134, completion_tokens: 10796, cached_tokens: 9600 } });
  const binding = { runId: 'e1028978-6e01-409a-925d-7767638b4b0b', requestId: execution.requestId, jobId: execution.jobId, fencingToken: execution.fencingToken };
  const tools = new ToolRegistry(), execute = vi.fn(async () => { throw Error('NO_NEXT_TOOL'); });
  for (const t of fixture.wire6.tools) tools.register({ ...t.function, readOnly: true, execute });
  const bodies: any[] = [], checkpoints: any[] = [], traces: any[] = [];
  const answer = { analysisVersion: 1, summary: '本地脚本终答，不能代表真实模型分析。', claims: [], hypotheses: [], unresolvedQuestions: ['文件系统维度不匹配，网络失败不是零值。'], recommendations: [] };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    const summary = body.messages[0].content.startsWith('Summarize historical data,');
    const response = summary ? fixture.responses[4] : violate ? fixture.responses[5]
      : { content: JSON.stringify(answer), toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 20, completion_tokens: 20 } };
    const message = { role: 'assistant', content: response.content, ...response._extra,
      ...(response.toolCalls.length ? { tool_calls: response.toolCalls.map((c: any) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) };
    const value = { choices: [{ index: 0, message, delta: message, finish_reason: response.finishReason }], usage: response.usage };
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    res.end(body.stream ? 'data: ' + JSON.stringify(value) + '\n\ndata: [DONE]\n\n' : JSON.stringify(value));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const actual = new OpenAIProvider({ apiKey: 'offline-unused', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    capabilities: { model: 'deepseek-flash', contextWindowTokens: 1048576, maxOutputTokens: 393216, source: 'configuration', version: 'retained-B13' } });
  const provider = { getDefaultModel: actual.getDefaultModel.bind(actual), getModelCapabilities: actual.getModelCapabilities.bind(actual), countPromptTokens: actual.countPromptTokens.bind(actual),
    projectMessages: (m: Message[]) => investigationContextMessages(actual.projectMessages(m), 'ops'), chat: actual.chat.bind(actual), chatStream: actual.chatStream.bind(actual) };
  const original = ContextManager.prototype.assertFits;
  const spy = vi.spyOn(ContextManager.prototype, 'assertFits').mockImplementation(function(this: any, messages: any, limit: any, definitions: any) {
    const trace: any = { messages, input: this.tokens(messages, definitions), limit: limit ?? this.inputBudget, maxTokens: this.spec.maxTokens, schemas: (definitions ?? this.spec.tools.getDefinitions()).length };
    traces.push(trace); try { return original.call(this, messages, limit, definitions); } catch (e) { trace.error = String(e); throw e; }
  });
  try {
    const result = await new AgentRunner(provider).run({ initialMessages: raw, runtimeRunId: binding.runId, tools, model: 'deepseek-flash', hook: new NoopHook(),
      contextWindowTokens: 65536 + FS_ROUTE_WINDOW_TOKENS, maxTokens: 8192, maxIterations: 8, maxToolResultChars: 128000,
      contextPolicy: { recentToolBatches: 1, evidenceReferences: 'canonical', summaryMaxTokens: 10240 },
      contextEvidence: (source, summary) => investigationExecutionEvidence(source, execution, binding, 2, summary),
      budgetLimits: { maxProviderAttempts: 8, maxToolCalls: 20, maxTotalTokens: 128000, maxNoProgressSteps: 8 },
      resumeCheckpoint: { context_summary_v1: record, runtime_state_v1: recovery.snapshot(), context_state_v1: { schemaVersion: 1, compactCount: 2, successfulCompacts: 2, toolBatchesSinceCompact: 1, rapidRefills: 0 } },
      checkpointCallback: async c => { checkpoints.push(structuredClone(c)); } });
    const dir = process.env.OPS_REACHABILITY_EVIDENCE_DIR;
    if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(dir + '/' + (before ? violate ? 'before-six-violate' : 'before-six-answer' : 'after-six-stop') + '.json', JSON.stringify({ scope: 'Retained B13 offline loopback; real current clock, scripted response, no product sends, no active-summary DB recovery', binding, originalSourceHash: receipt.sourceHash, bodies, checkpoints, traces, result }, null, 2)); }
    expect(execute).not.toHaveBeenCalled();
    if (!before) {
      expect(bodies).toHaveLength(0);
      expect(result.resolution).toMatchObject({ kind: 'partial', reasonCode: 'TOKEN_BUDGET' });
      expect(result.runtimeState).toMatchObject({ providerAttempts: 6, toolCalls: 20, unknownRequests: 0, reservedTokens: 0 });
      return;
    }
    expect(bodies).toHaveLength(1);
    expect(bodies[0].tools ?? []).toEqual([]);
    expect(bodies[0].max_tokens).toBeGreaterThan(0); expect(bodies[0].max_tokens).toBeLessThanOrEqual(8192);
    expect(bodies[0].messages[0].content).toBe(fixture.wire.messages[0].content);
    expect(bodies[0].messages.some((m: any) => m.content?.includes(JSON.stringify(record.summary)))).toBe(true);
    for (const m of raw.slice(15)) if (m.role === 'tool') expect(bodies[0].messages.some((v: any) => v.tool_call_id === m.tool_call_id)).toBe(true);
    for (const m of bodies[0].messages) for (const c of m.tool_calls ?? []) expect(bodies[0].messages.filter((r: any) => r.tool_call_id === c.id)).toHaveLength(1);
    expect(result.runtimeState).toMatchObject({ providerAttempts: 6, toolCalls: 16, unknownRequests: 0, reservedTokens: 0 });
    if (violate) expect(checkpoints.at(-1)).toMatchObject({ phase: 'rejected_tool_batch', pendingToolCalls: [], rejectedToolCalls: expect.any(Array) });
    else { expect(result.stopReason).toBe('completed'); expect(modelAnalysis(result.finalContent!, [])).not.toBeNull(); }
  } finally { spy.mockRestore(); await new Promise<void>(r => server.close(() => r())); }
}
it('preserves the reachable full B13 answer before the optional sixth request can strand its next receipts', async () => { await replay(true); }, 30000);
it('durably refuses tools on the B13 capacity-limited answer without executing or requesting again', async () => { await replay(true, true); }, 30000);
it('retains the original B13 irreducible post-six budget stop without extra summary or final sends', async () => { await replay(false); }, 30000);
