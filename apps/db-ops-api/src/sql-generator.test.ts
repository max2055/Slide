/**
 * Nyquist validation: 106-04 — sql-generator AI SQL generation service
 *
 * Tests:
 * 1. generateCollectionSql returns SQL for valid mysql description
 * 2. generateCollectionSql returns error when description is empty
 * 3. Generated SQL passes validateSqlIsSelectOnly()
 * 4. extractSqlFromResponse strips markdown code blocks
 * 5. extractSqlFromResponse returns raw text if no code blocks
 * 6. extractSqlFromResponse returns null for empty response
 * 7. extractSqlFromResponse handles sql-marked code blocks
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock llmService
vi.mock('./llm-service.js', () => ({
  llmService: {
    chat: vi.fn(),
  },
}));

import { generateCollectionSql, extractSqlFromResponse } from './sql-generator.js';
import { llmService } from './llm-service.js';
import { validateSqlIsSelectOnly } from './sql-validator.js';

describe('106-04: sql-generator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns SQL for valid mysql description', async () => {
    vi.mocked(llmService.chat).mockResolvedValue({
      success: true,
      content: 'SELECT COUNT(*) as val FROM information_schema.PROCESSLIST',
    });

    const result = await generateCollectionSql('mysql', '监控活跃连接数');
    expect(result.sql).toBeDefined();
    expect(result.sql).toContain('SELECT');
    expect(result.error).toBeUndefined();
  });

  it('returns error when description is empty', async () => {
    const result = await generateCollectionSql('mysql', '');
    expect(result.error).toBeDefined();
    expect(result.sql).toBeUndefined();
    expect(llmService.chat).not.toHaveBeenCalled();
  });

  it('returns error when description is whitespace-only', async () => {
    const result = await generateCollectionSql('mysql', '   ');
    expect(result.error).toBeDefined();
    expect(result.sql).toBeUndefined();
  });

  it('Generated SQL passes validateSqlIsSelectOnly()', async () => {
    vi.mocked(llmService.chat).mockResolvedValue({
      success: true,
      content: 'SELECT COUNT(*) as val FROM information_schema.PROCESSLIST',
    });

    const result = await generateCollectionSql('mysql', '监控活跃连接数');
    expect(result.sql).toBeDefined();
    if (result.sql) {
      const validation = validateSqlIsSelectOnly(result.sql);
      expect(validation.valid).toBe(true);
    }
  });

  it('returns error when LLM call fails', async () => {
    vi.mocked(llmService.chat).mockResolvedValue({
      success: false,
      error: 'API 调用失败',
    });

    const result = await generateCollectionSql('mysql', '监控活跃连接数');
    expect(result.error).toBeDefined();
    expect(result.sql).toBeUndefined();
  });

  it('extractSqlFromResponse strips markdown code blocks', () => {
    const response = '```sql\nSELECT COUNT(*) as val FROM PROCESSLIST\n```';
    expect(extractSqlFromResponse(response)).toBe('SELECT COUNT(*) as val FROM PROCESSLIST');
  });

  it('extractSqlFromResponse returns raw text if no code blocks', () => {
    const response = 'SELECT COUNT(*) as val FROM PROCESSLIST';
    expect(extractSqlFromResponse(response)).toBe('SELECT COUNT(*) as val FROM PROCESSLIST');
  });

  it('extractSqlFromResponse returns null for empty response', () => {
    expect(extractSqlFromResponse('')).toBeNull();
    expect(extractSqlFromResponse('   ')).toBeNull();
  });

  it('extractSqlFromResponse handles sql-marked code blocks', () => {
    const response = '```\nSELECT count(*) as val FROM pg_stat_activity\n```';
    expect(extractSqlFromResponse(response)).toBe('SELECT count(*) as val FROM pg_stat_activity');
  });

  it('calls LLM with proper system prompt for mysql', async () => {
    vi.mocked(llmService.chat).mockResolvedValue({
      success: true,
      content: 'SELECT COUNT(*) as val FROM PROCESSLIST',
    });

    await generateCollectionSql('mysql', '监控活跃连接数');
    expect(llmService.chat).toHaveBeenCalledTimes(1);
    const messages = vi.mocked(llmService.chat).mock.calls[0][0];
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('MySQL');
  });
});
