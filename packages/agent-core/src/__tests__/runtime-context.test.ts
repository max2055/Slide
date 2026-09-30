import { expect, it } from 'vitest';
import { ContextManager, estimatePromptTokens, normalizeToolGroups } from '../runtime/context-manager.js';
import { ToolRegistry } from '../tool-registry.js';
import { NoopHook, AgentRunner } from '../runner.js';
import type { AgentRunSpec, Message } from '../types.js';
const spec = (extra: Partial<AgentRunSpec> = {}): AgentRunSpec => ({ initialMessages: [], tools: new ToolRegistry(), model: 'test', maxIterations: 2, maxToolResultChars: 1000, hook: new NoopHook(), contextWindowTokens: 8000, maxTokens: 500, ...extra });
const call: Message = { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } }, { id: 'b', type: 'function', function: { name: 'write', arguments: '{}' } }] };
it('counts Chinese, schemas, images and framing conservatively', () => {
  expect(estimatePromptTokens([{ role: 'user', content: '中文'.repeat(1000) }], [])).toBeGreaterThanOrEqual(6000);
  expect(estimatePromptTokens([], [{ description: 'x'.repeat(9000) }])).toBeGreaterThanOrEqual(9000);
  expect(estimatePromptTokens([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }] }], [])).toBeGreaterThanOrEqual(4096);
});
it('normalizes atomic batches without retaining orphans or duplicate results or changing raw messages', () => {
  const input: Message[] = [{ role: 'tool', tool_call_id: 'orphan', content: 'bad' }, call, { role: 'tool', tool_call_id: 'a', content: 'ok' }, { role: 'tool', tool_call_id: 'a', content: 'duplicate' }, { role: 'user', content: 'next' }];
  const before = structuredClone(input);
  const normalized = normalizeToolGroups(input);
  expect(normalized.map(m => m.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
  expect(normalized[2]).toMatchObject({ tool_call_id: 'b' });
  expect(input).toEqual(before);
});
it('bounds giant single tool results only in projection', () => {
  const input: Message[] = [{ role: 'user', content: 'goal' }, call, { role: 'tool', tool_call_id: 'a', content: '中'.repeat(10000) }];
  const manager = new ContextManager(spec());
  const projection = manager.project(input);
  manager.assertFits(projection);
  expect(JSON.stringify(input)).toContain('中'.repeat(10000));
});
it('impossible latest user or schema fails explicitly with no provider dispatch', async () => {
  let calls = 0;
  const runner = new AgentRunner({ getDefaultModel: () => 'test', chat: async () => { calls++; throw new Error('must not dispatch'); }, chatStream: async () => { throw new Error('must not dispatch'); } });
  const result = await runner.run(spec({ initialMessages: [{ role: 'user', content: '中'.repeat(10000) }] }));
  expect(calls).toBe(0);
  expect(result.resolution?.reasonCode).toBe('CONTEXT_UNRECOVERABLE');
});
it('giant schemas fail admission even when the tokenizer throws and degrades', async () => {
  for (const kind of ['schema', 'throw']) {
    let calls = 0; const tools = new ToolRegistry();
    tools.getDefinitions = () => [{ name: 'huge', description: 'x'.repeat(9000), parameters: { type: 'object', properties: {} } }];
    const runner = new AgentRunner({ getDefaultModel: () => 'test', countPromptTokens: kind === 'throw' ? () => { throw new Error('broken tokenizer'); } : undefined,
      chat: async () => { calls++; throw new Error('dispatch'); }, chatStream: async () => { calls++; throw new Error('dispatch'); } });
    const result = await runner.run(spec({ tools, initialMessages: [{ role: 'user', content: 'hi' }] }));
    expect(calls).toBe(0);
    expect(result.resolution?.reasonCode).toBe('CONTEXT_UNRECOVERABLE');
  }
});
it('current user and recent complete tool groups remain protected in a long single turn', () => {
  const raw: Message[] = [{ role: 'system', content: 'read only' }, { role: 'user', content: 'goal db-42' }];
  for (let i = 0; i < 5; i++) raw.push({ role: 'assistant', content: null, tool_calls: [{ id: String(i), type: 'function', function: { name: 'inspect', arguments: '{"id":"db-42"}' } }] }, { role: 'tool', tool_call_id: String(i), content: `evidence-${i}` });
  const manager = new ContextManager(spec()); const split = manager.split(raw);
  expect(split.end).toBe(8); expect(split.retained).toHaveLength(4);
  expect(split.pins).toContainEqual(raw[1]);
  expect(JSON.stringify(split.pins)).toContain('result_recorded_not_success_assertion');
});
it('checkpoint or hook schema changes are checked again at the actual provider boundary', async () => {
  const tools = new ToolRegistry(); let calls = 0;
  const runner = new AgentRunner({ getDefaultModel: () => 'test', chat: async () => { calls++; throw new Error('dispatch'); }, chatStream: async () => { throw new Error('dispatch'); } });
  const result = await runner.run(spec({ tools, initialMessages: [{ role: 'user', content: 'hi' }], checkpointCallback: async () => {
    tools.getDefinitions = () => [{ name: 'late', description: 'x'.repeat(9000), parameters: { type: 'object', properties: {} } }];
  } }));
  expect(calls).toBe(0); expect(result.runtimeError?.code).toBe('CONTEXT_UNRECOVERABLE');
});
