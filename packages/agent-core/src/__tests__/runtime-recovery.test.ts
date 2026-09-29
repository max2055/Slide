import { expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import type { AgentRunSpec, LLMProvider, LLMResponse, Message } from '../types.js';

const response = (content: string, finishReason = 'stop'): LLMResponse => ({ content, finishReason,
  toolCalls: [], shouldExecuteTools: false, hasToolCalls: false, usage: { prompt_tokens: 2, completion_tokens: 3 } });
async function run(responses: LLMResponse[], overrides: Partial<AgentRunSpec> = {}) {
  const requests: Message[][] = [];
  const provider: LLMProvider = { getDefaultModel: () => 'fixture',
    chat: async messages => { requests.push(structuredClone(messages)); return responses[Math.min(requests.length - 1, responses.length - 1)]; },
    chatStream: async () => { throw new Error('not streaming'); } };
  const result = await new AgentRunner(provider).run({ initialMessages: [{ role: 'user', content: '输出完整报告' }],
    tools: new ToolRegistry(), model: 'fixture', maxIterations: 20, maxToolResultChars: 1000, hook: new NoopHook(), ...overrides });
  return { result, requests };
}
it('four length responses terminate partial, never completed', async () => {
  const { result, requests } = await run(['甲', '乙', '丙', '丁'].map(s => response(s, 'length')));
  expect(requests).toHaveLength(4);
  expect(result.resolution).toMatchObject({ kind: 'partial', reasonCode: 'OUTPUT_LIMIT' });
  expect(result.finalContent).toBe('甲乙丙丁');
});
it('continuation merges exact overlap and final history contains the complete answer without markers', async () => {
  const { result } = await run([response('第一段。第二', 'length'), response('第二段。')]);
  expect(result.finalContent).toBe('第一段。第二段。');
  expect(result.messages.filter(m => m.role === 'assistant').map(m => m.content)).toEqual([result.finalContent]);
  expect(JSON.stringify(result.messages)).not.toContain('[System:');
});
it('empty finalization remedy returning length goes through the same continuation classifier', async () => {
  const { result } = await run([response(''), response(''), response('前半', 'length'), response('后半')]);
  expect(result.stopReason).toBe('completed');
  expect(result.finalContent).toBe('前半后半');
  expect(result.messages.at(-1)?.content).toBe(result.finalContent);
});

it('alternating error categories share a cumulative limit across a serialized restart', async () => {
  let checkpoint: Record<string, unknown> | undefined;
  const bad = '正在分析数据库状态……\n'.repeat(20);
  const first = await run([response(''), response(bad)], { maxIterations: 2,
    checkpointCallback: async p => { checkpoint = JSON.parse(JSON.stringify(p)); } });
  expect(first.result.runtimeState?.total).toBe(2);
  const second = await run([response('甲', 'length'), response('乙', 'length'), response('丙', 'length')], {
    resumeCheckpoint: checkpoint, maxIterations: 20, recoveryLimits: { total: 4 } });
  expect(second.requests).toHaveLength(3);
  expect(second.result.stopReason).not.toBe('completed');
  expect(second.result.runtimeState).toMatchObject({ total: 4, counts: { empty: 1, repetition: 1, continuation: 2 }, providerAttempts: 5 });
});
it('missing usage is reserved and survives restart; cached usage is not added twice', async () => {
  const { result } = await run([{ ...response(''), usage: {} }, { ...response('完成'), usage: { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 8 } }]);
  expect(result.runtimeState).toMatchObject({ unknownRequests: 1, reservedTokens: 204096, usage: { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 8 } });
});
it.each([401, 403, 400, 402])('does not retry nonrecoverable provider status %i', async providerStatus => {
  const { result, requests } = await run([{ ...response('', 'error'), error: 'provider rejected', providerStatus }]);
  expect(requests).toHaveLength(1);
  expect(result.stopReason).toBe('error');
  expect(result.runtimeError?.providerStatus).toBe(providerStatus);
});
it('cancellation during a recovery checkpoint never starts another request', async () => {
  const controller = new AbortController();
  const { requests, result } = await run([response('')], { signal: controller.signal,
    checkpointCallback: async p => { if ((p.runtime_state_v1 as {total: number}).total === 1) controller.abort(); } });
  expect(requests).toHaveLength(1);
  expect(result.stopReason).toBe('cancelled');
});
it('unknown checkpoint version refuses to dispatch a request', async () => {
  await expect(run([response('bad')], { resumeCheckpoint: { runtime_state_v1: { schemaVersion: 99 } } })).rejects.toThrow('checkpoint');
});
it('uncertain tool intent is never automatically replayed after recovery', async () => {
  const { requests, result } = await run([response('bad')], { resumeCheckpoint: { pending_tool_calls: [{ id: 'write' }] } });
  expect(requests).toHaveLength(0);
  expect(result.resolution?.reasonCode).toBe('TOOL_SETTLEMENT_UNKNOWN');
});

it('cancellation while committing final checkpoint cannot return completed', async () => {
  const controller = new AbortController();
  const { result } = await run([response('完成')], { signal: controller.signal,
    checkpointCallback: async p => { if (p.phase === 'final_response') controller.abort(); } });
  expect(result.stopReason).toBe('cancelled');
});

it('alternating all implemented recovery kinds cannot exceed the default total eight', async () => {
  vi.useFakeTimers();
  try {
    const bad = '正在分析数据库状态……\n'.repeat(20);
    const pending = run([response(bad), response(''), response('甲', 'length'), response(bad), response(''),
      response('乙', 'length'), response('丙', 'length'), { ...response('', 'error'), error: 'busy', providerStatus: 503 }, response('')]);
    await vi.runAllTimersAsync();
    const { result, requests } = await pending;
    expect(requests).toHaveLength(9);
    expect(result.runtimeState).toMatchObject({ total: 8, counts: { empty: 2, repetition: 2, continuation: 3, stream: 1 } });
    expect(result.resolution?.reasonCode).toBe('RECOVERY_LIMIT');
  } finally { vi.useRealTimers(); }
});
it('step exhaustion after a truncated prefix stays partial with matching history', async () => {
  const { result } = await run([response('prefix', 'length')], { maxIterations: 1 });
  expect(result.stopReason).toBe('max_iterations');
  expect(result.finalContent).toBe('prefix');
  expect(result.messages.at(-1)?.content).toBe('prefix');
});
it('cancellation in the terminal checkpoint is still non-success', async () => {
  const controller = new AbortController();
  const { result } = await run([response('done')], { signal: controller.signal,
    checkpointCallback: async p => { if (p.terminal_resolution) controller.abort(); } });
  expect(result.stopReason).toBe('cancelled');
});
