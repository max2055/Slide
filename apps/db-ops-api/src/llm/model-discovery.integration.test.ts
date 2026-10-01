import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createConfiguredAgentProvider } from '../adapter/llm-provider-factory.js';
import { createServiceProviderClient } from './provider-connection.js';
import { discoverModels } from './model-discovery.js';
import { resolveContextConfig } from '@slide/agent-core';

describe('supplier discovery to actual model request', () => {
  it.each([
    ['deepseek', 'deepseek-v4-flash', 1000000],
    ['stepfun', 'step-3.5-flash-2603', 256000],
    ['mimo', 'mimo-v2-flash', 262144],
  ])('preserves %s endpoint, credentials and selected parameters across discovery, chat and SDK testing', async (name, model, contextWindow) => {
    const requests: { path?: string; key?: string; body: any }[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      requests.push({ path: req.url, key: String(name === 'mimo' ? req.headers['api-key'] : req.headers.authorization), body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url?.endsWith('/models') ? { data: [{ id: model }] }
        : { id: 'test', object: 'chat.completion', model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/proxy/v1`;
      const { models } = await discoverModels({ providerName: name, baseURL, apiKey: 'test-key' });
      const selected = { id: 1, name, default_model: model, context_window: 4096, max_tokens: 2048,
        models_supported: models, enabled: true, is_default: true, supports_function_call: true, deployment_type: 'api', api_format: 'openai-completions', api_base_url: baseURL } as any;
      const agent = await createConfiguredAgentProvider({ getAllProviders: async () => [selected], getSceneBindings: async () => [], getProviderApiKey: async () => 'test-key' });
      expect(resolveContextConfig({ model }, agent)).toMatchObject({ contextWindowTokens: contextWindow, maxTokens: 2048 });
      const response = await agent.chat([{ role: 'user', content: 'hello' }], [], { maxTokens: 2048 });
      expect(response.content).toBe('ok');
      await (createServiceProviderClient(selected, 'test-key').client as any).models.list();
      expect(requests.map(r => r.path)).toEqual(['/proxy/v1/models', '/proxy/v1/chat/completions', '/proxy/v1/models']);
      expect(requests.map(r => r.key)).toEqual(Array(3).fill(name === 'mimo' ? 'test-key' : 'Bearer test-key'));
      expect(requests[1].body).toMatchObject({ model, max_tokens: 2048 });
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
