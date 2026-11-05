import { describe, expect, it } from 'vitest';
import type { LLMProvider } from '../llm-database-service.js';
import { publicLLMProvider } from './public-provider.js';

describe('GitHub #292 provider response boundary', () => {
  it('allowlists provider and nested model metadata without mutating runtime credentials', () => {
    const provider = {
      id: 7, name: 'local', api_base_url: 'http://localhost:11434', enabled: true,
      api_key_encrypted: 'cipher-sentinel', apiKey: 'plain-sentinel', API_KEY: 'variant-sentinel',
      futureSecret: 'future-sentinel',
      models_supported: [{ id: 'model', contextWindow: 32000, maxTokens: 1024,
        api_key_encrypted: 'nested-sentinel', apiKey: 'nested-plain-sentinel',
        cost: { input: 1, output: 2, secret: 'cost-sentinel' } }],
    } as unknown as LLMProvider;
    const dto = publicLLMProvider(provider);
    expect(dto).toMatchObject({ id: 7, name: 'local', enabled: true, hasApiKey: true,
      models_supported: [{ id: 'model', contextWindow: 32000, maxTokens: 1024, cost: { input: 1, output: 2 } }] });
    expect(JSON.stringify(dto)).not.toContain('sentinel');
    expect(provider.api_key_encrypted).toBe('cipher-sentinel');
  });
  it.each([null, ''])('reports absent credentials without adding a secret field', key => {
    const dto = publicLLMProvider({ api_key_encrypted: key, models_supported: null } as LLMProvider);
    expect(dto.hasApiKey).toBe(false);
    expect(dto.models_supported).toBeNull();
    expect(dto).not.toHaveProperty('api_key_encrypted');
  });
});

describe('MAX-329 independent review regressions', () => {
  const secret = 'SYNTHETIC_REVIEW_SENTINEL';
  const cases = [
    ['URL userinfo', { api_base_url: `https://user:${secret}@example.invalid/v1` }],
    ['URL x-api-key', { api_base_url: `https://example.invalid/v1?x-api-key=${secret}` }],
    ['URL clientSecret', { api_base_url: `https://example.invalid/v1?clientSecret=${secret}` }],
    ['model name object', { models_supported: [{ id: 'm', name: { clientSecret: secret } }] }],
    ['model desc object', { models_supported: [{ id: 'm', desc: { API_KEY: secret } }] }],
    ['cost input object', { models_supported: [{ id: 'm', cost: { input: { 'subscription-key': secret } } }] }],
  ] as const;
  it.each(cases)('blocks %s without mutating the internal provider', (_name, input) => {
    const before = structuredClone(input);
    expect(JSON.stringify(publicLLMProvider(input as unknown as LLMProvider))).not.toContain(secret);
    expect(input).toEqual(before);
  });
  it.each(['subscription-key', 'CLIENT_SECRET', 'client%53ecret', 'unknown-new-auth-field'])('drops untrusted URL query %s and fragments', key => {
    const input = { api_base_url: `https://example.invalid:8443/proxy/v1?${key}=${secret}&api-version=2024-06-01-preview#${secret}` };
    expect(publicLLMProvider(input as LLMProvider).api_base_url).toBe('https://example.invalid:8443/proxy/v1?api-version=2024-06-01-preview');
    expect(input.api_base_url).toContain(secret);
  });
  it.each(['::::?x-api-key=secret', 'file:///private/secret', 'https://', 'api.example.test:8443/v1'])('does not publish unsupported or malformed URL %s', api_base_url => {
    expect(publicLLMProvider({ api_base_url } as LLMProvider).api_base_url).toBeNull();
  });
  it('preserves clean URLs verbatim and refuses a secret disguised as an API version', () => {
    const api_base_url = 'http://localhost:11434';
    expect(publicLLMProvider({ api_base_url } as LLMProvider).api_base_url).toBe(api_base_url);
    expect(publicLLMProvider({ api_base_url: `https://example.invalid/v1?api-version=${secret}` } as LLMProvider).api_base_url).toBe('https://example.invalid/v1');
  });
  it('preserves ordinary metadata with their declared scalar types', () => {
    const model = { id: 'm', name: 'Model', desc: 'Legacy description', recommended: true,
      maxTokens: 1024, contextWindow: 32000, supportsFunctionCall: false, supportsVision: true,
      parameterProvider: 'manual-provider', parameterSource: 'manual' as const, cost: { input: 0, output: 2.5 } };
    expect(publicLLMProvider({ models_supported: [model] } as unknown as LLMProvider).models_supported).toEqual([model]);
  });
  it('omits invalid scalar values and malformed old model entries instead of reflecting their contents', () => {
    const model = { id: 'm', name: [secret], desc: { API_KEY: secret }, recommended: { secret },
      maxTokens: Infinity, contextWindow: -1, supportsFunctionCall: 'false', supportsVision: { secret },
      parameterProvider: { secret }, parameterSource: secret, cost: { input: NaN, output: { secret } } };
    const result = publicLLMProvider({ models_supported: [null, [], 'bad', { id: { secret } }, model] } as unknown as LLMProvider);
    expect(result.models_supported).toEqual([{ id: 'm', cost: {} }]);
    expect(publicLLMProvider({ models_supported: { secret } } as unknown as LLMProvider).models_supported).toBeNull();
  });
});
