import { describe, expect, it } from 'vitest';
import { normalizeProviderError, retainPartialThinkOpenTag } from '../openai-provider.js';

describe('OpenAI thinking tag stream buffering', () => {
  it('retains only a possible partial opening tag', () => {
    expect(retainPartialThinkOpenTag('hello ')).toBe('');
    expect(retainPartialThinkOpenTag('hello <thi')).toBe('<thi');
    expect(retainPartialThinkOpenTag('hello <thinking')).toBe('<thinking');
  });

  it('turns an upstream 402 balance error into an actionable message', () => {
    expect(normalizeProviderError({ status: 402, message: 'Insufficient Balance', code: 'invalid_request_error' })).toEqual({
      status: 402,
      errorCode: 'LLM_INSUFFICIENT_BALANCE',
      message: '当前大模型服务余额不足，请充值或切换可用模型提供商后重试。',
    });
  });
});

it('retains streamed length finish reason and usage; transport retries are disabled', async () => {
  const { OpenAIProvider } = await import('../openai-provider.js');
  const provider = new OpenAIProvider({ apiKey: 'fixture' });
  expect((provider as any).client.maxRetries).toBe(0);
  (provider as any).client.chat.completions.create = async () => (async function* () {
    yield { choices: [{ delta: { content: 'prefix' }, finish_reason: null }] };
    yield { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 4, completion_tokens: 6 } };
  })();
  const response = await provider.chatStream([], [], { onContentDelta: () => {} });
  expect(response).toMatchObject({ content: 'prefix', finishReason: 'length', usage: { prompt_tokens: 4, completion_tokens: 6 } });
});
it('an abruptly ended stream is not completed and truncated tool arguments are not executed', async () => {
  const { OpenAIProvider } = await import('../openai-provider.js');
  const provider = new OpenAIProvider({ apiKey: 'fixture' });
  (provider as any).client.chat.completions.create = async () => (async function* () {
    yield { choices: [{ delta: { content: 'partial' } }] };
  })();
  expect(await provider.chatStream([], [], { onContentDelta: () => {} })).toMatchObject({ finishReason: 'error', errorCode: 'INCOMPLETE_STREAM', shouldExecuteTools: false });
});
it('nonstreaming OpenAI responses preserve output limits, including incomplete tool calls', async () => {
  const { OpenAIProvider } = await import('../openai-provider.js');
  const provider = new OpenAIProvider({ apiKey: 'fixture' });
  (provider as any).client.chat.completions.create = async () => ({ choices: [{ finish_reason: 'length', message: { content: 'prefix',
    tool_calls: [{ id: 'one', function: { name: 'write', arguments: '{' } }] } }] });
  expect(await provider.chat([], [])).toMatchObject({ finishReason: 'length', shouldExecuteTools: false, usage: {} });
});
