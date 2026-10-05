import { expect, it } from 'vitest';
import { AgentRunner, NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import type { AgentRunSpec, LLMProvider, LLMResponse, Message } from '../types.js';

const bad = '正在分析数据库状态……\n'.repeat(20);
const response = (content: string, finishReason = 'stop'): LLMResponse => ({ content, finishReason,
  toolCalls: [], shouldExecuteTools: false, hasToolCalls: false, usage: { prompt_tokens: 2, completion_tokens: 3 } });

async function run(responses: LLMResponse[], overrides: Partial<AgentRunSpec> = {}) {
  const requests: Message[][] = [];
  const checkpoints: unknown[] = [];
  const provider: LLMProvider = {
    getDefaultModel: () => 'fixture',
    chat: async messages => { requests.push(structuredClone(messages)); return responses[Math.min(requests.length - 1, responses.length - 1)]; },
    chatStream: async () => { throw new Error('not streaming'); },
  };
  const result = await new AgentRunner(provider).run({ initialMessages: [{ role: 'user', content: '诊断数据库并输出结论' }],
    tools: new ToolRegistry(), model: 'fixture', maxIterations: 10, maxToolResultChars: 1000, hook: new NoopHook(),
    checkpointCallback: async p => { checkpoints.push(p); }, ...overrides });
  return { result, requests, checkpoints };
}

it('repeated_text_accepted regression: rejects all three candidates and persists none', async () => {
  const { result, requests, checkpoints } = await run([response(bad)]);
  expect(result.stopReason).toBe('error');
  expect(result.resolution?.reasonCode).toBe('MODEL_REPETITION_LOOP');
  expect(requests).toHaveLength(3);
  expect(JSON.stringify([result.messages, requests, checkpoints])).not.toContain(bad.replaceAll('\n', '\\n'));
});
it('accepts recovery while excluding rejected text and temporary reminders from history', async () => {
  const { result, requests } = await run([response(bad), response('数据库连接正常。')]);
  expect(result.finalContent).toBe('数据库连接正常。');
  expect(requests).toHaveLength(2);
  expect(result.messages).toEqual([{ role: 'user', content: '诊断数据库并输出结论' }, { role: 'assistant', id: expect.stringMatching(/^model_/), content: '数据库连接正常。', tool_calls: undefined }]);
});
it('classifies the empty-response remedy again instead of accepting repetition', async () => {
  const { result } = await run([response(''), response(''), response(bad)]);
  expect(result.stopReason).toBe('error');
  expect(result.resolution?.reasonCode).toBe('MODEL_REPETITION_LOOP');
});
it.each(['', '好', '是的', 'SELECT 1 UNION ALL SELECT 1;', '{"values":[1,1,1]}'])('does not confuse legal short/structured text with repetition: %s', async text => {
  const { result } = await run([response(text || '正常')]);
  expect(result.stopReason).toBe('completed');
});

it('observe mode makes no extra model or tool calls', async () => {
  const { result, requests } = await run([response(bad)], { supervisorMode: 'observe' });
  expect(requests).toHaveLength(1);
  expect(result.stopReason).toBe('completed');
});
it('drains injections without appending a rejected candidate', async () => {
  let injected = false;
  const { result, requests, checkpoints } = await run([response(bad), response('已处理新要求。')], {
    injectionCallback: async () => { if (injected) return []; injected = true; return [{ role: 'user', content: '只检查连接' }]; },
  });
  expect(result.hadInjections).toBe(true);
  expect(JSON.stringify([requests, checkpoints, result.messages])).not.toContain('正在分析');
  expect(result.messages.some(m => typeof m.content === 'string' && m.content.includes('只检查连接'))).toBe(true);
});
it('rejects unresolved tool intent without executing or completing it', async () => {
  const candidate = { ...response('done'), hasToolCalls: true, toolCalls: [{ id: 'pending', name: 'write', arguments: {} }] };
  const { result, requests } = await run([candidate]);
  expect(result.resolution?.reasonCode).toBe('UNRESOLVED_TOOL_CALLS');
  expect(requests).toHaveLength(1);
  expect(result.toolsUsed).toEqual([]);
});
it('user requested repetition is not rejected', async () => {
  const { result, requests } = await run([response(bad)], { initialMessages: [{ role: 'user', content: '请重复以下文字二十次：正在分析数据库状态……' }] });
  expect(result.stopReason).toBe('completed');
  expect(requests).toHaveLength(1);
});

it('step exhaustion after rejection is partial and never silently completed', async () => {
  const { result, requests } = await run([response(bad)], { maxIterations: 1 });
  expect(result).toMatchObject({ stopReason: 'max_iterations', finalContent: '', resolution: { kind: 'partial', reasonCode: 'MAX_MODEL_STEPS' } });
  expect(requests).toHaveLength(1);
});
it('historical repetition requests do not exempt the current request', async () => {
  const { result } = await run([response(bad)], { initialMessages: [
    { role: 'user', content: '请重复以下文字二十次' }, { role: 'assistant', content: '旧回复' }, { role: 'user', content: '诊断数据库' },
  ] });
  expect(result.resolution?.reasonCode).toBe('MODEL_REPETITION_LOOP');
});
