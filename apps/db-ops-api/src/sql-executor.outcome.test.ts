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
  securityEventService: { record: vi.fn() },
}));

vi.mock('./audit/sql-execution-intent.js', () => ({
  sqlExecutionIntent: { begin: mocks.beginIntent, finish: mocks.finishIntent },
}));

import { sqlExecutor } from './sql-executor.js';

const grant = { approvalRequestId: 374, reviewerId: 2, operationId: 'max374-op' };
const update = "UPDATE probe SET note = 'next' WHERE id = 1";

function pgDouble(fail?: (sql: string) => Error | undefined) {
  const calls: string[] = [];
  const client = {
    calls,
    escapeIdentifier: (value: string) => `"${value.replace(/"/g, '""')}"`,
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      const error = fail?.(sql);
      if (error) throw error;
      if (sql.startsWith('SELECT')) return { rows: [{ id: 1 }], fields: [{ name: 'id' }] };
      return { rows: [], fields: [] };
    }),
  };
  mocks.getConnection.mockReturnValue({
    id: 374, name: 'pg', db_type: 'postgresql', pgClient: client,
  });
  return client;
}

async function run(sql = update, operationId = grant.operationId) {
  return sqlExecutor.executeSql(374, sql, { approvalGrant: { ...grant, operationId } });
}

describe('MAX-374 mutation outcome receipts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureConnectionAlive.mockResolvedValue(true);
    mocks.authorizeApproval.mockResolvedValue(true);
    mocks.beginIntent.mockResolvedValue(undefined);
    mocks.finishIntent.mockResolvedValue(undefined);
    mocks.auditSql.mockResolvedValue(undefined);
  });

  it('records a PostgreSQL statement failure as rolled back only after ROLLBACK completes', async () => {
    const client = pgDouble((sql) => sql.startsWith('UPDATE') ? new Error('duplicate key value violates unique constraint') : undefined);
    const result = await run();

    expect(client.calls).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 15000',
      update,
      'ROLLBACK',
    ]);
    expect(result).toMatchObject({
      success: false,
      executionState: 'rolled_back',
      retryable: true,
      operationId: grant.operationId,
      error: 'duplicate key value violates unique constraint',
    });
    expect(result.error).not.toContain('SQL_OUTCOME_REQUIRES_RECONCILIATION');
    expect(mocks.finishIntent).toHaveBeenCalledWith(grant.operationId, 'rolled_back', {
      targetAcknowledged: false,
      receipt: 'rolled_back',
    });
    expect(mocks.finishIntent).not.toHaveBeenCalledWith(grant.operationId, 'unknown', expect.anything());
  });

  it('does not replay a consumed grant after a confirmed rollback', async () => {
    pgDouble((sql) => sql.startsWith('UPDATE') ? new Error('duplicate key value violates unique constraint') : undefined);
    const first = await run();
    mocks.beginIntent.mockRejectedValue(new Error('SQL_OPERATION_ALREADY_RECORDED_RECONCILE_DO_NOT_RETRY'));
    const second = await run();

    expect(first).toMatchObject({ executionState: 'rolled_back', retryable: true });
    expect(second).toMatchObject({ executionState: 'unknown', retryable: false });
    expect(mocks.getConnection().pgClient.query.mock.calls.filter(([sql]: [string]) => sql.startsWith('UPDATE'))).toHaveLength(1);
  });

  it('records a failure before the user statement as not executed when ROLLBACK completes', async () => {
    const client = pgDouble((sql) => sql.startsWith('SET LOCAL') ? new Error('cannot set statement_timeout') : undefined);
    const result = await run();

    expect(client.calls).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 15000',
      'ROLLBACK',
    ]);
    expect(result).toMatchObject({
      success: false,
      executionState: 'not_executed',
      retryable: true,
      error: 'cannot set statement_timeout',
    });
    expect(mocks.finishIntent).toHaveBeenCalledWith(grant.operationId, 'not_executed', expect.objectContaining({
      receipt: 'not_executed',
    }));
  });

  it('records a failed BEGIN as not executed and does not issue ROLLBACK', async () => {
    const client = pgDouble((sql) => sql === 'BEGIN' ? new Error('connection refused') : undefined);
    const result = await run();

    expect(client.calls).toEqual(['BEGIN']);
    expect(result).toMatchObject({ executionState: 'not_executed', retryable: true, error: 'connection refused' });
  });

  it('keeps a missing ROLLBACK receipt unknown and does not retry', async () => {
    const client = pgDouble((sql) => {
      if (sql.startsWith('UPDATE')) return new Error('statement canceled');
      if (sql === 'ROLLBACK') return new Error('EPIPE');
      return undefined;
    });
    const result = await run();

    expect(client.calls).toContain('ROLLBACK');
    expect(result).toMatchObject({
      success: false,
      executionState: 'unknown',
      retryable: false,
      error: expect.stringContaining('SQL_OUTCOME_REQUIRES_RECONCILIATION'),
    });
    expect(mocks.finishIntent).toHaveBeenCalledWith(grant.operationId, 'unknown', expect.objectContaining({
      targetAcknowledged: false,
      error: 'SQL_EXECUTION_OR_AUDIT_FAILED',
    }));
  });

  it('does not treat ROLLBACK after an unacknowledged COMMIT as a confirmed rollback', async () => {
    const client = pgDouble((sql) => sql === 'COMMIT' ? new Error('rollback the current transaction') : undefined);
    const result = await run();

    expect(client.calls).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 15000',
      update,
      'COMMIT',
      'ROLLBACK',
    ]);
    expect(result).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(result.error).toContain('do not retry');
    expect(mocks.finishIntent).toHaveBeenCalledWith(grant.operationId, 'unknown', expect.objectContaining({
      targetAcknowledged: false,
    }));
  });

  it('keeps a confirmed commit succeeded when audit recording fails', async () => {
    pgDouble();
    mocks.auditSql.mockRejectedValue(new Error('audit store closed'));
    const result = await run();

    expect(result).toMatchObject({
      success: true,
      executionState: 'succeeded',
      retryable: false,
      auditStatus: 'failed',
      auditError: 'AUDIT_LOG_FAILED',
    });
    expect(mocks.finishIntent).toHaveBeenCalledWith(grant.operationId, 'succeeded', expect.objectContaining({
      targetAcknowledged: true,
      auditStatus: 'failed',
      auditError: 'AUDIT_LOG_FAILED',
    }));
  });

  it('falls back to unknown when the rollback receipt cannot be stored', async () => {
    pgDouble((sql) => sql.startsWith('UPDATE') ? new Error('duplicate key') : undefined);
    mocks.finishIntent.mockRejectedValue(new Error('control down'));
    const result = await run();

    expect(result).toMatchObject({ executionState: 'unknown', retryable: false });
    expect(mocks.finishIntent).toHaveBeenCalledWith(grant.operationId, 'rolled_back', expect.anything());
    expect(mocks.finishIntent).toHaveBeenCalledWith(grant.operationId, 'unknown', expect.objectContaining({
      error: 'SQL_RECEIPT_NOT_RECORDED',
    }));
  });

  it('still leaves a MySQL statement error unknown instead of guessing from the error text', async () => {
    const query = vi.fn(async (sql: string) => {
      if (String(sql).startsWith('DELETE')) {
        throw Object.assign(new Error('table missing and was rolled back'), { code: 'ER_NO_SUCH_TABLE', errno: 1146, sqlState: '42S02' });
      }
      return [[], []];
    });
    const release = vi.fn();
    mocks.getConnection.mockReturnValue({
      id: 374,
      name: 'mysql',
      db_type: 'mysql',
      pool: { getConnection: vi.fn(async () => ({ query, release, threadId: 7 })) },
    });

    const result = await run('DELETE FROM missing_max374');

    expect(result).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(release).toHaveBeenCalledOnce();
  });
});
