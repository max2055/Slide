import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerLLMSceneRoutes } from './scene-routes.js';

describe('scene configuration API', () => {
  async function setup() {
    const app = Fastify();
    const store = { getAllProviders: vi.fn().mockResolvedValue([{ id: 1, name: 'one', enabled: true, is_default: true,
      default_model: 'base', models_supported: [{ id: 'fast' }], supports_function_call: true, api_key_encrypted: 'secret' }]),
      getSceneBindings: vi.fn().mockResolvedValue([]), saveSceneBinding: vi.fn() };
    await registerLLMSceneRoutes(app, async (req, reply) => {
      if (!req.headers.authorization) return reply.code(401).send();
    }, async (req, reply) => {
      if (req.headers.authorization !== 'manager') return reply.code(403).send();
    }, store as any);
    return { app, store };
  }
  it('requires authentication and management permission', async () => {
    const { app, store } = await setup();
    try {
      expect((await app.inject('/api/llm/scenes')).statusCode).toBe(401);
      expect((await app.inject({ method: 'PUT', url: '/api/llm/scenes/chat', headers: { authorization: 'reader' }, payload: { provider_id: null } })).statusCode).toBe(403);
      expect(store.saveSceneBinding).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('returns effective settings and preserves invalid binding errors without secrets', async () => {
    const { app, store } = await setup();
    store.getSceneBindings.mockResolvedValue([{ scene: 'chat', provider_id: 99, model: 'gone' }] as any);
    try {
      const result = await app.inject({ url: '/api/llm/scenes', headers: { authorization: 'reader' } });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toHaveLength(5);
      expect(result.json()[0].effective.model).toBe('base');
      expect(result.json()[1]).toMatchObject({ effective: null, error: expect.stringContaining('已删除') });
      expect(result.body).not.toContain('secret');
      store.getSceneBindings.mockRejectedValue(new Error('driver secret'));
      expect((await app.inject({ url: '/api/llm/scenes', headers: { authorization: 'reader' } })).statusCode).toBe(503);
    } finally { await app.close(); }
  });
  it('saves and clears valid bindings, rejects invalid scene/provider/model/payload', async () => {
    const { app, store } = await setup();
    const put = (scene: string, payload: any) => app.inject({ method: 'PUT', url: `/api/llm/scenes/${scene}`, headers: { authorization: 'manager' }, payload });
    try {
      expect((await put('chat', { provider_id: 1, model: 'fast' })).statusCode).toBe(200);
      expect(store.saveSceneBinding).toHaveBeenLastCalledWith('chat', { scene: 'chat', provider_id: 1, model: 'fast' });
      expect((await put('chat', { provider_id: null })).statusCode).toBe(200);
      expect(store.saveSceneBinding).toHaveBeenLastCalledWith('chat', null);
      for (const payload of [{}, { provider_id: '1', model: 'fast' }, { provider_id: 1, model: '' }, { provider_id: 1, model: 'unknown' }, { provider_id: 99, model: 'fast' }, { provider_id: 1, model: 'fast', apiKey: 'secret' }]) {
        expect((await put('chat', payload)).statusCode).toBe(400);
      }
      expect((await put('other', { provider_id: null })).statusCode).toBe(400);
      expect(store.saveSceneBinding).toHaveBeenCalledTimes(2);
    } finally { await app.close(); }
  });
});
