import { describe, expect, it, vi } from 'vitest';
import { sendChatMessage, type ChatState } from './chat.ts';
import { ChatAcceptanceTimeoutError, handleDirectAdapterEvent } from '../direct-gateway.ts';

function state(request: ReturnType<typeof vi.fn>): ChatState {
  return { client: { request } as any, connected: true, sessionKey: '', chatLoading: false, chatMessages: [],
    chatThinkingLevel: null, chatSending: false, chatMessage: '', chatAttachments: [], chatRunId: null,
    chatStream: null, chatStreamStartedAt: null, lastError: null };
}

describe('unconfirmed chat UI', () => {
  it('releases waiting state and retries the original operation for the same payload', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockRejectedValue(new ChatAcceptanceTimeoutError('message-1', retry, () => ''));
    const host = state(request);
    await sendChatMessage(host, 'hello');
    expect(host.chatSending).toBe(false);
    expect(host.chatRunId).toBeNull();
    expect(host.lastError).toContain('发送结果尚未确认');
    await sendChatMessage(host, 'hello');
    expect(retry).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not adopt a late session allocation after the user changed sessions', async () => {
    const request = vi.fn().mockRejectedValue(new ChatAcceptanceTimeoutError('message-1', vi.fn(), () => 'assigned'));
    const host = state(request);
    await sendChatMessage(host, 'hello');
    host.sessionKey = 'other';
    handleDirectAdapterEvent(host as any, { type: 'session.created', messageId: 'message-1', sessionKey: 'assigned' });
    expect(host.sessionKey).toBe('other');
    handleDirectAdapterEvent(host as any, { type: 'run.started', messageId: 'message-1', sessionKey: 'assigned', runId: 'old-run' });
    expect(host.sessionKey).toBe('other');
    expect(host.chatRunId).toBeNull();
  });

  it('does not clear a newer session when the old send expires', async () => {
    let expire!: (error: Error) => void;
    const request = vi.fn().mockImplementation(() => new Promise((_, reject) => { expire = reject; }));
    const host = state(request);
    host.sessionKey = 'first';
    const sending = sendChatMessage(host, 'hello');
    host.sessionKey = 'other';
    host.chatRunId = 'new-run';
    host.chatSending = true;
    host.chatStream = 'new stream';
    host.chatMessages = [];
    expire(new ChatAcceptanceTimeoutError('message-1', vi.fn(), () => 'first'));
    await sending;
    expect(host.chatRunId).toBe('new-run');
    expect(host.chatSending).toBe(true);
    expect(host.chatStream).toBe('new stream');
    expect(host.chatMessages).toEqual([]);
    expect(host.lastError).toBeNull();
  });

  it('does not reuse an unconfirmed message in another session', async () => {
    const retry = vi.fn();
    const request = vi.fn().mockRejectedValueOnce(new ChatAcceptanceTimeoutError('message-1', retry, () => 'first'))
      .mockResolvedValue(undefined);
    const host = state(request);
    host.sessionKey = 'first';
    await sendChatMessage(host, 'hello');
    host.sessionKey = 'other';
    await sendChatMessage(host, 'hello');
    expect(retry).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
