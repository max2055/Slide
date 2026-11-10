import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureConnectionAlive: vi.fn(),
  getConnection: vi.fn(),
  auditSql: vi.fn(),
  authorizeApproval: vi.fn(),
  beginIntent: vi.fn(),
  finishIntent: vi.fn(),
}));

vi.mock('./database-service', () => ({
  databaseService: {
    ensureConnectionAlive: mocks.ensureConnectionAlive,
    getConnection: mocks.getConnection,
  },
}));

vi.mock('./audit/audit-log', () => ({
  auditLogManager: { logSqlExecution: mocks.auditSql },
}));

vi.mock('./db-connection', () => ({
  dbConnection: { getPool: vi.fn(() => ({})) },
}));

vi.mock('./security/approval-execution-authorizer', () => ({
  authorizeApprovedSqlExecution: mocks.authorizeApproval,
}));

vi.mock('./security/security-event-service', () => ({
  securityEventService: { record: vi.fn(async () => undefined) },
}));

vi.mock('./audit/sql-execution-intent.js', () => ({
  sqlExecutionIntent: { begin: mocks.beginIntent, finish: mocks.finishIntent },
}));

import { sqlExecutor } from './sql-executor.js';

const WRAP_TAIL = ') AS slide_read_limit LIMIT 1001';

describe('PostgreSQL read-only wrapping keeps comments and literals', () => {
  let query: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureConnectionAlive.mockResolvedValue(true);
    mocks.authorizeApproval.mockResolvedValue(false);
    mocks.beginIntent.mockResolvedValue(undefined);
    mocks.finishIntent.mockResolvedValue(undefined);
    mocks.auditSql.mockResolvedValue(undefined);
    query = vi.fn(async (text: string) => {
      if (text.startsWith('SELECT * FROM (')) {
        const rows = Array.from({ length: text.includes('LIMIT 1001') ? 1001 : 1 }, (_, id) => ({ id }));
        return { rows, fields: [{ name: 'id' }] };
      }
      return { rows: [], fields: [] };
    });
    mocks.getConnection.mockReturnValue({
      id: 375,
      name: 'pg',
      db_type: 'postgresql',
      pgClient: { query, escapeIdentifier: (value: string) => `"${value.replace(/"/g, '""')}"` },
    });
  });

  async function sent(sql: string, timeoutMs?: number): Promise<string> {
    const result = await sqlExecutor.executeSql(375, sql, timeoutMs === undefined ? undefined : { timeoutMs });
    expect(result.success).toBe(true);
    const statement = query.mock.calls.map(([text]) => text).find((text: string) => text.startsWith('SELECT * FROM ('));
    expect(statement).toBeTypeOf('string');
    return statement as string;
  }

  it.each([
    ['SELECT 1 -- note;', 'SELECT 1 -- note;\n'],
    ['SELECT 1 -- note', 'SELECT 1 -- note\n'],
    ['SELECT 1 -- note\n', 'SELECT 1 -- note\n'],
    ['SELECT 1; -- note', 'SELECT 1'],
    ['SELECT 1;\n-- note', 'SELECT 1'],
    ['SELECT 1; /* tail */', 'SELECT 1'],
    ['SELECT 1;', 'SELECT 1'],
    ['SELECT 1;;', 'SELECT 1'],
    ['SELECT 1', 'SELECT 1'],
    ["SELECT ';'", "SELECT ';'"],
    ["SELECT ';';", "SELECT ';'"],
    ["SELECT 'a;b' -- note", "SELECT 'a;b' -- note\n"],
    ["SELECT 'it'';s;'", "SELECT 'it'';s;'"],
    ["SELECT E';'", "SELECT E';'"],
    ['SELECT 1 /* ; */', 'SELECT 1 /* ; */'],
    ['SELECT "a;b"', 'SELECT "a;b"'],
  ])('wraps %j without leaving the closer inside a comment', async (sql, inner) => {
    const statement = await sent(sql);
    expect(statement).toBe(`SELECT * FROM (${inner}) AS slide_read_limit LIMIT 1001`);
    expect(statement.endsWith(WRAP_TAIL)).toBe(true);
    expect(query.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 15000',
      statement,
      'COMMIT',
    ]);
  });

  it.each([
    ['SELECT $$;$$', 'SELECT $$;$$'],
    ['SELECT $tag$;$tag$', 'SELECT $tag$;$tag$'],
    ['SELECT 1 /* outer /* ; */ still */', 'SELECT 1 /* outer /* ; */ still */'],
  ])('wraps PostgreSQL syntax the MySQL pre-check cannot parse: %j', async (sql, inner) => {
    mocks.authorizeApproval.mockResolvedValue(true);
    const result = await sqlExecutor.executeSql(375, sql, {
      approvalGrant: { approvalRequestId: 375, reviewerId: 2, operationId: 'max375-pg-literal' },
    });
    expect(result.success).toBe(true);
    expect(query.mock.calls.map(([text]) => text)[2]).toBe(`SELECT * FROM (${inner}) AS slide_read_limit LIMIT 1001`);
    expect(mocks.beginIntent).not.toHaveBeenCalled();
  });

  it('keeps the ordinary SELECT 1 row cap', async () => {
    const result = await sqlExecutor.executeSql(375, 'SELECT 1;');
    expect(query.mock.calls.map(([text]) => text)[2]).toBe('SELECT * FROM (SELECT 1) AS slide_read_limit LIMIT 1001');
    expect(result).toMatchObject({ success: true, rowCount: 1000, truncated: true });
    expect(result.rows).toHaveLength(1000);
  });

  it('still applies the caller statement timeout before the wrapped read', async () => {
    await sqlExecutor.executeSql(375, 'SELECT 1 -- note;', { timeoutMs: 250 });
    expect(query).toHaveBeenCalledWith('SET LOCAL statement_timeout = 250');
  });

  it('rolls the read back when the wrapped statement fails and accepts the next read', async () => {
    query.mockImplementation(async (text: string) => {
      if (text.startsWith('SELECT * FROM (')) throw new Error('canceling statement due to statement timeout');
      return { rows: [], fields: [] };
    });
    const failed = await sqlExecutor.executeSql(375, 'SELECT 1 -- note;', { timeoutMs: 250 });
    expect(failed).toMatchObject({ success: false, error: expect.stringContaining('statement timeout') });
    expect(query.mock.calls.map(([text]) => text)).toContain('ROLLBACK');

    query.mockImplementation(async (text: string) => {
      if (text.startsWith('SELECT * FROM (')) return { rows: [{ id: 1 }], fields: [{ name: 'id' }] };
      return { rows: [], fields: [] };
    });
    const next = await sqlExecutor.executeSql(375, 'SELECT 1;');
    expect(next).toMatchObject({ success: true, rowCount: 1, truncated: false });
  });

  it.each([
    ['SELECT 1; SELECT 2', 'SQL_STATEMENT_NOT_ALLOWED_MULTI_STATEMENT', true],
    ['SELECT 1 -- note;\nSELECT 2', 'SQL_STATEMENT_NOT_ALLOWED_unknown', true],
    ['DELETE FROM probe', 'SQL_APPROVAL_REQUIRED_UNCLASSIFIED', false],
    ['UPDATE probe SET id = 1', 'SQL_APPROVAL_REQUIRED_UNCLASSIFIED', false],
  ])('does not execute a rejected statement %j', async (sql, error, approved) => {
    mocks.authorizeApproval.mockResolvedValue(approved);
    const result = await sqlExecutor.executeSql(375, sql, approved ? {
      approvalGrant: { approvalRequestId: 375, reviewerId: 2, operationId: 'max375-reject' },
    } : undefined);
    expect(result).toMatchObject({ success: false, error });
    expect(query).not.toHaveBeenCalled();
    expect(mocks.beginIntent).not.toHaveBeenCalled();
  });
});
