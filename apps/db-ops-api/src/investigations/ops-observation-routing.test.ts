import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { responseHash, OpenAIProvider, ToolRegistry, NoopHook, type Message } from '@slide/agent-core';
import { investigationContextMessages } from './executor.js';
import { investigationToolContract } from './tool-contract.js';
import { toolCatalog } from '../tools/catalog.js';
import { createQueryMetricsTool } from '../tools/ops/query_metrics.js';
import { admin } from '../metrics/policy/test-support.js';
import { MetricConsumerService } from '../metrics/consumers/service.js';
import { PolicyService } from '../metrics/policy/service.js';
import { observationIdentity } from '../contracts/metrics/validation.js';
import { resourceDiagnosticService } from '../resources/resource-diagnostic-service.js';
import { serverDiagnosticService } from '../server-diagnostic-service.js';
import { investigationPrompt, INVESTIGATION_PROFILES } from './profiles.js';
import { investigationToolPolicy } from './tool-contract.js';
import { MODEL_ANALYSIS_POLICY } from './model-analysis.js';
import { resolveInvestigationRuntime } from './runtime-configuration.js';
import '../tools/ops/index.js';
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
    const calls = fixture.calls.filter((c: any) => retained(c).success && (c.name === 'get_server_metrics' && c.args.maxRows === 100
      || c.name === 'get_resource_observations' && c.args.limit === 50 || c.name === 'query_metrics' && c.args.mode === 'realtime'));
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

// Offline persistence adapters, NOT a live collector or reconstructed original
// SQL rows. Retain B6 values, IDs, expired capabilities and attempts exactly.
// B5 package definitions are reused only after matching the B6 package digest.
// collected_at/lineage are schema envelopes absent from the formal report;
// normalized identity must still equal the original B6 sample ID.
function retainedService(snapshot = fixture, clock = () => '2026-10-22T06:57:30.000Z') {
  const definitions = JSON.parse(readFileSync(new URL('./fixtures/ops-discovery-b5-20261022.json', import.meta.url), 'utf8'));
  const find = (ref: any) => snapshot.resources.find((r: any) => r.ref.type === ref.type && r.ref.id === ref.id);
  const registry: any = { get: (pin: any) => {
    const release = definitions.releases.find((r: any) => r.package.id === pin.id && r.package.version === pin.version);
    expect(release.package.digest).toBe(pin.digest); return release;
  } };
  const inventory = async (type: string, id: string) => ({ type, id, attributes: type === 'instance'
    ? { 'db.engine': { value: 'mysql', observed_at: '2026-10-22T06:55:00Z', source: 'resource_configuration' } } : {} });
  const access = new PolicyService({} as any, registry, { exists: async ref => Boolean(find(ref)), inventory: async ref => inventory(ref.type, String(ref.id)) } as any);
  const policy: any = { assertAccess: access.assertAccess.bind(access), effective: async (actor: any, ref: any) => {
    await access.assertAccess(actor, ref, false);
    const r = find(ref); return { ...r.effective, published_revision: r.formal.revision };
  } };
  const samples = (r: any, id: string) => r.formal.metrics.find((m: any) => m.metric === id)?.cycles.flatMap((c: any) => c.samples) ?? [];
  const store: any = { inventory,
    attempts: async (ref: any) => find(ref).formal.metrics.flatMap((m: any) => m.cycles.map((c: any) => c.attempt).filter(Boolean)),
    dimensions: async (ref: any, def: any, from: string, to: string) => [...new Map(samples(find(ref), def.id)
      .filter((s: any) => s.observedAt >= from && s.observedAt < to).map((s: any) => [JSON.stringify(s.dimensions), s.dimensions])).values()],
    queryWindow: async (series: any, from: string, to: string) => samples(find({ type: series.resource_type, id: Number(series.resource_id) }), series.metric.id)
      .filter((s: any) => s.observedAt >= from && s.observedAt < to && JSON.stringify(s.dimensions) === JSON.stringify(series.dimensions))
      .map((s: any) => {
        const release = registry.get({ id: s.versions.package_id, version: s.versions.package_version,
          digest: find({ type: series.resource_type, id: Number(series.resource_id) }).formal.binding.package.digest });
        const mapping = release.package.collectors.find((c: any) => c.id === s.source.collector_id).mappings.find((m: any) => m.metric.id === series.metric.id);
        const base: any = { id: s.id, stage: 'normalized', resource_type: series.resource_type, resource_id: series.resource_id,
          metric: series.metric, dimensions: s.dimensions, observed_at: s.observedAt, stored_at: s.storedAt,
          collected_at: s.storedAt, lineage: [], production: 'measured', unit: s.unit, value: s.value, quality: s.quality,
          accuracy: s.accuracy, source: s.source, versions: s.versions };
        base.lineage = [{ id: observationIdentity({ ...base, stage: 'raw', raw_field: mapping.raw_field }), stage: 'raw' }];
        expect(observationIdentity(base)).toBe(s.id); return base;
      }),
  };
  return new MetricConsumerService(policy, registry, store, clock);
}

it('sends actual B6 bounded handlers and discovered semantic reads through 64k SDK admission and durable recovery after full r4 history', async () => {
  const core = new URL('../../../../packages/agent-core/src/', import.meta.url);
  const { ContextManager, sourceHash } = await import(new URL('runtime/context-manager.js', core).href);
  const { ModelStep } = await import(new URL('runtime/model-step.js', core).href);
  const { autoCompact } = await import(new URL('runtime/auto-compact.js', core).href);
  const { RecoveryPolicy } = await import(new URL('runtime/recovery-policy.js', core).href);
  const { RapidRefill } = await import(new URL('runtime/rapid-refill.js', core).href);
  const history = JSON.parse(readFileSync(new URL('./fixtures/ops-post-query-fix-20261022.json', import.meta.url), 'utf8'));
  const tools = new ToolRegistry(), profile = INVESTIGATION_PROFILES.ops;
  for (const name of profile.toolAllowlist) tools.register({ ...investigationToolContract(toolCatalog.get(name)!, scope, profile.budget)!,
    readOnly: true, concurrencySafe: false, exclusive: true, execute: async () => { throw Error('use actual offline handlers'); } });
  const capabilities = { model: 'deepseek-flash', contextWindowTokens: 1048576, maxOutputTokens: 393216,
    source: 'configuration' as const, version: 'verified-B6-offline' };
  const runtime = resolveInvestigationRuntime(capabilities, { contextWindowTokens: 65536, maxTokens: 8192 });
  const raw: Message[] = [{ role: 'system', content: investigationPrompt(profile) + investigationToolPolicy(scope, profile.budget) + MODEL_ANALYSIS_POLICY }, ...history.users, ...history.entries];
  const before = JSON.stringify(raw), digest = sourceHash(raw), wire: any[] = [], checkpoints: any[] = [], observations: any[] = [];
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); wire.push(body);
    const content = body.tools?.length ? 'offline only' : JSON.stringify({ goal: ['read retained B6'], constraints: [], done: [], pending: [], evidence: [], uncertain: ['capability snapshot expired'] });
    const response = { id: 'local', choices: [{ index: 0, message: { role: 'assistant', content }, delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    res.end(body.stream ? 'data: ' + JSON.stringify(response) + '\n\ndata: [DONE]\n\n' : JSON.stringify(response));
  });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  try {
    const actual = new OpenAIProvider({ apiKey: 'offline-unused', model: 'deepseek-flash', capabilities,
      baseURL: `http://127.0.0.1:${(receiver.address() as any).port}/v1` });
    const provider: any = { getDefaultModel: actual.getDefaultModel.bind(actual), getModelCapabilities: actual.getModelCapabilities.bind(actual),
      countPromptTokens: actual.countPromptTokens.bind(actual), projectMessages: (m: Message[]) => investigationContextMessages(actual.projectMessages(m), 'ops'),
      chat: actual.chat.bind(actual), chatStream: actual.chatStream.bind(actual) };
    const spec: any = { initialMessages: raw, tools, model: 'deepseek-flash', ...runtime, maxIterations: 24,
      maxToolResultChars: 128000, hook: new NoopHook(), checkpointCallback: async () => {},
      contextPolicy: { recentToolBatches: 1, evidenceReferences: 'canonical', summaryMaxTokens: runtime.summaryMaxTokens } };
    const manager = new ContextManager(spec, provider), recovery = new RecoveryPolicy(), refill = new RapidRefill();
    const persist = async (r: any) => { if (r) checkpoints.push(structuredClone(r)); };
    await autoCompact(manager, raw, provider, recovery, refill, persist, false);
    const send = async (name: string, args: any, receipt: any) => {
      expect(tools.prepareCall(name, args).error).toBeNull();
      expect(receipt.success).toBe(true);
      const id = `b6_${observations.length}`;
      raw.push({ role: 'assistant', content: 'Read retained evidence, not a model-generated choice.', tool_calls: [{ id, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }], _extra: { reasoning_content: 'Preserve source/quality and capability expiry.' } } as Message,
        { role: 'tool', name, tool_call_id: id, content: JSON.stringify(receipt) });
      refill.completeBatch();
      if (manager.shouldCompact(raw)) await autoCompact(manager, raw, provider, recovery, refill, persist, false);
      const view = manager.project(raw); manager.assertFits(view);
      const restored = new ContextManager(spec, provider); restored.summary = JSON.parse(JSON.stringify(checkpoints.at(-1)));
      expect(provider.projectMessages(restored.project(raw))).toEqual(provider.projectMessages(view));
      await new ModelStep(provider).request(spec, view, spec.hook, {} as any);
      const body = wire.at(-1), projected = JSON.parse(body.messages.find((m: any) => m.tool_call_id === id).content);
      expect(projected.data.evidenceOmitted).not.toBe(true);
      expect(projected.data.contextReference.sha256).toBe(responseHash(receipt));
      expect(body.messages.find((m: any) => m.tool_calls?.[0]?.id === id).reasoning_content).toBe('Preserve source/quality and capability expiry.');
      for (const m of body.messages.filter((m: any) => m.tool_calls)) for (const c of m.tool_calls)
        expect(body.messages.filter((t: any) => t.tool_call_id === c.id)).toHaveLength(1);
      observations.push({ name, args, receipt, projected, tokens: manager.tokens(view), inputBudget: manager.inputBudget });
      return projected;
    };
    // Run production handlers with retained persistence responses. This is not
    // a live SQL/collector test; spies end before semantic ACL/handler reduction.
    const pages = fixture.calls.filter((c: any) => c.args.limit === 4 || c.args.maxRows === 1);
    for (const call of pages) {
      const original = retained(call);
      const spy = call.name === 'get_resource_observations'
        ? vi.spyOn(resourceDiagnosticService, 'getObservations').mockResolvedValue(original.data.observations)
        : vi.spyOn(serverDiagnosticService, 'getMetricData').mockResolvedValue(original.data);
      try {
        const receipt: any = await toolCatalog.get(call.name)!.handler(call.args, { actor: admin });
        expect(receipt.data).toEqual(original.data);
        const view = await send(call.name, call.args, receipt);
        for (const key of Object.keys(original.data)) expect(view.data[key]).toEqual(original.data[key]);
      } finally { spy.mockRestore(); }
    }
    const service = retainedService(), semantic = createQueryMetricsTool(service), indexes = new Map<string, any>();
    for (const ref of scope) {
      const definitions: any[] = [];
      for (let offset: number | null = 0; offset !== null;) {
        const args = { resourceType: ref.type, resourceId: ref.id, mode: 'discover',
          ...(ref.type === 'server' ? { discovery_offset: offset, discovery_limit: 8 } : {}) };
        const receipt = await semantic.handler(args, { actor: admin });
        const view = await send('query_metrics', args, receipt);
        if (ref.type === 'server') expect(view.data.definitions.length).toBeLessThanOrEqual(8);
        definitions.push(...view.data.definitions); offset = view.data.discovery.next_offset;
        indexes.set(ref.type, { ...view.data, definitions });
      }
    }
    const serverDefinition = indexes.get('server').definitions.find((d: any) => d.kind === 'gauge' && d.unit === '%');
    expect(serverDefinition).toBeDefined();
    const detailArgs = { resourceType: 'server', resourceId: 3, mode: 'discover', metric_ids: [serverDefinition.id] };
    const detail = await send('query_metrics', detailArgs, await semantic.handler(detailArgs, { actor: admin }));
    expect(detail.data.definitions).toHaveLength(1);
    expect(detail.data.definitions[0]).toMatchObject({ id: serverDefinition.id, semantic_version: serverDefinition.semantic_version });
    const choices = [ ['instance', 'mysql.threads.connected'], ['instance', 'mysql.connections.limit'],
      ['instance', 'mysql.tables.estimated_allocated_bytes'], ['instance', 'custom.mysql.slow_queries_snapshot'],
      ['server', 'linux.cpu.user_system_percent'], ['server', 'linux.memory.used_bytes'], ['server', 'host.filesystem.used_bytes'],
      ['server', 'host.filesystem.size_bytes'], ['server', 'host.network.bytes_total'] ];
    for (const [type, wanted] of choices) {
      const definition = indexes.get(type).definitions.find((d: any) => d.id === wanted); expect(definition).toBeDefined();
      const r = fixture.resources.find((r: any) => r.ref.type === type), formal = r.formal.metrics.find((m: any) => m.metric === definition.id);
      const samples = formal.cycles[2].samples, time = samples[0]?.observedAt ?? formal.cycles[2].attempt.started_at;
      const to = new Date(Date.parse(time) + 1).toISOString(), from = new Date(Date.parse(to) - 60000).toISOString();
      const args = { resourceType: type, resourceId: r.ref.id, metric_ids: [definition.id], series_index: 0, from, to };
      const receipt: any = await semantic.handler(args, { actor: admin });
      const view = await send('query_metrics', args, receipt), metric = view.data.metrics[0];
      expect(view.data.metrics).toEqual(receipt.data.metrics);
      expect(metric.definition).toMatchObject({ id: definition.id, semantic_version: definition.semantic_version, unit: definition.unit });
      expect(metric.capability).toEqual(r.effective.resolved.metric_templates.find((t: any) => t.metric.id === definition.id).capability);
      expect(metric.capability.valid_until < from).toBe(true); // Do not turn expired capability into current support.
      expect(metric.attempt).toEqual(formal.cycles[2].attempt);
      if (definition.id === 'host.network.bytes_total') {
        expect(metric).toMatchObject({ state: 'temporary_failure', series: [], attempt: { error: 'parse_error' } });
        expect(view.status).toBe('warning'); expect(view.next_actions.length).toBeGreaterThan(0);
      } else {
        const series = metric.series[0], b = series.buckets[0], source = samples.find((s: any) => JSON.stringify(s.dimensions) === JSON.stringify(series.dimensions));
        expect(b.value).toEqual(source.value); expect(b.accuracy).toBe(source.accuracy);
        expect(b.quality).toEqual(definition.id === 'mysql.tables.estimated_allocated_bytes'
          ? { status: 'partial', reason: 'partial_input' } : source.quality);
        expect(b.unit).toBe(source.unit); expect(b.observed_at).toBe(source.observedAt); expect(b.freshness).toBe('fresh'); expect(b.coverage).toBe(1);
        expect(b.sources).toEqual([{ id: source.id, source: source.source, versions: source.versions }]);
        if (definition.id === 'custom.mysql.slow_queries_snapshot') {
          expect(metric.definition.kind).toBe('gauge'); expect(b.unit).toBe('count');
        }
        if (definition.id === 'mysql.tables.estimated_allocated_bytes') expect(b.accuracy).toBe('estimated');
      }
    }
    // B6's slow snapshot is actually 2. Reuse the separately identified B5
    // retained true-zero sample; never alter a B6 value to satisfy this case.
    const b5 = JSON.parse(readFileSync(new URL('./fixtures/ops-discovery-b5-20261022.json', import.meta.url), 'utf8'));
    const zeroSample = b5.resources[0].formal.metrics.find((m: any) => m.metric === 'custom.mysql.slow_queries_snapshot').cycles[2].samples[0];
    const zeroTo = new Date(Date.parse(zeroSample.observedAt) + 1).toISOString();
    const zeroArgs = { resourceType: 'instance', resourceId: 1, metric_ids: ['custom.mysql.slow_queries_snapshot'], series_index: 0,
      from: new Date(Date.parse(zeroTo) - 60000).toISOString(), to: zeroTo };
    const zero = await createQueryMetricsTool(retainedService(b5, () => zeroTo)).handler(zeroArgs, { actor: admin });
    const zeroView = await send('query_metrics', zeroArgs, zero);
    expect(zeroView.data.metrics[0].definition).toMatchObject({ kind: 'gauge', unit: 'count' });
    expect(zeroView.data.metrics[0].series[0].buckets[0].value).toEqual({ encoding: 'uint64', value: '0' });
    expect(wire.filter(b => b.tools?.length)).toHaveLength(18);
    for (const body of wire) expect(body.max_tokens).toBe(body.tools?.length ? 8192 : 10240);
    const prefix = raw.slice(0, history.users.length + history.entries.length + 1);
    expect(JSON.stringify(prefix)).toBe(before); expect(sourceHash(prefix)).toBe(digest);
    expect(await semantic.handler({ resourceType: 'server', resourceId: 3, mode: 'discover' }, { actor: { ...admin, permissions: [] } }))
      .toMatchObject({ success: false, errorCode: 'POLICY_FORBIDDEN' });
    let sends = 0;
    await expect(new ModelStep({ ...provider, chat: async () => { sends++; } }).request(spec,
      [...raw, { role: 'user', content: 'irreducible'.repeat(65536) }], spec.hook, {} as any)).rejects.toMatchObject({ code: 'CONTEXT_UNRECOVERABLE' });
    expect(sends).toBe(0);
  } finally {
    if (process.env.OPS_B6_EVIDENCE_DIR) writeFileSync(process.env.OPS_B6_EVIDENCE_DIR + '/sdk.json', JSON.stringify({
      kind: 'local SDK only, no product model; retained backing-service adapters, scripted tool choice', provenance: fixture.provenance,
      canonicalPrefixHash: digest, observations, wire, checkpoints,
      envelopeBoundary: 'collected_at uses storedAt; raw lineage reconstructed from package mapping only for schema envelope. Normalized ID equality asserted. Capability expiry unchanged.',
    }, null, 2));
    await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()));
  }
}, 30000);
