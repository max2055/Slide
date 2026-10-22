import { expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import { ContextManager, sourceHash } from '../runtime/context-manager.js';
import { RecoveryPolicy } from '../runtime/recovery-policy.js';
import type { AgentRunSpec, LLMProvider, LLMResponse, Message } from '../types.js';

const summary = { goal: ['inspect'], constraints: ['read only'], done: [], pending: ['report'], evidence: [], uncertain: ['missing evidence'] };
const reply = (content = 'Evidence remains incomplete.'): LLMResponse => ({ content, finishReason: 'stop', toolCalls: [], hasToolCalls: false, shouldExecuteTools: false, usage: { prompt_tokens: 11, completion_tokens: 7, cached_tokens: 3 } });
const toolReply = (): LLMResponse => ({ ...reply(), content: null, finishReason: 'tool_calls', hasToolCalls: true, shouldExecuteTools: true, toolCalls: [{ id: 'read-1', name: 'read', arguments: {} }] });

function fixture(attempts = 0, compact = false) {
  const tools = new ToolRegistry(), execute = vi.fn(async () => 'evidence');
  tools.register({ name: 'read', description: 'Read evidence', parameters: { type: 'object', properties: {} }, readOnly: true, concurrencySafe: true, exclusive: false, execute });
  const recovery = new RecoveryPolicy();
  recovery.state.providerAttempts = attempts;
  const raw: Message[] = [{ role: 'system', content: 'Read only.' }, { role: 'user', content: 'Inspect and report uncertainty.' }];
  if (compact) raw.push({ role: 'assistant', content: 'historical record '.repeat(650) }, { role: 'user', content: 'Report.' });
  const saved: any[] = [];
  const spec: AgentRunSpec = { initialMessages: raw, tools, model: 'test', hook: new NoopHook(), maxIterations: 8,
    contextWindowTokens: 15000, maxTokens: 500, maxToolResultChars: 1000,
    contextPolicy: { watermark: 0.6, summaryMaxTokens: 500 },
    budgetLimits: { maxProviderAttempts: 8, maxToolCalls: 20, maxTotalTokens: 128000, maxNoProgressSteps: 8 },
    resumeCheckpoint: { runtime_state_v1: recovery.snapshot() }, checkpointCallback: async c => { saved.push(structuredClone(c)); } };
  const requests: { messages: Message[]; tools: unknown[]; admitted: any }[] = [];
  const provider: LLMProvider = { getDefaultModel: () => 'test',
    chat: async (messages, definitions) => {
      requests.push({ messages: structuredClone(messages), tools: definitions, admitted: structuredClone(saved.at(-1).runtime_state_v1) });
      return reply();
    }, chatStream: async () => reply(JSON.stringify(summary)) };
  return { spec, raw, saved, provider, requests, execute };
}

function hint(messages: Message[]) {
  return messages.find(m => m.source === 'runtime' && String(m.content).startsWith('Execution budget:'))?.content as string;
}

it('recomputes the dispatch suffix after natural compaction without changing canonical history or source hashes', async () => {
  const f = fixture(2, true), before = structuredClone(f.raw);
  const result = await new AgentRunner(f.provider).run(f.spec);
  expect(result.stopReason).toBe('completed');
  expect(f.saved.at(-1).context_state_v1.successfulCompacts).toBe(1);
  const request = f.requests[0];
  expect(request.admitted.providerAttempts).toBe(4);
  expect(hint(request.messages)).toContain('remainingProviderAttempts=5');
  expect(hint(request.messages)).toContain('remainingTotalTokens=127982');
  expect(f.raw).toEqual(before);
  const record = f.saved.at(-1).context_summary_v1;
  expect(record.sourceHash).toBe(sourceHash(before.slice(0, record.sourceEnd)));
  expect(JSON.stringify(result.messages)).not.toContain('Execution budget:');
});

it.each([false, true])('uses the last ordinary attempt for an answer after compaction=%s', async compact => {
  const f = fixture(compact ? 6 : 7, compact);
  const result = await new AgentRunner(f.provider).run(f.spec);
  expect(result.stopReason).toBe('completed');
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].tools).toEqual([]);
  expect(hint(f.requests[0].messages)).toContain('remainingProviderAttempts=1');
  expect(hint(f.requests[0].messages)).toContain('Give the final answer');
  expect(result.runtimeState).toMatchObject({ providerAttempts: 8, toolCalls: 0, unknownRequests: 0, reservedTokens: 0 });
});

it('refuses and persists a tool batch returned in breach of the final answer request', async () => {
  const f = fixture(7);
  f.provider.chat = async () => toolReply();
  const result = await new AgentRunner(f.provider).run(f.spec);
  expect(f.execute).not.toHaveBeenCalled();
  expect(result.resolution).toMatchObject({ kind: 'partial', reasonCode: 'MAX_PROVIDER_ATTEMPTS' });
  expect(f.saved.at(-1)).toMatchObject({ phase: 'rejected_tool_batch', pendingToolCalls: [], completedToolResults: [], rejectedToolCalls: [{ id: 'read-1' }] });
  expect(result.runtimeState).toMatchObject({ providerAttempts: 8, toolCalls: 0, unknownRequests: 0, reservedTokens: 0 });
});

it('accounts for persisted delegated allowances and subsequent summary consumption', async () => {
  const f = fixture(4, true);
  const state = new RecoveryPolicy(f.spec.resumeCheckpoint!.runtime_state_v1);
  state.state.delegated = { modelSteps: 1, providerAttempts: 2, toolCalls: 3, tokens: 1000 };
  f.spec.resumeCheckpoint = { runtime_state_v1: state.snapshot() };
  const result = await new AgentRunner(f.provider).run(f.spec);
  expect(result.stopReason).toBe('completed');
  expect(f.requests[0].tools).toEqual([]);
  expect(hint(f.requests[0].messages)).toContain('remainingProviderAttempts=1');
  expect(hint(f.requests[0].messages)).toContain('remainingToolCalls=17');
  expect(hint(f.requests[0].messages)).toContain('remainingTotalTokens=126982');
});

it.each([false, true])('does not dispatch when zero ordinary attempts remain (summary consumes last=%s)', async compact => {
  const f = fixture(compact ? 7 : 8, compact);
  const result = await new AgentRunner(f.provider).run(f.spec);
  expect(f.requests).toHaveLength(0);
  expect(f.execute).not.toHaveBeenCalled();
  expect(result.resolution).toMatchObject({ kind: 'partial', reasonCode: 'MAX_PROVIDER_ATTEMPTS' });
  expect(result.runtimeState?.providerAttempts).toBe(8);
});

it('preserves input growth rejection after recomputing the suffix', async () => {
  const f = fixture(2, true);
  f.spec.hook.beforeIteration = async context => { context.messages.push({ role: 'user', content: 'x'.repeat(30000) }); };
  const result = await new AgentRunner(f.provider).run(f.spec);
  expect(result.resolution?.reasonCode).toBe('CONTEXT_UNRECOVERABLE');
  expect(f.requests).toHaveLength(0);
  expect(f.saved.at(-1).context_summary_v1).toBeDefined();
  expect(() => new ContextManager(f.spec).assertFits(f.raw)).not.toThrow();
});

it('cannot spend an unsettled token reservation on the final answer', async () => {
  const f = fixture(7);
  const recovery = new RecoveryPolicy(f.spec.resumeCheckpoint!.runtime_state_v1);
  recovery.state.unknownRequests = 1; recovery.state.reservedTokens = 127999;
  f.spec.resumeCheckpoint = { runtime_state_v1: recovery.snapshot() };
  const result = await new AgentRunner(f.provider).run(f.spec);
  expect(f.requests).toHaveLength(0);
  expect(result.resolution).toMatchObject({ kind: 'partial', reasonCode: 'TOKEN_BUDGET' });
  expect(result.runtimeState).toMatchObject({ providerAttempts: 7, unknownRequests: 1, reservedTokens: 127999 });
});

it('keeps unknown final-answer usage reserved and cannot send again after restart', async () => {
  const f = fixture(7), chat = vi.fn(async () => ({ ...toolReply(), usage: {} }));
  f.provider.chat = chat;
  const first = await new AgentRunner(f.provider).run(f.spec);
  expect(first.resolution?.reasonCode).toBe('MAX_PROVIDER_ATTEMPTS');
  expect(f.execute).not.toHaveBeenCalled();
  expect(first.runtimeState).toMatchObject({ providerAttempts: 8, unknownRequests: 1, reservedTokens: 15000 });
  const second = await new AgentRunner(f.provider).run({ ...f.spec, resumeCheckpoint: { runtime_state_v1: first.runtimeState } });
  expect(second.resolution?.reasonCode).toBe('MAX_PROVIDER_ATTEMPTS');
  expect(chat).toHaveBeenCalledTimes(1);
  expect(second.runtimeState).toMatchObject({ providerAttempts: 8, unknownRequests: 1, reservedTokens: 15000 });
});

it('preserves the last attempt for a complete admissible answer before optional watermark compaction', async () => {
  const f = fixture(7, true), summaries = vi.fn(async () => reply(JSON.stringify(summary)));
  f.provider.chatStream = summaries;
  const result = await new AgentRunner(f.provider).run(f.spec);
  expect(result.stopReason).toBe('completed');
  expect(summaries).not.toHaveBeenCalled();
  expect(f.requests).toHaveLength(1); expect(f.requests[0].tools).toEqual([]);
  expect(f.requests[0].messages.some(m => String(m.content).includes('historical record'))).toBe(true);
  expect(result.runtimeState?.providerAttempts).toBe(8);
});
