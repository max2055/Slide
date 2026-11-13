import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { llmDatabaseService } from './llm-database-service.js';

afterEach(() => vi.restoreAllMocks());
describe('provider protocol save boundary (#471)', () => {
  it.each(['google-generative-ai', 'unknown', 'OPENAI-COMPLETIONS', ' openai-completions '])('rejects %s before persistence', async apiFormat => {
    const execute = vi.fn();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as never);
    vi.spyOn(llmDatabaseService, 'getProviderByName').mockResolvedValue(null);
    const result = await llmDatabaseService.configureProvider({ name: 'custom', apiFormat });
    expect(result.success).toBe(false);
    expect(result.error).toContain('LLM_API_FORMAT_UNSUPPORTED');
    expect(execute).not.toHaveBeenCalled();
  });
  it('preserves an existing legacy protocol when updating unrelated metadata', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as never);
    vi.spyOn(llmDatabaseService, 'getProviderByName').mockResolvedValue({
      id: 1, name: 'google', api_format: 'google-generative-ai', context_window: 64000, max_tokens: 2048,
    } as any);
    expect(await llmDatabaseService.configureProvider({ name: 'google', displayName: '历史配置' })).toMatchObject({ success: true });
    expect(execute.mock.calls[0][0]).not.toContain('api_format');
  });
  it.each(['anthropic-messages', 'openai-completions', 'ollama', ''])('accepts supported/automatic format %s', async apiFormat => {
    const execute = vi.fn().mockResolvedValue([{ insertId: 7 }]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as never);
    vi.spyOn(llmDatabaseService, 'getProviderByName').mockResolvedValue(null);
    expect(await llmDatabaseService.configureProvider({ name: 'custom', apiFormat })).toMatchObject({ success: true });
    expect(execute.mock.calls[0][1][3]).toBe(apiFormat || null);
  });
});
