import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmDatabaseService } from '../llm-database-service.js';
import { dbConnection } from '../db-connection.js';

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
});
