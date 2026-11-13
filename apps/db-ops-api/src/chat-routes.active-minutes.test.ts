import Fastify from 'fastify';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ActorContext } from './auth/actor-context.js';
import { registerChatRoutes, type ChatRouteDependencies } from './chat-routes.js';

const actor: ActorContext = {
  userId: 7, username: 'alice', roles: [], permissions: [],
  sessionVersion: 1, instanceScopes: {}, requestId: 'active-minutes',
};
const now = Date.parse('2026-11-11T00:00:00Z');

async function setup() {
  const app = Fastify();
  const getSessions = vi.fn<ChatRouteDependencies['service']['getSessions']>()
    .mockResolvedValue([
      { session_id: 'recent', last_message_at: new Date(now - 60_000) },
      { session_id: 'boundary', last_message_at: new Date(now - 600_000) },
      { session_id: 'older', last_message_at: new Date(now - 660_000) },
      { session_id: 'undated', last_message_at: null },
    ] as Awaited<ReturnType<ChatRouteDependencies['service']['getSessions']>>);
  const deps: ChatRouteDependencies = {
    verifyToken: async (request) => { Object.assign(request, { user: actor }); },
    service: {
      getSessions, getMessages: vi.fn(), getMessagePage: vi.fn(),
      getSessionMetadata: vi.fn(), updateSessionSettings: vi.fn(),
      deleteSession: vi.fn(), enforceMessageCap: vi.fn(),
    },
    handleChatSend: vi.fn(),
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
