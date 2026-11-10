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
vi.mock('./db-connection', () => ({ dbConnection: { getPool: vi.fn(() => ({})) } }));
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

const grant = { approvalRequestId: 385, reviewerId: 2, operationId: 'max367-op' };

function damengSession() {
  const events: string[] = [];
  const session = {
    conn_prop_sessionTimeout: 15,
    conn_prop_socketTimeout: 30_000,
    execute: vi.fn(async (sql: string) => {
      events.push(`execute:${sql}`);
      if (sql.includes('SYS_CONTEXT')) return { rows: [['SYSDBA']], metaData: [{ name: 'CURRENT_SCHEMA' }] };
      if (sql.startsWith('SELECT')) return { rows: [[1]], metaData: [{ name: 'ID' }] };
      return { rowsAffected: 1, rows: [] };
    }),
    commit: vi.fn(async () => { events.push('commit'); }),
    rollback: vi.fn(async () => { events.push('rollback'); }),
  };
  return { session, events };
}

describe('Dameng same-instance ownership (MAX-367)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureConnectionAlive.mockResolvedValue(true);
    mocks.authorizeApproval.mockResolvedValue(true);
    mocks.recordSecurityEvent.mockResolvedValue(undefined);
    mocks.beginIntent.mockResolvedValue(undefined);
    mocks.finishIntent.mockResolvedValue(undefined);
    mocks.auditSql.mockResolvedValue(undefined);
  });

  it('keeps the shared session until the read-only transaction rolls back, and applies the one-second driver timeout', async () => {
    const { session, events } = damengSession();
    let releaseQuery: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    session.execute.mockImplementation(async (sql: string) => {
      events.push(`execute:${sql}`);
      if (sql === 'SELECT 1 FROM DUAL') {
        expect(session.conn_prop_sessionTimeout).toBe(1);
        await gate;
      }
      return { rows: [[1]], metaData: [{ name: 'ID' }] };
    });
    mocks.getConnection.mockReturnValue({
      id: 367, name: 'dameng', db_type: 'dameng', dmConnection: session,
    });

    const first = sqlExecutor.executeSql(367, 'SELECT 1 FROM DUAL', { timeoutMs: 100, userId: '7', username: 'max367' });
    const second = sqlExecutor.executeSql(367, 'SELECT 2 FROM DUAL', { timeoutMs: 2500, userId: '7', username: 'max367' });
    await vi.waitUntil(() => events.includes('execute:SELECT 1 FROM DUAL'));
    expect(events).toEqual([
      'execute:SET TRANSACTION READ ONLY',
      'execute:SELECT 1 FROM DUAL',
    ]);
    expect(session.conn_prop_socketTimeout).toBe(30_000);
    releaseQuery();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toMatchObject({ success: true, rowCount: 1 });
    expect(secondResult).toMatchObject({ success: true, rowCount: 1 });
    expect(events).toEqual([
      'execute:SET TRANSACTION READ ONLY',
      'execute:SELECT 1 FROM DUAL',
      'rollback',
      'execute:SET TRANSACTION READ ONLY',
      'execute:SELECT 2 FROM DUAL',
      'rollback',
    ]);
    expect(session.conn_prop_sessionTimeout).toBe(15);
    expect(session.commit).not.toHaveBeenCalled();
    expect(mocks.auditSql).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', dbType: 'dameng' }));
  });

  it('commits an approved write only after execute, and does not replay a timeout', async () => {
    const { session, events } = damengSession();
    mocks.getConnection.mockReturnValue({
      id: 3671, name: 'dameng', db_type: 'dameng', dmConnection: session,
    });

    const ok = await sqlExecutor.executeSql(3671, "UPDATE SLIDE_MAX367_DML SET NOTE = 'after' WHERE ID = 1", {
      approvalGrant: grant, timeoutMs: 1500,
    });
    expect(ok).toMatchObject({ success: true, executionState: 'succeeded', operationId: grant.operationId, retryable: false });
    expect(session.execute).toHaveBeenCalledWith(
      "UPDATE SLIDE_MAX367_DML SET NOTE = 'after' WHERE ID = 1",
      [],
      { maxRows: 0, autoCommit: false },
    );
    expect(session.conn_prop_sessionTimeout).toBe(15);
    expect(mocks.finishIntent).toHaveBeenCalledWith(grant.operationId, 'succeeded', expect.objectContaining({ targetAcknowledged: true }));

    events.length = 0;
    session.execute.mockImplementation(async (sql: string) => {
      events.push(`execute:${sql}`);
      throw Object.assign(new Error('[-608] 请求执行超时'), { errCode: -608 });
    });
    const timedOut = await sqlExecutor.executeSql(3671, "UPDATE SLIDE_MAX367_DML SET NOTE = 'slow' WHERE ID = 1", {
      approvalGrant: { ...grant, operationId: 'max367-timeout' }, timeoutMs: 1000,
    });

    expect(session.execute).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["execute:UPDATE SLIDE_MAX367_DML SET NOTE = 'slow' WHERE ID = 1", 'rollback']);
    expect(timedOut).toMatchObject({
      success: false,
      executionState: 'unknown',
      retryable: false,
      operationId: 'max367-timeout',
    });
    expect(timedOut.executionState).not.toBe('not_started');
    expect(mocks.finishIntent).toHaveBeenCalledWith('max367-timeout', 'unknown', expect.objectContaining({ targetAcknowledged: false }));
    expect(mocks.auditSql).toHaveBeenCalledTimes(1);
    expect(session.conn_prop_sessionTimeout).toBe(15);
  });

  it('switches schema with a quoted identifier and restores it before releasing the session', async () => {
    const { session, events } = damengSession();
    let releaseQuery: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    session.execute.mockImplementation(async (sql: string) => {
      events.push(sql);
      if (sql.includes('SYS_CONTEXT')) return { rows: [['SYSDBA']], metaData: [{ name: 'CURRENT_SCHEMA' }] };
      if (sql.startsWith('SELECT')) await gate;
      return { rows: [[7]], metaData: [{ name: 'ID' }] };
    });
    mocks.getConnection.mockReturnValue({
      id: 3672, name: 'dameng', db_type: 'dameng', dmConnection: session,
    });

    const pending = sqlExecutor.executeSql(3672, 'SELECT ID FROM SLIDE_MAX367_VIS', {
      database: 'APP"1', timeoutMs: 1000, userId: '7', username: 'max367',
    });
    await vi.waitUntil(() => events.includes('SELECT ID FROM SLIDE_MAX367_VIS'));
    expect(events).toEqual([
      "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL",
      'SET SCHEMA "APP""1"',
      'SET TRANSACTION READ ONLY',
      'SELECT ID FROM SLIDE_MAX367_VIS',
    ]);
    releaseQuery();
    await pending;
    expect(events.at(-2)).toBe('rollback');
    expect(events.at(-1)).toBe('SET SCHEMA "SYSDBA"');
  });

  it('does not execute Dameng SQL when approval is missing', async () => {
    const { session } = damengSession();
    mocks.authorizeApproval.mockResolvedValue(false);
    mocks.getConnection.mockReturnValue({
      id: 3673, name: 'dameng', db_type: 'dameng', dmConnection: session,
    });

    const denied = await sqlExecutor.executeSql(3673, 'DELETE FROM SLIDE_MAX367_DML WHERE ID = 1');
    expect(denied.success).toBe(false);
    expect(denied.error).toContain('SQL_APPROVAL_REQUIRED');
    expect(session.execute).not.toHaveBeenCalled();
    expect(mocks.beginIntent).not.toHaveBeenCalled();
  });
});
