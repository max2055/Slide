import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./llm/provider-connection.js', () => ({ createServiceProviderClient: vi.fn() }));
vi.mock('./llm/scene-routing.js', () => ({ resolveSceneModel: vi.fn() }));

const provider = (name: string, isDefault = false) => ({
  name, display_name: name, deployment_type: 'ollama', default_model: 'm', models_supported: null,
  context_window: 8192, supports_function_call: false, supports_vision: false, enabled: true, is_default: isDefault,
});

describe('LLMService provider isolation and reload', () => {
  beforeEach(() => vi.resetModules());

  it('isolates a Provider that cannot build a client instead of failing the whole service', async () => {
    const { createServiceProviderClient } = await import('./llm/provider-connection.js');
    (createServiceProviderClient as any).mockImplementation((p: any) => {
      if (p.name === 'bad') throw new Error('LLM_CREDENTIAL_NOT_CONFIGURED');
      return { name: p.name, type: 'ollama', client: null, config: p };
    });
    const { llmDatabaseService } = await import('./llm-database-service.js');
    vi.spyOn(llmDatabaseService, 'getEnabledProviders').mockResolvedValue([provider('good', true), provider('bad')] as any);
    vi.spyOn(llmDatabaseService, 'getProviderApiKey').mockResolvedValue('k');
    const { LLMService } = await import('./llm-service.js') as any;
    const service = new LLMService();
    await expect(service.initialize()).resolves.toBe(true);
    expect(service.getAvailableProviders().map((p: any) => p.name)).toEqual(['good']);
    expect(service.isInitialized()).toBe(true);
  });

  it('keeps the previous clients when a reload cannot load any provider', async () => {
    const { createServiceProviderClient } = await import('./llm/provider-connection.js');
    (createServiceProviderClient as any).mockImplementation((p: any) => ({ name: p.name, type: 'ollama', client: null, config: p }));
    const { llmDatabaseService } = await import('./llm-database-service.js');
    const enabled = vi.spyOn(llmDatabaseService, 'getEnabledProviders').mockResolvedValue([provider('good', true)] as any);
    vi.spyOn(llmDatabaseService, 'getProviderApiKey').mockResolvedValue('k');
    const { LLMService } = await import('./llm-service.js') as any;
    const service = new LLMService();
    expect(await service.initialize()).toBe(true);
    enabled.mockRejectedValueOnce(new Error('db down'));
    await expect(service.reloadConfig()).rejects.toThrow('LLM_CONFIGURATION_UNAVAILABLE');
    expect(service.isInitialized()).toBe(true);
    expect(service.getAvailableProviders().map((p: any) => p.name)).toEqual(['good']);
  });
});
