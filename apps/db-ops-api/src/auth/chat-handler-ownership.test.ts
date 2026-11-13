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
      undefined, undefined, undefined, expect.any(String),
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

  // GitHub #502: exercise the public handler with an observed partial assistant.
  it.each([new Error('engine failed'), undefined, null, 'engine failed'])(
    'retains both failures when chat rejects with %s and assistant persistence fails', async (chatError) => {
      const persistenceError = new Error('assistant save failed');
      mocks.chat.mockImplementationOnce(async (_key, _message, emit) => {
        emit({ type: 'thinking_delta', delta: 'reason' });
        emit({ type: 'text_delta', delta: 'partial answer' });
        throw chatError;
      });
      mocks.addMessage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(persistenceError);
      const events = vi.fn();

      const error = await handleChatSend(actor, { sessionKey: 's', message: 'hello' }, events)
        .then(() => { throw new Error('Expected rejection'); }, error => error);

      expect(error).toBeInstanceOf(AggregateError);
      expect(error.cause).toBe(chatError);
      expect(error.errors).toHaveLength(2);
      expect(error.errors[0]).toBe(chatError);
      expect(error.errors[1]).toBe(persistenceError);
      expect(events).toHaveBeenCalledTimes(2);
      expect(mocks.addMessage).toHaveBeenCalledTimes(2);
      expect(mocks.addMessage).toHaveBeenLastCalledWith(actor, 's', expect.objectContaining({
        role: 'assistant', content: '<think>reason</think>\n\npartial answer',
        metadata: expect.objectContaining({ interrupted: true, stopReason: 'error' }),
      }));
    },
  );

  it('preserves the original engine error when partial assistant persistence succeeds', async () => {
    const chatError = new Error('engine failed');
    mocks.chat.mockImplementationOnce(async (_key, _message, emit) => {
      emit({ type: 'text_delta', delta: 'partial answer' });
      throw chatError;
    });

    await expect(handleChatSend(actor, { sessionKey: 's', message: 'hello' })).rejects.toBe(chatError);
    expect(mocks.addMessage).toHaveBeenCalledTimes(2);
  });

  it('surfaces assistant persistence failure after successful chat', async () => {
    const persistenceError = new Error('assistant save failed');
    mocks.addMessage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(persistenceError);

    await expect(handleChatSend(actor, { sessionKey: 's', message: 'hello' })).rejects.toBe(persistenceError);
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    expect(mocks.addMessage).toHaveBeenCalledTimes(2);
  });

  it('preserves an engine failure without creating an empty assistant', async () => {
    const chatError = new Error('engine failed before any output');
    mocks.chat.mockRejectedValueOnce(chatError);

    await expect(handleChatSend(actor, { sessionKey: 's', message: 'hello' })).rejects.toBe(chatError);
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
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
