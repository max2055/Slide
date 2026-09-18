import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from '@slide/agent-core';
import { optimizePromptContent } from './optimize.js';

describe('optimizePromptContent', () => {
  it('calls the provider once without tools and returns its text', async () => {
    const chat = vi.fn().mockResolvedValue({ content: 'optimized', finishReason: 'stop' });
    const provider = { chat } as unknown as LLMProvider;
    await expect(optimizePromptContent('original', async () => provider)).resolves.toBe('optimized');
    expect(chat).toHaveBeenCalledOnce();
    expect(chat).toHaveBeenCalledWith([{ role: 'user', content: 'original' }], [], { signal: expect.any(AbortSignal) });
  });

  it('reports provider failures instead of returning an empty success', async () => {
    const provider = { chat: vi.fn().mockResolvedValue({ content: null, finishReason: 'error', error: 'provider unavailable' }) } as unknown as LLMProvider;
    await expect(optimizePromptContent('original', async () => provider)).rejects.toThrow('provider unavailable');
  });

  it('reports an aborted provider call as a timeout', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
    const provider = { chat: vi.fn().mockImplementation(async () => {
      controller.abort();
      return { content: null, finishReason: 'error', error: 'aborted' };
    }) } as unknown as LLMProvider;
    await expect(optimizePromptContent('original', async () => provider)).rejects.toMatchObject({ name: 'TimeoutError' });
    vi.restoreAllMocks();
  });
});
