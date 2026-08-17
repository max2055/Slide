import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureConnectionAlive: vi.fn(),
  getConnection: vi.fn(),
  auditSql: vi.fn(),
  recordSecurityEvent: vi.fn(),
  authorizeApproval: vi.fn(),
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
  securityEventService: { record: mocks.recordSecurityEvent },
}));

import { sqlExecutor } from './sql-executor.js';

describe('SqlExecutor security controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureConnectionAlive.mockResolvedValue(true);
    mocks.authorizeApproval.mockResolvedValue(false);
    mocks.recordSecurityEvent.mockResolvedValue(undefined);
  });

  it('runs PostgreSQL reads in a read-only transaction with a mandatory timeout and server-side row cap', async () => {
    const rows = Array.from({ length: 1001 }, (_, id) => ({ id }));
    const query = vi.fn(async (sql: string) => {
      if (/^SELECT \* FROM \(/.test(sql)) return { rows, fields: [{ name: 'id' }] };
      return { rows: [], fields: [] };
    });
    mocks.getConnection.mockReturnValue({
      id: 7,
      name: 'pg',
      db_type: 'postgresql',
      pgClient: { query },
    });

    const result = await sqlExecutor.executeSql(7, 'SELECT id FROM users');

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 15000',
      'SELECT * FROM (SELECT id FROM users) AS slide_read_limit LIMIT 1001',
      'COMMIT',
    ]);
    expect(result).toMatchObject({ success: true, rowCount: 1000, truncated: true });
    expect(result.rows).toHaveLength(1000);
  });

  it('uses one dedicated MySQL connection and restores session limits before releasing it', async () => {
    const rows = Array.from({ length: 1001 }, (_, id) => ({ id }));
    const connection = {
      query: vi.fn(async (sql: string) => sql === 'SELECT id FROM users'
        ? [rows, [{ name: 'id' }]]
        : [[], []]),
      release: vi.fn(),
    };
    const pool = {
      getConnection: vi.fn(async () => connection),
      query: vi.fn(),
    };
    mocks.getConnection.mockReturnValue({ id: 8, name: 'mysql', db_type: 'mysql', pool });

    const result = await sqlExecutor.executeSql(8, 'SELECT id FROM users');

    expect(pool.getConnection).toHaveBeenCalledOnce();
    expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
      'SET SESSION max_execution_time = 15000',
      'SET SESSION sql_select_limit = 1001',
      'START TRANSACTION READ ONLY',
      'SELECT id FROM users',
      'COMMIT',
      'SET SESSION max_execution_time = 0',
      'SET SESSION sql_select_limit = DEFAULT',
    ]);
    expect(connection.release).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: true, rowCount: 1000, truncated: true });
  });

  it('clamps a caller-supplied timeout to the security maximum', async () => {
    const query = vi.fn(async () => ({ rows: [{ value: 1 }], fields: [{ name: 'value' }] }));
    mocks.getConnection.mockReturnValue({
      id: 9,
      name: 'pg',
      db_type: 'postgresql',
      pgClient: { query },
    });

    await sqlExecutor.executeSql(9, 'SELECT 1 AS value', { timeoutMs: 999_999 });

    expect(query).toHaveBeenCalledWith('SET LOCAL statement_timeout = 30000');
  });

  it.each([
    ['SELECT 1; DELETE FROM users', 'MULTI_STATEMENT'],
    ['SET search_path TO public', 'session'],
    ['BEGIN', 'transaction'],
    ['CALL dangerous_procedure()', 'procedure'],
  ])('never turns an approval into arbitrary SQL execution: %s', async (sql, reason) => {
    const query = vi.fn();
    mocks.authorizeApproval.mockResolvedValue(true);
    mocks.getConnection.mockReturnValue({
      id: 10,
      name: 'pg',
      db_type: 'postgresql',
      pgClient: { query },
    });

    const result = await sqlExecutor.executeSql(10, sql, {
      approvalGrant: { approvalRequestId: 1, reviewerId: 2, operationId: 'bound-operation' },
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining(reason) });
    expect(query).not.toHaveBeenCalled();
  });
});
