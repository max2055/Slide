import { describe, expect, it } from 'vitest';
import { AgentRunner, NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import type { AgentHookContext, LLMProvider, LLMResponse, Message } from '../types.js';

const response = (content: string, finishReason = 'stop'): LLMResponse => ({
  content, finishReason, toolCalls: [], shouldExecuteTools: false, hasToolCalls: false,
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

// Frozen against main@07b3e6ce458b0b4576d356a97d78ab17df3ddd66 BEFORE migration.
// Original traces remain in docs/slide/runtime-v2-source/legacy-runtime-traces.snap.
// Current snapshots change only for explicitly fixed defects/contracts.
const scenarios = [
  { name: 'legacy defect: repeated_text_accepted', responses: [response('正在分析数据库状态……\n'.repeat(20))] },
  { name: 'legacy defect: length_exhaustion_accepted', responses: [1, 2, 3, 4].map(i => response(`截断片段${i}`, 'length')) },
  { name: 'legacy defect: continuation_final_drops_prefix', responses: [response('第一部分结论。', 'length'), response('第二部分结论。')] },
  { name: 'legacy defect: empty_finalization_length_bypasses_recovery', responses: [response(''), response(''), response('仍未完成的截断答案', 'length')] },
  { name: 'normal response', responses: [response('诊断完成。')] },
  { name: 'provider error', responses: [{ ...response('', 'error'), error: 'fixture failure' }] },
];

const copy = (value: unknown) => JSON.parse(JSON.stringify(value));

// Frozen traces assert the pre-identity API; canonical ID invariants have their
// own checkpoint roundtrip tests. Do not replace the historical snapshots.
const legacyCheckpointCopy = (payload: Record<string, unknown>) => {
  const result = copy(payload);
  delete result.canonical_run_id;
  for (const message of [result.assistantMessage, ...(result.completedToolResults ?? [])]) {
    if (!message) continue;
    for (const key of ['id', 'runId', 'turnId', 'source']) delete message[key];
  }
  return result;
};

describe('frozen legacy compatibility traces', () => {
  it.each(scenarios)('$name', async ({ responses }) => {
    const trace: unknown[] = [];
    let requests = 0;
    const chat: LLMProvider['chat'] = async (messages, tools, options) => {
      trace.push(['request', copy(messages), copy(tools), options?.model]);
      return responses[Math.min(requests++, responses.length - 1)];
    };
    const hook = new NoopHook();
    hook.beforeIteration = async ctx => { trace.push(['before', copy(ctx)]); };
    hook.afterIteration = async ctx => { trace.push(['after', copy(ctx)]); };
    hook.finalizeContent = (ctx, content) => { trace.push(['finalize', ctx.iteration, content]); return content; };
    const result = await new AgentRunner({ chat, chatStream: (messages, tools, _callbacks, options) => chat(messages, tools, options), getDefaultModel: () => 'fixture' }).run({
      initialMessages: [{ role: 'user', content: '诊断数据库并输出结论' }], tools: new ToolRegistry(),
      model: 'fixture', maxIterations: 10, maxToolResultChars: 1000, hook,
      checkpointCallback: async payload => { trace.push(['checkpoint', legacyCheckpointCopy(payload)]); },
      onProviderRequest: promise => { trace.push(['request-observed']); void promise.then(() => trace.push(['settled'])); },
    });
    expect({ requests, result, trace }).toMatchSnapshot();
  });

  it('preserves streaming thinking, injection order, provider replacement and public defaults', async () => {
    const events: unknown[] = [];
    const contexts: Message[][] = [];
    let calls = 0;
    const provider: LLMProvider = {
      getDefaultModel: () => 'replacement',
      chat: async () => { throw new Error('stream expected'); },
      chatStream: async (messages, _tools, callbacks) => {
        contexts.push(copy(messages));
        await callbacks.onThinkingDelta?.('thinking');
        await callbacks.onContentDelta?.(`answer${++calls}`);
        return response(`answer${calls}`);
      },
    };
    const hook = new NoopHook();
    hook.wantsStreaming = () => true;
    hook.emitReasoning = async text => { events.push(['thinking', text]); };
    hook.emitReasoningEnd = async () => { events.push(['thinking-end']); };
    hook.onStream = async (_ctx, text) => { events.push(['text', text]); };
    hook.onStreamEnd = async (_ctx, resuming) => { events.push(['stream-end', resuming]); };
    hook.afterIteration = async (ctx: AgentHookContext) => { events.push(['after', ctx.iteration]); };
    const runner = new AgentRunner({ ...provider, getDefaultModel: () => 'original' });
    expect(runner.getDefaultModel()).toBe('original');
    runner.setProvider(provider);
    expect(runner.getDefaultModel()).toBe('replacement');
    let drains = 0;
    const result = await runner.run({
      initialMessages: [{ role: 'user', content: 'first' }], tools: new ToolRegistry(), model: 'fixture',
      maxIterations: 4, maxToolResultChars: 1000, hook,
      injectionCallback: async () => ++drains === 1 ? [{ role: 'user', content: 'follow-up' }] : [],
      checkpointCallback: async payload => { events.push(['checkpoint', legacyCheckpointCopy(payload)]); },
    });
    expect({ events, contexts, result, calls, drains }).toMatchSnapshot();
  });
});
