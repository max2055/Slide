import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@slide/agent-core';
import { AnthropicProvider } from './llm-provider.js';

function fixture() {
  const response = {
    content: [{ type: 'text', text: 'Complete.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 2 },
  };
  const create = vi.fn(() => ({
    withResponse: async () => ({ data: response, response: { headers: new Headers() } }),
  }));
  const stream = vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Complete.' } };
    },
    finalMessage: async () => response,
  }));
  const provider = new AnthropicProvider();
  Object.assign(provider, { client_: { messages: { create, stream } } });
  return { provider, create, stream };
}

function conversation(): Message[] {
  return [
    { role: 'user', content: 'Read the status.' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_status', type: 'function', function: { name: 'read_status', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_status', content: 'status: healthy' },
  ];
}

describe.each(['chat', 'chatStream'] as const)('AnthropicProvider.%s tool results (#476)', method => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', ' \t\n'],
  ])('rejects a %s tool_call_id locally with zero SDK requests', async (_label, id) => {
    const { provider, create, stream } = fixture();
    const messages = conversation();
    messages.push({ role: 'tool', content: 'must not be discarded', ...(id === undefined ? {} : { tool_call_id: id }) });
    const before = structuredClone(messages);
    const onContentDelta = vi.fn();
    const result = method === 'chat'
      ? provider.chat(messages, [])
      : provider.chatStream(messages, [], { onContentDelta });

    await expect(result).rejects.toThrow('ANTHROPIC_TOOL_RESULT_ID_REQUIRED: tool message requires a non-empty tool_call_id');
    expect(create).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(onContentDelta).not.toHaveBeenCalled();
    expect(messages).toEqual(before);
  });

  it('preserves a valid tool call/result pair and its content', async () => {
    const { provider, create, stream } = fixture();
    const messages = conversation();
    const before = structuredClone(messages);
    const onContentDelta = vi.fn();
    const result = method === 'chat'
      ? await provider.chat(messages, [])
      : await provider.chatStream(messages, [], { onContentDelta });

    expect(result).toMatchObject({ content: 'Complete.', finishReason: 'stop' });
    const dispatch = method === 'chat' ? create : stream;
    expect(dispatch).toHaveBeenCalledOnce();
    expect(method === 'chat' ? stream : create).not.toHaveBeenCalled();
    expect(dispatch.mock.calls[0]).toEqual([
      expect.objectContaining({ messages: [
        { role: 'user', content: 'Read the status.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_status', name: 'read_status', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_status', content: 'status: healthy' }] },
      ] }),
      { signal: undefined },
    ]);
    if (method === 'chatStream') expect(onContentDelta).toHaveBeenCalledWith('Complete.');
    expect(messages).toEqual(before);
  });
});
