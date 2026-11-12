import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureConnectionAlive: vi.fn(),
  getConnection: vi.fn(),
  reconnect: vi.fn(),
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
    reconnect: mocks.reconnect,
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
    close: vi.fn(async () => { events.push('close'); }),
  };
  return { session, events };
}

describe('Dameng same-instance ownership (MAX-367)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureConnectionAlive.mockResolvedValue(true);
    mocks.reconnect.mockResolvedValue(true);
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
    expect(mocks.ensureConnectionAlive).not.toHaveBeenCalled();
    expect(mocks.beginIntent).not.toHaveBeenCalled();
  });

  it('runs the production health probe only after the previous owner releases the session', async () => {
    const { session, events } = damengSession();
    let releaseQuery: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    session.execute.mockImplementation(async (sql: string) => {
      events.push(sql);
      if (sql === 'SELECT 42 FROM DUAL') await gate;
      return { rows: [[1]], metaData: [{ name: 'ID' }] };
    });
    mocks.getConnection.mockReturnValue({
      id: 3674, name: 'dameng', db_type: 'dameng', dmConnection: session, connected: true,
    });
    mocks.ensureConnectionAlive.mockImplementation(async () => {
      await session.execute('SELECT 1 FROM DUAL');
      return true;
    });

    const first = sqlExecutor.executeSql(3674, 'SELECT 42 FROM DUAL');
    await vi.waitUntil(() => events.includes('SELECT 42 FROM DUAL'));
    const second = sqlExecutor.executeSql(3674, 'SELECT 43 FROM DUAL');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.filter((sql) => sql === 'SELECT 1 FROM DUAL')).toEqual(['SELECT 1 FROM DUAL']);
    expect(events).not.toContain('rollback');
    releaseQuery();
    await Promise.all([first, second]);

    const firstRollback = events.indexOf('rollback');
    const probes = events.map((sql, index) => sql === 'SELECT 1 FROM DUAL' ? index : -1).filter((index) => index >= 0);
    expect(probes).toHaveLength(2);
    expect(probes[1]).toBeGreaterThan(firstRollback);
    expect(events.indexOf('SELECT 43 FROM DUAL')).toBeGreaterThan(probes[1]);
  });

  it('rejects a Dameng mutation before execute when intent storage fails', async () => {
    const { session } = damengSession();
    mocks.getConnection.mockReturnValue({
      id: 3677, name: 'dameng', db_type: 'dameng', dmConnection: session, connected: true,
    });
    mocks.beginIntent.mockRejectedValue(new Error('CONTROL_UNAVAILABLE'));

    const result = await sqlExecutor.executeSql(3677, 'DELETE FROM T', { approvalGrant: grant });

    expect(result).toMatchObject({ success: false, executionState: 'not_started', retryable: false });
    expect(result.error).toContain('SQL_INTENT_REJECTED');
    expect(result.error).toContain('CONTROL_UNAVAILABLE');
    expect(session.execute).not.toHaveBeenCalled();
    expect(mocks.finishIntent).not.toHaveBeenCalled();
  });

  it('replaces the session when schema restore fails and keeps the next request on the new session', async () => {
    const stale = damengSession();
    const fresh = damengSession();
    let schema = 'SYSDBA';
    stale.session.execute.mockImplementation(async (sql: string): Promise<any> => {
      stale.events.push(sql);
      if (sql.includes('SYS_CONTEXT')) return { rows: [['SYSDBA']], metaData: [{ name: 'CURRENT_SCHEMA' }] };
      if (sql === 'SET SCHEMA "APP"') { schema = 'APP'; return { rows: [] }; }
      if (sql === 'SET SCHEMA "SYSDBA"') throw new Error('injected restore failure');
      return { rows: [[schema]], metaData: [{ name: 'SCHEMA' }] };
    });
    fresh.session.execute.mockImplementation(async (sql: string) => {
      fresh.events.push(sql);
      return { rows: [['SYSDBA']], metaData: [{ name: 'SCHEMA' }] };
    });
    let current = stale.session;
    mocks.getConnection.mockImplementation(() => ({
      id: 3676, name: 'dameng', db_type: 'dameng', dmConnection: current, connected: true,
    }));
    mocks.reconnect.mockImplementation(async () => { current = fresh.session; return true; });

    const failed = await sqlExecutor.executeSql(3676, 'SELECT ID FROM T', {
      database: 'APP', userId: '7', username: 'max367',
    });
    const next = await sqlExecutor.executeSql(3676, 'SELECT ID FROM T', { userId: '7', username: 'max367' });

    expect(failed.success).toBe(false);
    expect(failed.error).toContain('injected restore failure');
    expect(next).toMatchObject({ success: true, rows: [{ SCHEMA: 'SYSDBA' }] });
    expect(stale.events.filter((sql) => sql === 'SELECT ID FROM T')).toHaveLength(1);
    expect(fresh.events.some((sql) => sql === 'SELECT ID FROM T')).toBe(true);
    expect(stale.session.close).toHaveBeenCalledOnce();
    expect(mocks.auditSql).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      userId: '7',
      errorMessage: expect.stringContaining('DAMENG_SESSION_QUARANTINED schema=injected restore failure reconnect=ok'),
    }));
  });

  it('records both the statement error and the schema restore error, then serves the next request from a new session', async () => {
    const stale = damengSession();
    const fresh = damengSession();
    stale.session.execute.mockImplementation(async (sql: string): Promise<any> => {
      stale.events.push(sql);
      if (sql.includes('SYS_CONTEXT')) return { rows: [['SYSDBA']], metaData: [{ name: 'CURRENT_SCHEMA' }] };
      if (sql === 'SET SCHEMA "APP"') return { rows: [] };
      if (sql === 'SET SCHEMA "SYSDBA"') throw new Error('injected restore failure');
      if (sql.includes('BOOM')) throw new Error('injected statement failure');
      return { rows: [[1]], metaData: [{ name: 'ID' }] };
    });
    fresh.session.execute.mockImplementation(async (sql: string) => {
      fresh.events.push(sql);
      return { rows: [[1]], metaData: [{ name: 'ID' }] };
    });
    let current = stale.session;
    mocks.getConnection.mockImplementation(() => ({
      id: 3678, name: 'dameng', db_type: 'dameng', dmConnection: current, connected: true,
    }));
    mocks.reconnect.mockImplementation(async () => { current = fresh.session; return true; });

    const failed = await sqlExecutor.executeSql(3678, 'SELECT BOOM FROM T', {
      database: 'APP', userId: '7', username: 'max367',
    });
    const next = await sqlExecutor.executeSql(3678, 'SELECT ID FROM T', { userId: '7', username: 'max367' });

    expect(failed.success).toBe(false);
    expect(failed.error).toContain('injected statement failure');
    expect(next.success).toBe(true);
    expect(fresh.events.some((sql) => sql === 'SELECT ID FROM T')).toBe(true);
    expect(stale.events.some((sql) => sql === 'SELECT ID FROM T')).toBe(false);
    expect(mocks.auditSql).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      errorMessage: expect.stringContaining('schema=injected restore failure'),
    }));
    expect(mocks.auditSql).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: expect.stringContaining('cause=injected statement failure'),
    }));
  });

  it('does not let a queued request use a session whose rollback failed', async () => {
    const stale = damengSession();
    const fresh = damengSession();
    let releaseQuery: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    stale.session.execute.mockImplementation(async (sql: string) => {
      stale.events.push(sql);
      if (sql.includes('FIRST')) {
        await gate;
        throw new Error('injected statement failure');
      }
      return { rows: [], metaData: [] };
    });
    stale.session.rollback.mockRejectedValue(new Error('injected rollback failure'));
    fresh.session.execute.mockImplementation(async (sql: string) => {
      fresh.events.push(sql);
      return { rows: [], metaData: [] };
    });
    let current = stale.session;
    mocks.getConnection.mockImplementation(() => ({
      id: 3675, name: 'dameng', db_type: 'dameng', dmConnection: current, connected: true,
    }));
    mocks.ensureConnectionAlive.mockImplementation(async () => {
      await current.execute('SELECT 1 FROM DUAL');
      return true;
    });
    mocks.reconnect.mockImplementation(async () => { current = fresh.session; return true; });

    const first = sqlExecutor.executeSql(3675, "UPDATE T SET NOTE = 'FIRST'", { approvalGrant: grant });
    await vi.waitUntil(() => stale.events.some((sql) => sql.includes('FIRST')));
    const second = sqlExecutor.executeSql(3675, "UPDATE T SET NOTE = 'SECOND'", {
      approvalGrant: { ...grant, operationId: 'second' }, userId: '9', username: 'max367',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fresh.events).toEqual([]);
    expect(stale.events.filter((sql) => sql === 'SELECT 1 FROM DUAL')).toHaveLength(1);
    releaseQuery();
    const [failed, recovered] = await Promise.all([first, second]);

    expect(failed).toMatchObject({ success: false, executionState: 'unknown', retryable: false, operationId: grant.operationId });
    expect(recovered).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
    expect(stale.events.some((sql) => sql.includes('SECOND'))).toBe(false);
    expect(fresh.events.some((sql) => sql.includes('SECOND'))).toBe(true);
    expect(stale.session.commit).not.toHaveBeenCalled();
    expect(fresh.session.commit).toHaveBeenCalledOnce();
    expect(mocks.finishIntent).toHaveBeenCalledWith(grant.operationId, 'unknown', expect.objectContaining({ targetAcknowledged: false }));
    const diagnosis = mocks.auditSql.mock.calls.map((call) => String(call[0]?.errorMessage ?? '')).join('\n');
    expect(diagnosis).toContain('DAMENG_SESSION_QUARANTINED');
    expect(diagnosis).toContain('rollback=injected rollback failure');
    expect(diagnosis).toContain('cause=injected statement failure');
    expect(diagnosis).toContain('reconnect=ok');
    expect(mocks.auditSql).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', userId: '2' }));
  });

  it('does not execute on a retired session when rebuild fails', async () => {
    const { session, events } = damengSession();
    session.execute.mockImplementation(async (sql: string) => {
      events.push(sql);
      if (sql.includes('FIRST')) throw new Error('injected statement failure');
      return { rows: [], metaData: [] };
    });
    session.rollback.mockRejectedValue(new Error('injected rollback failure'));
    mocks.getConnection.mockReturnValue({
      id: 3679, name: 'dameng', db_type: 'dameng', dmConnection: session, connected: true,
    });
    mocks.reconnect.mockResolvedValue(false);

    const failed = await sqlExecutor.executeSql(3679, "UPDATE T SET NOTE = 'FIRST'", { approvalGrant: grant });
    const next = await sqlExecutor.executeSql(3679, "UPDATE T SET NOTE = 'SECOND'", {
      approvalGrant: { ...grant, operationId: 'second' },
    });

    expect(failed).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(next).toMatchObject({ success: false, executionState: 'not_started', retryable: false, error: '实例未连接或重连失败' });
    expect(events.filter((sql) => sql.includes('SECOND'))).toEqual([]);
    expect(session.commit).not.toHaveBeenCalled();
    expect(mocks.auditSql).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: expect.stringContaining('reconnect=failed'),
    }));
  });
});
