import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook, OpenAIProvider, ToolRegistry, type Message } from '@slide/agent-core';
import { investigationContextMessages, investigationExecutionEvidence } from './executor.js';
import { modelAnalysis } from './model-analysis.js';
const core = new URL('../../../../packages/agent-core/src/', import.meta.url);
const { ContextManager, sourceHash } = await import(new URL('runtime/context-manager.js', core).href);
const { responseHash } = await import(new URL('runtime/summary-receipt.js', core).href);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/ops-budget-b14-20261023.json', import.meta.url), 'utf8'));

// Full retained B14 input and receipts. Only the next reply is scripted, over
// loopback HTTP; this neither sends to the product Provider nor resumes its DB.
async function replay(before: boolean, violate = false) {
  const raw: Message[] = structuredClone([...fixture.initialMessages, ...fixture.history].slice(0, before ? 21 : 27));
  const execution = structuredClone(fixture.state), receipt = execution.lastSummaryReceipt;
  expect(sourceHash(raw.slice(0, fixture.summaryEnd))).toBe(receipt.sourceHash);
  const record = structuredClone(fixture.summaryRecord);
  expect(raw.some((_, i) => sourceHash(raw.slice(0, i + 1)) === record.previousSummary.sourceHash)).toBe(true);
  const { RecoveryPolicy } = await import(new URL('runtime/recovery-policy.js', core).href);
  const recovery = new RecoveryPolicy();
  Object.assign(recovery.state, { providerAttempts: before ? 6 : 7, toolCalls: before ? 15 : 20, modelSteps: before ? 4 : 5,
    usage: fixture.usageBefore[before ? "before" : "after"] });
  const binding = { runId: raw.at(-1)!.runId!, requestId: execution.requestId, jobId: execution.jobId, fencingToken: execution.fencingToken };
  const tools = new ToolRegistry(), execute = vi.fn(async () => { throw Error('NO_NEXT_TOOL'); });
  for (const t of fixture.wire.tools) tools.register({ ...t.function, readOnly: true, execute });
  const bodies: any[] = [], checkpoints: any[] = [], traces: any[] = [];
  const answer = { analysisVersion: 1, summary: '本地脚本终答，不能代表真实模型分析。', claims: [], hypotheses: [], unresolvedQuestions: ['文件系统维度不匹配，网络失败不是零值。'], recommendations: [] };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    const summary = body.messages[0].content.startsWith('Summarize historical data,');
    const response = summary ? fixture.responses[5] : violate ? fixture.responses[6]
      : { content: JSON.stringify(answer), toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 20, completion_tokens: 20 } };
    const message = { role: 'assistant', content: response.content, ...response._extra,
      ...(response.toolCalls.length ? { tool_calls: response.toolCalls.map((c: any) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) };
    const value = { choices: [{ index: 0, message, delta: message, finish_reason: response.finishReason }], usage: response.usage };
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    res.end(body.stream ? 'data: ' + JSON.stringify(value) + '\n\ndata: [DONE]\n\n' : JSON.stringify(value));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const actual = new OpenAIProvider({ apiKey: 'offline-unused', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    capabilities: { model: 'deepseek-flash', contextWindowTokens: 1048576, maxOutputTokens: 393216, source: 'configuration', version: 'retained-B14' } });
  const provider = { getDefaultModel: actual.getDefaultModel.bind(actual), getModelCapabilities: actual.getModelCapabilities.bind(actual), countPromptTokens: actual.countPromptTokens.bind(actual),
    projectMessages: (m: Message[]) => investigationContextMessages(actual.projectMessages(m), 'ops'), chat: actual.chat.bind(actual), chatStream: actual.chatStream.bind(actual) };
  const original = ContextManager.prototype.assertFits;
  const spy = vi.spyOn(ContextManager.prototype, 'assertFits').mockImplementation(function(this: any, messages: any, limit: any, definitions: any) {
    const trace: any = { messages, input: this.tokens(messages, definitions), limit: limit ?? this.inputBudget, maxTokens: this.spec.maxTokens, schemas: (definitions ?? this.spec.tools.getDefinitions()).length };
    traces.push(trace); try { return original.call(this, messages, limit, definitions); } catch (e) { trace.error = String(e); throw e; }
  });
  try {
    const result = await new AgentRunner(provider).run({ initialMessages: raw, runtimeRunId: binding.runId, tools, model: 'deepseek-flash', hook: new NoopHook(),
      contextWindowTokens: 65536, maxTokens: 8192, maxIterations: 8, maxToolResultChars: 128000,
      contextPolicy: { recentToolBatches: 1, evidenceReferences: 'canonical', summaryMaxTokens: 10240 },
      contextEvidence: (source, summary) => investigationExecutionEvidence(source, execution, binding, 2, summary),
      budgetLimits: { maxProviderAttempts: 8, maxToolCalls: 20, maxTotalTokens: 128000, maxNoProgressSteps: 8 },
      resumeCheckpoint: { context_summary_v1: record, runtime_state_v1: recovery.snapshot(), context_state_v1: { schemaVersion: 1, compactCount: 2, successfulCompacts: 2, toolBatchesSinceCompact: 1, rapidRefills: 0 } },
      checkpointCallback: async c => { checkpoints.push(structuredClone(c)); } });
    const dir = process.env.OPS_LOW_BALANCE_EVIDENCE_DIR;
    if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(dir + '/' + (before ? violate ? 'before-seven-violate' : 'before-seven-answer' : 'after-seven-stop') + '.json', JSON.stringify({ scope: 'Retained B14 offline loopback; real current clock, scripted response, no product sends, no active-summary DB recovery', binding, originalSourceHash: receipt.sourceHash, bodies, checkpoints, traces, result }, null, 2)); }
    expect(execute).not.toHaveBeenCalled();
    if (!before) {
      expect(bodies).toHaveLength(0);
      expect(result.resolution).toMatchObject({ kind: 'partial', reasonCode: 'TOKEN_BUDGET' });
      expect(result.runtimeState).toMatchObject({ providerAttempts: 7, toolCalls: 20, unknownRequests: 0, reservedTokens: 0 });
      return;
    }
    expect(bodies).toHaveLength(1);
    expect(bodies[0].tools ?? []).toEqual([]);
    expect(bodies[0].max_tokens).toBeGreaterThan(0); expect(bodies[0].max_tokens).toBeLessThanOrEqual(8192);
    expect(bodies[0].messages[0].content).toBe(fixture.wire.messages[0].content);
    expect(bodies[0].messages.some((m: any) => m.content?.includes(JSON.stringify(record.summary)))).toBe(true);
    for (const m of raw.slice(fixture.summaryEnd)) if (m.role === 'tool') expect(bodies[0].messages.some((v: any) => v.tool_call_id === m.tool_call_id)).toBe(true);
    for (const m of bodies[0].messages) for (const c of m.tool_calls ?? []) expect(bodies[0].messages.filter((r: any) => r.tool_call_id === c.id)).toHaveLength(1);
    const latest = [...raw].reverse().find(m => m.role === 'assistant' && m.tool_calls?.length)!;
    const wireLatest = bodies[0].messages.find((m: any) => m.tool_calls?.[0]?.id === latest.tool_calls![0].id);
    expect(wireLatest.reasoning_content).toBe(latest.reasoning_content ?? (latest as any)._extra?.reasoning_content);
    const originals = new Map(raw.filter(m => m.role === 'tool').map(m => [m.tool_call_id, JSON.parse(m.content as string)]));
    const distinct = new Map<string, any>(), metricIds = new Set<string>();
    const compare = (id: string, value: any) => {
      const original: any = originals.get(id);
      for (const metric of value?.data?.metrics ?? []) {
        const origin = original.data.metrics.find((m: any) => m.definition.id === metric.definition.id);
        expect(metric.definition).toEqual(origin.definition);
        for (const series of metric.series ?? []) {
          const source = origin.series.find((v: any) => JSON.stringify(v.dimensions) === JSON.stringify(series.dimensions));
          const buckets = series.buckets.map((b: any) => ({ ...series.bucketDefaults, ...(series.bucketColumns
            ? Object.fromEntries(series.bucketColumns.flatMap((key: string, i: number) => b[0][i] ? [[key, b[1][i]]] : [])) : b) }));
          expect(buckets).toEqual(source.buckets);
          for (const bucket of buckets) if (bucket.value !== null && bucket.value !== undefined) {
            metricIds.add(metric.definition.id);
            distinct.set(JSON.stringify([metric.definition.id, series.dimensions, bucket.window]), bucket);
          }
        }
      }
    };
    for (const message of bodies[0].messages) if (message.role === 'tool') {
      const value = JSON.parse(message.content.slice(message.content.indexOf('{')));
      if (originals.has(message.tool_call_id)) compare(message.tool_call_id, value);
      if (value.canonicalSource && value.receipts) for (const receipt of value.receipts) {
        const durable = execution.tools[receipt.toolCallId];
        expect(durable.status).toBe('returned');
        expect(receipt.receiptHash).toBe(responseHash(durable.result));
        if (receipt.valuesProvided) compare(receipt.toolCallId, receipt.observation);
        else { expect(receipt.reason).toBe('INPUT_BUDGET'); expect(receipt.observation).toBeUndefined(); }
      }
    }
    // Current final request preserves every field of 15 numeric buckets.
    // Six earlier connection buckets remain in the retained earlier SDK wires,
    // with honest valuesProvided=false references in this narrower final view.
    expect(metricIds.size).toBe(5); expect(distinct.size).toBe(15);
    for (const body of fixture.earlierWires) for (const message of body.messages) if (message.role === 'tool') {
      let value: any;
      try { value = JSON.parse(message.content.slice(message.content.indexOf('{'))); }
      catch { continue; } // Compacted non-metric history can contain a text suffix.
      if (originals.has(message.tool_call_id)) compare(message.tool_call_id, value);
      if (value.canonicalSource && value.receipts) for (const receipt of value.receipts) {
        if (receipt.valuesProvided) compare(receipt.toolCallId, receipt.observation);
      }
    }
    expect(metricIds.size).toBe(7); expect(distinct.size).toBe(21);
    expect(result.runtimeState).toMatchObject({ providerAttempts: 7, toolCalls: 15, unknownRequests: 0, reservedTokens: 0 });
    if (violate) expect(checkpoints.at(-1)).toMatchObject({ phase: 'rejected_tool_batch', pendingToolCalls: [], rejectedToolCalls: expect.any(Array) });
    else { expect(result.stopReason).toBe('completed'); expect(modelAnalysis(result.finalContent!, [])).not.toBeNull(); }
  } finally { spy.mockRestore(); await new Promise<void>(r => server.close(() => r())); }
}
it('preserves the reachable full B14 answer before the optional seventh request can strand its next receipts', async () => { await replay(true); }, 30000);
it('durably refuses tools on the B14 capacity-limited answer without executing or requesting again', async () => { await replay(true, true); }, 30000);
it('retains the original B14 irreducible post-seven budget stop without extra summary or final sends', async () => { await replay(false); }, 30000);
