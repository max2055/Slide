import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook, OpenAIProvider, ToolRegistry, currentTime, responseHash, type Message } from '@slide/agent-core';
import { boundedInvestigationArguments, investigationContextMessages, investigationExecutionEvidence, investigationToolContextResult } from './executor.js';
import { investigationToolContract, investigationToolPolicy } from './tool-contract.js';
import { toolCatalog } from '../tools/catalog.js';
import '../tools/ops/index.js';
import '../tools/generated/slide-self-mgmt/resource_tools.js';
import '../tools/generated/slide-self-mgmt/server_tools.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ops-temporal-b17-20261023.json', import.meta.url), 'utf8'));
const originals = fixture.originals;
const prefix = '01a1672b-f1d5-700c-bcc0-720a9e3ff7fb';
const facts = originals['durable-agent_canonical_facts.json'].map((r: any) => r.entry_json);
const scope = [{ type: 'instance', id: 1 }, { type: 'server', id: 3 }];
const budget = { maxBytes: 128000, maxRows: 200, maxWindowMs: 3600000 };
const now = Date.parse('2026-10-23T05:22:52.245Z');
const base = { resourceType: 'instance', resourceId: 1, mode: 'history', metric_ids: ['mysql.connections.limit'] };
const historyCalls = originals[`response-${prefix}_2.json`].toolCalls.filter((c: any) => c.arguments.mode === 'history');
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

function assertTimeContract(text: string) {
  expect(text).toContain('to(exclusive) <= latest Current Time ISO instant');
  expect(text).toContain('from = to - requested duration');
  expect(text).toContain('Never round up');
  expect(text).toContain('omit both');
}

describe('history time contract and unchanged execution guard', () => {
  it('advertises the current cutoff and exact requested duration in the real tool schema', () => {
    assertTimeContract(investigationToolContract(toolCatalog.get('query_metrics')!, scope, budget)!.description);
  });
  it.each([false, true])('routes direct read guidance to the advertised time contract (selected=%s)', selected => {
    const receipt = { success: true, data: { resource: { type: 'server', id: 3 }, observations: [{ resource: { type: 'server', id: 3 }, metricId: 'host.memory.used_bytes', value: null }] } };
    const args = { resourceType: 'server', resourceId: 3, ...(selected ? { metricIds: ['host.memory.used_bytes'] } : {}) };
    const projected = JSON.parse(investigationToolContextResult(receipt, 'local-page', 'ops', 'get_resource_observations', args) as string);
    expect(projected.data.metricRead.instructions).toContain('Follow query_metrics history time contract.');
    assertTimeContract(investigationToolContract(toolCatalog.get(projected.data.metricRead.discover.tool)!, scope, budget)!.description);
    expect(projected.data.observations).toEqual(receipt.data.observations);
    expect(projected.data.contextReference.sha256).toBe(responseHash(receipt));
  });
  it('labels the existing ISO clock as UTC independently of the display timezone', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'Asia/Shanghai' } as any);
    try { expect(currentTime(new Date(now))).toBe('Current Time: 2026-10-23T05:22:52.245Z (UTC; local timezone: Asia/Shanghai)'); }
    finally { vi.restoreAllMocks(); }
  });
  it('retains all twelve B17 canonical facts, both original wires/responses/usages and the formal partial result', () => {
    expect(facts).toHaveLength(12);
    expect(facts.filter((m: any) => m.role === 'tool')).toHaveLength(10);
    expect(historyCalls).toHaveLength(5);
    for (const i of [1, 2]) {
      expect(originals[`response-${prefix}_${i}.json`].usage.prompt_tokens).toBeGreaterThan(0);
      expect(originals[`wire-${prefix}_${i}.json`].messages.filter((m: any) => String(m.content).startsWith('Current Time:'))).toHaveLength(1);
    }
    expect(originals['durable-agent_runs.json'][0].result_json.resolution).toMatchObject({ kind: 'partial', reasonCode: 'INVESTIGATION_TOOL_WINDOW_LIMIT' });
  });
  it('keeps all five original future requests rejected without calling a handler or changing their arguments', () => {
    const handler = vi.fn(), before = structuredClone(historyCalls);
    for (const call of historyCalls) {
      expect(() => { const args = boundedInvestigationArguments(call.name, call.arguments, budget, now); handler(args); }).toThrow('INVESTIGATION_TOOL_WINDOW_LIMIT');
      const to = new Date(now).toISOString();
      const legal = { ...call.arguments, to, from: new Date(now - 6 * 60000).toISOString() };
      expect(boundedInvestigationArguments(call.name, legal, budget, now).args).toEqual(legal);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(historyCalls).toEqual(before);
  });
  it.each([
    '2026-10-23T05:22:52.244Z', '2026-10-23T05:22:52.245Z',
    '2026-10-23T13:22:52.245+08:00', '2026-10-23T00:22:52.245-05:00',
    '2026-10-23T05:22:00Z', '2026-10-23T05:00:00Z', '2026-10-23T00:00:00Z',
  ])('compares ISO instants at past/equal minute/hour/day/zone boundaries: %s', to => {
    const args = { ...base, to, from: new Date(Date.parse(to) - 6 * 60000).toISOString() };
    expect(boundedInvestigationArguments('query_metrics', args, budget, now).args).toEqual(args);
  });
  it.each([
    { to: '2026-10-23T05:22:52.246Z' }, { to: '2026-10-23T05:23:00Z' },
    { to: '2026-10-23T06:00:00Z' }, { to: '2026-10-24T00:00:00Z' },
    { to: '2026-10-23T13:22:52.246+08:00' }, { to: 'invalid' },
    { from: 'invalid' }, { from: '2026-10-23T05:22:53Z' },
    { from: '2026-10-23T04:00:00Z' }, { since: '2026-10-23T05:20:00Z' },
  ])('rejects future/reversed/invalid/oversized/ambiguous windows: %j', change => {
    const args = { ...base, from: '2026-10-23T05:16:52.245Z', ...change };
    expect(() => boundedInvestigationArguments('query_metrics', args, budget, now)).toThrow('INVESTIGATION_TOOL_WINDOW_LIMIT');
  });
  it('preserves existing defaults without pretending they mean the requested six minutes', () => {
    expect(boundedInvestigationArguments('query_metrics', base, budget, now).args).toMatchObject({ from: '2026-10-23T04:22:52.245Z', to: '2026-10-23T05:22:52.245Z' });
    const fromOnly = { ...base, from: '2026-10-23T05:16:52.245Z' };
    expect(boundedInvestigationArguments('query_metrics', fromOnly, budget, now).args).toEqual(fromOnly);
    expect(() => boundedInvestigationArguments('query_metrics', { ...base, to: new Date(now).toISOString() }, budget, now)).toThrow('INVESTIGATION_TOOL_WINDOW_LIMIT');
  });
});

// Full retained B17 prefix, then an explicitly scripted local continuation.
// B17 itself never sent these extra requests and never produced a summary/final.
it.each([false, true])('sends the complete B17 projection through local HTTP SDK with refreshed time (summary=%s)', async compact => {
  const execution = structuredClone(originals['durable-agent_runs.json'][0].result_json.investigationExecution);
  const binding = { runId: originals['durable-agent_runs.json'][0].id, requestId: execution.requestId, jobId: execution.jobId, fencingToken: execution.fencingToken };
  const first = originals[`wire-${prefix}_1.json`];
  const initial = first.messages.filter((m: any) => !String(m.content).startsWith('Current Time:') && !String(m.content).startsWith('Execution budget:'));
  initial[0] = { ...initial[0], content: initial[0].content.replace(/\nAll tools \(runtime enforced\):[^\n]+/, investigationToolPolicy(scope, budget)) };
  const raw = structuredClone([...initial, ...facts]);
  const originalsHash = sha(facts);
  const bodies: any[] = [], responses: any[] = [], checkpoints: any[] = [], traces: any[] = [], dispatched: any[] = [];
  const summary = { goal: ['B17 local transport verification'], constraints: ['read only'], done: ['five receipts and five refusals'], pending: ['numeric history and diagnosis'], evidence: [], uncertain: ['no original final answer'] };
  let ordinary = 0, summaries = 0, lastSummaryResponse: any;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    const isSummary = body.messages[0].content.startsWith('Summarize historical data,');
    if (isSummary) summaries++; else ordinary++;
    const message = { role: 'assistant', content: isSummary ? JSON.stringify(summary) : 'Local scripted transport only; B17 remains partial, with no numeric history or diagnosis.' };
    const response = { choices: [{ index: 0, message, delta: message, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } };
    responses.push(response); vi.setSystemTime(Date.now() + 1234);
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    res.end(body.stream ? 'data: ' + JSON.stringify(response) + '\n\ndata: [DONE]\n\n' : JSON.stringify(response));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const actual = new OpenAIProvider({ apiKey: 'local-unused', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    capabilities: { model: 'deepseek-flash', contextWindowTokens: 1048576, maxOutputTokens: 393216, source: 'configuration', version: 'B17-local-retained' } });
  const provider = { getDefaultModel: actual.getDefaultModel.bind(actual), getModelCapabilities: actual.getModelCapabilities.bind(actual), countPromptTokens: actual.countPromptTokens.bind(actual),
    projectMessages: (m: Message[]) => investigationContextMessages(actual.projectMessages(m), 'ops'),
    chat: async (...args: Parameters<typeof actual.chat>) => { dispatched.push(structuredClone({ messages: args[0], tools: args[1], maxTokens: args[2]?.maxTokens })); return actual.chat(...args); },
    chatStream: async (...args: Parameters<typeof actual.chatStream>) => { dispatched.push(structuredClone({ messages: args[0], tools: args[1], maxTokens: args[3]?.maxTokens })); const r = await actual.chatStream(...args); if (String(args[0][0]?.content).startsWith('Summarize historical data,')) lastSummaryResponse = r; return r; } };
  const tools = new ToolRegistry(), execute = vi.fn(async () => { throw Error('No tool execution in retained continuation'); });
  for (const t of first.tools) tools.register({ ...investigationToolContract(toolCatalog.get(t.function.name)!, scope, budget)!, readOnly: true, concurrencySafe: false, exclusive: true, execute });
  const core = new URL('../../../../packages/agent-core/src/', import.meta.url);
  const { ContextManager } = await import(new URL('runtime/context-manager.js', core).href);
  const { RecoveryPolicy } = await import(new URL('runtime/recovery-policy.js', core).href);
  // Synthetic continuation keeps the two original attempts, ten tools and all
  // measured usage spent. It does not reopen the terminal product investigation.
  const recovery = new RecoveryPolicy();
  Object.assign(recovery.state, { modelSteps: 2, providerAttempts: 2, toolCalls: 10,
    usage: { prompt_tokens: execution.usage.inputTokens, completion_tokens: execution.usage.outputTokens, cached_tokens: execution.usage.cachedInputTokens } });
  const originalAssert = ContextManager.prototype.assertFits;
  const spy = vi.spyOn(ContextManager.prototype, 'assertFits').mockImplementation(function(this: any, messages: any, limit: any, definitions: any) {
    traces.push({ input: this.tokens(messages, definitions), limit: limit ?? this.inputBudget, maxTokens: this.spec.maxTokens, messages, definitions: definitions ?? this.spec.tools.getDefinitions() });
    return originalAssert.call(this, messages, limit, definitions);
  });
  try {
    const result = await new AgentRunner(provider).run({ initialMessages: raw, runtimeRunId: binding.runId, tools, hook: new NoopHook(), model: 'deepseek-flash',
      contextWindowTokens: 65536, maxTokens: 8192, maxIterations: 8, maxToolResultChars: 128000,
      contextPolicy: { recentToolBatches: 1, evidenceReferences: 'canonical', summaryMaxTokens: 10240, ...(compact ? { watermark: 0.2, target: 0.1 } : {}) },
      contextEvidence: (s, summaryRecord) => investigationExecutionEvidence(s, execution, binding, initial.length, summaryRecord),
      budgetLimits: { maxProviderAttempts: 8, maxToolCalls: 20, maxTotalTokens: 128000, maxNoProgressSteps: 8 },
      resumeCheckpoint: { runtime_state_v1: recovery.snapshot() },
      checkpointCallback: async c => { checkpoints.push(structuredClone(c)); if ((c.context_request_v1 as any)?.status === 'accepted') execution.lastSummaryReceipt = { ...(c.context_request_v1 as any), response: lastSummaryResponse }; },
    });
    const dir = process.env.OPS_TEMPORAL_EVIDENCE_DIR;
    if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/b17-local-sdk-${compact}.json`, JSON.stringify({ bodies, responses, dispatched, checkpoints, traces, result, originalsHash }, null, 2)); }
    expect(result.stopReason).toBe('completed'); expect(execute).not.toHaveBeenCalled();
    expect(ordinary).toBe(1); expect(summaries).toBe(compact ? 1 : 0);
    const request = bodies.at(-1), definition = request.tools.find((t: any) => t.function.name === 'query_metrics');
    assertTimeContract(definition.function.description);
    for (const [i, body] of bodies.entries()) {
      // Deep compare every transport message/schema, including reasoning and
      // effective extras, against the admitted production adapter input.
      const messages = dispatched[i].messages.map((m: any) => ({ role: m.role,
        content: m.role === 'assistant' ? (typeof m.content === 'string' ? m.content : null) : m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.role === 'tool' ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.role === 'assistant' && m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}), ...m._extra }));
      expect(body.messages).toEqual(messages);
      expect(body.tools ?? []).toEqual(dispatched[i].tools.map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })));
      expect(body.max_tokens).toBe(dispatched[i].maxTokens);
      const clocks = body.messages.filter((m: any) => String(m.content).startsWith('Current Time:'));
      expect(clocks).toHaveLength(1);
      expect(clocks[0].content).toContain(new Date(now + i * 1234).toISOString());
      expect(clocks[0].content).toContain('(UTC; local timezone:');
      for (const m of body.messages) for (const c of m.tool_calls ?? []) expect(body.messages.filter((r: any) => r.tool_call_id === c.id)).toHaveLength(1);
    }
    expect(traces.length).toBeGreaterThan(0); expect(traces.every(t => t.input <= t.limit)).toBe(true);
    expect(sha(facts)).toBe(originalsHash);
    expect(result.messages.slice(initial.length, initial.length + facts.length)).toEqual(facts);
    expect(result.runtimeState).toMatchObject({ unknownRequests: 0, reservedTokens: 0 });
    expect(result.runtimeState!.providerAttempts).toBe(2 + bodies.length);
    expect(result.runtimeState!.toolCalls).toBe(10);
    if (compact) expect(checkpoints.some(c => c.context_summary_v1?.summary.goal[0] === summary.goal[0])).toBe(true);
  } finally { spy.mockRestore(); vi.useRealTimers(); await new Promise<void>(r => server.close(() => r())); }
}, 30000);
