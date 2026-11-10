import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureConnectionAlive: vi.fn(),
  getConnection: vi.fn(),
  auditSql: vi.fn(),
  recordSecurityEvent: vi.fn(),
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
  securityEventService: { record: mocks.recordSecurityEvent },
}));

vi.mock('./audit/sql-execution-intent.js', () => ({
  sqlExecutionIntent: { begin: mocks.beginIntent, finish: mocks.finishIntent },
}));

import { sqlExecutor } from './sql-executor.js';

const grant = { approvalRequestId: 284, reviewerId: 2, operationId: 'oracle-op-1' };

function oracleSession() {
  const events: string[] = [];
  const session = {
    callTimeout: 0,
    execute: vi.fn(async (sql: string) => {
      events.push(`execute:${sql}`);
      if (sql.startsWith('SELECT')) return { rows: [[1]], metaData: [{ name: 'ID' }] };
      return { rowsAffected: 1, rows: [] };
    }),
    commit: vi.fn(async () => { events.push('commit'); }),
    rollback: vi.fn(async () => { events.push('rollback'); }),
    close: vi.fn(async () => { events.push('close'); }),
  };
  return { session, events };
}

describe('Oracle DML commit boundary (MAX-361)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureConnectionAlive.mockResolvedValue(true);
    mocks.authorizeApproval.mockResolvedValue(true);
    mocks.recordSecurityEvent.mockResolvedValue(undefined);
    mocks.beginIntent.mockResolvedValue(undefined);
    mocks.finishIntent.mockResolvedValue(undefined);
    mocks.auditSql.mockResolvedValue(undefined);
  });

  it('records succeeded only after an approved UPDATE commits, then releases the pooled connection', async () => {
    const { session, events } = oracleSession();
    let releaseCommit: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    session.commit.mockImplementation(async () => { events.push('commit'); await gate; });
    mocks.getConnection.mockReturnValue({
      id: 361, name: 'oracle', db_type: 'oracle', oracleConnection: {}, oraclePool: { getConnection: async () => session },
    });

    const pending = sqlExecutor.executeSql(361, "UPDATE SLIDE_MAX361_DML SET NOTE = 'after' WHERE ID = 1", { approvalGrant: grant });
    await vi.waitUntil(() => events.includes('commit'));
    expect(mocks.finishIntent).not.toHaveBeenCalled();
    expect(mocks.auditSql).not.toHaveBeenCalled();
    releaseCommit();
    const result = await pending;

    expect(events).toEqual([
      "execute:UPDATE SLIDE_MAX361_DML SET NOTE = 'after' WHERE ID = 1",
      'commit',
      'close',
    ]);
    expect(session.execute).toHaveBeenCalledWith(
      "UPDATE SLIDE_MAX361_DML SET NOTE = 'after' WHERE ID = 1",
      [],
      { maxRows: 0, autoCommit: false },
    );
    expect(result).toMatchObject({ success: true, executionState: 'succeeded', operationId: grant.operationId, retryable: false });
    expect(mocks.auditSql).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', dbType: 'oracle' }));
    expect(mocks.finishIntent).toHaveBeenCalledWith(grant.operationId, 'succeeded', expect.objectContaining({ targetAcknowledged: true }));
    expect(session.callTimeout).toBe(0);
  });

  it('keeps a commit failure unknown, releases the connection, and does not execute again', async () => {
    const { session, events } = oracleSession();
    session.commit.mockImplementation(async () => {
      events.push('commit');
      throw Object.assign(new Error('ORA-03113: end-of-file on communication channel'), { errorNum: 3113 });
    });
    mocks.getConnection.mockReturnValue({
      id: 361, name: 'oracle', db_type: 'oracle', oracleConnection: {}, oraclePool: { getConnection: async () => session },
    });

    const result = await sqlExecutor.executeSql(361, 'DELETE FROM SLIDE_MAX361_DML WHERE ID = 1', { approvalGrant: grant });

    expect(session.execute).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['execute:DELETE FROM SLIDE_MAX361_DML WHERE ID = 1', 'commit', 'rollback', 'close']);
    expect(result).toMatchObject({
      success: false,
      executionState: 'unknown',
      retryable: false,
      operationId: grant.operationId,
      error: expect.stringContaining('SQL_OUTCOME_REQUIRES_RECONCILIATION'),
    });
    expect(mocks.auditSql).not.toHaveBeenCalled();
    expect(mocks.finishIntent).toHaveBeenCalledWith(
      grant.operationId, 'unknown', expect.objectContaining({ targetAcknowledged: false, error: 'SQL_EXECUTION_OR_AUDIT_FAILED' }),
    );
  });

  it('treats a broken Oracle connection during execute as unknown and still closes the session', async () => {
    const { session, events } = oracleSession();
    session.execute.mockImplementation(async (sql: string) => {
      events.push(`execute:${sql}`);
      throw Object.assign(new Error('NJS-500: connection to the Oracle Database was broken'), { code: 'NJS-500' });
    });
    mocks.getConnection.mockReturnValue({
      id: 361, name: 'oracle', db_type: 'oracle', oracleConnection: {}, oraclePool: { getConnection: async () => session },
    });

    const result = await sqlExecutor.executeSql(361, 'INSERT INTO SLIDE_MAX361_DML (ID, NOTE) VALUES (2, \'x\')', { approvalGrant: grant });

    expect(session.commit).not.toHaveBeenCalled();
    expect(events).toEqual([
      "execute:INSERT INTO SLIDE_MAX361_DML (ID, NOTE) VALUES (2, 'x')",
      'rollback',
      'close',
    ]);
    expect(result).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(mocks.finishIntent).toHaveBeenCalledWith(grant.operationId, 'unknown', expect.any(Object));
  });

  it('does not retry when the same operation is already recorded after an unknown commit', async () => {
    const { session } = oracleSession();
    session.commit.mockRejectedValue(new Error('ORA-03113: end-of-file on communication channel'));
    const pool = { getConnection: vi.fn(async () => session) };
    mocks.getConnection.mockReturnValue({
      id: 361, name: 'oracle', db_type: 'oracle', oracleConnection: {}, oraclePool: pool,
    });

    const first = await sqlExecutor.executeSql(361, 'UPDATE SLIDE_MAX361_DML SET NOTE = \'lost\' WHERE ID = 1', { approvalGrant: grant });
    mocks.beginIntent.mockRejectedValue(new Error('SQL_OPERATION_ALREADY_RECORDED_RECONCILE_DO_NOT_RETRY'));
    const second = await sqlExecutor.executeSql(361, 'UPDATE SLIDE_MAX361_DML SET NOTE = \'lost\' WHERE ID = 1', { approvalGrant: grant });

    expect(first).toMatchObject({ executionState: 'unknown', retryable: false });
    expect(second).toMatchObject({ executionState: 'unknown', retryable: false });
    expect(pool.getConnection).toHaveBeenCalledOnce();
    expect(session.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps a read-only Oracle transaction rolled back and releases it on both success and statement failure', async () => {
    const success = oracleSession();
    mocks.getConnection.mockReturnValue({
      id: 361, name: 'oracle', db_type: 'oracle', oracleConnection: {}, oraclePool: { getConnection: async () => success.session },
    });
    const selected = await sqlExecutor.executeSql(361, 'SELECT ID FROM SLIDE_MAX361_DML WHERE ID = 1');
    expect(success.events).toEqual([
      'execute:SET TRANSACTION READ ONLY',
      'execute:SELECT ID FROM SLIDE_MAX361_DML WHERE ID = 1',
      'rollback',
      'close',
    ]);
    expect(success.session.commit).not.toHaveBeenCalled();
    expect(selected).toMatchObject({ success: true, rowCount: 1 });
    expect(selected.executionState).toBeUndefined();
    expect(mocks.beginIntent).not.toHaveBeenCalled();

    const failed = oracleSession();
    failed.session.execute.mockImplementation(async (sql: string) => {
      failed.events.push(`execute:${sql}`);
      if (sql.startsWith('SELECT')) throw new Error('ORA-00942: table or view does not exist');
      return { rowsAffected: 0, rows: [] };
    });
    mocks.getConnection.mockReturnValue({
      id: 361, name: 'oracle', db_type: 'oracle', oracleConnection: {}, oraclePool: { getConnection: async () => failed.session },
    });
    const errored = await sqlExecutor.executeSql(361, 'SELECT ID FROM MISSING_MAX361');
    expect(failed.events).toEqual([
      'execute:SET TRANSACTION READ ONLY',
      'execute:SELECT ID FROM MISSING_MAX361',
      'rollback',
      'close',
    ]);
    expect(errored).toMatchObject({ success: false, error: expect.stringContaining('ORA-00942') });
    expect(errored.executionState).toBeUndefined();
  });

  it('leaves Oracle DDL on its implicit commit and still records succeeded without commit()', async () => {
    const { session, events } = oracleSession();
    mocks.getConnection.mockReturnValue({
      id: 361, name: 'oracle', db_type: 'oracle', oracleConnection: session, oraclePool: null,
    });

    const result = await sqlExecutor.executeSql(361, 'CREATE TABLE SLIDE_MAX361_DDL (ID INT)', { approvalGrant: grant });

    expect(events).toEqual(['execute:CREATE TABLE SLIDE_MAX361_DDL (ID INT)']);
    expect(session.commit).not.toHaveBeenCalled();
    expect(session.rollback).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
  });

  it('commits a write on the persistent session when the pool is absent and does not close that session', async () => {
    const { session, events } = oracleSession();
    mocks.getConnection.mockReturnValue({
      id: 361, name: 'oracle', db_type: 'oracle', oracleConnection: session, oraclePool: null,
    });

    const result = await sqlExecutor.executeSql(361, 'UPDATE SLIDE_MAX361_DML SET NOTE = \'direct\' WHERE ID = 1', { approvalGrant: grant });

    expect(events).toEqual(["execute:UPDATE SLIDE_MAX361_DML SET NOTE = 'direct' WHERE ID = 1", 'commit']);
    expect(session.close).not.toHaveBeenCalled();
    expect(result.executionState).toBe('succeeded');
  });
});
