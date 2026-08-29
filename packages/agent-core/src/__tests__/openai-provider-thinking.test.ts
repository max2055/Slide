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
