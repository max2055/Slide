import { describe, expect, it, vi } from 'vitest';
import { flushChatQueueForEvent, handleSendChat, type ChatHost } from './app-chat.ts';
import { activateChatSession } from './chat-session-state.ts';

function host(request = vi.fn().mockResolvedValue({ sessions: [] })) {
  return {
    client: { request, cancelChat: vi.fn(() => true) }, connected: true,
    sessionKey: 'main', chatMessage: '', chatAttachments: [], chatQueue: [],
    chatMessages: [], chatSending: false, chatRunId: null, chatStream: null,
    chatModelCatalog: [], chatModelOverrides: {}, refreshSessionsAfterChat: new Set(),
    settings: {}, applySettings: vi.fn(), updateComplete: Promise.resolve(),
  } as unknown as ChatHost;
}

describe('MAX-627 chat input', () => {
  it.each(['stop', 'wait', 'exit', 'abort', 'esc', 'STOP', 'Wait'])('sends %s as ordinary text (#708)', async word => {
    const state = host(); state.chatMessage = word;
    await handleSendChat(state);
    expect(state.client!.request).toHaveBeenCalledWith('chat.send', expect.objectContaining({ message: word }));
    expect(state.chatMessages).toHaveLength(1);
    expect(state.client!.cancelChat).not.toHaveBeenCalled();
  });

  it('queues plain stop during a run and keeps /stop cancellation (#708)', async () => {
    const state = host(); state.chatRunId = 'running'; state.chatMessage = 'stop';
    await handleSendChat(state);
    expect(state.chatQueue).toMatchObject([{ text: 'stop' }]);
    expect(state.client!.cancelChat).not.toHaveBeenCalled();
    state.chatMessage = '/STOP'; await handleSendChat(state);
    expect(state.client!.cancelChat).toHaveBeenCalledExactlyOnceWith('running', 'main');
  });

  it('preserves a failed /usage draft and consumes a successful one (#410)', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ sessions: [] });
    const state = host(request); state.chatMessage = ' /usage ';
    await handleSendChat(state);
    expect(state.chatMessage).toBe(' /usage ');
    expect(state.chatMessages).toMatchObject([{ content: expect.stringContaining('Failed to get usage') }]);
    expect(state.lastError).toContain('可重试');
    await handleSendChat(state);
    expect(state.chatMessage).toBe('');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('rejects local-command attachments before execution (busy=%s) (#410)', async busy => {
    const state = host(); state.chatMessage = '/usage'; state.chatRunId = busy ? 'run' : null;
    const images = [{ id: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,YQ==' }];
    state.chatAttachments = images;
    await handleSendChat(state);
    expect(state.chatMessage).toBe('/usage'); expect(state.chatAttachments).toEqual(images);
    expect(state.chatQueue).toEqual([]); expect(state.client!.request).not.toHaveBeenCalled();
    expect(state.lastError).toContain('不支持附件');
  });

  it.each([false, true])('does not overwrite edits made while /usage is pending (success=%s) (#410)', async success => {
    let resolve!: (value: unknown) => void; let reject!: (reason: Error) => void;
    const state = host(vi.fn(() => new Promise((a, b) => { resolve = a; reject = b; })));
    state.chatMessage = '/usage'; const sending = handleSendChat(state);
    state.chatMessage = '新的输入'; state.chatAttachments = [{ id: 'new', mimeType: 'image/png', dataUrl: 'new' }];
    if (success) resolve({ sessions: [] }); else reject(new Error('offline'));
    await sending;
    expect(state.chatMessage).toBe('新的输入'); expect(state.chatAttachments[0].id).toBe('new');
  });

  it('does not clear the draft when a command is sent through an override (#410)', async () => {
    const state = host(); state.chatMessage = '保留草稿';
    await handleSendChat(state, '/usage', { restoreDraft: true });
    expect(state.chatMessage).toBe('保留草稿');
  });

  it('retains a failed queued read command for recovery (#410)', async () => {
    const state = host(vi.fn().mockRejectedValue(new Error('offline')));
    state.chatMessage = '/usage'; state.chatRunId = 'running'; await handleSendChat(state);
    state.chatRunId = null; await flushChatQueueForEvent(state);
    expect(state.chatQueue).toMatchObject([{ localCommandName: 'usage' }]);
  });

  it('does not inject an old command result into a different session (#410)', async () => {
    let reject!: (reason: Error) => void;
    const state = host(vi.fn(() => new Promise((_, r) => { reject = r; })));
    state.chatMessage = '/usage'; const sending = handleSendChat(state);
    activateChatSession(state, 'other'); state.chatMessage = 'other draft';
    reject(new Error('offline')); await sending;
    expect(state.chatMessage).toBe('other draft'); expect(state.chatMessages).toEqual([]);
  });

  it('marks a steer send failure as unknown and never automatically replays it (#410)', async () => {
    // MAX-626 /steer now admits atomically via chat.steer, without sessions.list.
    const request = vi.fn().mockRejectedValue(new Error('connection lost'));
    const state = host(request); state.chatMessage = '/steer hello';
    await handleSendChat(state);
    expect(state.lastError).toContain('结果未知');
    expect(state.chatMessage).toBe('/steer hello');
    await flushChatQueueForEvent(state);
    expect(request).toHaveBeenCalledExactlyOnceWith('chat.steer', { sessionKey: 'main', message: 'hello' });
  });
});
