import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredAgentProvider, configuredModelCapabilities } from './llm-provider-factory.js';
import { resolveContextConfig } from '@slide/agent-core';
import { createServiceProviderClient } from '../llm/provider-connection.js';
import { llmService } from '../llm-service.js';
import { dbConnection } from '../db-connection.js';
import { llmDatabaseService } from '../llm-database-service.js';

const config = { name: 'proxy', enabled: true, is_default: true, supports_function_call: true, deployment_type: 'api', api_format: 'anthropic-messages', default_model: 'test-model', api_base_url: 'https://proxy.invalid' } as any;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('configured provider consistency', () => {
  it('passes selected scene model limits and capability configuration through without assuming a 200k window', async () => {
    const selected = { ...config, context_window: 32768, max_tokens: 2048, supports_vision: false };
    const agent = await createConfiguredAgentProvider({ getSceneBindings: async () => [], getAllProviders: async () => [selected], getProviderApiKey: async () => 'fixture' });
    expect(agent.getModelCapabilities?.()).toMatchObject({ model: 'test-model', contextWindowTokens: 32768,
      preferredOutputTokens: 2048, supportsTools: true, supportsVision: false, source: 'configuration' });
    expect(resolveContextConfig({ model: agent.getDefaultModel() }, agent)).toMatchObject({ contextWindowTokens: 32768, maxTokens: 2048 });
  });
  it('a model catalog tightens larger stored windows and never replaces a smaller explicit configuration', () => {
    expect(configuredModelCapabilities({ ...config, context_window: 200000 }, 'gpt-4o').contextWindowTokens).toBe(128000);
    expect(configuredModelCapabilities({ ...config, context_window: 8192 }, 'gpt-4o').contextWindowTokens).toBe(8192);
    expect(configuredModelCapabilities(config, 'unknown')).toMatchObject({ contextWindowTokens: 8192, source: 'conservative-fallback' });
    expect(() => configuredModelCapabilities({ ...config, context_window: -1 }, 'unknown')).toThrow('INVALID_MODEL_CONTEXT');
  });
  it('uses the same explicit Anthropic endpoint/key/model without mutating the environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'old-key'); vi.stubEnv('ANTHROPIC_MODEL', 'old-model');
    const agent = await createConfiguredAgentProvider({ getSceneBindings: async () => [], getAllProviders: async () => [config], getProviderApiKey: async () => 'configured-key' });
    const service = createServiceProviderClient(config, 'configured-key');
    expect(agent.getDefaultModel()).toBe(service.config.default_model);
    expect((agent as any).client.baseURL).toBe(service.client!.baseURL);
    expect((agent as any).client.apiKey).toBe('configured-key');
    expect(process.env.ANTHROPIC_API_KEY).toBe('old-key'); expect(process.env.ANTHROPIC_MODEL).toBe('old-model');
  });
  it('does not revive env credentials after every provider is disabled', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'old-key');
    const agent = await createConfiguredAgentProvider({ getSceneBindings: async () => [], getAllProviders: async () => [], getProviderApiKey: vi.fn() });
    await expect(agent.chat([], [])).rejects.toThrow('未配置提供商或全局默认');
  });
  it('supports a keyless local provider and its OpenAI-compatible endpoint', async () => {
    const key = vi.fn().mockResolvedValue(null);
    const agent = await createConfiguredAgentProvider({ getSceneBindings: async () => [], getAllProviders: async () => [{ ...config, api_format: null, deployment_type: 'local', api_base_url: 'http://localhost:11434/' }], getProviderApiKey: key });
    expect((agent as any).client.baseURL).toBe('http://localhost:11434/v1');
    expect((agent as any).client.apiKey).toBe('ollama');
    expect(key).toHaveBeenCalledWith(config.name);
  });
  it.each(['openai-completions', 'anthropic-messages'])('preserves stored local credentials for %s across agent, service and connection tests', async api_format => {
    const provider = { ...config, deployment_type: 'local', api_format };
    vi.spyOn(llmDatabaseService, 'getEnabledProviders').mockResolvedValue([provider]);
    vi.spyOn(llmDatabaseService, 'getAllProviders').mockResolvedValue([provider]);
    vi.spyOn(llmDatabaseService, 'getSceneBindings').mockResolvedValue([]);
    vi.spyOn(llmDatabaseService, 'getProviderByName').mockResolvedValue(provider);
    vi.spyOn(llmDatabaseService, 'getProviderApiKey').mockResolvedValue('local-gateway-key');

    const agent = await createConfiguredAgentProvider(llmDatabaseService);
    const connectionTest = createServiceProviderClient(provider, 'local-gateway-key');
    expect.soft((agent as any).client.apiKey).toBe(connectionTest.client!.apiKey);
    expect((agent as any).client.baseURL).toBe(connectionTest.client!.baseURL);
    expect(agent.getDefaultModel()).toBe(provider.default_model);

    expect(await llmService.initialize()).toBe(true);
    expect.soft((llmService as any).providerClients.get(provider.name).client.apiKey).toBe('local-gateway-key');
    expect(await llmService.configureProvider(provider.name)).toBe(true);
    expect.soft((llmService as any).providerClients.get(provider.name).client.apiKey).toBe('local-gateway-key');
  });
  it.each([null, ''])('falls back only when a local OpenAI endpoint has no key (%s)', async apiKey => {
    const provider = { ...config, deployment_type: 'local', api_format: 'openai-completions' };
    vi.spyOn(llmDatabaseService, 'getEnabledProviders').mockResolvedValue([provider]);
    vi.spyOn(llmDatabaseService, 'getAllProviders').mockResolvedValue([provider]);
    vi.spyOn(llmDatabaseService, 'getSceneBindings').mockResolvedValue([]);
    vi.spyOn(llmDatabaseService, 'getProviderApiKey').mockResolvedValue(apiKey);
    const agent = await createConfiguredAgentProvider(llmDatabaseService);
    expect((agent as any).client.apiKey).toBe('ollama');
    expect(await llmService.initialize()).toBe(true);
    expect((llmService as any).providerClients.get(provider.name).client.apiKey).toBe('ollama');
  });
  it('does not skip a misconfigured selected provider in favor of another', async () => {
    await expect(createConfiguredAgentProvider({ getSceneBindings: async () => [], getAllProviders: async () => [config, { ...config, name: 'other' }], getProviderApiKey: async () => null })).rejects.toThrow('LLM_CREDENTIAL_NOT_CONFIGURED');
  });
  it('does not select another protocol for an unsupported format', () => {
    expect(() => createServiceProviderClient({ ...config, api_format: 'google-generative-ai' }, 'key')).toThrow('LLM_API_FORMAT_UNSUPPORTED');
  });
  it.each(['disabled', 'read failure', 'invalid config'])('discards the old service client after %s', async mode => {
    vi.spyOn(llmDatabaseService, 'getEnabledProviders').mockResolvedValue([config]);
    vi.spyOn(llmDatabaseService, 'getProviderApiKey').mockResolvedValue('key');
    expect(await llmService.initialize()).toBe(true);
    const read = vi.spyOn(llmDatabaseService, 'getProviderByName');
    if (mode === 'read failure') read.mockRejectedValue(new Error('unavailable'));
    else read.mockResolvedValue({ ...config, enabled: mode !== 'disabled', api_format: mode === 'invalid config' ? 'unsupported' : config.api_format });
    expect(await llmService.configureProvider(config.name)).toBe(false);
    expect(llmService.getAvailableProviders()).toEqual([]);
    expect(llmService.selectProvider({ preferredName: config.name })).toBeNull();
  });
  it.each(['getAllProviders', 'getEnabledProviders', 'getDefaultProvider', 'getProviderByName', 'getProviderById', 'getProvidersByDeploymentType'] as const)('%s distinguishes database failure from missing configuration', async method => {
    const error = new Error('driver detail');
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: vi.fn().mockRejectedValue(error) } as any);
    await expect((llmDatabaseService[method] as any)('test')).rejects.toMatchObject({ message: 'LLM_CONFIGURATION_UNAVAILABLE', cause: error });
  });
});
