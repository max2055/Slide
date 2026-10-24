import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentRunner, NoopHook, OpenAIProvider, ToolRegistry, responseHash, type Message } from '@slide/agent-core';
import { investigationContextMessages, investigationExecutionEvidence, investigationToolContextResult, boundedInvestigationArguments } from './executor.js';
import { createQueryMetricsTool } from '../tools/ops/query_metrics.js';
import { MetricConsumerService } from '../metrics/consumers/service.js';
import { createConfigurationRegistry } from '../metrics/config/registry.js';
import { PolicyService } from '../metrics/policy/service.js';
import { MemoryPolicyStore, admin } from '../metrics/policy/test-support.js';
import { investigationToolContract } from './tool-contract.js';
import { modelAnalysis } from './model-analysis.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ops-filesystem-20261024.json', import.meta.url), 'utf8'));
const original = JSON.parse(fixture.originalToolMessage.content);
const originalArgs = JSON.parse(fixture.originalToolCall.function.arguments);
const callId = fixture.originalToolCall.id;
const project = (raw: any, id = callId, args = originalArgs) => JSON.parse(String(investigationToolContextResult(raw, id, 'ops', 'query_metrics', args)));
const key = (d: object) => JSON.stringify(Object.entries(d).sort(([a], [b]) => a.localeCompare(b)));
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const { ContextManager } = await import(new URL('../../../../packages/agent-core/src/runtime/context-manager.js', import.meta.url).href);

// Real normalized points are queried through the production semantic service.
// The store and policy persistence are in-memory adapters, not the live storage.
async function reader(missingMetric?: string) {
  const registry = createConfigurationRegistry(), store = new MemoryPolicyStore();
  const now = original.data.window.to, points = fixture.normalizedPoints.filter((p: any) => p.metric.id !== missingMetric);
  const policy = new PolicyService(store, registry, { exists: async () => true,
    inventory: async () => ({ type: 'server', id: '3', attributes: {} }) }, () => now);
  const release = registry.list().find(r => r.package.id === 'linux-host' && r.package.version === '1.1.0')!.package;
  await policy.changeBinding(admin, { type: 'server', id: 3 }, { expected_revision: 0,
    package: { id: release.id, version: release.version, digest: release.digest } }, true);
  const service = new MetricConsumerService(policy, registry, {
    dimensions: async (_r, d) => {
      const dimensions = [...new Map(points.filter((p: any) => p.metric.id === d.id).map((p: any) => [key(p.dimensions), p.dimensions])).values()] as Record<string, string>[];
      return d.id.endsWith('used_bytes') ? dimensions.reverse() : dimensions;
    },
    queryWindow: async s => points.filter((p: any) => p.metric.id === s.metric.id && key(p.dimensions) === key(s.dimensions)),
    inventory: async () => null, attempts: async () => [],
  }, () => now);
  return createQueryMetricsTool(service, () => now);
}

describe('MAX222 retained FS receipt and bounded numerical model view', () => {
  it('keeps all 11 original series with exact values, dimensions, timestamps and receipt identity', () => {
    expect(responseHash(original)).toBe(fixture.provenance.rawReceiptHash);
    expect(Buffer.byteLength(JSON.stringify(original))).toBe(15331);
    const before = JSON.stringify(original), view = project(original);
    expect(view.data.evidenceOmitted).not.toBe(true);
    expect(view.data.metrics).toEqual(original.data.metrics);
    expect(view.data.metrics[0].series).toHaveLength(11);
    expect(view.data.contextReference.sha256).toBe(responseHash(original));
    expect(view.data.contextProjection).toBe('metric_series_v1');
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(16384);
    expect(JSON.stringify(original)).toBe(before);
    expect(project(view)).toEqual(view);
  });

  it('provides an exact dimension directory and executable narrow read when the full page is too large', async () => {
    const large = structuredClone(original);
    large.data.metrics[0].series[0].buckets[0].extra = 'x'.repeat(20000);
    const view = project(large);
    expect(view.data.evidenceOmitted).toBe(true);
    expect(view.data.seriesSelection.total_series).toBe(11);
    expect(view.data.seriesSelection.entries).toEqual(original.data.metrics[0].series.map((s: any, series_index: number) => ({ series_index, dimensions: s.dimensions })));
    const args = view.data.seriesSelection.read.arguments;
    expect(args).toMatchObject({ ...originalArgs, mode: 'history', series_index: 0, from: original.data.window.from, to: original.data.window.to });
    const tool = await reader();
    const bounded = boundedInvestigationArguments('query_metrics', args, { maxBytes: 128000, maxRows: 200, maxWindowMs: 3600000 }, Date.parse(original.data.window.to));
    const receipt: any = await tool.handler(bounded.args, { actor: admin });
    expect(receipt.success).toBe(true);
    expect(receipt.data.selection).toMatchObject({ series_index: 0, total_series: 11 });
    expect(receipt.data.metrics[0].series).toHaveLength(1);
    expect(project(receipt, 'narrowed', args).data.evidenceOmitted).not.toBe(true);
  });

  it.each(['zero', 'null', 'missing value', 'missing series', 'duplicate dimensions', 'failure'] as const)('preserves %s without merging, filling or upgrading evidence', kind => {
    const raw = structuredClone(original), metric = raw.data.metrics[0];
    if (kind === 'zero') metric.series[0].buckets[0].value.value = '0';
    if (kind === 'null') { metric.series[0].buckets[0].value = null; metric.series[0].buckets[0].quality = { status: 'unknown', reason: 'missing_input' }; }
    if (kind === 'missing value') delete metric.series[0].buckets[0].value;
    if (kind === 'missing series') metric.series.splice(2, 1);
    if (kind === 'duplicate dimensions') metric.series[1].dimensions = structuredClone(metric.series[0].dimensions);
    if (kind === 'failure') { metric.state = 'temporary_failure'; metric.attempt = { status: 'failed', error: 'parse_error' }; }
    const before = JSON.stringify(raw), view = project(raw);
    expect(view.data.metrics).toEqual(raw.data.metrics);
    expect(view.data.evidenceOmitted).not.toBe(true);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('rejects unbounded pages, preserves single-series behavior and never strips a denial', () => {
    for (const dimension of ['series', 'buckets', 'bytes']) {
      const raw = structuredClone(original), metric = raw.data.metrics[0];
      if (dimension === 'series') metric.series = Array(17).fill(metric.series[0]);
      if (dimension === 'buckets') metric.series.forEach((s: any) => s.buckets = Array(6).fill(s.buckets[0]));
      if (dimension === 'bytes') metric.extra = 'x'.repeat(17000);
      expect(project(raw).data.evidenceOmitted).toBe(true);
    }
    const single = structuredClone(original); single.data.metrics[0].series = single.data.metrics[0].series.slice(0, 1);
    expect(project(single).data.contextProjection).toBe('single_metric_v1');
    const denied = { ...original, policyDecision: { allow: false, reasonCode: 'DENIED' } };
    expect(investigationToolContextResult(denied, callId, 'ops', 'query_metrics')).toBe(denied);
  });

  it.each(['host.filesystem.used_bytes', 'host.filesystem.size_bytes'])('does not invent a peer when %s is absent', async missing => {
    const tool = await reader(missing);
    const receipt: any = await tool.handler({ ...originalArgs, metric_ids: [missing] }, { actor: admin });
    expect(receipt.success).toBe(true);
    expect(receipt.status).toBe('warning');
    expect(project(receipt).data.metrics[0].series).toEqual([]);
    const forbidden: any = await tool.handler(originalArgs, { actor: { ...admin, permissions: [], instanceScopes: {} } });
    expect(forbidden.success).toBe(false);
  });

  it('reads used and size through legal handlers, pairs by full dimensions rather than order, and admits both originals for final', async () => {
    const tool = await reader(), binding = { runId: 'local-run', requestId: 'local-request', jobId: 'local-job', fencingToken: 7 };
    const state: any = { schemaVersion: 1, ...binding, tools: {} };
    const messages: Message[] = [{ role: 'system', content: 'Read only; null is unknown. Pair mount/device/fs_type and time/unit; duplicate or missing peers are gaps.' },
      { role: 'user', content: '分析文件系统已用与容量，保留每个挂载的维度、时间与证据引用。' }];
    for (const [i, id] of ['host.filesystem.size_bytes', 'host.filesystem.used_bytes'].entries()) {
      const args = { ...originalArgs, mode: 'history', metric_ids: [id], from: original.data.window.from, to: original.data.window.to, interval: '1m' };
      const bounded = boundedInvestigationArguments('query_metrics', args, { maxBytes: 128000, maxRows: 200, maxWindowMs: 3600000 }, Date.parse(original.data.window.to));
      const receipt: any = await tool.handler(bounded.args, { actor: admin });
      expect(receipt.success).toBe(true);
      messages.push({ role: 'assistant', content: null, runId: binding.runId, tool_calls: [{ id: `local-${i}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(bounded.args) } }] },
        { role: 'tool', name: tool.name, runId: binding.runId, tool_call_id: `local-${i}`, content: JSON.stringify(receipt) });
      state.tools[`local-${i}`] = { name: tool.name, status: 'returned', inputHash: sha(bounded.args), result: receipt };
    }
    const evidence = investigationExecutionEvidence(messages, state, binding);
    expect(evidence.receipts).toHaveLength(2);
    const views = evidence.receipts.map(r => JSON.parse(r.content));
    expect(views.every(v => !v.data.evidenceOmitted)).toBe(true);
    const [sizes, used] = views.map(v => v.data.metrics[0].series);
    expect(sizes).toHaveLength(11); expect(used).toHaveLength(11);
    for (const s of sizes) {
      const peers = used.filter((u: any) => key(u.dimensions) === key(s.dimensions));
      expect(peers).toHaveLength(1);
      expect(peers[0].buckets[0].observed_at).toBe(s.buckets[0].observed_at);
      expect(peers[0].buckets[0].unit).toBe(s.buckets[0].unit);
      expect(peers[0].buckets[0].value).not.toBeNull();
      expect(s.buckets[0].sources[0].id).toMatch(/^sha256:/);
    }
    const actual = new OpenAIProvider({ apiKey: 'offline-unused', model: 'deepseek-flash' });
    const provider = { projectMessages: (m: Message[]) => investigationContextMessages(actual.projectMessages(m), 'ops'),
      getModelCapabilities: actual.getModelCapabilities.bind(actual), countPromptTokens: actual.countPromptTokens.bind(actual) };
    const manager = new ContextManager({ initialMessages: messages, model: 'deepseek-flash', tools: new ToolRegistry(), hook: new NoopHook(),
      maxIterations: 8, maxTokens: 8192, contextWindowTokens: 65536, maxToolResultChars: 128000 }, provider);
    const suffix: Message[] = [{ role: 'user', content: 'No tools remain. Produce final using only these exact receipts; preserve gaps.' }];
    const final = [...manager.project(messages), ...suffix];
    manager.assertFits(final);
    const wire = provider.projectMessages(final);
    const numeric = wire.filter(m => m.role === 'tool').map(m => JSON.parse(String(m.content)));
    expect(numeric.map(v => v.data.metrics[0].definition.id)).toEqual(['host.filesystem.size_bytes', 'host.filesystem.used_bytes']);
    expect(numeric.every(v => v.data.metrics[0].series.length === 11 && !v.data.evidenceOmitted)).toBe(true);
    expect(project(original).data.metricRead.pairedRead.arguments).toMatchObject({ metric_ids: ['host.filesystem.used_bytes'], from: original.data.window.from, to: original.data.window.to });
    expect(investigationExecutionEvidence(messages, { ...state, fencingToken: 8 }, binding).receipts).toHaveLength(0);
    state.tools['local-0'].inputHash = 'bad';
    expect(investigationExecutionEvidence(messages, state, binding).receipts).toHaveLength(1);
  });

  it('carries every paired value over the real SDK final wire when the tool budget is exhausted (scripted loopback only)', async () => {
    const tool = await reader(), bodies: any[] = [], returned: any[] = [], checkpoints: any[] = [];
    const requests = [originalArgs, project(original).data.metricRead.pairedRead.arguments];
    const finalContent = JSON.stringify({ analysisVersion: 1, summary: '离线脚本仅验证数值及引用到达终答，不代表真实模型分析。',
      claims: [{ statement: '本地回放获得文件系统成对原始回执，健康与根因未确认。', supportingToolCallIds: ['local-size', 'local-used'], contradictingToolCallIds: [] }],
      hypotheses: [], unresolvedQuestions: ['真实模型是否自主完成完整FS分析尚未验证。'], recommendations: [] });
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
      const message = bodies.length === 1 ? { role: 'assistant', content: null, reasoning_content: 'Offline scripted selection; no model inference.',
        tool_calls: requests.map((args, i) => ({ id: i ? 'local-used' : 'local-size', type: 'function', function: { name: 'query_metrics', arguments: JSON.stringify(args) } })) }
        : { role: 'assistant', content: finalContent };
      const value = { choices: [{ index: 0, message, delta: message, finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 100 } }; // Synthetic test usage, never ledger evidence.
      res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
      res.end(body.stream ? 'data: ' + JSON.stringify(value) + '\n\ndata: [DONE]\n\n' : JSON.stringify(value));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const actual = new OpenAIProvider({ apiKey: 'offline-unused', model: 'deepseek-flash',
        baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1`, capabilities: {
          model: 'deepseek-flash', contextWindowTokens: 1048576, maxOutputTokens: 393216, source: 'configuration', version: 'offline-retained' } });
      const provider = { getDefaultModel: actual.getDefaultModel.bind(actual), getModelCapabilities: actual.getModelCapabilities.bind(actual),
        countPromptTokens: actual.countPromptTokens.bind(actual), projectMessages: (m: Message[]) => investigationContextMessages(actual.projectMessages(m), 'ops'),
        chat: actual.chat.bind(actual), chatStream: actual.chatStream.bind(actual) };
      const tools = new ToolRegistry();
      tools.register({ ...investigationToolContract(tool as any, [{ type: 'server', id: 3 }], { maxRows: 200, maxWindowMs: 3600000 })!,
        readOnly: true, concurrencySafe: false, exclusive: true, execute: async args => {
          const bounded = boundedInvestigationArguments(tool.name, args, { maxRows: 200, maxBytes: 128000, maxWindowMs: 3600000 }, Date.parse(original.data.window.to));
          const result: any = await tool.handler(bounded.args, { actor: admin });
          expect(result.success).toBe(true); returned.push(result); return result;
        } });
      const result = await new AgentRunner(provider).run({ initialMessages: [{ role: 'system', content: 'Read only; missing and null remain unknown.' },
        { role: 'user', content: '核对所有文件系统的已用与容量。' }], tools, hook: new NoopHook(), model: 'deepseek-flash',
        contextWindowTokens: 65536, maxTokens: 8192, maxIterations: 8, maxToolResultChars: 128000, concurrentTools: false,
        budgetLimits: { maxProviderAttempts: 8, maxToolCalls: 2, maxTotalTokens: 128000, maxNoProgressSteps: 8 },
        checkpointCallback: async c => { checkpoints.push(structuredClone(c)); } });
      expect(result.stopReason).toBe('completed');
      expect(bodies).toHaveLength(2); expect(returned).toHaveLength(2);
      expect(bodies[1].tools ?? []).toEqual([]);
      expect(bodies[1].max_tokens).toBe(8192);
      const receipts = bodies[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => ({ id: m.tool_call_id, receipt: JSON.parse(m.content) }));
      expect(receipts.map((r: any) => r.id)).toEqual(['local-size', 'local-used']);
      expect(receipts.map((r: any) => r.receipt.data.metrics[0].series.length)).toEqual([11, 11]);
      receipts.forEach((r: any, i: number) => expect(r.receipt.data.metrics).toEqual(returned[i].data.metrics));
      expect(bodies[1].messages.some((m: any) => m.reasoning_content === 'Offline scripted selection; no model inference.')).toBe(true);
      for (const body of bodies) for (const m of body.messages) for (const c of m.tool_calls ?? [])
        expect(body.messages.filter((r: any) => r.tool_call_id === c.id)).toHaveLength(1);
      expect(modelAnalysis(result.finalContent!, receipts.map((r: any) => ({ id: r.id, metadata_json: { source: 'tool:' + r.id } })))?.claims).toHaveLength(1);
      expect(result.runtimeState).toMatchObject({ providerAttempts: 2, toolCalls: 2, unknownRequests: 0, reservedTokens: 0 });
      if (process.env.OPS_FS_EVIDENCE_DIR) {
        mkdirSync(process.env.OPS_FS_EVIDENCE_DIR, { recursive: true });
        writeFileSync(process.env.OPS_FS_EVIDENCE_DIR + '/sdk-final-replay.json', JSON.stringify({ note: 'Loopback script; synthetic usage; no product model or SQL', bodies, returned, checkpoints, result }, null, 2));
      }
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  });
});
