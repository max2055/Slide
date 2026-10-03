import { createServer } from 'node:http';
import Fastify from 'fastify';
import { requirePermission } from '../../src/auth/require-permission.js';
import { llmService } from '../../src/llm-service.js';
import { registerConnectionTestRoutes } from '../../src/llm/connection-test-routes.js';
import { registerModelDiscoveryRoutes } from '../../src/llm/model-discovery.js';

/** Browser-only in-memory store and fake supplier; never opens a database. */
export async function createCredentialProbeFixture(name: string, modelId: string) {
  const calls: { path: string; credential: string | undefined }[] = [];
  const server = createServer((req, res) => {
    calls.push({ path: req.url!, credential: String(req.headers['api-key'] || req.headers.authorization || '') });
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url?.endsWith('/models') ? { data: [{ id: modelId }] }
      : { id: 'fake-browser-completion', model: modelId, choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  let savedKey = 'fake-saved-key'; let keyReads = 0;
  const provider: any = { id: 11, name, display_name: name, enabled: true, is_default: true,
    api_base_url: origin + '/approved/v1', default_model: modelId, api_format: 'openai-completions', deployment_type: 'api',
    api_key_encrypted: 'fake-ciphertext', context_window: 64000, max_tokens: 2048, supports_function_call: true,
    models_supported: [{ id: modelId, parameterProvider: name }] };
  const app = Fastify();
  const auth = async (req: any, reply: any) => {
    if (req.headers.authorization !== 'fake-manager') return reply.code(401).send({});
    req.user = { username: 'manager', permissions: ['llm:manage'] };
  };
  const store = { getProviderByName: async () => ({ ...provider }), getProviderApiKey: async () => { keyReads++; return savedKey; } };
  await registerModelDiscoveryRoutes(app, auth, requirePermission('llm:manage'), store as any);
  await registerConnectionTestRoutes(app, auth, requirePermission('llm:manage'), store as any, llmService);
  app.get('/api/llm/configs', async () => [{ ...provider, api_key_encrypted: undefined, has_api_key: true }]);
  app.get('/api/llm/scenes', async () => []);
  app.put('/api/llm/configs/:id', { preHandler: [auth, requirePermission('llm:manage')] }, async req => {
    const body = req.body as any;
    Object.assign(provider, { api_base_url: body.baseURL, default_model: body.model, context_window: body.contextWindow,
      max_tokens: body.maxTokens, models_supported: body.modelsSupported });
    if (body.apiKey) savedKey = body.apiKey;
    return { success: true };
  });
  return { app, calls, origin, keyReads: () => keyReads,
    close: async () => { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
