import { describe, expect, it } from 'vitest';
import { retainPartialThinkOpenTag } from '../openai-provider.js';

describe('OpenAI thinking tag stream buffering', () => {
  it('retains only a possible partial opening tag', () => {
    expect(retainPartialThinkOpenTag('hello ')).toBe('');
    expect(retainPartialThinkOpenTag('hello <thi')).toBe('<thi');
    expect(retainPartialThinkOpenTag('hello <thinking')).toBe('<thinking');
  });
});
