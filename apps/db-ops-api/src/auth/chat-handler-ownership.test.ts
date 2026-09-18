import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from './actor-context.js';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  authorizeSession: vi.fn(),
  addMessage: vi.fn(),
  getMessages: vi.fn(),
  chat: vi.fn(),
}));

vi.mock('../chat-database-service.js', () => ({
  chatDatabaseService: {
    createSession: mocks.createSession,
    authorizeSession: mocks.authorizeSession,
    addMessage: mocks.addMessage,
    getMessages: mocks.getMessages,
  },
}));

vi.mock('../adapter/get-agent-engine.js', () => ({
  getAgentEngine: vi.fn().mockResolvedValue({ chat: mocks.chat }),
}));

import { handleChatHistory, handleChatSend } from '../chat-handler.js';

const actor: ActorContext = Object.freeze({
  userId: 7,
  username: 'alice',
  roles: Object.freeze([]),
  permissions: Object.freeze([]),
  sessionVersion: 1,
  instanceScopes: Object.freeze({}),
  requestId: 'handler-request',
});

describe('chat ownership handler boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.addMessage.mockResolvedValue(undefined);
    mocks.authorizeSession.mockResolvedValue({ session_id: 'authorized-session' });
    mocks.chat.mockResolvedValue({ finalContent: 'answer', usage: { prompt_tokens: 1 } });
    mocks.createSession.mockResolvedValue({ session_id: 'server-generated-key' });
    mocks.getMessages.mockResolvedValue([]);
  });

  it('does not invoke the agent or persist an assistant response when append authorization fails', async () => {
    mocks.authorizeSession.mockRejectedValueOnce(new Error('Chat session not found'));

    await expect(handleChatSend(actor, {
      sessionKey: 'other-session',
      message: 'steal it',
    })).rejects.toThrow('Chat session not found');

    expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
  });

  it('creates and returns a server key and uses it for the complete chat turn', async () => {
    const result = await handleChatSend(actor, { message: 'new session' });

    expect(mocks.createSession).toHaveBeenCalledWith(actor, { title: '新会话' });
    expect(mocks.addMessage).toHaveBeenNthCalledWith(1, actor, 'server-generated-key', expect.objectContaining({
      role: 'user',
      content: 'new session',
    }));
    expect(mocks.chat).toHaveBeenCalledWith(
      'server-generated-key',
      'new session',
      expect.any(Function),
      actor,
    );
    expect(mocks.addMessage).toHaveBeenNthCalledWith(2, actor, 'server-generated-key', expect.objectContaining({
      role: 'assistant',
      content: 'answer',
    }));
    expect(result).toMatchObject({ sessionKey: 'server-generated-key', finalContent: 'answer' });
  });

  it.each(['cancelled', 'timed_out', 'error', 'max_iterations', 'tool_error', 'empty_final_response'])(
    'persists streamed partial output and reasoning for %s', async (stopReason) => {
      mocks.chat.mockImplementationOnce(async (_key, _message, emit) => {
        emit({ type: 'thinking_delta', delta: 'reason' });
        emit({ type: 'text_delta', delta: 'part' });
        emit({ type: 'text_delta', delta: 'partial answer' });
        emit({ type: stopReason === 'cancelled' ? 'cancelled' : 'error', stopReason });
        return { finalContent: null, stopReason };
      });
      await handleChatSend(actor, { sessionKey: 's', message: 'hello' });
      expect(mocks.addMessage).toHaveBeenCalledTimes(2);
      expect(mocks.addMessage).toHaveBeenLastCalledWith(actor, 's', expect.objectContaining({
        role: 'assistant', content: '<think>reason</think>\n\npartial answer',
        metadata: expect.objectContaining({ interrupted: true, stopReason }),
      }));
    },
  );

  it('saves reasoning-only output when the engine throws', async () => {
    mocks.chat.mockImplementationOnce(async (_key, _message, emit) => {
      emit({ type: 'thinking_delta', delta: 'reason' });
      throw new Error('broken');
    });
    await expect(handleChatSend(actor, { sessionKey: 's', message: 'hello' })).rejects.toThrow('broken');
    expect(mocks.addMessage).toHaveBeenLastCalledWith(actor, 's', expect.objectContaining({
      role: 'assistant', content: '<think>reason</think>\n\n',
      metadata: expect.objectContaining({ interrupted: true, stopReason: 'error' }),
    }));
  });

  it('does not create an empty assistant message', async () => {
    mocks.chat.mockResolvedValueOnce({ finalContent: null, stopReason: 'cancelled' });
    await handleChatSend(actor, { sessionKey: 's', message: 'hello' });
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
  });

  it('loads history through the same actor-scoped repository boundary', async () => {
    await handleChatHistory(actor, { sessionKey: 'shared-session', limit: 10 });

    expect(mocks.getMessages).toHaveBeenCalledWith(actor, 'shared-session', 10);
  });
});
