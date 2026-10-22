import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { responseHash, type Message } from '@slide/agent-core';
import { investigationContextMessages } from './executor.js';
import { investigationToolContract } from './tool-contract.js';
import { toolCatalog } from '../tools/catalog.js';
import { createQueryMetricsTool } from '../tools/ops/query_metrics.js';
import { admin } from '../metrics/policy/test-support.js';
import '../tools/generated/slide-self-mgmt/resource_tools.js';
import '../tools/generated/slide-self-mgmt/server_tools.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ops-observation-b6-20261022.json', import.meta.url), 'utf8'));
const scope = [{ type: 'instance', id: 1 }, { type: 'server', id: 3 }];
function retained(call: any) {
  const entry = fixture.entries.find((e: any) => e.tool_call_id === call.toolCallId);
  return JSON.parse(entry.content);
}
function project(call: any, receipt = retained(call)) {
  const messages: Message[] = [{ role: 'assistant', content: '', tool_calls: [{ id: call.toolCallId, type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) } }] },
    { role: 'tool', tool_call_id: call.toolCallId, content: JSON.stringify(receipt) }];
  const before = JSON.stringify(messages);
  const view = investigationContextMessages(messages, 'ops');
  expect(JSON.stringify(messages)).toBe(before);
  expect(investigationContextMessages(view, 'ops')).toEqual(view);
  return JSON.parse(String(view[1].content));
}

describe('B6 successful bounded observations and legal metric routing', () => {
  it('keeps both actual limit4 database pages losslessly readable, including null and partial_input', () => {
    const calls = fixture.calls.filter((c: any) => c.name === 'get_resource_observations' && c.args.limit === 4);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const raw = retained(call), view = project(call);
      expect(view.data.evidenceOmitted).not.toBe(true);
      expect(view.data.observations).toEqual(raw.data.observations);
      expect(view.data.contextReference.sha256).toBe(responseHash(raw));
      expect(view.data.metricRead.discover).toEqual({ tool: 'query_metrics', arguments: {
        resourceType: 'instance', resourceId: 1, mode: 'discover', discovery_limit: 8 } });
    }
  });
  it('keeps the actual server maxRows1 latest/history page with all dimensions, units, times and gaps', () => {
    const call = fixture.calls.find((c: any) => c.name === 'get_server_metrics' && c.args.maxRows === 1);
    const raw = retained(call), view = project(call);
    expect(view.data.evidenceOmitted).not.toBe(true);
    for (const key of ['latest', 'history', 'freshness', 'gaps']) expect(view.data[key]).toEqual(raw.data[key]);
    expect(view.details).toEqual(raw.details);
    expect(view.data.metricRead.discover.arguments).toMatchObject({ resourceType: 'server', resourceId: 3 });
  });
  it('offers executable discovery on the same resource when a large legacy page or unselected semantic read is omitted', async () => {
    const calls = fixture.calls.filter((c: any) => c.name === 'get_server_metrics' && c.args.maxRows === 100
      || c.name === 'get_resource_observations' && c.args.limit === 50 || c.name === 'query_metrics' && c.args.mode === 'realtime');
    expect(calls.length).toBeGreaterThan(3);
    for (const call of calls) {
      const view = project(call);
      const read = view.data.metricRead;
      expect(read?.discover.tool).toBe('query_metrics');
      const expected = call.name === 'get_server_metrics' ? { type: 'server', id: call.args.serverId }
        : { type: call.args.resourceType, id: call.args.resourceId };
      let resource: any;
      const tool = createQueryMetricsTool({ discover: async (_actor: any, ref: any) => {
        resource = ref; return { profile: {}, definitions: [], effective: null };
      } } as any);
      expect(await tool.handler(read.discover.arguments, { actor: admin })).toMatchObject({ success: true });
      expect(resource).toEqual(expected);
      expect(read.instructions).toContain('metric_ids');
      expect(read.instructions).toContain('series_index');
    }
  });
  it('preserves all six actual legacy metric errors and supplies an authorized-schema alternative without alias mapping', () => {
    const calls = fixture.calls.filter((c: any) => c.name === 'get_server_metrics' && c.args.metricName);
    expect(calls).toHaveLength(6);
    for (const call of calls) {
      const raw = retained(call), view = project(call);
      expect(view.success).toBe(false); expect(view.error).toBe(raw.error); expect(view.errorCode).toBe(raw.errorCode);
      expect(view.metricRead.discover.arguments).toEqual({ resourceType: 'server', resourceId: 3, mode: 'discover', discovery_limit: 8 });
      expect(view.metricRead.discover.arguments.metric_ids).toBeUndefined();
    }
  });
  it('advertises semantic discovery for each resource and explains the legacy server name limitation', () => {
    for (const name of ['get_server_metrics', 'get_resource_observations']) {
      const contract = investigationToolContract(toolCatalog.get(name)!, scope, { maxWindowMs: 3600000, maxRows: 100 })!;
      expect(contract.description).toContain('query_metrics'); expect(contract.description).toContain('discover');
      if (name === 'get_server_metrics') expect(contract.description).toContain('metricName');
    }
  });
  it('does not make oversized single records, failure/denial or another profile bypass admission', () => {
    const call = fixture.calls.find((c: any) => c.args.maxRows === 1);
    const raw = retained(call), huge = structuredClone(raw);
    huge.data.latest[0].opaque = 'x'.repeat(80000);
    expect(project(call, huge).data.evidenceOmitted).toBe(true);
    const denied = { ...raw, policyDecision: { allow: false, reasonCode: 'DENIED' } };
    expect(project(call, denied)).toEqual(denied);
    const messages: Message[] = [{ role: 'tool', name: call.name, tool_call_id: call.toolCallId, content: JSON.stringify(raw) }];
    expect(investigationContextMessages(messages, 'system')).toBe(messages);
  });
});
