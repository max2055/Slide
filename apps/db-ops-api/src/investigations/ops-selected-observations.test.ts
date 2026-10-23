import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { OpenAIProvider, responseHash, type Message } from '@slide/agent-core';
import { investigationContextMessages, investigationExecutionEvidence } from './executor.js';
import { createQueryMetricsTool } from '../tools/ops/query_metrics.js';
import { admin } from '../metrics/policy/test-support.js';

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
    expect(route.history.arguments).toEqual({ resourceType: 'server', resourceId: 3, mode: 'history', interval: '1m' });
    let query: any;
    const handler = createQueryMetricsTool({ query: async (_actor: any, args: any) => {
      query = args; return { metrics: [], window: { from: args.from, to: args.to } };
    } } as any);
    const from = '2026-10-23T01:00:00Z', to = '2026-10-23T02:00:00Z';
    const result: any = await handler.handler({ ...route.history.arguments, metric_ids: [route.returnedMetricIds[0]], from, to }, { actor: admin } as any);
    expect(result.success).toBe(true);
    expect(query).toMatchObject({ resource: { type: 'server', id: 3 }, metric_ids: [ids[0]], from, to, bucket_ms: 60000 });
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
  });
  it('never projects failed or denied receipts as successful evidence', () => {
    for (const raw of [{ ...original(serverCall), success: false, status: 'error', errorCode: 'UNKNOWN' },
      { ...original(serverCall), policyDecision: { allow: false, reasonCode: 'DENIED' } }]) expect(project(serverCall, raw)).toEqual(raw);
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
});
