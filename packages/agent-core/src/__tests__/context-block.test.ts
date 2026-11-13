import { expect, it, vi } from 'vitest';
import { projectContextBlocks, type ContextBlock } from '../context-block.js';
import { OpenAIProvider } from '../openai-provider.js';

it.each([['first', 'second'], ['same', 'same']])('MAX-464 gives legacy system occurrences unique stable identities (%s, %s)', async (first, second) => {
  const blocks: ContextBlock[] = [first, second].map(content => ({ kind: 'history', sourceIds: [], authority: 'user', lifetime: 'request', priority: 1, tokenPolicy: 'bounded', messages: [{ role: 'system', content, source: 'derived' }] }));
  // Include duplicate occurrences within a single block as well as across blocks.
  blocks[0].messages!.push({ role: 'system', content: first, source: 'derived' });
  const messages = projectContextBlocks(blocks);
  expect(projectContextBlocks(blocks)).toEqual(messages);
  const ids = messages.flatMap(m => m.tool_calls?.map(c => c.id) ?? []);
  expect(new Set(ids).size).toBe(3);
  expect(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id)).toEqual(ids);
  expect(messages.some(m => m.role === 'system' || m.contextAuthority === 'policy')).toBe(false);
  const provider = new OpenAIProvider({ apiKey: 'fixture', model: 'fixture' });
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} });
  // Capture the actual provider wire projection; no external Provider call.
  Object.assign(provider, { client: { chat: { completions: { create } } } });
  await provider.chat(messages, []);
  const wire = create.mock.calls[0][0].messages;
  expect(wire.filter((m: { role: string }) => m.role === 'tool').map((m: { tool_call_id: string }) => m.tool_call_id)).toEqual(ids);
});
