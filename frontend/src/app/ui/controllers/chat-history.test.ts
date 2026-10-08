import { describe, expect, it, vi } from 'vitest';
import { loadChatHistory, type ChatState } from './chat.ts';
import { handleDirectAdapterEvent } from '../direct-gateway.ts';
import { getChatProjection } from '../chat/message-projection.ts';

function state(request: ReturnType<typeof vi.fn>): ChatState {
  return { client: { request } as any, connected: true, sessionKey: 'one', chatLoading: false, chatMessages: [],
    chatThinkingLevel: null, chatSending: false, chatMessage: '', chatAttachments: [], chatRunId: null,
    chatStream: null, chatStreamStartedAt: null, lastError: null };
}

describe('complete paged chat history', () => {
  it('explicit refresh clears stale notices on a pending empty session', async () => {
    const host = state(vi.fn()); host.sessionKey = ''; host.lastError = 'old send failure';
    await loadChatHistory(host, { clearNotices: true });
    expect(host.lastError).toBeNull();
  });
  it('explicit refresh clears run/recovery notices while keeping connection failures', async () => {
    const host = Object.assign(state(vi.fn().mockResolvedValue({ messages: [] })), {
      lastError: 'old failure', chatRecoveryNotice: 'old recovery', connectionError: 'network interrupted' });
    await loadChatHistory(host, { clearNotices: true });
    expect(host.lastError).toBeNull();
    expect(host.chatRecoveryNotice).toBeNull();
    expect(host.connectionError).toBe('network interrupted');
  });
  it('automatic history refresh preserves the actionable run error', async () => {
    const host = state(vi.fn().mockResolvedValue({ messages: [] }));
    host.lastError = '余额不足，请充值后重试';
    await loadChatHistory(host);
    expect(host.lastError).toBe('余额不足，请充值后重试');
  });
  it('failed display snapshot retains the error after asynchronous history reload', async () => {
    const host = Object.assign(state(vi.fn().mockResolvedValue({ messages: [{ role: 'user', content: 'question' }] })),
      { chatRunId: 'run', chatSending: true, chatQueue: [], settings: {}, applySettings() {},
        chatToolMessages: [], chatStreamSegments: [], toolStreamById: new Map(), toolStreamOrder: [] });
    handleDirectAdapterEvent(host as any, { type: 'stream.snapshot', sessionKey: 'one',
      stream: { version: 1, streamEpoch: 'epoch', runId: 'run', turnId: 'turn', subscriptionId: 'sub', fromSeq: 1, toSeq: 1 },
      snapshot: { version: 1, runId: 'run', attempt: 1, sequence: 1, phase: 'generating', parts: [],
        terminal: 'failed', runState: 'failed', error: '余额不足，请充值后重试' } });
    await vi.waitFor(() => expect(host.chatMessages).toHaveLength(1));
    expect(host.lastError).toBe('余额不足，请充值后重试');
    expect(host.chatSending).toBe(false);
  });
  it('a late history response preserves live snapshot, suffix cursor and cancellation', async () => {
    let complete!: (value: unknown) => void;
    const history = [{ role: 'user', content: 'history', runId: 'run' },
      { id: 'saved-live', role: 'assistant', content: 'live', runId: 'run' },
      { id: 'saved-tool', role: 'tool', content: 'ok', messageParts: { runId: 'run' } },
      { id: 'older', role: 'assistant', content: 'older turn', runId: 'older-run' }];
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
      .mockResolvedValue({ messages: history });
    const host = Object.assign(state(request), {
      chatRunId: 'run', chatSending: true, chatQueue: [], settings: {}, applySettings() {},
      chatToolMessages: [], chatStreamSegments: [], toolStreamById: new Map(), toolStreamOrder: [],
    });
    const pending = loadChatHistory(host);
    const stream = { version: 1 as const, streamEpoch: 'epoch', runId: 'run', turnId: 'turn', subscriptionId: 'sub', fromSeq: 1, toSeq: 1 };
    handleDirectAdapterEvent(host as any, { type: 'stream.snapshot', sessionKey: 'one', stream,
      snapshot: { version: 1, runId: 'run', attempt: 1, sequence: 1, phase: 'generating', parts: [
        { messageId: 'm', part: { id: 'text', type: 'text', text: 'live', source: 'fact', status: 'partial' } } ] } });
    complete({ messages: history });
    await pending;
    expect(host.chatStream).toBe('live');
    expect(host.chatMessages).toEqual([history[0], history[3]]);
    handleDirectAdapterEvent(host as any, { type: 'stream.delta', sessionKey: 'one', stream: { ...stream, fromSeq: 2, toSeq: 2 },
      projection: { version: 1, runId: 'run', attempt: 1, sequence: 2, operations: [{ type: 'run.terminal', outcome: 'cancelled' }] } });
    expect(getChatProjection(host as any, 'run')?.terminal).toBe('cancelled');
    expect(host.chatRunId).toBeNull();
    expect(host.chatSending).toBe(false);
    await vi.waitFor(() => expect(host.chatMessages).toEqual(history));
    expect(request).toHaveBeenCalledTimes(2);
  });

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
