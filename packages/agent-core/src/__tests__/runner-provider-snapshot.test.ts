import { expect, it, vi } from 'vitest';
import { AgentRunner, NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import type { AgentRunSpec, LLMProvider, LLMResponse } from '../types.js';

const done = (content: string): LLMResponse => ({
  content, finishReason: 'stop', toolCalls: [], hasToolCalls: false, shouldExecuteTools: false,
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const read: LLMResponse = {
  ...done(''), content: null, finishReason: 'tool_calls', hasToolCalls: true, shouldExecuteTools: true,
  toolCalls: [{ id: 'read-1', name: 'read', arguments: {} }],
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function provider(name: string, window: number, output: number, chat: LLMProvider['chat']): LLMProvider {
  return {
    getDefaultModel: () => name,
    getModelCapabilities: vi.fn((model?: string) => ({ model: model ?? name, contextWindowTokens: window,
      preferredOutputTokens: output, maxOutputTokens: output, source: 'configuration' as const, version: name })),
    projectMessages: vi.fn(messages => messages),
    chat: vi.fn(chat),
    chatStream: vi.fn((messages, tools, _callbacks, options) => chat(messages, tools, options)),
  };
}
function spec(runner: AgentRunner, extra: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return { initialMessages: [{ role: 'user', content: 'Inspect resources.' }], tools: new ToolRegistry(),
    model: runner.getDefaultModel(), maxIterations: 5, maxToolResultChars: 1000, hook: new NoopHook(), ...extra };
}

// #689: a config reload must affect future runs, including concurrent starts,
// without changing the client/credentials, model, or context of a live run.
it.each([
  { streaming: false, runTimeoutMs: undefined },
  { streaming: true, runTimeoutMs: undefined },
  { streaming: false, runTimeoutMs: 10_000 },
  { streaming: true, runTimeoutMs: 10_000 },
])('pins provider across tool steps and answer-only views: %j', async ({ streaming, runTimeoutMs }) => {
  const entered = deferred(); const release = deferred();
  const old = provider('old-model', 16000, 500, async (messages, tools, options) => {
    expect(options).toMatchObject({ model: 'old-model', maxTokens: 500 });
    if (!messages.some(m => m.role === 'tool')) return read;
    expect(tools).toEqual([]); // Force the final-view path after one allowed tool.
    return done('old-client');
  });
  const next = provider('new-model', 8000, 250, async (_m, _t, options) => {
    expect(options).toMatchObject({ model: 'new-model', maxTokens: 250 });
    return done('new-client');
  });
  const runner = new AgentRunner(old);
  const hook = new NoopHook(); hook.wantsStreaming = () => streaming;
  const oldCheckpoints: Record<string, unknown>[] = [];
  const newCheckpoints: Record<string, unknown>[] = [];
  const config = spec(runner, { hook, runTimeoutMs, checkpointCallback: async p => { oldCheckpoints.push(p); },
    budgetLimits: { maxToolCalls: 1, maxProviderAttempts: 5, maxTotalTokens: 100000, maxNoProgressSteps: 5 } });
  config.tools.register({ name: 'read', description: 'read', parameters: { type: 'object', properties: {} },
    readOnly: true, concurrencySafe: true, exclusive: false,
    execute: async () => { entered.resolve(); await release.promise; return 'evidence'; } });
  const live = runner.run(config);
  await entered.promise;
  let fresh;
  try {
    runner.setProvider(next);
    fresh = await runner.run(spec(runner, { checkpointCallback: async p => { newCheckpoints.push(p); } }));
  } finally { release.resolve(); }
  const settled = await live;
  expect(fresh?.finalContent).toBe('new-client');
  expect(settled.stopReason).toBe('completed');
  expect(settled.finalContent).toBe('old-client');
  expect(streaming ? old.chatStream : old.chat).toHaveBeenCalledTimes(2);
  expect(next.chat).toHaveBeenCalledTimes(1);
  expect(next.chatStream).not.toHaveBeenCalled();
  const contexts = (checkpoints: Record<string, unknown>[]) => checkpoints.filter(p => p.context_config_v1).map(p => p.context_config_v1);
  expect(contexts(oldCheckpoints)).not.toHaveLength(0);
  for (const context of contexts(oldCheckpoints)) expect(context).toMatchObject({ contextWindowTokens: 16000, maxTokens: 500, version: 'old-model' });
  expect(contexts(newCheckpoints)).not.toHaveLength(0);
  for (const context of contexts(newCheckpoints)) expect(context).toMatchObject({ contextWindowTokens: 8000, maxTokens: 250, version: 'new-model' });
  expect(config.contextWindowTokens).toBeUndefined(); // Caller spec is not changed.
});

it('uses the original provider for reactive compaction after a config reload', async () => {
  const summary = { goal: ['inspect'], constraints: ['read only'], done: [], pending: ['report'], evidence: [], uncertain: [] };
  let ordinary = 0;
  let runner: AgentRunner;
  const next = provider('new-model', 8000, 250, async () => done('wrong-client'));
  const old = provider('old-model', 16000, 500, async (_messages, _tools, options) => {
    expect(options).toMatchObject({ model: 'old-model', maxTokens: 500 });
    if (++ordinary === 1) {
      runner.setProvider(next);
      return { ...done(''), finishReason: 'error', error: 'context window exceeded' };
    }
    return done('recovered-with-old-client');
  });
  old.chatStream = vi.fn(async (_messages, tools, _callbacks, options) => {
    expect(tools).toEqual([]);
    expect(options).toMatchObject({ model: 'old-model', maxTokens: 500 });
    return done(JSON.stringify(summary));
  });
  runner = new AgentRunner(old);
  const checkpoint = vi.fn(async (_payload: Record<string, unknown>) => {});
  const result = await runner.run(spec(runner, {
    initialMessages: [{ role: 'user', content: 'Inspect resources.' },
      { role: 'assistant', content: 'Historical evidence. '.repeat(80) }, { role: 'user', content: 'Report.' }],
    checkpointCallback: checkpoint,
  }));
  expect(result.stopReason).toBe('completed');
  expect(result.finalContent).toBe('recovered-with-old-client');
  expect(old.chat).toHaveBeenCalledTimes(2);
  expect(old.chatStream).toHaveBeenCalledTimes(1);
  expect(next.chat).not.toHaveBeenCalled();
  expect(next.chatStream).not.toHaveBeenCalled();
  expect(next.getModelCapabilities).not.toHaveBeenCalled();
  expect(next.projectMessages).not.toHaveBeenCalled();
  expect(result.runtimeState).toMatchObject({ providerAttempts: 3 });
  expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ context_summary_v1: expect.any(Object) }));
});

it('captures the provider synchronously before the first asynchronous run preparation', async () => {
  const old = provider('old-model', 16000, 500, async () => done('old-client'));
  const next = provider('new-model', 8000, 250, async () => done('new-client'));
  const runner = new AgentRunner(old);
  const live = runner.run(spec(runner));
  runner.setProvider(next);
  const [first, second] = await Promise.all([live, runner.run(spec(runner))]);
  expect(first.finalContent).toBe('old-client');
  expect(second.finalContent).toBe('new-client');
  expect(old.chat).toHaveBeenCalledTimes(1);
  expect(next.chat).toHaveBeenCalledTimes(1);
});

it('keeps the original client when only credentials change for the same model', async () => {
  const next = provider('same-model', 16000, 500, async () => done('replacement-client'));
  const old = provider('same-model', 16000, 500, async messages =>
    messages.some(m => m.role === 'tool') ? done('original-client') : read);
  const runner = new AgentRunner(old);
  const config = spec(runner);
  config.tools.register({ name: 'read', description: 'read', parameters: { type: 'object', properties: {} },
    readOnly: true, concurrencySafe: true, exclusive: false,
    execute: async () => { runner.setProvider(next); return 'evidence'; } });
  const result = await runner.run(config);
  expect(result.finalContent).toBe('original-client');
  expect(old.chat).toHaveBeenCalledTimes(2);
  expect(next.chat).not.toHaveBeenCalled();
  expect(next.getModelCapabilities).not.toHaveBeenCalled();
});
