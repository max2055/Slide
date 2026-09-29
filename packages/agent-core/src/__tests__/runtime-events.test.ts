import { expect, it } from 'vitest';
import { AgentRunner, NoopHook } from '../runner.js';
import { ToolRegistry } from '../tool-registry.js';
import type { LLMProvider, RuntimeEvent } from '../index.js';

it('correlates ordered recovery and readiness without body or unknown usage loss', async () => {
  const events: RuntimeEvent[] = []; let n = 0;
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chatStream: async () => { throw new Error('unused'); }, chat: async () => ({
    content: ++n === 1 ? 'secret-user-prose'.repeat(20) : '正常', finishReason: 'stop', toolCalls: [], shouldExecuteTools: false, hasToolCalls: false, usage: {} }) };
  await new AgentRunner(provider).run({ initialMessages: [{ role: 'user', content: 'private-user-text' }], tools: new ToolRegistry(), model: 'secret-model', hook: new NoopHook(), maxIterations: 5, maxToolResultChars: 100,
    runtimeRunId: '00000000-0000-0000-0000-000000000001', onRuntimeEvent: e => { events.push(e); } });
  expect(events.map(e => e.type)).toEqual(['model.start', 'candidate.reject', 'recovery.start', 'model.start', 'response.ready']);
  expect(new Set(events.map(e => e.runId)).size).toBe(1); expect(new Set(events.map(e => e.turnId)).size).toBe(1);
  expect(events.map(e => e.sequence)).toEqual([1,2,3,4,5]);
  expect(events.at(-1)).toMatchObject({ unknownRequests: 2, recoveryCount: 1 });
  expect(JSON.stringify(events)).not.toMatch(/secret|private/);
});
it.each([() => { throw new Error('observer'); }, async () => { throw new Error('observer'); }])('isolates observer errors from execution', async onRuntimeEvent => {
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chatStream: async () => { throw new Error('unused'); }, chat: async () => ({ content: 'ok', finishReason: 'stop', toolCalls: [], shouldExecuteTools: false, hasToolCalls: false, usage: {} }) };
  expect((await new AgentRunner(provider).run({ initialMessages: [], tools: new ToolRegistry(), model: 'test', hook: new NoopHook(), maxIterations: 1, maxToolResultChars: 100, onRuntimeEvent })).stopReason).toBe('completed');
});
it('observe reports repetition once without a second model execution', async () => {
  const events: RuntimeEvent[] = []; let calls = 0;
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chatStream: async () => { throw new Error('unused'); }, chat: async () => { calls++; return { content: '正在分析数据库状态……\n'.repeat(20), finishReason: 'stop', toolCalls: [], shouldExecuteTools: false, hasToolCalls: false, usage: {} }; } };
  const result = await new AgentRunner(provider).run({ initialMessages: [], tools: new ToolRegistry(), model: 'test', hook: new NoopHook(), maxIterations: 4, maxToolResultChars: 100, supervisorMode: 'observe', onRuntimeEvent: e => { events.push(e); } });
  expect(result.stopReason).toBe('completed'); expect(calls).toBe(1);
  expect(events.map(e => e.type)).toEqual(['model.start', 'candidate.observe_repetition', 'response.ready']);
});
it('correlates each concurrent batch member without serializing tool IDs or arguments', async () => {
  const events: RuntimeEvent[] = []; let calls = 0;
  const tools = new ToolRegistry();
  tools.register({ name: 'read', description: 'read', parameters: { type: 'object', properties: {} }, readOnly: true, concurrencySafe: true, exclusive: false, execute: async () => 'evidence' });
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chatStream: async () => { throw new Error('unused'); }, chat: async () => {
    const toolCalls = calls++ ? [] : [1, 2].map(n => ({ id: `private-${n}`, name: 'read', arguments: { secret: n } }));
    return { content: toolCalls.length ? null : 'ok', finishReason: toolCalls.length ? 'tool_calls' : 'stop', toolCalls, shouldExecuteTools: !!toolCalls.length, hasToolCalls: !!toolCalls.length, usage: {} };
  } };
  await new AgentRunner(provider).run({ initialMessages: [], tools, model: 'test', hook: new NoopHook(), maxIterations: 4, maxToolResultChars: 100, onRuntimeEvent: e => { events.push(e); } });
  expect(events.filter(e => e.type === 'tool.start').map(e => e.toolIndex)).toEqual([1, 2]);
  expect(events.filter(e => e.type === 'tool.returned').map(e => e.toolIndex).sort()).toEqual([1, 2]);
  expect(JSON.stringify(events)).not.toMatch(/private|secret/);
});
