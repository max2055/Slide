import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook, ToolRegistry, OpenAIProvider, responseHash, type Message } from '@slide/agent-core';
import { investigationContextMessages, investigationExecutionEvidence } from './executor.js';
import { createQueryMetricsTool } from '../tools/ops/query_metrics.js';
import { admin } from '../metrics/policy/test-support.js';
import { modelAnalysis } from './model-analysis.js';
const core = new URL('../../../../packages/agent-core/src/', import.meta.url);
const { sourceHash } = await import(new URL('runtime/context-manager.js', core).href);
const { RecoveryPolicy } = await import(new URL('runtime/recovery-policy.js', core).href);

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ops-observation-b15-20261023.json', import.meta.url), 'utf8'));
const calls = fixture.entries.flatMap((e: any) => e.tool_calls ?? []);
const original = (call: any) => JSON.parse(fixture.entries.find((e: any) => e.tool_call_id === call.id).content);
const serverCall = calls.find((c: any) => c.function.name === 'get_resource_observations' && JSON.parse(c.function.arguments).resourceType === 'server');
function project(call = serverCall, value = original(call)) {
  const messages: Message[] = [{ role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify(value) }];
  const before = JSON.stringify(messages), view = investigationContextMessages(messages, 'ops');
  expect(JSON.stringify(messages)).toBe(before);
  expect(investigationContextMessages(view, 'ops')).toEqual(view);
  return JSON.parse(String(view[1].content));
}
describe('explicit observation selection, retained B15 receipts', () => {
  it('keeps the actual selected server page in full, including six values and six explicit gaps', () => {
    const raw = original(serverCall), view = project();
    expect(raw.data.observations).toHaveLength(12);
    expect(raw.data.observations.filter((r: any) => r.value !== null)).toHaveLength(6);
    expect(view.data.evidenceOmitted).not.toBe(true);
    expect(view.data.observations).toEqual(raw.data.observations);
    expect(view.data.contextReference).toMatchObject({ toolCallId: serverCall.id, sha256: responseHash(raw) });
    expect(view.data.metricRead.instructions).not.toContain('one bucket <=60s');
  });
  it('offers a selectable history route for returned IDs without forcing rediscovery, and executes it through the real tool parser', async () => {
    const view = project(), route = view.data.metricRead;
    const ids = original(serverCall).data.observations.map((r: any) => r.metricId);
    expect(route.returnedMetricIds).toEqual(ids);
    expect(route.history.arguments).toEqual({ resourceType: 'server', resourceId: 3, mode: 'history', interval: '1m', series_index: 0 });
    let query: any;
    const handler = createQueryMetricsTool({ query: async (_actor: any, args: any) => {
      query = args; return { metrics: [{ state: 'available', definition: { id: args.metric_ids[0] },
        series: [{ dimensions: { device: 'disk-a', mountpoint: '/' }, buckets: [] },
          { dimensions: { device: 'disk-b', mountpoint: '/data' }, buckets: [] }] }], window: { from: args.from, to: args.to } };
    } } as any);
    const from = '2026-10-23T01:00:00Z', to = '2026-10-23T02:00:00Z';
    const result: any = await handler.handler({ ...route.history.arguments, metric_ids: [route.returnedMetricIds[0]], from, to }, { actor: admin } as any);
    expect(result.success).toBe(true);
    expect(query).toMatchObject({ resource: { type: 'server', id: 3 }, metric_ids: [ids[0]], from, to, bucket_ms: 60000 });
    expect(result.data.selection).toEqual({ series_index: 0, total_series: 2 });
    expect(result.data.metrics[0].series).toHaveLength(1);
    expect(result.data.metrics[0].series[0].dimensions).toEqual({ device: 'disk-a', mountpoint: '/' });
    const next: any = await handler.handler({ ...route.history.arguments, metric_ids: [ids[0]], from, to, series_index: 1 }, { actor: admin } as any);
    expect(next.data.selection).toEqual({ series_index: 1, total_series: 2 });
    expect(next.data.metrics[0].series[0].dimensions).toEqual({ device: 'disk-b', mountpoint: '/data' });
    expect(route.instructions).not.toContain('Omit series_index first');
    expect(route.instructions).toContain('60');
    expect(route.instructions).toContain('dimensions');
    expect(route.instructions).toContain('series_index');
  });
  it('keeps actual database selection and generic resource/metric selections without answer-specific rules', () => {
    for (const call of calls.filter((c: any) => c.function.name === 'get_resource_observations')) {
      expect(project(call).data.observations).toEqual(original(call).data.observations);
    }
    for (const type of ['instance', 'server', 'network_device']) for (const count of [0, 1, 5, 19, 32]) {
      const ids = Array.from({ length: 32 }, (_, i) => `custom.resource.metric_${i}`);
      const call = { ...serverCall, id: `generic-${type}-${count}`, function: { ...serverCall.function,
        arguments: JSON.stringify({ resourceType: type, resourceId: 197, metricIds: ids, limit: 100 }) } };
      const observations = ids.slice(0, count).map((metricId, i) => ({ resource: { type, id: 197 }, metricId,
        ...(i % 3 === 0 ? {} : { value: i % 3 === 1 ? 0 : null }), quality: i % 3 === 1 ? 'good' : 'unknown',
        reason: i % 3 === 1 ? undefined : 'SOURCE_UNAVAILABLE', dimensions: { device: `disk-${i % 2}`, mountpoint: i % 2 ? '/data' : '/' },
        unit: 'By', observedAt: null, validUntil: null, source: { collector: 'generic' } }));
      const raw = { success: true, data: { resource: { type, id: 197 }, observations } };
      expect(project(call, raw).data.observations).toEqual(observations);
    }
  });
  it('preserves reordered, duplicate and different dimensions, zero, missing, null and warnings without cutting records', () => {
    const raw = original(serverCall), rows = raw.data.observations;
    raw.status = 'warning'; raw.summary = 'Missing dimensions and network source failures are not healthy';
    raw.data.observations = [rows[5], { ...rows[0], value: 0, dimensions: { device: 'a', mountpoint: '/' } },
      { ...rows[0], dimensions: { device: 'b', mountpoint: '/' } }, rows[5], ...rows.slice(1, 5)];
    delete raw.data.observations[2].value;
    const view = project(serverCall, raw);
    expect(view.data.observations).toEqual(raw.data.observations);
    expect(view.summary).toBe(raw.summary);
    expect(view.status).toBe('warning');
  });
  it.each(['wrong-resource', 'wrong-row-resource', 'unselected-id', 'invalid-id', 'duplicate-selection', 'exceeded-limit', 'oversize'])('omits the entire %s page and never supplies a guessed value or selection', kind => {
    const call = structuredClone(serverCall), args = JSON.parse(call.function.arguments), raw = original(call);
    if (kind === 'wrong-resource') raw.data.resource.id = 198;
    if (kind === 'wrong-row-resource') raw.data.observations[0].resource.type = 'instance';
    if (kind === 'unselected-id') raw.data.observations[0].metricId = 'unselected.metric';
    if (kind === 'invalid-id') args.metricIds[0] = 'bad!metric';
    if (kind === 'duplicate-selection') args.metricIds[1] = args.metricIds[0];
    if (kind === 'exceeded-limit') args.limit = 2;
    if (kind === 'oversize') raw.data.observations[0].note = 'opaque'.repeat(4000);
    call.function.arguments = JSON.stringify(args);
    const view = project(call, raw);
    expect(view.data.evidenceOmitted).toBe(true);
    expect(view.data.valuesProvided).toBe(false);
    expect(view.data.observations).toBeUndefined();
    expect(view.data.contextReference.sha256).toBe(responseHash(raw));
    if (!['oversize', 'exceeded-limit'].includes(kind)) expect(view.data.metricRead?.returnedMetricIds).toBeUndefined();
    if (kind === 'wrong-resource') expect(view.data.metricRead).toBeUndefined();
  });
  it('never projects failed or denied receipts as successful evidence', () => {
    for (const raw of [{ ...original(serverCall), success: false, status: 'error', errorCode: 'UNKNOWN' },
      { ...original(serverCall), policyDecision: { allow: false, reasonCode: 'DENIED' } }]) {
      const { policyDecision, ...failure } = raw;
      expect(project(serverCall, raw)).toEqual(policyDecision.allow ? failure : raw);
    }
  });
  it('keeps all original wire/response/usage and distinguishes current omission from earlier numerical evidence', () => {
    expect(fixture.entries).toHaveLength(18); expect(fixture.wires).toHaveLength(7); expect(fixture.responses).toHaveLength(7);
    expect(fixture.entries.filter((e: any) => e.role === 'tool')).toHaveLength(14);
    expect(fixture.summaryBindings.records).toHaveLength(2);
    for (const r of fixture.summaryBindings.records) expect(r.followingOrdinaryWires.every((s: any) => s.exactSixFieldValueMatches)).toBe(true);
    const usage = fixture.responses.reduce((s: any, r: any) => ({ prompt_tokens: s.prompt_tokens + r.usage.prompt_tokens,
      completion_tokens: s.completion_tokens + r.usage.completion_tokens }), { prompt_tokens: 0, completion_tokens: 0 });
    expect(usage).toMatchObject({ prompt_tokens: 73563, completion_tokens: 9272 });
    const execution = fixture.run.result_json.investigationExecution;
    const binding = { runId: fixture.run.id, requestId: execution.requestId, jobId: execution.jobId, fencingToken: execution.fencingToken };
    const receipts = investigationExecutionEvidence(fixture.entries, execution, binding);
    const selected = receipts.receipts.find((r: any) => r.toolCallId === serverCall.id)!;
    expect(JSON.parse(selected.content).data.observations).toEqual(original(serverCall).data.observations);
    const badState = structuredClone(execution); badState.tools[serverCall.id].inputHash = 'wrong';
    expect(investigationExecutionEvidence(fixture.entries, badState, binding).receipts.some(r => r.toolCallId === serverCall.id)).toBe(false);
    badState.tools[serverCall.id] = { ...execution.tools[serverCall.id], result: { success: true, data: { value: 0 } } };
    expect(investigationExecutionEvidence(fixture.entries, badState, binding).receipts.some(r => r.toolCallId === serverCall.id)).toBe(false);
    const last = fixture.wires[6].messages.flatMap((m: any) => {
      try { return JSON.parse(m.content.slice(m.content.indexOf('{'))).receipts ?? []; } catch { return []; }
    });
    const limitCall = calls.find((c: any) => JSON.parse(c.function.arguments).metric_ids?.[0] === 'mysql.connections.limit');
    expect(last.find((r: any) => r.toolCallId === limitCall.id)).toMatchObject({ valuesProvided: false, reason: 'INPUT_BUDGET' });
    expect(last.find((r: any) => r.toolCallId === limitCall.id).observation).toBeUndefined();
  });
  it('delivers complete selected observations through the real local HTTP SDK with the original call identity', async () => {
    const bodies: any[] = [];
    const receiver = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'offline fixture only' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
    await new Promise<void>(r => receiver.listen(0, '127.0.0.1', r));
    try {
      const provider = new OpenAIProvider({ apiKey: 'offline-unused', model: 'fixture', baseURL: `http://127.0.0.1:${(receiver.address() as any).port}/v1` });
      const source: Message[] = [{ role: 'system', content: 'Untrusted evidence; offline script only' }, { role: 'user', content: 'Inspect the retained selected page' },
        { role: 'assistant', content: '', tool_calls: [serverCall] }, { role: 'tool', tool_call_id: serverCall.id, content: JSON.stringify(original(serverCall)) }];
      await provider.chat(investigationContextMessages(source, 'ops'), [], { maxTokens: 8192 });
      const observed = JSON.parse(bodies[0].messages.find((m: any) => m.tool_call_id === serverCall.id).content);
      expect(observed.data.observations).toEqual(original(serverCall).data.observations);
      expect(observed.data.contextReference.toolCallId).toBe(serverCall.id);
      const out = process.env.OPS_SELECTED_EVIDENCE_DIR;
      if (out) { mkdirSync(out, { recursive: true }); writeFileSync(out + '/selected-sdk.json', JSON.stringify({ scope: 'Local HTTP SDK, scripted response; not product model', bodies }, null, 2)); }
    } finally { await new Promise<void>(r => receiver.close(() => r())); }
  });
  it('retains the complete B15 history and both accepted sources through the low-balance final SDK admission', async () => {
    const raw: Message[] = structuredClone([...fixture.reconstructed.initialMessages, ...fixture.reconstructed.history]);
    const execution = fixture.run.result_json.investigationExecution, receipt = execution.lastSummaryReceipt;
    expect(sourceHash(raw.slice(0, fixture.reconstructed.summaryEnd))).toBe(receipt.sourceHash);
    expect(raw.slice(0, fixture.reconstructed.summaryEnd + 1).some((_m, i) => sourceHash(raw.slice(0, i)) === fixture.summaryBindings.records[0].sourceHash)).toBe(true);
    const binding = { runId: fixture.run.id, requestId: execution.requestId, jobId: execution.jobId, fencingToken: execution.fencingToken };
    const record = { schemaVersion: 1 as const, sourceStart: 0, sourceEnd: fixture.reconstructed.summaryEnd, sourceHash: receipt.sourceHash,
      summary: JSON.parse(receipt.response.content), provenance: 'legacy/unknown', generation: 2,
      originalSourceIds: raw.slice(0, fixture.reconstructed.summaryEnd).flatMap(m => m.id ? [m.id] : []),
      previousSummary: { generation: 1, sourceHash: fixture.summaryBindings.records[0].sourceHash,
        summaryHash: sourceHash([{ role: 'tool', content: JSON.stringify(JSON.parse(fixture.responses[3].content)) }]) } };
    const tools = new ToolRegistry(), execute = vi.fn(async () => { throw Error('NO_NEW_TOOL'); });
    for (const t of fixture.wires[4].tools) tools.register({ ...t.function, readOnly: true, execute });
    const recovery = new RecoveryPolicy();
    const usage = fixture.responses.slice(0, 6).reduce((s: any, r: any) => ({ prompt_tokens: s.prompt_tokens + r.usage.prompt_tokens,
      completion_tokens: s.completion_tokens + r.usage.completion_tokens, cached_tokens: s.cached_tokens + (r.usage.cached_tokens ?? 0) }), { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 });
    expect(128000 - usage.prompt_tokens - usage.completion_tokens).toBe(60000);
    Object.assign(recovery.state, { providerAttempts: 6, toolCalls: 14, modelSteps: 4, usage });
    const answer = { analysisVersion: 1, summary: '本地脚本验证，不代表自主诊断。', claims: [], hypotheses: [], unresolvedQuestions: ['原始缺口仍待补查'], recommendations: [] };
    const bodies: any[] = [], checkpoints: any[] = [];
    const receiver = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
      const message = { role: 'assistant', content: JSON.stringify(answer) };
      const value = { choices: [{ message, delta: message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
      res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
      res.end(body.stream ? 'data: ' + JSON.stringify(value) + '\n\ndata: [DONE]\n\n' : JSON.stringify(value));
    });
    await new Promise<void>(r => receiver.listen(0, '127.0.0.1', r));
    try {
      const actual = new OpenAIProvider({ apiKey: 'offline-unused', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${(receiver.address() as any).port}/v1`,
        capabilities: { model: 'deepseek-flash', contextWindowTokens: 1048576, maxOutputTokens: 393216, source: 'configuration', version: 'retained-B15' } });
      const provider = { getDefaultModel: actual.getDefaultModel.bind(actual), getModelCapabilities: actual.getModelCapabilities.bind(actual),
        countPromptTokens: actual.countPromptTokens.bind(actual), projectMessages: (m: Message[]) => investigationContextMessages(actual.projectMessages(m), 'ops'),
        chat: actual.chat.bind(actual), chatStream: actual.chatStream.bind(actual) };
      const result = await new AgentRunner(provider).run({ initialMessages: raw, runtimeRunId: binding.runId, tools, model: 'deepseek-flash', hook: new NoopHook(),
        contextWindowTokens: 65536, maxTokens: 8192, maxIterations: 8, maxToolResultChars: 128000,
        contextPolicy: { recentToolBatches: 1, evidenceReferences: 'canonical', summaryMaxTokens: 10240 },
        contextEvidence: (source, summary) => investigationExecutionEvidence(source, execution, binding, 2, summary),
        budgetLimits: { maxProviderAttempts: 8, maxToolCalls: 20, maxTotalTokens: 128000, maxNoProgressSteps: 8 },
        resumeCheckpoint: { context_summary_v1: record, runtime_state_v1: recovery.snapshot(), context_state_v1: { schemaVersion: 1, compactCount: 2, successfulCompacts: 2, toolBatchesSinceCompact: 1, rapidRefills: 0 } },
        checkpointCallback: async c => { checkpoints.push(structuredClone(c)); } });
      const out = process.env.OPS_SELECTED_EVIDENCE_DIR;
      if (out) { mkdirSync(out, { recursive: true }); writeFileSync(out + '/b15-final-sdk.json', JSON.stringify({ scope: 'Original sourceHash verified; offline loopback scripted final, not active DB checkpoint resume or autonomous analysis', bodies, checkpoints, result }, null, 2)); }
      expect(bodies).toHaveLength(1); expect(bodies[0].tools ?? []).toEqual([]); expect(bodies[0].max_tokens).toBeLessThanOrEqual(8192);
      expect(bodies[0].messages[0].content).toBe(raw[0].content);
      expect(bodies[0].messages.some((m: any) => m.content?.includes(JSON.stringify(record.summary)))).toBe(true);
      expect(execute).not.toHaveBeenCalled(); expect(result.stopReason).toBe('completed'); expect(modelAnalysis(result.finalContent!, [])).not.toBeNull();
      expect(result.runtimeState).toMatchObject({ providerAttempts: 7, toolCalls: 14, unknownRequests: 0, reservedTokens: 0 });
      for (const m of bodies[0].messages) for (const c of m.tool_calls ?? []) expect(bodies[0].messages.filter((r: any) => r.tool_call_id === c.id)).toHaveLength(1);
      const compare = (id: string, observation: any) => {
        const source = original(calls.find((c: any) => c.id === id));
        if (observation.data?.evidenceOmitted) { expect(observation.data.observations).toBeUndefined(); return; }
        if (observation.data?.observations) expect(observation.data.observations).toEqual(source.data.observations);
        for (const metric of observation.data?.metrics ?? []) {
          const copy = structuredClone(metric);
          for (const series of copy.series) {
            series.buckets = series.buckets.map((b: any) => ({ ...series.bucketDefaults, ...(series.bucketColumns
              ? Object.fromEntries(series.bucketColumns.flatMap((key: string, i: number) => b[0][i] ? [[key, b[1][i]]] : [])) : b) }));
            delete series.bucketDefaults; delete series.bucketColumns;
          }
          expect(copy).toEqual(source.data.metrics.find((m: any) => m.definition.id === copy.definition.id));
        }
      };
      for (const message of bodies[0].messages) if (message.role === 'tool') {
        const observation = JSON.parse(message.content.slice(message.content.indexOf('{')));
        if (observation.canonicalSource && Array.isArray(observation.receipts)) for (const r of observation.receipts) {
          expect(r.receiptHash).toBe(responseHash(execution.tools[r.toolCallId].result));
          if (r.valuesProvided) compare(r.toolCallId, r.observation);
          else { expect(r.reason).toBe('INPUT_BUDGET'); expect(r.observation).toBeUndefined(); }
        }
        else if (calls.some((c: any) => c.id === message.tool_call_id)) compare(message.tool_call_id, observation);
      }
    } finally { await new Promise<void>(r => receiver.close(() => r())); }
  }, 30000);
});
