import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { responseHash, ToolRegistry } from '@slide/agent-core';
import { MODEL_ANALYSIS_POLICY, modelAnalysis } from './model-analysis.js';
import { investigationToolContract } from './tool-contract.js';
import { boundedInvestigationArguments, investigationContextMessages, investigationToolContextResult } from './executor.js';
import { createQueryMetricsTool } from '../tools/ops/query_metrics.js';
import { MetricConsumerService, coreProfiles } from '../metrics/consumers/service.js';
import { createConfigurationRegistry } from '../metrics/config/registry.js';
import { PolicyService } from '../metrics/policy/service.js';
import { MemoryPolicyStore, admin } from '../metrics/policy/test-support.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ops-current-evidence-20261024.json', import.meta.url), 'utf8'));
const fs = JSON.parse(readFileSync(new URL('./fixtures/ops-fs-selected-20261024.json', import.meta.url), 'utf8'));
const scope = [{ type: 'instance', id: 1 }, { type: 'server', id: 3 }];
const budget = { maxRows: 200, maxBytes: 128000, maxWindowMs: 3600000 };
const final = fixture['sdk-02-sent'], received = fixture['sdk-02-received'];
const evidence = final.messages.filter((m: any) => m.role === 'tool')
  .map((m: any) => ({ id: `e-${m.tool_call_id}`, metadata_json: { source: `tool:${m.tool_call_id}` } }));
const validate = new Ajv2020({ strict: false }).compile(JSON.parse(MODEL_ANALYSIS_POLICY.split('analysis): ')[1]));
const key = (d: object) => JSON.stringify(Object.entries(d).sort(([a], [b]) => a.localeCompare(b)));

describe('current evidence planning and nonempty claim support, actual failed run', () => {
  it('preserves original SDK hashes, seven real call IDs, discovery-only receipts and the rejected answer', () => {
    for (const sent of [fixture['sdk-01-sent'], final]) {
      expect(createHash('sha256').update(JSON.stringify([sent.messages, sent.tools])).digest('hex')).toBe(sent.requestHash);
    }
    const calls = fixture['sdk-01-received'].response.toolCalls;
    expect(calls).toHaveLength(7);
    expect(calls.filter((c: any) => c.name === 'query_metrics').every((c: any) => c.arguments.mode === 'discover')).toBe(true);
    const canonical = fixture['canonical-method-boundary'];
    for (const call of calls) {
      expect(final.messages.filter((m: any) => m.tool_call_id === call.id)).toHaveLength(1);
      expect(canonical.filter((m: any) => m.tool_call_id === call.id)).toHaveLength(1);
    }
    const answer = JSON.parse(received.response.content);
    expect(answer.claims[3].supportingToolCallIds).toEqual([]);
    expect(modelAnalysis(received.response.content, evidence)).toBeNull();
    expect(final.tools).toEqual([]);
    for (const r of fixture['actual-metric-receipts'].receipts) {
      const raw = r.rawReceipt;
      expect(raw.data.definitions.length).toBeGreaterThan(0);
      expect(raw.data.metrics).toBeUndefined();
      const view = JSON.parse(String(investigationToolContextResult(raw, r.id, 'ops', r.name, r.arguments)));
      expect(view.data.contextReference.sha256).toBe(responseHash(raw));
      expect(view.data.metrics).toBeUndefined(); // Definitions never become values.
    }
  });

  it('rejects the real empty-support answer in the advertised schema as well as publication', () => {
    expect(validate(JSON.parse(received.response.content))).toBe(false);
    expect(validate.errors?.some(e => e.keyword === 'minItems')).toBe(true);
  });

  it('advertises existing product core IDs and current-value-first planning without granting capability', () => {
    const tool = createQueryMetricsTool();
    const contract = investigationToolContract(tool, scope, budget)!;
    for (const ref of scope) for (const m of coreProfiles[ref.type as keyof typeof coreProfiles]) expect(contract.description).toContain(m.id);
    expect(investigationToolContract(tool, [{ type: 'instance', id: 1 }], budget)!.description).not.toContain('host.filesystem.used_bytes');
    expect(contract.description).toContain('not capability');
    expect(MODEL_ANALYSIS_POLICY).toContain('First batch: current values');
    expect(MODEL_ANALYSIS_POLICY).toContain('tool_call_id');
    expect(MODEL_ANALYSIS_POLICY).toContain('discover is definitions only');
    expect(MODEL_ANALYSIS_POLICY).toContain('used/size together');
  });

  it('binds valid support to actual message IDs even for small metadata receipts without contextReference', () => {
    const call = fixture['sdk-01-received'].response.toolCalls[0];
    const message = final.messages.find((m: any) => m.tool_call_id === call.id);
    expect(JSON.parse(message.content).data.contextReference).toBeUndefined();
    // Authored contract example, never a repair of the stored model answer.
    const answer = { analysisVersion: 1, summary: '仅描述平台元数据，当前指标缺失。',
      claims: [{ statement: '实例摘要上报healthy；不能据此确认当前健康。', supportingToolCallIds: [call.id], contradictingToolCallIds: [] }],
      hypotheses: [{ statement: '原因未验证。', supportingToolCallIds: [], contradictingToolCallIds: [] }],
      unresolvedQuestions: ['尚缺当前指标。'], recommendations: [] };
    expect(validate(answer)).toBe(true);
    expect(modelAnalysis(JSON.stringify(answer), evidence)?.claims[0].supportingEvidenceIds).toEqual([`e-${call.id}`]);
    for (const ids of [[], ['unknown'], ['older-run']]) expect(modelAnalysis(JSON.stringify({ ...answer,
      claims: [{ ...answer.claims[0], supportingToolCallIds: ids }] }), evidence)).toBeNull();
    expect(modelAnalysis(JSON.stringify({ ...answer, extra: true }), evidence)).toBeNull();
    expect(modelAnalysis(JSON.stringify(answer).slice(0, -1), evidence)).toBeNull();
  });

  it('executes advertised core FS reads in the first scripted batch and follows oversized pages by exact dimensions', async () => {
    // Retained real points with isolated in-memory policy/store; no live DB or
    // model. The script chooses calls, it does not demonstrate autonomous choice.
    const now = fs.receipts.filter((r: any) => r.rawReceipt.data.window).map((r: any) => r.rawReceipt.data.window.to).sort().at(-1);
    const registry = createConfigurationRegistry(), store = new MemoryPolicyStore();
    const policy = new PolicyService(store, registry, { exists: async () => true,
      inventory: async () => ({ type: 'server', id: '3', attributes: {} }) }, () => now);
    const release = registry.list().find(r => r.package.id === 'linux-host' && r.package.version === '1.1.0')!.package;
    await policy.changeBinding(admin, { type: 'server', id: 3 }, { expected_revision: 0,
      package: { id: release.id, version: release.version, digest: release.digest } }, true);
    const service = new MetricConsumerService(policy, registry, {
      dimensions: async (_r, d) => [...new Map(fs.normalizedPoints.filter((p: any) => p.metric.id === d.id)
        .map((p: any) => [key(p.dimensions), p.dimensions])).values()] as Record<string, string>[],
      queryWindow: async s => fs.normalizedPoints.filter((p: any) => p.metric.id === s.metric.id && key(p.dimensions) === key(s.dimensions)),
      inventory: async () => null, attempts: async () => [],
    }, () => now);
    const tool = createQueryMetricsTool(service, () => now), tools = new ToolRegistry();
    tools.register({ ...investigationToolContract(tool, scope, budget)!, readOnly: true, concurrencySafe: false,
      exclusive: true, execute: async () => { throw Error('use real handler'); } });
    const views: any[] = [];
    for (const metric of coreProfiles.server.filter(m => m.id.startsWith('host.filesystem.'))) {
      const args = { resourceType: 'server', resourceId: 3, mode: 'history', metric_ids: [metric.id],
        from: new Date(Date.parse(now) - 60000).toISOString(), to: now, interval: '1m' };
      expect(tools.prepareCall(tool.name, args).error).toBeNull();
      const bounded = boundedInvestigationArguments(tool.name, args, budget, Date.parse(now));
      const raw: any = await tool.handler(bounded.args, { actor: admin });
      expect(raw.success).toBe(true);
      const view = JSON.parse(String(investigationToolContextResult(raw, metric.id, 'ops', tool.name, args)));
      expect(view.data.evidenceOmitted).not.toBe(true);
      expect(view.data.metrics[0].series).toHaveLength(11);
      expect(view.data.metrics).toEqual(raw.data.metrics);
      views.push(view);
      // When a page cannot fit, existing exact-directory guidance is executable.
      const large = structuredClone(raw); large.data.metrics[0].extra = 'x'.repeat(17000);
      const omitted = JSON.parse(String(investigationToolContextResult(large, metric.id, 'ops', tool.name, args)));
      expect(omitted.data.evidenceOmitted).toBe(true);
      const route = omitted.data.seriesSelection.read.arguments;
      expect(tools.prepareCall(tool.name, route).error).toBeNull();
      const narrow: any = await tool.handler(route, { actor: admin });
      expect(narrow.success).toBe(true);
      expect(narrow.data.metrics[0].series[0].dimensions).toEqual(omitted.data.seriesSelection.entries[0].dimensions);
      expect(investigationContextMessages([{ role: 'tool', name: tool.name, tool_call_id: metric.id, content: JSON.stringify(narrow) }], 'ops')[0].content).toContain('single_metric_v1');
    }
    const [used, size] = views.map(v => v.data.metrics[0].series);
    for (const u of used) {
      const peer = size.filter((s: any) => key(s.dimensions) === key(u.dimensions));
      expect(peer).toHaveLength(1);
      expect(peer[0].buckets[0].observed_at).toBe(u.buckets[0].observed_at);
      expect(peer[0].buckets[0].unit).toBe(u.buckets[0].unit);
    }
    const denied: any = await tool.handler({ resourceType: 'server', resourceId: 3 }, { actor: { ...admin, permissions: [], instanceScopes: {} } });
    expect(denied.success).toBe(false);
    expect(investigationToolContextResult(denied, 'denied', 'ops', tool.name)).toBe(denied);
  });
});
