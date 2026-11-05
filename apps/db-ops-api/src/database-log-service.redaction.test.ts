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
import { redactDatabaseLogText } from './database-log-redaction.js';

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

  it('redacts nested credential key variants while retaining diagnostic fields', () => {
    const input = JSON.stringify({ clientSecret: 'demo-secret', accessToken: 'demo-access', nested: [{ CLIENT_SECRET: 'one', 'access-token': 'two', CLIENTSECRET: 'three', error_code: 1062 }] });
    const result = JSON.parse(redactDatabaseLogText(input, 'mysql').text);
    expect(result).toEqual({ clientSecret: '[REDACTED]', accessToken: '[REDACTED]', nested: [{ CLIENT_SECRET: '[REDACTED]', 'access-token': '[REDACTED]', CLIENTSECRET: '[REDACTED]', error_code: 1062 }] });
  });

  it('fails closed for explicitly identified unsupported SQL and handles semicolons inside SQL', () => {
    for (const sql of ['SET @customer_id = 123456789', 'UNSUPPORTED DIALECT THING 555555555', "SELECT 'before;private' /* ; secret */ FROM accounts WHERE id = 987654321"]) {
      const result = redactDatabaseLogText(JSON.stringify({ sql, error_code: 1062 }), 'mysql');
      expect(result.text).not.toContain('123456789');
      expect(result.text).not.toContain('private');
      expect(result.text).not.toContain('987654321');
      expect(result.text).not.toContain('555555555');
      expect(result.text).toContain('1062');
      if (sql.startsWith('UNSUPPORTED')) expect(result.gaps).toContain('SQL_REDACTION_UNAVAILABLE');
    }
  });

  it('does not let quoted or commented semicolons hide a later unsupported statement', () => {
    for (const input of [
      "query: SELECT 'inside;secret' FROM accounts; UNSUPPORTED 333333333",
      'sql: SELECT 1 /* ; comment */ FROM accounts; UNSUPPORTED 333333333',
      'SELECT 444444444; query: UNSUPPORTED 333333333',
      'Could not select a replica. query: UNSUPPORTED 333333333',
      'SET @customer_id = 123456789',
    ]) {
      const result = redactDatabaseLogText(input, 'mysql');
      expect(result.text).not.toContain('inside;secret');
      expect(result.text).not.toContain('333333333');
      expect(result.text).not.toContain('444444444');
      expect(result.text).not.toContain('123456789');
      if (input.includes('UNSUPPORTED')) expect(result.gaps).toContain('SQL_REDACTION_UNAVAILABLE');
    }
  });

  it('protects message, raw content and pattern names in the real prompt assembly without changing logs', async () => {
    const input = log({
      message: 'Error 1062: sql: SET @customer_id = 123456789',
      raw_content: JSON.stringify({ clientSecret: 'demo-secret', accessToken: 'demo-access', nested: [{ 'CLIENT_SECRET': 'nested-secret', error_code: 1062, statement: 'UNSUPPORTED DIALECT THING 555555555' }], sql: "SELECT 'before;private' /* ; comment-secret */ FROM accounts WHERE id = 987654321" }),
      detected_patterns: [{ pattern: 'query: SET @customer_id = 777777777', severity: 'error', message: 'not sent' }],
    });
    const original = structuredClone(input);
    await databaseLogService.triggerLogAnalysis([input], 7, 93);
    const prompt = services.chatWithTracking.mock.calls[0][0][0].content as string;
    for (const secret of ['123456789', '777777777', '555555555', 'demo-secret', 'demo-access', 'nested-secret', 'private', 'comment-secret', '987654321']) expect(prompt).not.toContain(secret);
    expect(prompt).toContain('1062');
    expect(prompt).toContain('SQL_REDACTION_UNAVAILABLE');
    expect(services.completeAnalysis).toHaveBeenCalledWith(93, expect.objectContaining({ result: expect.objectContaining({ redaction_gaps: ['SQL_REDACTION_UNAVAILABLE'] }) }));
    expect(input).toEqual(original);
  });

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
