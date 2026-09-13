import { describe, expect, it, vi } from 'vitest';
import { loadChatHistory, type ChatState } from './chat.ts';

function state(request: ReturnType<typeof vi.fn>): ChatState {
  return { client: { request } as any, connected: true, sessionKey: 'one', chatLoading: false, chatMessages: [],
    chatThinkingLevel: null, chatSending: false, chatMessage: '', chatAttachments: [], chatRunId: null,
    chatStream: null, chatStreamStartedAt: null, lastError: null };
}

describe('complete paged chat history', () => {
  it('loads older pages and applies the chronological transcript once', async () => {
    const recent = Array.from({ length: 200 }, (_, i) => ({ role: 'user', id: String(i + 201), content: 'recent' }));
    const older = Array.from({ length: 200 }, (_, i) => ({ role: 'user', id: String(i + 1), content: 'old' }));
    const request = vi.fn().mockResolvedValueOnce({ messages: recent, nextBefore: 201, thinkingLevel: 'low' })
      .mockResolvedValueOnce({ messages: older, nextBefore: null });
    const host = state(request);
    await loadChatHistory(host);
    expect(host.chatMessages).toEqual([...older, ...recent]);
    expect(host.chatLoading).toBe(false);
    expect(host.chatThinkingLevel).toBe('low');
    expect(request).toHaveBeenLastCalledWith('chat.history', { sessionKey: 'one', limit: 200, paged: true, before: 201 });
  });

  it('ignores an old session result arriving during pagination', async () => {
    let complete!: (value: unknown) => void;
    const request = vi.fn().mockResolvedValueOnce({ messages: [], nextBefore: 10 })
      .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const host = state(request);
    const pending = loadChatHistory(host);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    host.sessionKey = 'two';
    host.chatMessages = [{ role: 'user', content: 'new session' }];
    complete({ messages: [{ role: 'user', content: 'stale' }], nextBefore: null });
    await pending;
    expect(host.chatMessages).toEqual([{ role: 'user', content: 'new session' }]);
  });

  it('stops non-advancing cursors and preserves the existing transcript on page failure', async () => {
    const request = vi.fn().mockResolvedValue({ messages: [], nextBefore: 10 });
    const host = state(request);
    host.chatMessages = [{ role: 'user', content: 'existing' }];
    await loadChatHistory(host);
    expect(request).toHaveBeenCalledTimes(2);
    expect(host.lastError).toContain('did not advance');
    expect(host.chatMessages).toHaveLength(1);
    expect(host.chatLoading).toBe(false);
  });
});
