import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAIProvider, NoopHook, ToolRegistry, responseHash, type Message } from '@slide/agent-core';
import { investigationContextMessages } from './executor.js';
import { investigationPrompt, INVESTIGATION_PROFILES } from './profiles.js';
import * as contracts from './tool-contract.js';
import { toolCatalog } from '../tools/catalog.js';
import '../tools/ops/index.js';
import '../tools/generated/slide-self-mgmt/resource_tools.js';
import '../tools/generated/slide-self-mgmt/server_tools.js';

const core = new URL('../../../../packages/agent-core/src/', import.meta.url);
const { ContextManager, sourceHash, prepareMessages } = await import(new URL('runtime/context-manager.js', core).href);
const { ModelStep } = await import(new URL('runtime/model-step.js', core).href);
const { autoCompact } = await import(new URL('runtime/auto-compact.js', core).href);
const { RecoveryPolicy } = await import(new URL('runtime/recovery-policy.js', core).href);
const { RapidRefill } = await import(new URL('runtime/rapid-refill.js', core).href);
const { currentTime, projectContextBlocks, runtimeBlock } = await import(new URL('context-block.js', core).href);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/ops-second-batch-20261022.json', import.meta.url), 'utf8'));
const resources = fixture.resources;
const profile = INVESTIGATION_PROFILES.ops;
const clock = projectContextBlocks([runtimeBlock('runtime', currentTime(new Date('2026-10-21T16:49:26Z')))]);
const summary = { goal: ['Read-only resource investigation'], constraints: [], done: [], pending: [], evidence: [], uncertain: ['Root cause unverified; omitted receipts require narrower reads'] };
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

async function setup() {
  const received: any[] = [];
  // Real SDK serialization, loopback only. These replies are protocol fixtures,
  // not model-generated analysis or usage telemetry.
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); received.push(body);
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(summary) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Offline protocol receipt; no business conclusion.' }, finish_reason: 'stop' }] }));
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const actual = new OpenAIProvider({ apiKey: 'offline-unused', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${address.port}/v1` });
  const provider = {
    getDefaultModel: actual.getDefaultModel.bind(actual), countPromptTokens: actual.countPromptTokens.bind(actual),
    projectMessages: (messages: Message[]) => investigationContextMessages(actual.projectMessages(messages), 'ops'),
    chat: actual.chat.bind(actual), chatStream: actual.chatStream.bind(actual),
  };
  const tools = new ToolRegistry();
  for (const name of profile.toolAllowlist) {
    const contract = contracts.investigationToolContract(toolCatalog.get(name)!, resources, profile.budget)!;
    tools.register({ ...contract, readOnly: true, concurrencySafe: false, exclusive: true,
      execute: async () => { throw Error('NO_TOOL_EXECUTION_IN_OFFLINE_REPLAY'); } });
  }
  // Fallback is solely the predecessor reproducer; the production helper must
  // be used once implemented. The failing boundary is actual admission.
  const policy = (contracts as any).investigationToolPolicy?.(resources, profile.budget) ?? '';
  const raw: Message[] = [{ role: 'system', source: 'runtime', contextAuthority: 'policy', content: investigationPrompt(profile) + policy }, ...fixture.users, ...fixture.entries];
  const spec: any = { initialMessages: raw, tools, model: 'deepseek-flash', maxIterations: 8, maxToolResultChars: 128000,
    contextWindowTokens: 16000, maxTokens: 4096, hook: new NoopHook(), checkpointCallback: async () => {}, contextPolicy: { recentToolBatches: 1, evidenceReferences: 'canonical', summaryMaxTokens: 2048 } };
  return { raw, spec, provider, received };
}

describe('r2 second atomic Ops batch at the real model boundary', () => {
  it('compacts older history and sends the complete retained batch through the SDK without changing canonical evidence', async () => {
    const { raw, spec, provider, received } = await setup();
    const before = JSON.stringify(raw), digest = sourceHash(raw);
    const manager = new ContextManager(spec, provider), split = manager.split(raw);
    const large = raw.find(m => m.name === 'query_metrics')!, receipt = JSON.parse(String(large.content));
    expect(Buffer.byteLength(String(large.content))).toBe(90383);
    expect(split.retained.filter((m: Message) => m.role === 'tool')).toHaveLength(4);
    expect(spec.tools.getDefinitions()).toHaveLength(7);
    const estimate = manager.tokens([...split.pins, ...prepareMessages(spec, split.retained), ...clock]);
    console.info('R2 protected reconstruction', estimate, '/', manager.inputBudget);
    manager.assertFits([...split.pins, ...prepareMessages(spec, split.retained), ...clock]);
    const saved: any[] = [];
    await autoCompact(manager, raw, provider, new RecoveryPolicy(), new RapidRefill(), async (record: any) => { if (record) saved.push(record); }, false, clock);
    expect(saved).toHaveLength(1);
    expect(saved[0].sourceHash).toBe(sourceHash(raw.slice(0, split.end)));
    const request = [...manager.project(raw), ...clock];
    await new ModelStep(provider).request(spec, request, spec.hook, {} as any);
    expect(received).toHaveLength(2); // one summary + one ordinary request
    expect(received[0].tools).toBeUndefined();
    expect(received[1].tools).toHaveLength(7);
    const wire = received[1].messages;
    expect(wire[0].content).toContain('All tools (runtime enforced)');
    expect(wire[0].content).not.toContain('primary');
    expect(wire[0].content).toContain('"maxWindowMs":3600000');
    expect(wire[0].content).toContain('Missing/unknown is not healthy');
    const retainedAssistant = split.retained[0];
    expect(wire.find((m: any) => m.tool_calls?.[0]?.id === retainedAssistant.tool_calls![0].id).tool_calls).toEqual(retainedAssistant.tool_calls);
    for (const call of retainedAssistant.tool_calls!) expect(wire.filter((m: any) => m.tool_call_id === call.id)).toHaveLength(1);
    const view = JSON.parse(wire.find((m: any) => m.tool_call_id === large.tool_call_id).content);
    expect(view.data.contextReference).toEqual({ toolCallId: large.tool_call_id, sha256: responseHash(receipt), bytes: 90383 });
    expect(view.data).toMatchObject({ evidenceOmitted: true, requiresNarrowerRead: true });
    expect(wire[0].content).toContain('never infer health or cause from it');
    expect(JSON.stringify(wire)).toContain('METRIC_REFERENCE_REVIEW_REQUIRED');
    const failure = fixture.entries.at(-1), failureValue = JSON.parse(failure.content);
    const { policyDecision: _audit, ...businessFailure } = failureValue;
    expect(JSON.parse(wire.find((m: any) => m.tool_call_id === failure.tool_call_id).content)).toEqual(businessFailure);
    expect(JSON.stringify(wire)).toContain('unknown');
    const projected = provider.projectMessages(request);
    expect(provider.projectMessages(projected)).toEqual(projected);
    expect(JSON.stringify(raw)).toBe(before); expect(sourceHash(raw)).toBe(digest);
    console.info('R2 final reconstruction', manager.tokens(request), '/', manager.inputBudget);
  });

  it('rejects irreducible protected input before any SDK request', async () => {
    const { raw, spec, provider, received } = await setup();
    const input = [...raw, { role: 'user' as const, content: 'x'.repeat(20000) }];
    await expect(new ModelStep(provider).request(spec, input, spec.hook, {} as any)).rejects.toMatchObject({ code: 'CONTEXT_UNRECOVERABLE' });
    expect(received).toHaveLength(0);
  });
});
