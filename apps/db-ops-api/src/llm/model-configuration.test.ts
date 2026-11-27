import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmDatabaseService, type LLMProvider } from '../llm-database-service.js';
import { dbConnection } from '../db-connection.js';
import { publicLLMProvider } from './public-provider.js';

afterEach(() => vi.restoreAllMocks());
describe('model configuration input validation', () => {
  it.each([
    { contextWindow: 0 }, { contextWindow: -1 }, { contextWindow: 2.5 }, { maxTokens: 0 }, { maxTokens: -1 },
    { contextWindow: 4096, maxTokens: 4096 },
    { modelsSupported: [{ id: 'known', contextWindow: -1 }] },
    { modelsSupported: [{ id: 'known', maxTokens: -1 }] },
  ])('rejects invalid limits before writing %j', async patch => {
    const execute = vi.fn().mockResolvedValue([[]]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    const result = await llmDatabaseService.configureProvider({ name: 'test', ...patch } as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('LLM_MODEL_PARAMETERS_INVALID');
    expect(execute).not.toHaveBeenCalled();
  });

  it('retains hidden metadata for the same model without restoring cleared fields or deleted models', async () => {
    const execute = vi.fn<(sql: string, values: unknown[]) => Promise<unknown>>().mockResolvedValue([{ affectedRows: 1 }]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    const storedModels = [
      { id: 'known', name: 'Old', contextWindow: 16_384, cost: { input: 2, output: 3, extension: 'private' }, opaque_extension: { marker: 'private' } },
      { id: 'deleted', name: 'Deleted', opaque_extension: 'old' },
    ];
    const provider = { id: 1, name: 'test', default_model: 'known', context_window: 4096, max_tokens: 2048, models_supported: storedModels } as unknown as LLMProvider;
    vi.spyOn(llmDatabaseService, 'getProviderByName').mockResolvedValue(provider);
    const [visible] = publicLLMProvider(provider).models_supported!;
    expect(visible).not.toHaveProperty('opaque_extension');
    expect(visible.cost).toEqual({ input: 2, output: 3 });
    expect(await llmDatabaseService.configureProvider({ name: 'test', modelsSupported: [{ id: 'known', name: 'New' }, { id: 'new', name: 'New ID' }] })).toMatchObject({ success: true });
    const stored = JSON.parse(String(execute.mock.calls[0][1][0]));
    expect(stored).toEqual([
      { id: 'known', name: 'New', opaque_extension: { marker: 'private' }, cost: { extension: 'private' } },
      { id: 'new', name: 'New ID' },
    ]);
    expect(publicLLMProvider({ ...provider, models_supported: stored }).models_supported).toEqual([
      { id: 'known', name: 'New', cost: {} }, { id: 'new', name: 'New ID' },
    ]);
    expect(execute.mock.calls[0][1]).toEqual([JSON.stringify(stored), 'test', 1, JSON.stringify(storedModels)]);
    expect(execute.mock.calls[0][0]).toContain('AND id = ? AND');
    expect(execute.mock.calls[0][0]).toContain('<=> CAST(? AS JSON)');

    execute.mockResolvedValueOnce([{ affectedRows: 0 }]);
    expect(await llmDatabaseService.configureProvider({ name: 'test', modelsSupported: [] })).toMatchObject({
      success: false, error: expect.stringContaining('LLM_MODEL_CONFIGURATION_CHANGED'),
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
