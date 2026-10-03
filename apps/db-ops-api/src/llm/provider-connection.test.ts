import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { llmService } from '../llm-service.js';
import { registerConnectionTestRoutes } from './connection-test-routes.js';
import { registerModelDiscoveryRoutes } from './model-discovery.js';

async function receiver(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  return { origin, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}

describe('actual credential transport with fake keys and local receivers', () => {
  it('keeps credential-free local Ollama working and rejects its redirects', async () => {
    const paths: string[] = [];
    let redirect = false;
    const proxy = await receiver((req, res) => {
      paths.push(req.url!); req.resume();
      expect(req.headers.authorization).toBeUndefined();
      if (redirect) { res.writeHead(307, { Location: '/capture' }); res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: { content: 'ok' }, model: 'local-test', prompt_eval_count: 2, eval_count: 1 }));
    });
    const app = Fastify();
    const provider = { name: 'local', api_base_url: proxy.origin + '/tenant', api_format: null, deployment_type: 'local', default_model: 'local-test' };
    await registerConnectionTestRoutes(app, async () => {}, async () => {},
      { getProviderByName: async () => provider, getProviderApiKey: async () => null } as any, llmService);
    try {
      const send = () => app.inject({ method: 'POST', url: '/api/llm/test', payload: { providerName: 'local' } });
      expect((await send()).json().success).toBe(true);
      redirect = true;
      expect((await send()).json().success).toBe(false);
      expect(paths).toEqual(['/tenant/api/chat', '/tenant/api/chat']);
    } finally { await app.close(); await proxy.close(); }
  });
  it.each([
    ['deepseek', 'openai-completions', 'deepseek-flash'],
    ['stepfun', 'openai-completions', 'step-3.5-flash-2603'],
    ['mimo', 'openai-completions', 'mimo-v2-flash'],
    ['anthropic', 'anthropic-messages', 'claude-test'],
  ])('%s supports saved and draft requests, blocks origin/path changes and SDK/fetch redirects', async (name, apiFormat, model) => {
    const unapproved: string[] = [];
    const target = await receiver((req, res) => { unapproved.push(JSON.stringify(req.headers)); res.end('{}'); });
    const approved: { path: string; headers: IncomingMessage['headers']; body: string }[] = [];
    let redirect = ''; let upstreamError = false;
    const proxy = await receiver((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        approved.push({ path: req.url!, headers: req.headers, body });
        if (redirect) { res.writeHead(307, { Location: redirect }); res.end(); return; }
        res.setHeader('Content-Type', 'application/json');
        if (upstreamError) { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'fake-saved-key fake-draft-key' } })); return; }
        res.end(JSON.stringify(req.url?.endsWith('/models') ? { data: [{ id: model }] }
          : apiFormat === 'anthropic-messages' ? { id: 'fake-message', type: 'message', role: 'assistant', model,
            content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2, output_tokens: 1 } }
            : { id: 'fake-completion', model, choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
      });
    });
    const app = Fastify();
    const provider = { id: 1, name, api_format: apiFormat, deployment_type: 'api', api_key_encrypted: 'fake-ciphertext',
      api_base_url: proxy.origin + '/tenant/v1', default_model: model, models_supported: [{ id: model, parameterProvider: name }] };
    const store = { getProviderByName: vi.fn().mockImplementation(async () => ({ ...provider })), getProviderApiKey: vi.fn().mockResolvedValue('fake-saved-key') };
    const auth = async (req: any, reply: any) => { if (req.headers.authorization !== 'manager') return reply.code(403).send({}); };
    await registerModelDiscoveryRoutes(app, auth, auth, store as any);
    await registerConnectionTestRoutes(app, auth, auth, store as any, llmService);
    const send = (endpoint: string, patch = {}) => app.inject({ method: 'POST', url: endpoint, headers: { authorization: 'manager' },
      payload: { providerName: name, baseURL: provider.api_base_url, ...patch } });
    try {
      for (const endpoint of ['/api/llm/models', '/api/llm/test']) {
        for (const baseURL of [target.origin + '/v1', proxy.origin + '/unapproved/v1']) {
          const before = approved.length; store.getProviderApiKey.mockClear();
          expect((await send(endpoint, { baseURL })).statusCode).toBe(403);
          expect(store.getProviderApiKey).not.toHaveBeenCalled(); expect(approved).toHaveLength(before);
        }
        const saved = await send(endpoint); expect(saved.statusCode).toBe(200);
        if (endpoint.endsWith('/test')) expect(saved.json().success).toBe(true);
        expect(approved.at(-1)!.headers[name === 'mimo' ? 'api-key' : apiFormat === 'anthropic-messages' ? 'x-api-key' : 'authorization']).toContain('fake-saved-key');
        expect(approved.at(-1)!.path).toMatch(/^\/tenant\/v1\//);
        if (endpoint.endsWith('/test')) expect(JSON.parse(approved.at(-1)!.body).max_tokens).toBe(50);
        store.getProviderApiKey.mockClear();
        expect((await send(endpoint, { apiKey: 'fake-draft-key', baseURL: proxy.origin + '/draft/v1' })).statusCode).toBe(200);
        expect(store.getProviderApiKey).not.toHaveBeenCalled();
        expect(approved.at(-1)!.path).toMatch(/^\/draft\/v1\//);
        expect(JSON.stringify(approved.at(-1)!.headers)).toContain('fake-draft-key');
        for (const location of [target.origin + '/capture', proxy.origin + '/capture']) {
          redirect = location; const before = approved.length;
          const result = await send(endpoint);
          expect(endpoint.endsWith('/test') ? result.json().success : result.statusCode !== 200).toBe(endpoint.endsWith('/test') ? false : true);
          expect(approved).toHaveLength(before + 1); // no redirect or SDK retry
          expect(result.body).not.toContain('fake-saved-key');
        }
        redirect = ''; upstreamError = true;
        const failed = await send(endpoint); expect(failed.body).not.toMatch(/fake-(saved|draft)-key/);
        upstreamError = false;
      }
      expect(unapproved).toEqual([]);
      expect(approved.some(request => request.path === '/capture')).toBe(false);
    } finally { await app.close(); await proxy.close(); await target.close(); }
  });
});
