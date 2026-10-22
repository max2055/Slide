import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { AgentRunner, NoopHook, OpenAIProvider, ToolRegistry, type Message } from '@slide/agent-core';
import { investigationContextMessages, investigationExecutionEvidence } from './executor.js';
import { investigationToolContract } from './tool-contract.js';
import { INVESTIGATION_PROFILES } from './profiles.js';
import { resolveInvestigationRuntime } from './runtime-configuration.js';
import { modelAnalysis } from './model-analysis.js';
import { toolCatalog } from '../tools/catalog.js';
import '../tools/ops/index.js';
import '../tools/generated/slide-self-mgmt/resource_tools.js';
import '../tools/generated/slide-self-mgmt/server_tools.js';

const retained = JSON.parse(readFileSync(new URL('./fixtures/ops-execution-b11-20261022.json', import.meta.url), 'utf8'));
it('B11 legal discovery/read chain carries current receipts through accepted summaries into local HTTP SDK strict citations', async () => {
  const bodies: any[] = [], checkpoints: any[] = [], executed: string[] = [], coverage: any[] = [];
  const ordinary = retained.responses.filter((r: any) => r.toolCalls.length), summaries = [retained.responses[3], retained.responses[5]];
  let step = 0, summaryStep = 0, currentCall = '', lastSummaryResponse: any;
  const state: any = { schemaVersion: 1, requestId: 'local-request', jobId: 'local-job', fencingToken: 1, tools: {} };
  const binding = { runId: 'local-run', requestId: 'local-request', jobId: 'local-job', fencingToken: 1 };
  let cited: string | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    const isSummary = body.messages[0].content.startsWith('Summarize historical data,');
    let response: any;
    if (isSummary) response = summaries[summaryStep++ % summaries.length];
    else if (step < ordinary.length && body.tools?.length) response = ordinary[step++];
    else {
      const message = body.messages.find((m: any) => m.role === 'tool' && m.content.startsWith('[Untrusted observations returned in this execution;'));
      const scope = message ? JSON.parse(message.content.slice(message.content.indexOf('\n') + 1)) : { receipts: [] };
      let value: unknown;
      for (const r of scope.receipts) {
        coverage.push({ id: r.toolCallId, hash: r.receiptHash, valuesProvided: r.valuesProvided, reason: r.reason });
        if (!r.valuesProvided || cited) continue;
        for (const metric of r.observation?.data?.metrics ?? []) for (const series of metric.series ?? []) for (const bucket of series.buckets ?? []) {
          const n = series.bucketColumns ? bucket[1][series.bucketColumns.indexOf('value')] : bucket.value;
          if (n !== null && n !== undefined) { cited = r.toolCallId; value = n; }
        }
      }
      if (!cited) cited = scope.receipts[0]?.toolCallId;
      const answer = { analysisVersion: 1, summary: '本地脚本只验证引用链，不代表真实模型分析。',
        claims: cited ? [{ statement: value === undefined ? '本次回执已返回，但当前请求未提供数值，不能进行数值分析。' : `本次已提供完整回执含观测值 ${value}；健康和根因未确认。`, supportingToolCallIds: [cited], contradictingToolCallIds: [] }] : [],
        hypotheses: [], unresolvedQuestions: ['未提供的回执不能支持数值分析。'], recommendations: [] };
      response = { content: JSON.stringify(answer), toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 10 } }; step++;
    }
    const message = { role: 'assistant', content: response.content, ...response._extra,
      ...(response.toolCalls.length ? { tool_calls: response.toolCalls.map((c: any) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) };
    const value = { id: 'local', choices: [{ index: 0, message, delta: message, finish_reason: response.finishReason }], usage: response.usage };
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    res.end(body.stream ? 'data: ' + JSON.stringify(value) + '\n\ndata: [DONE]\n\n' : JSON.stringify(value));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const tools = new ToolRegistry(), scope = [{ type: 'instance', id: 1 }, { type: 'server', id: 3 }];
    for (const name of INVESTIGATION_PROFILES.ops.toolAllowlist) tools.register({
      ...investigationToolContract(toolCatalog.get(name)!, scope, INVESTIGATION_PROFILES.ops.budget)!,
      readOnly: true, concurrencySafe: false, exclusive: true, execute: async args => {
        const source = retained.history.find((m: any) => m.role === 'tool' && m.tool_call_id === currentCall);
        expect(source).toBeDefined();
        const value = JSON.parse(source.content); executed.push(currentCall);
        state.tools[currentCall] = { name, status: 'returned', inputHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'), result: value };
        return value;
      },
    });
    const capability = { model: 'deepseek-flash', contextWindowTokens: 1048576, maxOutputTokens: 393216, source: 'configuration' as const, version: 'retained-B11-capacity' };
    const actual = new OpenAIProvider({ apiKey: 'local-unused', model: capability.model, capabilities: capability, baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1` });
    const provider = { getDefaultModel: actual.getDefaultModel.bind(actual), getModelCapabilities: actual.getModelCapabilities.bind(actual), countPromptTokens: actual.countPromptTokens.bind(actual),
      projectMessages: (m: Message[]) => investigationContextMessages(actual.projectMessages(m), 'ops'), chat: actual.chat.bind(actual),
      chatStream: async (...args: Parameters<typeof actual.chatStream>) => { const r = await actual.chatStream(...args); if (String(args[0][0]?.content).startsWith('Summarize historical data,')) lastSummaryResponse = r; return r; } };
    const initialMessages = retained.initialMessages.filter((m: any) => !String(m.content).startsWith('Current Time:') && !String(m.content).startsWith('Execution budget:'));
    const result = await new AgentRunner(provider).run({ initialMessages, tools, hook: new NoopHook(), model: capability.model,
      ...resolveInvestigationRuntime(capability, { contextWindowTokens: 65536, maxTokens: 8192 }), maxIterations: 8, maxToolResultChars: 128000,
      concurrentTools: false, contextPolicy: { recentToolBatches: 1, evidenceReferences: 'canonical', summaryMaxTokens: 10240 },
      contextEvidence: (source, summary) => investigationExecutionEvidence(source, state, binding, initialMessages.length, summary),
      onToolEvent: e => { if (e.phase === 'running' && !e.progress) currentCall = e.toolCallId; },
      budgetLimits: { maxProviderAttempts: 8, maxToolCalls: 20, maxTotalTokens: 128000, maxNoProgressSteps: 8 },
      checkpointCallback: async c => {
        checkpoints.push(structuredClone(c));
        if ((c.context_request_v1 as any)?.status === 'accepted') state.lastSummaryReceipt = { ...(c.context_request_v1 as any), response: lastSummaryResponse };
      },
    });
    const dir = process.env.OPS_CURRENT_EVIDENCE_DIR;
    if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(dir + '/b11-local-sdk.json', JSON.stringify({ bodies, checkpoints, executed, coverage, result }, null, 2)); }
    expect(result.stopReason).toBe('completed'); expect(step).toBe(6); expect(summaryStep).toBe(2); expect(bodies).toHaveLength(8);
    expect(executed).toHaveLength(20); expect(cited).toBeDefined(); expect(coverage.every(r => r.valuesProvided || r.reason === 'INPUT_BUDGET')).toBe(true);
    const evidence = executed.map((id, i) => ({ id: String(i), metadata_json: { source: 'tool:' + id } }));
    expect(modelAnalysis(result.finalContent!, evidence)?.claims).toHaveLength(1);
    expect(modelAnalysis(result.finalContent!.replace(cited!, 'unknown-call'), evidence)).toBeNull();
    for (const body of bodies) for (const m of body.messages) for (const call of m.tool_calls ?? [])
      expect(body.messages.filter((r: any) => r.tool_call_id === call.id)).toHaveLength(1);
  } finally { await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())); }
}, 30000);
