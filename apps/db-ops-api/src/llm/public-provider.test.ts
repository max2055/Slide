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
