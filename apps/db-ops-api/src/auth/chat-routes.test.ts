import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ChatSessionNotFoundError } from '../chat-database-service.js';
import type { ActorContext } from './actor-context.js';

const actor: ActorContext = Object.freeze({
  userId: 7,
  username: 'alice',
  roles: Object.freeze([]),
  permissions: Object.freeze([]),
  sessionVersion: 1,
  instanceScopes: Object.freeze({}),
  requestId: 'route-request',
});

async function loadRegisterChatRoutes(): Promise<((app: any, deps: any) => Promise<void>) | undefined> {
  const module = await import('../chat-routes.js').catch(() => ({}));
  return (module as any).registerChatRoutes;
}

function routeDependencies() {
  const service = {
    getMessages: vi.fn().mockResolvedValue([{
      role: 'user',
      content: 'hello',
      created_at: new Date('2026-07-17T00:00:00.000Z'),
    }]),
    getSessions: vi.fn().mockResolvedValue([{
      session_id: 'owner-session',
      title: 'Owner session',
      last_message_at: new Date('2026-07-17T00:00:00.000Z'),
      message_count: 1,
      metadata: null,
      instance_id: null,
    }]),
    updateSessionSettings: vi.fn().mockResolvedValue(true),
    deleteSession: vi.fn().mockResolvedValue(true),
    enforceMessageCap: vi.fn().mockResolvedValue(2),
  };
  const handleChatSend = vi.fn().mockResolvedValue({
    sessionKey: 'server-session',
    finalContent: 'answer',
    usage: { prompt_tokens: 1 },
  });
  const verifyToken = vi.fn(async (request: any) => {
    request.user = actor;
  });
  return { service, handleChatSend, verifyToken };
}

describe('chat REST actor boundary', () => {
  it('registers injectable routes and passes request.user to every chat operation', async () => {
    const registerChatRoutes = await loadRegisterChatRoutes();
    expect(registerChatRoutes).toBeTypeOf('function');
    if (!registerChatRoutes) return;
    const app = Fastify();
    const deps = routeDependencies();
    await registerChatRoutes(app, deps);

    expect((await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { message: 'hello' },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET',
      url: '/api/chat/history?sessionKey=owner-session&limit=10',
    })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/sessions' })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'PATCH',
      url: '/api/sessions/owner-session',
      payload: { model: 'model-a' },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'DELETE',
      url: '/api/sessions/owner-session',
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST',
      url: '/api/sessions/owner-session/cap',
      payload: { maxMessages: 20 },
    })).statusCode).toBe(200);

    expect(deps.handleChatSend).toHaveBeenCalledWith(actor, { message: 'hello', sessionKey: undefined });
    expect(deps.service.getMessages).toHaveBeenCalledWith(actor, 'owner-session', 10);
    expect(deps.service.getSessions).toHaveBeenCalledWith(actor);
    expect(deps.service.updateSessionSettings).toHaveBeenCalledWith(actor, 'owner-session', {
      model: 'model-a',
      thinkingLevel: undefined,
    });
    expect(deps.service.deleteSession).toHaveBeenCalledWith(actor, 'owner-session');
    expect(deps.service.enforceMessageCap).toHaveBeenCalledWith(actor, 'owner-session', 20);
    await app.close();
  });

  it('maps unauthorized and missing sessions to the same 404 response', async () => {
    const registerChatRoutes = await loadRegisterChatRoutes();
    expect(registerChatRoutes).toBeTypeOf('function');
    if (!registerChatRoutes) return;
    const app = Fastify();
    const deps = routeDependencies();
    deps.handleChatSend.mockRejectedValueOnce(new ChatSessionNotFoundError());
    deps.service.getMessages.mockRejectedValueOnce(new ChatSessionNotFoundError());
    deps.service.updateSessionSettings.mockRejectedValueOnce(new ChatSessionNotFoundError());
    deps.service.deleteSession.mockRejectedValueOnce(new ChatSessionNotFoundError());
    deps.service.enforceMessageCap.mockRejectedValueOnce(new ChatSessionNotFoundError());
    await registerChatRoutes(app, deps);

    const send = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { message: 'forbidden', sessionKey: 'other-session' },
    });
    const history = await app.inject({
      method: 'GET',
      url: '/api/chat/history?sessionKey=other-session',
    });
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/other-session',
      payload: { model: 'forbidden-model' },
    });
    const remove = await app.inject({ method: 'DELETE', url: '/api/sessions/missing-session' });
    const cap = await app.inject({
      method: 'POST',
      url: '/api/sessions/other-session/cap',
      payload: { maxMessages: 10 },
    });

    expect(send.statusCode).toBe(404);
    expect(history.statusCode).toBe(404);
    expect(patch.statusCode).toBe(404);
    expect(remove.statusCode).toBe(404);
    expect(cap.statusCode).toBe(404);
    expect(send.json()).toEqual({ error: 'Session not found' });
    expect(history.json()).toEqual({ error: 'Session not found' });
    expect(patch.json()).toEqual({ ok: false, error: 'Session not found' });
    expect(remove.json()).toEqual({ ok: false, error: 'Session not found' });
    expect(cap.json()).toEqual({ ok: false, error: 'Session not found' });
    expect(deps.handleChatSend).toHaveBeenCalledWith(actor, {
      message: 'forbidden',
      sessionKey: 'other-session',
    });
    await app.close();
  });

  it('rejects malformed, fractional, and unbounded pagination and cap values', async () => {
    const registerChatRoutes = await loadRegisterChatRoutes();
    expect(registerChatRoutes).toBeTypeOf('function');
    if (!registerChatRoutes) return;
    const app = Fastify();
    const deps = routeDependencies();
    await registerChatRoutes(app, deps);

    for (const limit of ['0', '-1', '1.5', 'NaN', '501']) {
      expect((await app.inject({
        method: 'GET', url: `/api/chat/history?sessionKey=owner-session&limit=${limit}`,
      })).statusCode).toBe(400);
    }
    for (const maxMessages of [0, -1, 1.5, 'NaN', 10_001]) {
      expect((await app.inject({
        method: 'POST', url: '/api/sessions/owner-session/cap', payload: { maxMessages },
      })).statusCode).toBe(400);
    }
    expect(deps.service.getMessages).not.toHaveBeenCalled();
    expect(deps.service.enforceMessageCap).not.toHaveBeenCalled();
    await app.close();
  });
});


describe('chat history cursor pages', () => {
  it('forwards the actor/cursor and returns stable message IDs and the next cursor', async () => {
    const register = await loadRegisterChatRoutes();
    const app = Fastify();
    const deps = routeDependencies();
    const getMessagePage = vi.fn().mockResolvedValue({
      messages: [{ message_id: 'message-2', sequence: 2, role: 'user', content: 'older', created_at: new Date() }], nextBefore: 2,
    });
    await register!(app, { ...deps, service: { ...deps.service, getMessagePage } });
    const result = await app.inject({ method: 'GET', url: '/api/chat/history?sessionKey=owner-session&paged=true&before=20&limit=10' });
    expect(result.statusCode).toBe(200);
    expect(getMessagePage).toHaveBeenCalledWith(actor, 'owner-session', 10, 20);
    expect(result.json()).toMatchObject({ messages: [{ id: 'message-2', sequence: 2 }], nextBefore: 2 });
    expect(deps.service.getMessages).not.toHaveBeenCalled();
    for (const query of ['paged=true&before=-1', 'paged=true&before=1.5', 'before=20', 'paged=true&before=9007199254740992']) {
      expect((await app.inject({ method: 'GET', url: `/api/chat/history?sessionKey=owner-session&${query}` })).statusCode).toBe(400);
    }
    getMessagePage.mockRejectedValueOnce(new ChatSessionNotFoundError());
    expect((await app.inject({ method: 'GET', url: '/api/chat/history?sessionKey=foreign&paged=true' })).statusCode).toBe(404);
    await app.close();
  });
});
