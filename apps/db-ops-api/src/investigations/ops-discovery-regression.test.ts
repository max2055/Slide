import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { responseHash } from '@slide/agent-core';
import { createQueryMetricsTool } from '../tools/ops/query_metrics.js';
import { admin } from '../metrics/policy/test-support.js';
import { investigationToolContextResult } from './executor.js';
import { observationIdentity } from '../contracts/metrics/validation.js';
import { MetricConsumerService } from '../metrics/consumers/service.js';
import { PolicyService } from '../metrics/policy/service.js';
import { investigationContextMessages } from './executor.js';
import { investigationPrompt, INVESTIGATION_PROFILES } from './profiles.js';
import { investigationToolContract, investigationToolPolicy } from './tool-contract.js';
import { MODEL_ANALYSIS_POLICY } from './model-analysis.js';
import { resolveInvestigationRuntime } from './runtime-configuration.js';
import { OpenAIProvider, ToolRegistry, NoopHook, type Message } from '@slide/agent-core';
import { toolCatalog } from '../tools/catalog.js';
import '../tools/ops/index.js';
import '../tools/generated/slide-self-mgmt/resource_tools.js';
import '../tools/generated/slide-self-mgmt/server_tools.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ops-discovery-b5-20261022.json', import.meta.url), 'utf8'));
const catalog = fixture.discoveryReceipt.data;

// Snapshot persistence adapters only: actual discovery, ACL check, semantic
// query/reducer, strict handler, projection, admission and SDK run below.
// The formal report omits collected_at/lineage. Reconstruct schema envelopes
// solely for offline reduction; never claim these envelopes as original rows.
function retainedService() {
  const find = (ref: any) => fixture.resources.find((r: any) => r.ref.type === ref.type && r.ref.id === ref.id);
  const registry: any = { get: (pin: any) => fixture.releases.find((r: any) => r.package.id === pin.id && r.package.version === pin.version) };
  const inventory = async (type: string, id: string) => ({ type, id, attributes: type === 'instance'
    ? { 'db.engine': { value: 'mysql', observed_at: '2026-10-22T05:17:25.193Z', source: 'resource_configuration' } } : {} });
  const access = new PolicyService({} as any, registry, { exists: async ref => Boolean(find(ref)), inventory: async ref => inventory(ref.type, String(ref.id)) } as any);
  const policy: any = { assertAccess: access.assertAccess.bind(access), effective: async (actor: any, ref: any) => {
    await access.assertAccess(actor, ref, false);
    const r = find(ref), effective = r.effective;
    return { ...effective, published_revision: r.formal.revision };
  } };
  const store: any = {
    inventory,
    attempts: async (ref: any) => find(ref).formal.metrics.flatMap((m: any) => m.cycles.map((c: any) => c.attempt).filter(Boolean)),
    dimensions: async (ref: any, def: any, from: string, to: string) => {
      const samples = find(ref).formal.metrics.find((m: any) => m.metric === def.id)?.cycles.flatMap((c: any) => c.samples) ?? [];
      return [...new Map(samples.filter((s: any) => s.observedAt >= from && s.observedAt < to).map((s: any) => [JSON.stringify(s.dimensions), s.dimensions])).values()];
    },
    queryWindow: async (series: any, from: string, to: string) => {
      const r = find({ type: series.resource_type, id: Number(series.resource_id) });
      const metric = r.formal.metrics.find((m: any) => m.metric === series.metric.id);
      return (metric?.cycles.flatMap((c: any) => c.samples) ?? [])
        .filter((s: any) => s.observedAt >= from && s.observedAt < to && JSON.stringify(s.dimensions) === JSON.stringify(series.dimensions))
        .map((s: any) => {
          const release = fixture.releases.find((p: any) => p.package.id === s.versions.package_id && p.package.version === s.versions.package_version);
          const mapping = release.package.collectors.find((c: any) => c.id === s.source.collector_id).mappings.find((m: any) => m.metric.id === series.metric.id);
          const base: any = { id: s.id, stage: 'normalized', resource_type: series.resource_type, resource_id: series.resource_id,
          metric: series.metric, dimensions: s.dimensions, observed_at: s.observedAt, stored_at: s.storedAt,
          // Test-envelope fields are not used for any asserted bucket result.
          collected_at: s.storedAt, lineage: [], production: 'measured',
          unit: s.unit, value: s.value, quality: s.quality, accuracy: s.accuracy, source: s.source, versions: s.versions };
          const rawId = observationIdentity({ ...base, stage: 'raw', raw_field: mapping.raw_field });
          base.lineage = [{ id: rawId, stage: 'raw' }];
          expect(observationIdentity(base)).toBe(s.id); // Exact retained identity, no invented source IDs.
          return base;
        });
    },
  };
  return new MetricConsumerService(policy, registry, store, () => '2026-10-22T05:06:30.000Z');
}

describe('B5 discovery is actionable before explicit metric reads', () => {
  it('keeps every actual ID and semantic index in the retained canonical model projection', () => {
    const before = JSON.stringify(fixture.discoveryReceipt);
    const view = JSON.parse(String(investigationToolContextResult(fixture.discoveryReceipt, 'retained-discovery', 'ops', 'query_metrics')));
    expect(view.data.metric_ids).toEqual(catalog.definitions.map((d: any) => d.id));
    expect(view.data.definitions.find((d: any) => d.id === 'custom.mysql.slow_queries_snapshot'))
      .toMatchObject({ kind: 'gauge', unit: 'count', semantic_version: '1.0.0' });
    expect(view.data.contextReference.sha256).toBe(responseHash(fixture.discoveryReceipt));
    expect(view.data.evidenceOmitted).not.toBe(true);
    expect(view.data.discovery.detail).toBe('index');
    expect(JSON.stringify(fixture.discoveryReceipt)).toBe(before);
    expect(JSON.parse(String(investigationToolContextResult(view, 'retained-discovery', 'ops', 'query_metrics')))).toEqual(view);
  });

  it('offers strict, bounded, exhaustive discovery pages and explicit full definitions', async () => {
    const tool = createQueryMetricsTool({ discover: async () => catalog } as any);
    const base = { resourceType: 'instance', resourceId: 1, mode: 'discover' };
    const ids: string[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const receipt: any = await tool.handler({ ...base, discovery_offset: offset, discovery_limit: 8 }, { actor: admin });
      expect(receipt.success).toBe(true);
      expect(receipt.data.definitions.length).toBeLessThanOrEqual(8);
      expect(receipt.data.effective).toBeUndefined();
      ids.push(...receipt.data.metric_ids);
      offset = receipt.data.discovery.next_offset;
    }
    expect(ids).toEqual(catalog.definitions.map((d: any) => d.id));
    const chosen = catalog.definitions.find((d: any) => d.id === 'custom.mysql.processlist_connections');
    const detail: any = await tool.handler({ ...base, metric_ids: [chosen.id] }, { actor: admin });
    expect(detail).toMatchObject({ success: true, data: { definitions: [chosen], discovery: { detail: 'definition', next_offset: null } } });
    for (const extra of [{ discovery_limit: 65 }, { discovery_offset: -1 }, { metric_ids: [chosen.id], discovery_offset: 0 }, { metric_ids: [chosen.id, chosen.id] }])
      expect(await tool.handler({ ...base, ...extra }, { actor: admin })).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    expect(await tool.handler({ ...base, metric_ids: ['invented.metric'] }, { actor: admin })).toMatchObject({ success: false, errorCode: 'UNKNOWN_METRIC' });
    expect(await tool.handler({ ...base, mode: 'realtime', discovery_limit: 8 }, { actor: admin })).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    expect(await tool.handler(base, {})).toMatchObject({ success: false, errorCode: 'AUTH_REQUIRED' });
  });
});


async function sdkDiscoveredMetrics(window: number, output: number) {
  const core = new URL('../../../../packages/agent-core/src/', import.meta.url);
  const { ContextManager, sourceHash } = await import(new URL('runtime/context-manager.js', core).href);
  const { ModelStep } = await import(new URL('runtime/model-step.js', core).href);
  const { autoCompact } = await import(new URL('runtime/auto-compact.js', core).href);
  const { RecoveryPolicy } = await import(new URL('runtime/recovery-policy.js', core).href);
  const { RapidRefill } = await import(new URL('runtime/rapid-refill.js', core).href);
  const { currentTime, projectContextBlocks, runtimeBlock } = await import(new URL('context-block.js', core).href);
  const { createServer } = await import('node:http');
  const retained = JSON.parse(readFileSync(new URL('./fixtures/ops-post-query-fix-20261022.json', import.meta.url), 'utf8'));
  const scope = [{ type: 'instance', id: 1 }, { type: 'server', id: 3 }];
  const profile = INVESTIGATION_PROFILES.ops, tools = new ToolRegistry();
  for (const name of profile.toolAllowlist) {
    const contract = investigationToolContract(toolCatalog.get(name)!, scope, profile.budget)!;
    tools.register({ ...contract, readOnly: true, concurrencySafe: false, exclusive: true, execute: async () => { throw Error('offline handler only'); } });
  }
  const capability = { model: 'deepseek-flash', contextWindowTokens: 1048576, maxOutputTokens: 393216, source: 'configuration' as const, version: 'verified-B5-offline' };
  const runtime = resolveInvestigationRuntime(capability, { contextWindowTokens: window, maxTokens: output });
  const raw: Message[] = [{ role: 'system', content: investigationPrompt(profile) + investigationToolPolicy(scope, profile.budget) + MODEL_ANALYSIS_POLICY }, ...retained.users, ...retained.entries];
  const original = JSON.stringify(raw), originalHash = sourceHash(raw), bodies: any[] = [], saved: any[] = [], observations: any[] = [];
  const summary = { goal: ['read actual B5 metric IDs'], constraints: ['read only'], done: [], pending: ['inspect quality'], evidence: [], uncertain: ['unknown is not healthy'] };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    const content = body.tools?.length ? 'offline only' : JSON.stringify(summary);
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    const response = { id: 'local', choices: [{ index: 0, message: { role: 'assistant', content }, delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
    res.end(body.stream ? 'data: ' + JSON.stringify(response) + '\n\ndata: [DONE]\n\n' : JSON.stringify(response));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const actual = new OpenAIProvider({ apiKey: 'offline-unused', model: 'deepseek-flash', capabilities: capability, baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1` });
    const provider: any = { getDefaultModel: actual.getDefaultModel.bind(actual), getModelCapabilities: actual.getModelCapabilities.bind(actual), countPromptTokens: actual.countPromptTokens.bind(actual),
      projectMessages: (m: Message[]) => investigationContextMessages(actual.projectMessages(m), 'ops'), chat: actual.chat.bind(actual), chatStream: actual.chatStream.bind(actual) };
    const spec: any = { initialMessages: raw, tools, model: 'deepseek-flash', ...runtime, maxIterations: 24, maxToolResultChars: 128000, hook: new NoopHook(), checkpointCallback: async () => {},
      contextPolicy: { recentToolBatches: 1, evidenceReferences: 'canonical', summaryMaxTokens: runtime.summaryMaxTokens } };
    const manager = new ContextManager(spec, provider), recovery = new RecoveryPolicy(), refill = new RapidRefill();
    const persist = async (record: any) => { if (record) saved.push(structuredClone(record)); };
    const suffix = projectContextBlocks([runtimeBlock('runtime', currentTime(new Date('2026-10-22T05:06:30Z')))]);
    await autoCompact(manager, raw, provider, recovery, refill, persist, false, suffix);
    const service = retainedService(), tool = createQueryMetricsTool(service);
    const send = async (args: any, validate: (view: any) => void) => {
      const receipt: any = await tool.handler(args, { actor: admin });
      if (!receipt.success && args.metric_ids) await service.query(admin, { resource: { type: args.resourceType, id: args.resourceId }, metric_ids: args.metric_ids, from: args.from, to: args.to });
      expect(receipt.success).toBe(true);
      const id = `actual_read_${raw.filter(m => m.role === 'tool').length}`;
      raw.push({ role: 'assistant', content: 'inspect actual discovered ID', tool_calls: [{ id, type: 'function', function: { name: 'query_metrics', arguments: JSON.stringify(args) } }],
        _extra: { reasoning_content: 'Retain source quality and coverage.' } } as Message,
        { role: 'tool', name: 'query_metrics', tool_call_id: id, content: JSON.stringify(receipt) });
      refill.completeBatch();
      if (manager.shouldCompact(raw, suffix)) await autoCompact(manager, raw, provider, recovery, refill, persist, false, suffix);
      const view = [...manager.project(raw), ...suffix]; manager.assertFits(view);
      const restored = new ContextManager(spec, provider); restored.summary = structuredClone(saved.at(-1));
      expect(provider.projectMessages([...restored.project(raw), ...suffix])).toEqual(provider.projectMessages(view));
      await new ModelStep(provider).request(spec, view, spec.hook, {} as any);
      const wire = bodies.at(-1), result = JSON.parse(wire.messages.find((m: any) => m.tool_call_id === id).content);
      expect(result.data.contextReference.sha256).toBe(responseHash(receipt));
      expect(result.data.evidenceOmitted).not.toBe(true);
      expect(wire.messages.find((m: any) => m.tool_calls?.[0]?.id === id).reasoning_content).toBe('Retain source quality and coverage.');
      for (const m of wire.messages.filter((m: any) => m.tool_calls)) for (const call of m.tool_calls)
        expect(wire.messages.filter((r: any) => r.tool_call_id === call.id)).toHaveLength(1);
      validate(result);
      observations.push({ args, receipt, projected: result, tokens: manager.tokens(view), inputBudget: manager.inputBudget });
      console.info('B5 discovery/semantic SDK', window, args.mode ?? args.metric_ids[0], manager.tokens(view), '/', manager.inputBudget);
      return result;
    };
    const indexes = new Map<string, any>();
    for (const ref of scope) {
      const result = await send({ resourceType: ref.type, resourceId: ref.id, mode: 'discover' }, view => {
        expect(view.data.discovery.next_offset).toBeNull();
        expect(view.data.metric_ids.length).toBeGreaterThan(20);
      });
      indexes.set(ref.type, result.data);
    }
    // Select from the received index, without legacy aliases or invented IDs.
    const choices = [
      ['instance', 'custom.mysql.processlist_connections'], ['instance', 'mysql.connections.limit'], ['instance', 'custom.mysql.slow_queries_snapshot'],
      ['server', 'linux.cpu.user_system_percent'], ['server', 'linux.memory.used_bytes'], ['server', 'host.filesystem.used_bytes'], ['server', 'host.network.bytes_total'],
    ];
    for (const [type, wanted] of choices) {
      const index = indexes.get(type), definition = index.definitions.find((d: any) => d.id === wanted);
      expect(definition).toBeDefined();
      const resource = fixture.resources.find((r: any) => r.ref.type === type), formal = resource.formal.metrics.find((m: any) => m.metric === definition.id);
      const samples = formal.cycles[2].samples;
      const time = samples[0]?.observedAt ?? formal.cycles[2].attempt.started_at;
      const to = new Date(Date.parse(time) + 1).toISOString(), from = new Date(Date.parse(to) - 60000).toISOString();
      await send({ resourceType: type, resourceId: resource.ref.id, metric_ids: [definition.id], series_index: 0, from, to }, view => {
        const m = view.data.metrics[0];
        expect(m.definition.id).toBe(definition.id);
        expect(m.definition.semantic_version).toBe(definition.semantic_version);
        expect(m.definition.unit).toBe(definition.unit);
        expect(m.capability).toBeDefined(); expect(m.attempt).not.toBeNull();
        expect(view.data.window).toEqual({ from, to });
        expect(view.summary).toBeTruthy();
        if (type === 'server' && definition.id === 'host.network.bytes_total') {
          expect(m.state).toBe('temporary_failure'); expect(m.attempt.error).toBe('parse_error');
          expect(m.series).toEqual([]); expect(view.status).toBe('warning');
          expect(view.next_actions.length).toBeGreaterThan(0);
        } else {
          const series = m.series[0], b = series.buckets[0];
          const source = samples.find((s: any) => JSON.stringify(s.dimensions) === JSON.stringify(series.dimensions));
          expect(b.value).toEqual(source.value); expect(b.quality).toEqual(source.quality);
          expect(b.accuracy).toBe(source.accuracy); expect(b.freshness).toBe('fresh');
          expect(b.unit).toBe(source.unit); expect(b.observed_at).toBe(source.observedAt);
          expect(b.coverage).toBe(1); expect(b.sample_count).toBe(1);
          expect(b.sources).toEqual([{ id: source.id, source: source.source, versions: source.versions }]);
          if (definition.id === 'custom.mysql.slow_queries_snapshot') {
            expect(m.definition.kind).toBe('gauge'); expect(b.unit).toBe('count');
          }
        }
      });
    }
    expect(bodies.filter(b => b.tools?.length)).toHaveLength(9); // 2 discoveries + 7 consecutive reads.
    expect(raw.filter(m => m.role === 'tool')).toHaveLength(20); // r4 11 + 9, within Ops ceiling.
    for (const body of bodies) expect(body.max_tokens).toBe(body.tools?.length ? output : 10240);
    expect(JSON.stringify(raw.slice(0, retained.entries.length + retained.users.length + 1))).toBe(original);
    expect(sourceHash(raw.slice(0, retained.entries.length + retained.users.length + 1))).toBe(originalHash);
    const denied: any = await tool.handler({ resourceType: 'instance', resourceId: 1, mode: 'discover' }, { actor: { ...admin, permissions: [] } });
    expect(denied).toMatchObject({ success: false, errorCode: 'POLICY_FORBIDDEN' });
  } finally {
    if (process.env.OPS_DISCOVERY_EVIDENCE_DIR) writeFileSync(process.env.OPS_DISCOVERY_EVIDENCE_DIR + `/sdk-${window}.json`, JSON.stringify({
      kind: 'local SDK HTTP replay; no product model', window, output, fixture: fixture.provenance, sourceHash: originalHash,
      envelopeReconstruction: 'Formal report omits collected_at and lineage. collected_at uses storedAt only for schema envelope. Raw lineage reconstructed from retained mapping; normalized ID equality asserted. These envelopes are not original persisted rows. No counter samples or epochs reconstructed.',
      observations, bodies, checkpoints: saved,
    }, null, 2));
    await new Promise<void>((r, j) => server.close(e => e ? j(e) : r()));
  }
}
it('discovers actual B5 IDs then sends seven consecutive semantic observations after r4 through the SDK at 64k/8k', async () => {
  await sdkDiscoveredMetrics(65536, 8192);
});
it('retains final admission protection when both default discovery indexes cannot fit at 32k', async () => {
  await expect(sdkDiscoveredMetrics(32768, 4096)).rejects.toMatchObject({ code: 'CONTEXT_UNRECOVERABLE' });
});
