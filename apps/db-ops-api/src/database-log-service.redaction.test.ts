import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseLog } from './database-log-service.js';

const services = vi.hoisted(() => ({
  createAnalysis: vi.fn(),
  updateStatus: vi.fn(),
  completeAnalysis: vi.fn(),
  failAnalysis: vi.fn(),
  chatWithTracking: vi.fn(),
}));

vi.mock('./ai-analysis-database-service.js', () => ({
  aiAnalysisDatabaseService: {
    createAnalysis: services.createAnalysis,
    updateStatus: services.updateStatus,
    completeAnalysis: services.completeAnalysis,
    failAnalysis: services.failAnalysis,
  },
}));

vi.mock('./llm-service.js', () => ({ llmService: { chatWithTracking: services.chatWithTracking } }));

import { databaseLogService } from './database-log-service.js';

const log = (overrides: Partial<DatabaseLog> = {}): DatabaseLog => ({
  id: 1,
  instance_id: 7,
  log_level: 'error' as const,
  source: 'mysql_error' as const,
  message: '',
  raw_content: '',
  detected_patterns: null,
  collected_at: new Date('2026-10-25T00:00:00.000Z'),
  created_at: new Date('2026-10-25T00:00:00.000Z'),
  ...overrides,
});

describe('database log analysis redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.updateStatus.mockResolvedValue(undefined);
    services.completeAnalysis.mockResolvedValue(undefined);
    services.failAnalysis.mockResolvedValue(undefined);
    services.chatWithTracking.mockResolvedValue({ success: true, content: 'analysis', duration_ms: 1 });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('redacts credentials, connection strings, quoted values, and SQL literals before the provider call', async () => {
    await databaseLogService.triggerLogAnalysis([log({
      message: `Error 1062: duplicate entry 'person@example.invalid' for key 'users.email'; password="hunter two"; mysql://reader:uri-secret@db.internal:3306/app. Could not select a replica for this failover.`,
      raw_content: JSON.stringify({
        error_code: 1062,
        diagnostic_code: 'ER_DUP_ENTRY 1062',
        password: 'raw password',
        token: 'raw-token',
        connection: 'mongodb://raw-user:raw-uri-secret@db.internal/app',
        sql: "INSERT INTO users(email, token, retry_count) VALUES ('person@example.invalid', 'sql-secret-987', 3419)",
      }),
      detected_patterns: [{ pattern: 'password=pattern-secret', severity: 'error', message: 'not sent to the provider' }],
    })], 7, 91);

    const prompt = services.chatWithTracking.mock.calls[0][0][0].content as string;
    expect(prompt).toContain('Error 1062');
    expect(prompt).toContain('"error_code":1062');
    expect(prompt).toContain('"password":"[REDACTED]"');
    expect(prompt).toContain('"token":"[REDACTED]"');
    expect(prompt).toContain('"connection":"mongodb://[REDACTED]@db.internal/app"');
    expect(prompt).toContain(`"sql":"INSERT INTO users(email, token, retry_count) VALUES ('[REDACTED]', '[REDACTED]', NULL)"`);
    expect(prompt).toContain('INSERT INTO users(email, token, retry_count)');
    expect(prompt).toContain("VALUES ('[REDACTED]', '[REDACTED]', NULL)");
    expect(prompt).toContain('password=[REDACTED](error)');
    expect(prompt).toContain('db.internal:3306/app');
    expect(prompt).toContain('Could not select a replica for this failover.');
    for (const secret of ['person@example.invalid', 'hunter two', 'reader', 'uri-secret', 'raw password', 'raw-token', 'raw-user', 'raw-uri-secret', 'sql-secret-987', 'pattern-secret', '3419']) {
      expect(prompt).not.toContain(secret);
    }
  });

  it('preserves diagnostic prefixes and records a gap when a source has no known SQL dialect', async () => {
    await databaseLogService.triggerLogAnalysis([log({
      source: 'other',
      message: `Error code 1205: query SELECT * FROM accounts WHERE email = 'message-private'`,
      raw_content: `Error 1205; SELECT * FROM accounts WHERE note = 'before;after-private'`,
    })], 7, 92);

    const prompt = services.chatWithTracking.mock.calls[0][0][0].content as string;
    expect(prompt).toContain('Error code 1205');
    expect(prompt).toContain('Error 1205;');
    expect(prompt).toContain('SQL 已省略');
    expect(prompt).toContain('SQL_REDACTION_UNAVAILABLE');
    expect(prompt).not.toContain('message-private');
    expect(prompt).not.toContain('after-private');
    expect(services.completeAnalysis).toHaveBeenCalledWith(92, expect.objectContaining({
      result: expect.objectContaining({ redaction_gaps: ['SQL_REDACTION_UNAVAILABLE'] }),
    }));
  });
});
