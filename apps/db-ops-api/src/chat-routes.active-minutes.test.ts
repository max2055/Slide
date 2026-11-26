import Fastify from 'fastify';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ActorContext } from './auth/actor-context.js';
import { ChatForbiddenError } from './auth/chat-authorization.js';
import { registerChatRoutes, type ChatRouteDependencies } from './chat-routes.js';

const actor: ActorContext = {
  userId: 7, username: 'alice', roles: [], permissions: ['chat:view'],
  sessionVersion: 1, instanceScopes: {}, requestId: 'active-minutes',
};
const now = Date.parse('2026-11-11T00:00:00Z');

async function setup(overrides: Pick<ChatRouteDependencies, 'getModelDefaults' | 'authorizeChat'> = {}) {
  const app = Fastify();
  const getSessions = vi.fn<ChatRouteDependencies['service']['getSessions']>()
    .mockResolvedValue([
      { session_id: 'recent', last_message_at: new Date(now - 60_000) },
      { session_id: 'boundary', last_message_at: new Date(now - 600_000) },
      { session_id: 'older', last_message_at: new Date(now - 660_000) },
      { session_id: 'undated', last_message_at: null },
    ] as Awaited<ReturnType<ChatRouteDependencies['service']['getSessions']>>);
  const deps: ChatRouteDependencies = {
    authorizeChat: async a => a,
    verifyToken: async (request) => { Object.assign(request, { user: actor }); },
    service: {
      getSessions, getMessages: vi.fn(), getMessagePage: vi.fn(),
      getSessionMetadata: vi.fn(), updateSessionSettings: vi.fn(),
      deleteSession: vi.fn(), enforceMessageCap: vi.fn(),
    },
    handleChatSend: vi.fn(),
    ...overrides,
  };
  await registerChatRoutes(app, deps);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  onTestFinished(() => app.close());
  return { app, getSessions };
}

afterEach(() => vi.restoreAllMocks());

describe('GET /api/sessions activeMinutes (#503)', () => {
  it.each([
    '', 'abc', '-1', '0', '10abc', '1.5', '1e2', '0x10', '+10',
    'NaN', 'Infinity', '01', '525601', '9007199254740992', '9'.repeat(100),
  ])('rejects invalid window %j before reading sessions', async (value) => {
    const { app, getSessions } = await setup();
    const response = await app.inject(`/api/sessions?activeMinutes=${encodeURIComponent(value)}`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'activeMinutes must be a positive integer up to 525600' });
    expect(getSessions).not.toHaveBeenCalled();
  });

  it('rejects repeated parameters', async () => {
    const { app, getSessions } = await setup();
    const response = await app.inject('/api/sessions?activeMinutes=10&activeMinutes=20');
    expect(response.statusCode).toBe(400);
    expect(getSessions).not.toHaveBeenCalled();
  });

  it.each([
    ['', ['recent', 'boundary', 'older', 'undated']],
    ['?activeMinutes=1', []],
    ['?activeMinutes=10', ['recent']],
    ['?activeMinutes=525600', ['recent', 'boundary', 'older']],
  ])('preserves authorized results and strict window boundaries for %s', async (query, keys) => {
    const { app, getSessions } = await setup();
    const response = await app.inject(`/api/sessions${query}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().sessions.map((session: { key: string }) => session.key)).toEqual(keys);
    expect(response.json()).toMatchObject({ ok: true, defaults: {} });
    expect(getSessions).toHaveBeenCalledExactlyOnceWith(actor);
  });

  it('preserves service failure status rather than returning an empty success', async () => {
    const { app, getSessions } = await setup();
    getSessions.mockRejectedValueOnce(new Error('storage unavailable'));
    const response = await app.inject('/api/sessions?activeMinutes=10');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: '获取会话列表失败：storage unavailable' });
  });

  it('runs authentication before parameter handling', async () => {
    const app = Fastify();
    const getSessions = vi.fn();
    await registerChatRoutes(app, {
      authorizeChat: async a => a,
    verifyToken: async (_request, reply) => { await reply.code(401).send({ error: 'Unauthorized' }); },
      service: { getSessions } as unknown as ChatRouteDependencies['service'],
      handleChatSend: vi.fn(),
    });
    try {
      expect((await app.inject('/api/sessions?activeMinutes=abc')).statusCode).toBe(401);
      expect(getSessions).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});

describe('GET /api/sessions chat model defaults', () => {
  it('returns the effective model and provider even before a visible session exists', async () => {
    const getModelDefaults = vi.fn()
      .mockResolvedValueOnce({ model: 'scene-specific-model', modelProvider: 'configured-provider' })
      .mockResolvedValueOnce({ model: 'new-default', modelProvider: 'other-provider' });
    const { app, getSessions } = await setup({ getModelDefaults });
    getSessions.mockResolvedValue([]);
    const first = await app.inject('/api/sessions');
    const second = await app.inject('/api/sessions');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, sessions: [], defaults: { model: 'scene-specific-model', modelProvider: 'configured-provider' } });
    expect(second.json().defaults).toEqual({ model: 'new-default', modelProvider: 'other-provider' });
  });

  it('retains authorized sessions when model configuration cannot be resolved', async () => {
    const getModelDefaults = vi.fn().mockRejectedValue(new Error('private configuration detail'));
    const { app } = await setup({ getModelDefaults });
    const response = await app.inject('/api/sessions?activeMinutes=10');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, sessions: [{ key: 'recent' }], defaults: {} });
    expect(response.body).not.toContain('private configuration detail');
  });

  it('does not resolve defaults for a denied actor and omits them on a later revocation', async () => {
    const getModelDefaults = vi.fn().mockResolvedValue({ model: 'scene-specific-model', modelProvider: 'configured-provider' });
    const authorizeChat = vi.fn().mockRejectedValue(new ChatForbiddenError());
    const { app } = await setup({ getModelDefaults, authorizeChat });
    const denied = await app.inject('/api/sessions');
    expect(denied.statusCode).toBe(403);
    expect(getModelDefaults).not.toHaveBeenCalled();

    authorizeChat.mockResolvedValueOnce(actor);
    const revoked = await app.inject('/api/sessions');
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json()).toEqual({ error: '权限不足', code: 'CHAT_FORBIDDEN' });
    expect(getModelDefaults).toHaveBeenCalledOnce();
  });
});
