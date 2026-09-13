import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredAgentProvider } from './llm-provider-factory.js';
import { createServiceProviderClient } from '../llm/provider-connection.js';
import { llmService } from '../llm-service.js';
import { dbConnection } from '../db-connection.js';
import { llmDatabaseService } from '../llm-database-service.js';

const config = { name: 'proxy', enabled: true, deployment_type: 'api', api_format: 'anthropic-messages', default_model: 'test-model', api_base_url: 'https://proxy.invalid' } as any;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('configured provider consistency', () => {
  it('uses the same explicit Anthropic endpoint/key/model without mutating the environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'old-key'); vi.stubEnv('ANTHROPIC_MODEL', 'old-model');
    const agent = await createConfiguredAgentProvider({ getEnabledProviders: async () => [config], getProviderApiKey: async () => 'configured-key' });
    const service = createServiceProviderClient(config, 'configured-key');
    expect(agent.getDefaultModel()).toBe(service.config.default_model);
    expect((agent as any).client.baseURL).toBe(service.client!.baseURL);
    expect((agent as any).client.apiKey).toBe('configured-key');
    expect(process.env.ANTHROPIC_API_KEY).toBe('old-key'); expect(process.env.ANTHROPIC_MODEL).toBe('old-model');
  });
  it('does not revive env credentials after every provider is disabled', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'old-key');
    const agent = await createConfiguredAgentProvider({ getEnabledProviders: async () => [], getProviderApiKey: vi.fn() });
    await expect(agent.chat([], [])).rejects.toThrow('LLM_PROVIDER_NOT_CONFIGURED');
  });
  it('supports a keyless local provider and its OpenAI-compatible endpoint', async () => {
    const key = vi.fn();
    const agent = await createConfiguredAgentProvider({ getEnabledProviders: async () => [{ ...config, api_format: null, deployment_type: 'local', api_base_url: 'http://localhost:11434/' }], getProviderApiKey: key });
    expect((agent as any).client.baseURL).toBe('http://localhost:11434/v1'); expect(key).not.toHaveBeenCalled();
  });
  it('does not skip a misconfigured selected provider in favor of another', async () => {
    await expect(createConfiguredAgentProvider({ getEnabledProviders: async () => [config, { ...config, name: 'other' }], getProviderApiKey: async () => null })).rejects.toThrow('LLM_CREDENTIAL_NOT_CONFIGURED');
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
