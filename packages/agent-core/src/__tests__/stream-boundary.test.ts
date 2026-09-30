import { expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import { Session } from '../session.js';
import { StreamBoundary } from '../runtime/stream-boundary.js';
import type { AgentHookContext, AgentRunSpec, LLMProvider, LLMResponse, StreamCallbacks } from '../types.js';

const reply = (content: string): LLMResponse => ({ content, finishReason: 'stop', toolCalls: [], usage: { prompt_tokens: 2, completion_tokens: 3 }, hasToolCalls: false, shouldExecuteTools: false });
function spec(provider: LLMProvider, overrides: Partial<AgentRunSpec> = {}) {
  return new AgentRunner(provider).run({ initialMessages: [{ id: 'user-fact', role: 'user', content: 'diagnose' }],
    tools: new ToolRegistry(), model: 'fixture', hook: new NoopHook(), maxIterations: 10, maxToolResultChars: 1000, ...overrides });
}

it('stops transport recovery without a durable anchor and discards an uncommitted tail', async () => {
  let calls = 0;
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chat: async () => { throw new Error('unused'); },
    chatStream: async (_m, _t, c) => { calls++; await c.onThinkingDelta?.('discard'); await c.onContentDelta('discard'); throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); } };
  const hook = new NoopHook(); hook.wantsStreaming = () => true;
  const reset = vi.fn(); (hook as any).onCandidateRejected = reset;
  const result = await spec(provider, { hook });
  expect(calls).toBe(1); expect(result.resolution?.reasonCode).toBe('STREAM_ANCHOR_UNAVAILABLE');
  expect(reset.mock.calls[0][0].streamReset).toMatchObject({ anchor: null, discardedBytes: 14 });
  expect(JSON.stringify(result.messages)).not.toContain('discard');
});

it('tool checkpoint survives reset and restart without replaying a tool or consuming its approval again', async () => {
  vi.useFakeTimers();
  try {
    const execute = vi.fn(async () => 'settled'); const approval = vi.fn();
    const tools = new ToolRegistry(); tools.register({ name: 'read', description: 'read', parameters: { type: 'object', properties: {} }, readOnly: false, concurrencySafe: false, exclusive: true, execute: async () => { approval(); return execute(); } });
    const tool = { ...reply('durable narration'), toolCalls: [{ id: 'tool-1', name: 'read', arguments: {} }], hasToolCalls: true, shouldExecuteTools: true };
    let calls = 0; let saved: Record<string, unknown> = {}; const checkpoints: Record<string, unknown>[] = []; const contexts: unknown[] = []; const callbacks: StreamCallbacks[] = [];
    const provider: LLMProvider = { getDefaultModel: () => 'fixture', chat: async () => { throw new Error('unused'); }, chatStream: async (m, _t, c) => {
      calls++; contexts.push(structuredClone(m)); callbacks.push(c);
      await c.onThinkingDelta?.(calls === 1 ? 'durable reasoning' : calls === 2 ? 'discard reasoning' : 'fresh reasoning');
      await c.onContentDelta(calls === 1 ? tool.content! : calls === 2 ? 'discard text' : 'fresh answer');
      if (calls === 2) { await c.onToolCallDelta?.({ index: 0, arguments: '{' } as any); throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }
      return calls === 1 ? tool : reply('fresh answer');
    } };
    const hook = new NoopHook(); hook.wantsStreaming = () => true; const resets: any[] = [];
    (hook as any).onCandidateRejected = (ctx: AgentHookContext, text: string) => resets.push({ ...ctx.streamReset, text });
    const first = spec(provider, { tools, hook, maxIterations: 2, checkpointCallback: async cp => { saved = structuredClone(cp); checkpoints.push(saved); } });
    await vi.runAllTimersAsync(); const result = await first;
    expect(result.stopReason).toBe('max_iterations');
    expect(saved.stream_state_v1).toMatchObject({ attempt: 2, discardedBytes: expect.any(Number), anchor: { text: 'durable narration', reasoning: 'durable reasoning', source: 'checkpoint', messageIds: expect.arrayContaining([expect.stringMatching(/^cp_/)]) } });
    expect(resets[0].text).toBe('durable narration'); expect(resets[0].anchor.reasoning).toBe('durable reasoning');
    const discarded = (saved.stream_state_v1 as any).discardedBytes; expect(discarded).toBeGreaterThan(20);
    const session = new Session('fixture'); session.messages = [{ id: 'user-fact', role: 'user', content: 'diagnose' }]; session.metadata.runtime_checkpoint = saved;
    new AgentRunner(provider)._restoreRuntimeCheckpoint(session as any);
    const second = await spec(provider, { tools, hook, initialMessages: session.messages as any, resumeCheckpoint: saved, checkpointCallback: async cp => { saved = structuredClone(cp); } });
    expect(second.stopReason, JSON.stringify({ error: second.error, resolution: second.resolution })).toBe('completed'); expect(execute).toHaveBeenCalledTimes(1); expect(approval).toHaveBeenCalledTimes(1);
    expect(saved.stream_state_v1).toMatchObject({ attempt: 3, discardedBytes: discarded });
    expect(second.runtimeState).toMatchObject({ providerAttempts: 3, counts: { stream: 1 }, unknownRequests: 1, usage: { prompt_tokens: 4, completion_tokens: 6 } });
    expect(JSON.stringify(contexts)).not.toContain('discard');
    const before = resets.length; await callbacks[1].onThinkingDelta?.('late'); await callbacks[1].onContentDelta('late'); expect(resets).toHaveLength(before);
    expect(checkpoints.find(cp => cp.phase === 'tools_completed')?.checkpoint_id).toBe((saved.stream_state_v1 as any).anchor.checkpointId);
    expect(saved.checkpoint_id).not.toBe((saved.stream_state_v1 as any).anchor.checkpointId);
  } finally { vi.useRealTimers(); }
});

it('a response_ready checkpoint cannot restore a candidate as a canonical final assistant', async () => {
  let saved: Record<string, unknown> = {};
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chat: async () => reply('candidate'), chatStream: async () => { throw new Error('unused'); } };
  await spec(provider, { checkpointCallback: async cp => { saved = structuredClone(cp); } });
  const session = new Session('fixture'); session.metadata.runtime_checkpoint = saved;
  expect(new AgentRunner(provider)._restoreRuntimeCheckpoint(session as any)).toBe(false);
  expect(session.messages).toEqual([]);
  expect((saved.stream_state_v1 as any).anchor.text).toBe('');
});

it('malformed stream epochs fail closed before dispatch', () => {
  expect(() => new StreamBoundary({ schemaVersion: 2 })).toThrow('Invalid stream');
});
