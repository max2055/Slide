import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AgentRunner, NoopHook, OpenAIProvider, ToolRegistry, type Message } from '@slide/agent-core';
import { investigationContextMessages } from './executor.js';
import { investigationToolContract } from './tool-contract.js';
import { INVESTIGATION_PROFILES } from './profiles.js';
import { resolveInvestigationRuntime } from './runtime-configuration.js';
import { modelAnalysis } from './model-analysis.js';
import { toolCatalog } from '../tools/catalog.js';
import '../tools/ops/index.js';
import '../tools/generated/slide-self-mgmt/resource_tools.js';
import '../tools/generated/slide-self-mgmt/server_tools.js';

const retained = JSON.parse(readFileSync(new URL('./fixtures/ops-budget-b10-20261022.json', import.meta.url), 'utf8'));
const core = new URL('../../../../packages/agent-core/src/', import.meta.url);
const { ContextManager, sourceHash } = await import(new URL('runtime/context-manager.js', core).href);
const answer = { analysisVersion: 1, summary: '离线脚本终答：证据不完整，不能确认根因。', claims: [], hypotheses: [], unresolvedQuestions: ['尚缺同维度文件系统和网络有效观测。'], recommendations: [] };

// Only localhost receives these SDK requests. Choices and retained usage are
// scripted transport fixtures, never new product Provider calls or real analysis.
async function replay(mode: 'answer' | 'violate' | 'r4') {
  const bodies: any[] = [], executed: string[] = [], checkpoints: any[] = [], errors: unknown[] = [], dispatchBudgets: any[] = [];
  const ordinary = retained.responses.filter((r: any) => r.toolCalls.length);
  const summaries = retained.responses.filter((r: any) => !r.toolCalls.length);
  let ordinaryIndex = 0, summaryIndex = 0, usedTokens = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
      dispatchBudgets.push({ tokens: (mode === 'r4' ? 1000000 : 128000) - usedTokens, tools: 20 - executed.length });
      const isSummary = body.messages[0].content.startsWith('Summarize historical data,');
      let response: any;
      if (isSummary) response = summaries[summaryIndex++ % summaries.length];
      else {
        const final = !body.tools?.length || (mode === 'r4' && ordinaryIndex === 5);
        response = final && mode !== 'violate'
          ? { content: JSON.stringify(answer), toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 10 } }
          : ordinary[ordinaryIndex % ordinary.length];
        if (mode === 'r4' && !final) {
          response = { ...response, content: null, toolCalls: ordinary[2].toolCalls.slice(0, 2).map((call: any) => ({ ...call, id: call.id + '_r4_' + ordinaryIndex })) };
        }
        ordinaryIndex++;
      }
      const message = { role: 'assistant', content: response.content,
        ...response._extra,
        ...(response.toolCalls.length ? { tool_calls: response.toolCalls.map((c: any) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) };
      const value = { id: 'local', choices: [{ index: 0, message, delta: message, finish_reason: response.finishReason }], usage: response.usage };
      usedTokens += response.usage.prompt_tokens + response.usage.completion_tokens;
      res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
      res.end(body.stream ? 'data: ' + JSON.stringify(value) + '\n\ndata: [DONE]\n\n' : JSON.stringify(value));
    } catch (e) { errors.push(String(e)); res.statusCode = 500; res.end('{}'); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const tools = new ToolRegistry(), scope = [{ type: 'instance', id: 1 }, { type: 'server', id: 3 }];
    for (const name of INVESTIGATION_PROFILES.ops.toolAllowlist) {
      const contract = investigationToolContract(toolCatalog.get(name)!, scope, INVESTIGATION_PROFILES.ops.budget)!;
      tools.register({ ...contract, readOnly: true, concurrencySafe: false, exclusive: true, execute: async (_args) => {
        // Match the actual scripted call ID; the long-history case repeats a
        // retained read while keeping fresh identities for pairing assertions.
        const batch = mode === 'r4' ? ordinary[2] : ordinary[ordinaryIndex - 1];
        const call = batch.toolCalls.find((c: any) => c.name === name && JSON.stringify(c.arguments) === JSON.stringify(_args));
        expect(call).toBeDefined();
        const receipt = retained.tools.find((m: any) => m.tool_call_id === call.id);
        expect(receipt).toBeDefined(); executed.push(call.id);
        return JSON.parse(receipt.content);
      } });
    }
    const capability = { model: 'deepseek-flash', contextWindowTokens: 1048576, maxOutputTokens: 393216, source: 'configuration' as const, version: 'retained-B10-capacity' };
    const actual = new OpenAIProvider({ apiKey: 'offline-unused', model: capability.model, capabilities: capability, baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1` });
    const provider = { getDefaultModel: actual.getDefaultModel.bind(actual), getModelCapabilities: actual.getModelCapabilities.bind(actual), countPromptTokens: actual.countPromptTokens.bind(actual),
      projectMessages: (m: Message[]) => investigationContextMessages(actual.projectMessages(m), 'ops'), chat: actual.chat.bind(actual), chatStream: actual.chatStream.bind(actual) };
    const initialMessages: Message[] = structuredClone(retained.initialMessages);
    if (mode === 'r4') {
      const r4 = JSON.parse(readFileSync(new URL('./fixtures/ops-post-query-fix-20261022.json', import.meta.url), 'utf8'));
      initialMessages.push(...r4.users, ...r4.entries);
    }
    const original = structuredClone(initialMessages);
    const spec: any = { initialMessages, tools, model: capability.model, hook: new NoopHook(),
      ...resolveInvestigationRuntime(capability, { contextWindowTokens: 65536, maxTokens: 8192 }),
      maxIterations: mode === 'r4' ? 16 : 8, maxToolResultChars: 128000,
      contextPolicy: { recentToolBatches: 1, evidenceReferences: 'canonical', summaryMaxTokens: 10240 },
      budgetLimits: { maxProviderAttempts: mode === 'r4' ? 16 : 8, maxToolCalls: 20, maxTotalTokens: mode === 'r4' ? 1000000 : 128000, maxNoProgressSteps: 8 },
      checkpointCallback: async (c: any) => { checkpoints.push(structuredClone(c)); } };
    const result = await new AgentRunner(provider).run(spec);
    expect(errors).toEqual([]);
    expect(initialMessages).toEqual(original);
    for (const body of bodies) {
      const summary = body.messages[0].content.startsWith('Summarize historical data,');
      expect(body.max_tokens).toBe(summary ? 10240 : 8192);
      for (const m of body.messages.filter((m: any) => m.tool_calls)) for (const call of m.tool_calls)
        expect(body.messages.filter((r: any) => r.role === 'tool' && r.tool_call_id === call.id)).toHaveLength(1);
      if (!summary) {
        const hint = body.messages.find((m: any) => m.content?.startsWith('Execution budget:'))?.content;
        expect(hint).toContain('remainingProviderAttempts=' + (spec.budgetLimits.maxProviderAttempts - bodies.indexOf(body)));
        expect(hint).toContain('remainingToolCalls=' + dispatchBudgets[bodies.indexOf(body)].tools);
      }
    }
    for (const [index, body] of bodies.entries()) if (!body.messages[0].content.startsWith('Summarize historical data,')) {
      const hint = body.messages.find((m: any) => m.content?.startsWith('Execution budget:'))?.content;
      expect(hint).toContain('remainingTotalTokens=' + dispatchBudgets[index].tokens);
    }
    const final = checkpoints.at(-1), manager = new ContextManager(spec, provider);
    manager.summary = final.context_summary_v1;
    if (manager.summary) {
      expect(manager.summary.sourceHash).toBe(sourceHash(result.messages.slice(0, manager.summary.sourceEnd)));
      expect(JSON.stringify(result.messages)).not.toContain('Execution budget:');
      const restored = new ContextManager(spec, provider); restored.summary = structuredClone(manager.summary);
      expect(restored.project(result.messages)).toEqual(manager.project(result.messages));
    }
    const dir = process.env.OPS_BUDGET_EVIDENCE_DIR;
    if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, mode + '.json'), JSON.stringify({ mode, bodies, dispatchBudgets, executed, checkpoints, result }, null, 2)); }
    console.info('Local SDK budget replay', mode, { ordinaryIndex, summaryIndex, executed: executed.length, resolution: result.resolution });
    return { bodies, executed, result, checkpoints, ordinaryIndex, summaryIndex };
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}

it('replays the B10 five ordinary / three summary chain and makes the eighth request answer-only', async () => {
  const r = await replay('answer');
  expect(r.ordinaryIndex).toBe(5); expect(r.summaryIndex).toBe(3);
  expect(r.bodies).toHaveLength(8); expect(r.bodies.at(-1).tools ?? []).toEqual([]);
  expect(r.executed).toHaveLength(15);
  expect(r.result.stopReason).toBe('completed');
  expect(modelAnalysis(r.result.finalContent, [])).not.toBeNull();
});

it('rejects the original B10 final four-tool response without executing it or sending request nine', async () => {
  const r = await replay('violate');
  expect(r.ordinaryIndex).toBe(5); expect(r.summaryIndex).toBe(3);
  expect(r.bodies).toHaveLength(8); expect(r.executed).toHaveLength(15);
  expect(r.result.resolution).toMatchObject({ kind: 'partial', reasonCode: 'MAX_PROVIDER_ATTEMPTS' });
  expect(r.checkpoints.at(-1)).toMatchObject({ phase: 'rejected_tool_batch', pendingToolCalls: [], rejectedToolCalls: expect.any(Array) });
});

it('sends six ordinary SDK requests after complete r4 history with natural compaction and recoverable canonical sources', async () => {
  const r = await replay('r4');
  expect(r.ordinaryIndex).toBe(6); expect(r.summaryIndex).toBeGreaterThan(0);
  expect(r.result.stopReason).toBe('completed');
  expect(r.executed).toHaveLength(10);
});
