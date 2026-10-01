import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverModels, registerModelDiscoveryRoutes } from './model-discovery.js';

afterEach(() => vi.restoreAllMocks());
describe('authenticated model discovery', () => {
  it.each([
    ['deepseek', 'https://api.deepseek.com', 'deepseek-v4-flash', 1000000, 393216],
    ['step', 'https://api.stepfun.com/v1/', 'step-3.5-flash-2603', 256000, 256000],
    ['mimo', 'https://api.xiaomimimo.com/v1', 'mimo-v2-flash', 262144, 65536],
  ])('loads %s models from the configured endpoint and enriches their limits', async (providerName, baseURL, id, contextWindow, maxTokens) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id }, { id }, { id: 'unknown-new-model' }] })));
    const result = await discoverModels({ providerName, baseURL, apiKey: 'draft-key' }, fetcher);
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({ id, contextWindow, maxTokens, supportsFunctionCall: true, parameterSource: 'catalog' });
    expect(result.models[1]).toMatchObject({ id: 'unknown-new-model', parameterSource: 'unknown' });
    expect(result.models[1].contextWindow).toBeUndefined();
    expect(fetcher.mock.calls[0][0]).toBe(baseURL.replace(/\/+$/, '') + (baseURL.replace(/\/+$/, '').endsWith('/v1') ? '/models' : '/v1/models'));
    const headers = fetcher.mock.calls[0][1].headers;
    expect(headers[providerName === 'mimo' ? 'api-key' : 'Authorization']).toBe(providerName === 'mimo' ? 'draft-key' : 'Bearer draft-key');
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  });
  it('preserves proxy subpaths and advertised metadata over catalog defaults', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: 'step-3.5-flash-2603', context_window: 64000, max_output_tokens: 8000, supports_function_call: false }] })));
    const result = await discoverModels({ providerName: 'stepfun', baseURL: 'https://proxy.example/step_plan/v1', apiKey: 'key' }, fetcher);
    expect(fetcher.mock.calls[0][0]).toBe('https://proxy.example/step_plan/v1/models');
    expect(result.models[0]).toMatchObject({ contextWindow: 64000, maxTokens: 8000, supportsFunctionCall: false, parameterSource: 'api' });
  });
  it('recognizes the current DeepSeek Flash ID even when listing only includes limits', async () => {
    const result = await discoverModels({ providerName: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'key' },
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'deepseek-flash', context_window: 1048576, max_output_tokens: 393216 }] }))));
    expect(result.models[0]).toMatchObject({ contextWindow: 1048576, maxTokens: 393216, supportsFunctionCall: true, supportsVision: true });
  });
  it('does not hide authentication errors or expose keys in errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('draft-secret', { status: 401 }));
    await expect(discoverModels({ providerName: 'step', baseURL: 'https://api.stepfun.com/v1', apiKey: 'draft-secret' }, fetcher)).rejects.toThrow('MODEL_DISCOVERY_HTTP_401');
  });
  it('falls back to the catalog only for unsupported listing endpoints and marks it', async () => {
    const result = await discoverModels({ providerName: 'mimo', baseURL: 'https://api.xiaomimimo.com/v1', apiKey: 'key' }, vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    expect(result.source).toBe('catalog');
    expect(result.warning).toContain('目录');
    expect(result.models.some(m => m.id === 'mimo-v2-flash')).toBe(true);
  });
  it('validates response shape, URLs and missing credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}'));
    await expect(discoverModels({ providerName: 'step', baseURL: 'https://api.stepfun.com/v1', apiKey: 'key' }, fetcher)).rejects.toThrow('MODEL_DISCOVERY_INVALID_RESPONSE');
    for (const baseURL of ['file:///etc/passwd', 'https://key@example.com/v1', 'https://example.com/v1?apiKey=secret']) {
      await expect(discoverModels({ providerName: 'custom', baseURL, apiKey: 'key' }, fetcher)).rejects.toThrow('MODEL_DISCOVERY_INVALID_URL');
    }
    await expect(discoverModels({ providerName: 'step', baseURL: 'https://api.stepfun.com/v1' }, fetcher)).rejects.toThrow('LLM_CREDENTIAL_NOT_CONFIGURED');
  });
  it('requires management access and reuses saved keys only when no draft key is provided', async () => {
    const app = Fastify();
    const store = { getProviderApiKey: vi.fn().mockResolvedValue('stored-secret'), getProviderByName: vi.fn().mockResolvedValue({ name: 'step', api_base_url: 'https://api.stepfun.com/v1' }) };
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: 'step-3.5-flash-2603' }] })));
    await registerModelDiscoveryRoutes(app, async (req, reply) => { if (!req.headers.authorization) return reply.code(401).send({}); }, async (req, reply) => { if (req.headers.authorization !== 'manager') return reply.code(403).send({}); }, store as any, fetcher);
    try {
      const payload = { providerName: 'step', baseURL: 'https://api.stepfun.com/v1' };
      for (const [authorization, status] of [[undefined, 401], ['reader', 403]] as const) expect((await app.inject({ method: 'POST', url: '/api/llm/models', headers: authorization ? { authorization } : {}, payload })).statusCode).toBe(status);
      expect(fetcher).not.toHaveBeenCalled();
      const saved = await app.inject({ method: 'POST', url: '/api/llm/models', headers: { authorization: 'manager' }, payload });
      expect(saved.statusCode).toBe(200);
      expect(saved.body).not.toContain('stored-secret');
      expect(store.getProviderApiKey).toHaveBeenCalledWith('step');
      store.getProviderApiKey.mockClear();
      expect((await app.inject({ method: 'POST', url: '/api/llm/models', headers: { authorization: 'manager' }, payload: { ...payload, apiKey: 'draft-secret' } })).statusCode).toBe(200);
      expect(store.getProviderApiKey).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'POST', url: '/api/llm/models', headers: { authorization: 'manager' }, payload: { ...payload, unexpected: true } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
