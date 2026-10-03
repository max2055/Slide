import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { requirePermission } from '../auth/require-permission.js';
import { registerModelDiscoveryRoutes } from './model-discovery.js';
import { registerConnectionTestRoutes } from './connection-test-routes.js';
import rateLimit from '@fastify/rate-limit';
import { normalizeCredentialDestination, resolveTestCredential } from './credential-destination-policy.js';
import { llmDatabaseService } from '../llm-database-service.js';

describe.each(['/api/llm/test', '/api/llm/models'])('%s saved credential boundary', endpoint => {
  async function fixture() {
    const app = Fastify();
    await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
    const provider = { name: 'custom', api_base_url: 'http://127.0.0.1:28801/approved/v1',
      api_format: 'openai-completions', deployment_type: 'api', api_key_encrypted: 'fake-encrypted', default_model: 'test-model' };
    const store = { getProviderByName: vi.fn().mockImplementation(async () => ({ ...provider })),
      getProviderApiKey: vi.fn().mockResolvedValue('fake-saved-key') };
    const outbound = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: 'test-model' }] })));
    const service = { testConnectionWithConfig: vi.fn().mockImplementation(async (...args) => { await outbound(...args); return { success: true }; }) };
    const auth = async (req: any, reply: any) => {
      if (!req.headers.authorization) return reply.code(401).send({});
      req.user = { username: req.headers.authorization, permissions: req.headers.authorization === 'manager' ? ['llm:manage'] : ['llm:view'] };
    };
    await registerModelDiscoveryRoutes(app, auth, requirePermission('llm:manage'), store as any, outbound);
    await registerConnectionTestRoutes(app, auth, requirePermission('llm:manage'), store as any, service as any);
    const send = (patch = {}, authorization: string | undefined = 'manager') => app.inject({ method: 'POST', url: endpoint,
      headers: authorization ? { authorization } : {}, payload: { providerName: provider.name, baseURL: provider.api_base_url, ...patch } });
    return { app, provider, store, outbound, service, send };
  }
  it('rejects unauthenticated and ordinary logged-in users before reading keys or making requests', async () => {
    const f = await fixture();
    try {
      expect((await f.send({}, '')).statusCode).toBe(401);
      expect((await f.send({}, 'reader')).statusCode).toBe(403);
      expect(f.store.getProviderByName).not.toHaveBeenCalled();
      expect(f.store.getProviderApiKey).not.toHaveBeenCalled();
      expect(f.outbound).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each(['http://127.0.0.1:28802/approved/v1', 'http://127.0.0.1:28801/other/v1',
    'http://127.0.0.1:28801/approved/v1/nested', 'http://127.0.0.1:28801/approved/v10'])('denies changed destination %s before decrypting', async baseURL => {
    const f = await fixture();
    try {
      expect((await f.send({ baseURL })).statusCode).toBe(403);
      expect(f.store.getProviderApiKey).not.toHaveBeenCalled();
      expect(f.outbound).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each(['', '   ', '********', 'sk-****abcd', '••••••••', 'sk-...abcd', '[REDACTED]'])('does not treat empty/masked key %j as a new credential', async apiKey => {
    const f = await fixture();
    try {
      expect((await f.send({ baseURL: 'http://localhost:28802/new', apiKey })).statusCode).toBe(403);
      expect(f.store.getProviderApiKey).not.toHaveBeenCalled();
      expect(f.outbound).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('allows the saved private proxy and trailing slash equivalence', async () => {
    const f = await fixture();
    try {
      expect((await f.send({ baseURL: f.provider.api_base_url + '/' })).statusCode).toBe(200);
      expect(f.store.getProviderApiKey).toHaveBeenCalledOnce();
      expect(f.outbound).toHaveBeenCalledOnce();
    } finally { await f.app.close(); }
  });
  it('allows an explicit draft key at a new URL without reading a saved key', async () => {
    const f = await fixture();
    try {
      expect((await f.send({ apiKey: 'fake-draft-key', baseURL: 'http://localhost:28802/new/v1' })).statusCode).toBe(200);
      expect(f.store.getProviderApiKey).not.toHaveBeenCalled();
      expect(JSON.stringify(f.outbound.mock.calls)).toContain('fake-draft-key');
      expect(JSON.stringify(f.outbound.mock.calls)).not.toContain('fake-saved-key');
    } finally { await f.app.close(); }
  });
  it('allows a new destination after the authorized saved config has changed', async () => {
    const f = await fixture();
    try {
      f.provider.api_base_url = 'http://localhost:28802/new/v1';
      expect((await f.send()).statusCode).toBe(200);
      expect(f.store.getProviderApiKey).toHaveBeenCalledOnce();
    } finally { await f.app.close(); }
  });
  it('limits each expensive entrypoint to ten calls per minute', async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 10; i++) expect((await f.send()).statusCode).toBe(200);
      expect((await f.send()).statusCode).toBe(429);
      expect(f.outbound).toHaveBeenCalledTimes(10);
      expect(f.store.getProviderApiKey).toHaveBeenCalledTimes(10);
    } finally { await f.app.close(); }
  });
  it('does not expose credential-store exceptions or make outbound requests on read failure', async () => {
    const f = await fixture();
    try {
      f.store.getProviderApiKey.mockRejectedValueOnce(new Error('fake-saved-key'));
      const response = await f.send();
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('fake-saved-key');
      expect(f.outbound).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each([{ apiKey: 123 }, { baseURL: true }, { apiKey: 'k'.repeat(4097) }, { apiFormat: 'unknown' }])('rejects malformed inputs before reading keys %j', async patch => {
    const f = await fixture();
    try {
      expect((await f.send(patch)).statusCode).toBe(400);
      expect(f.store.getProviderApiKey).not.toHaveBeenCalled();
      expect(f.outbound).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
});

describe('credential destination normalization', () => {
  it('equates default ports and trailing slashes, keeping the approved path', () => {
    expect(normalizeCredentialDestination('https://PROXY.example:443/tenant/v1/')).toBe('https://proxy.example/tenant/v1');
    expect(normalizeCredentialDestination('http://localhost:80/')).toBe('http://localhost');
  });
  it.each(['file:///etc/passwd', 'https://key@proxy.example/v1', 'https://proxy.example/v1?key=x',
    'https://proxy.example/v1#x', 'https://proxy.example/a/../v1', 'https://proxy.example/%2e%2e/v1',
    'https://proxy.example/a%2fv1', 'https://proxy.example/a\\v1', 'http:proxy.example/v1'])('rejects ambiguous/invalid destination %s', url => {
    expect(() => normalizeCredentialDestination(url)).toThrow('LLM_DESTINATION_INVALID');
  });
  it('does not trust a provider name when the configured origin is different', async () => {
    const readKey = vi.fn();
    await expect(resolveTestCredential({ name: 'deepseek', api_base_url: 'https://private.example/v1' } as any,
      { baseURL: 'https://api.deepseek.com/v1' }, readKey)).rejects.toThrow('LLM_CREDENTIAL_DESTINATION_MISMATCH');
    expect(readKey).not.toHaveBeenCalled();
  });
  it('preserves local Ollama defaults and supports omitted URL without a credential', async () => {
    const readKey = vi.fn().mockResolvedValue(null);
    await expect(resolveTestCredential({ name: 'local', deployment_type: 'local', api_base_url: null, api_format: null } as any,
      {}, readKey)).resolves.toMatchObject({ apiKey: '', baseURL: 'http://localhost:11434', apiFormat: 'ollama', deploymentType: 'local' });
  });
  it('fails before decrypting when a concurrent configuration/key update changes the approved snapshot', async () => {
    const expected = { id: 11, name: 'custom', api_base_url: 'https://private.example/v1', api_key_encrypted: 'invalid-fake-ciphertext' } as any;
    const read = vi.spyOn(llmDatabaseService, 'getProviderByName').mockResolvedValue({ ...expected, api_base_url: 'https://changed.example/v1' });
    try {
      await expect(llmDatabaseService.getProviderApiKey('custom', expected)).rejects.toThrow('LLM_TEST_CONFIGURATION_CHANGED');
    } finally { read.mockRestore(); }
  });
});
