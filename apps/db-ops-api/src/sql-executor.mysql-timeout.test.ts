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

const grant = { approvalRequestId: 598, reviewerId: 9, operationId: 'max373-op' };

type Session = {
  threadId?: number;
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

function session(threadId = 42): Session {
  return {
    threadId,
    query: vi.fn(async () => [[], []]),
    release: vi.fn(),
    destroy: vi.fn(),
  };
}

describe('MySQL mutation statement timeout (MAX-373)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureConnectionAlive.mockResolvedValue(true);
    mocks.authorizeApproval.mockResolvedValue(true);
    mocks.recordSecurityEvent.mockResolvedValue(undefined);
    mocks.beginIntent.mockResolvedValue(undefined);
    mocks.finishIntent.mockResolvedValue(undefined);
    mocks.auditSql.mockResolvedValue(undefined);
  });

  it.each([
    ['UPDATE t SET note = ? WHERE id = 1', 'write'],
    ['DELETE FROM t WHERE id = 1', 'write'],
    ['INSERT INTO t (id, note) VALUES (2, ?)', 'write'],
    ['ALTER TABLE t ADD COLUMN extra INT NULL', 'ddl'],
  ])('arms server lock ceilings for %s and does not use max_execution_time', async (sql) => {
    const worker = session();
    const pool = { getConnection: vi.fn(async () => worker) };
    mocks.getConnection.mockReturnValue({ id: 373, name: 'mysql', db_type: 'mysql', pool });

    const result = await sqlExecutor.executeSql(373, sql, { approvalGrant: { ...grant, operationId: `ok-${sql.slice(0, 6)}` }, timeoutMs: 1500 });

    expect(result).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
    const statements = worker.query.mock.calls.map(([text]) => text);
    expect(statements).toContain('SET SESSION innodb_lock_wait_timeout = 2');
    expect(statements).toContain('SET SESSION lock_wait_timeout = 2');
    expect(statements).toContain(sql);
    expect(statements).toContain('SET SESSION innodb_lock_wait_timeout = DEFAULT');
    expect(statements).toContain('SET SESSION lock_wait_timeout = DEFAULT');
    expect(statements.some((text: string) => String(text).includes('max_execution_time'))).toBe(false);
    expect(worker.release).toHaveBeenCalledOnce();
    expect(worker.destroy).not.toHaveBeenCalled();
    expect(worker.query.mock.calls.filter(([text]) => text === sql)).toHaveLength(1);
  });

  it('cancels a waiting change, releases the instance queue, and does not replay it', async () => {
    const events: string[] = [];
    let rejectUpdate: (error: Error) => void = () => undefined;
    const blocked = new Promise<never>((_, reject) => { rejectUpdate = reject; });
    const worker = session(81);
    worker.query.mockImplementation(async (sql: string) => {
      events.push(`worker:${sql}`);
      if (sql.startsWith('UPDATE ')) return blocked;
      return [[], []];
    });
    const killer = session(82);
    killer.query.mockImplementation(async (sql: string) => {
      events.push(`killer:${sql}`);
      if (sql === 'KILL QUERY 81') {
        rejectUpdate(Object.assign(new Error('Query execution was interrupted'), { errno: 1317, code: 'ER_QUERY_INTERRUPTED' }));
      }
      return [[], []];
    });
    const reader = session(83);
    reader.query.mockImplementation(async (sql: string) => {
      events.push(`reader:${sql}`);
      if (sql === 'SELECT 1 AS ready') return [[{ ready: 1 }], [{ name: 'ready' }]];
      return [[], []];
    });
    const acquired: Session[] = [worker, killer, reader];
    const pool = {
      getConnection: vi.fn(async () => {
        const next = acquired.shift();
        if (!next) throw new Error('unexpected checkout');
        events.push(`checkout:${next.threadId}`);
        return next;
      }),
    };
    mocks.getConnection.mockReturnValue({ id: 3731, name: 'mysql', db_type: 'mysql', pool });

    const started = Date.now();
    const update = sqlExecutor.executeSql(3731, 'UPDATE t SET note = "waiting" WHERE id = 1', {
      approvalGrant: grant, timeoutMs: 100, userId: '9', username: 'max373',
    });
    await vi.waitUntil(() => events.includes('worker:UPDATE t SET note = "waiting" WHERE id = 1'));
    const follow = sqlExecutor.executeSql(3731, 'SELECT 1 AS ready', { timeoutMs: 1000, userId: '9', username: 'max373' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(events.some((event) => event.startsWith('reader:'))).toBe(false);

    const [updateResult, followResult] = await Promise.all([update, follow]);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000);
    expect(updateResult).toMatchObject({
      success: false,
      executionState: 'unknown',
      retryable: false,
      operationId: grant.operationId,
    });
    expect(updateResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
    expect(updateResult.error).toContain('outcome may be unknown');
    expect(updateResult.error).toContain('do not retry');
    expect(updateResult.error?.toLowerCase()).not.toContain('rolled back');
    expect(followResult).toMatchObject({ success: true, rows: [{ ready: 1 }] });
    expect(events.filter((event) => event.startsWith('worker:UPDATE '))).toEqual([
      'worker:UPDATE t SET note = "waiting" WHERE id = 1',
    ]);
    expect(events).toContain('killer:KILL QUERY 81');
    expect(events.indexOf('reader:SELECT 1 AS ready')).toBeGreaterThan(events.indexOf('killer:KILL QUERY 81'));
    expect(worker.destroy).toHaveBeenCalled();
    expect(worker.release).not.toHaveBeenCalled();
    expect(killer.release).toHaveBeenCalled();
    expect(mocks.finishIntent).toHaveBeenCalledWith(grant.operationId, 'unknown', expect.objectContaining({ targetAcknowledged: false }));
    expect(mocks.finishIntent).not.toHaveBeenCalledWith(grant.operationId, 'succeeded', expect.anything());
    expect(mocks.auditSql).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      dbType: 'mysql',
      errorMessage: expect.stringContaining('outcome may be unknown'),
    }));
    expect(mocks.auditSql).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'success', sqlText: expect.stringContaining('UPDATE') }));
    expect(mocks.beginIntent).toHaveBeenCalledOnce();
  });

  it('destroys the session when no killer connection is available and still unblocks the queue', async () => {
    let rejectUpdate: (error: Error) => void = () => undefined;
    const blocked = new Promise<never>((_, reject) => { rejectUpdate = reject; });
    const worker = session(84);
    worker.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DELETE ')) return blocked;
      return [[], []];
    });
    worker.destroy.mockImplementation(() => {
      rejectUpdate(Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' }));
    });
    const reader = session(85);
    reader.query.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT 1 AS ready') return [[{ ready: 1 }], [{ name: 'ready' }]];
      return [[], []];
    });
    let checkouts = 0;
    const pool = {
      getConnection: vi.fn(async () => {
        checkouts += 1;
        if (checkouts === 1) return worker;
        if (checkouts === 2) throw new Error('pool exhausted');
        return reader;
      }),
    };
    mocks.getConnection.mockReturnValue({ id: 3732, name: 'mysql', db_type: 'mysql', pool });

    const update = sqlExecutor.executeSql(3732, 'DELETE FROM t WHERE id = 1', {
      approvalGrant: { ...grant, operationId: 'max373-destroy' }, timeoutMs: 100,
    });
    await vi.waitUntil(() => worker.query.mock.calls.some(([sql]) => sql === 'DELETE FROM t WHERE id = 1'));
    const follow = sqlExecutor.executeSql(3732, 'SELECT 1 AS ready');
    const [updateResult, followResult] = await Promise.all([update, follow]);

    expect(updateResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false, operationId: 'max373-destroy' });
    expect(updateResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
    expect(worker.destroy).toHaveBeenCalled();
    expect(worker.release).not.toHaveBeenCalled();
    expect(followResult.success).toBe(true);
    expect(worker.query.mock.calls.filter(([sql]) => sql === 'DELETE FROM t WHERE id = 1')).toHaveLength(1);
  });

  it('reports a server lock-wait timeout without retrying or returning the session to the pool', async () => {
    const worker = session(86);
    worker.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('ALTER ')) {
        throw Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' });
      }
      return [[], []];
    });
    const pool = { getConnection: vi.fn(async () => worker) };
    mocks.getConnection.mockReturnValue({ id: 3733, name: 'mysql', db_type: 'mysql', pool });

    const result = await sqlExecutor.executeSql(3733, 'ALTER TABLE t ADD COLUMN extra INT NULL', {
      approvalGrant: { ...grant, operationId: 'max373-mdl' }, timeoutMs: 1000,
    });

    expect(result).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(result.error).toContain('do not retry or claim a confirmed rollback');
    expect(worker.destroy).toHaveBeenCalled();
    expect(worker.release).not.toHaveBeenCalled();
    expect(worker.query.mock.calls.filter(([sql]) => String(sql).startsWith('ALTER '))).toHaveLength(1);
    expect(mocks.finishIntent).toHaveBeenCalledWith('max373-mdl', 'unknown', expect.anything());
  });

  it('keeps an ordinary mutation failure on the reconciliation path and restores the session', async () => {
    const worker = session();
    worker.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('INSERT ')) throw Object.assign(new Error('bad syntax'), { errno: 1064, code: 'ER_PARSE_ERROR' });
      return [[], []];
    });
    const pool = { getConnection: vi.fn(async () => worker) };
    mocks.getConnection.mockReturnValue({ id: 3734, name: 'mysql', db_type: 'mysql', pool });

    const result = await sqlExecutor.executeSql(3734, 'INSERT INTO t (id) VALUES (1)', {
      approvalGrant: { ...grant, operationId: 'max373-parse' },
    });

    expect(result).toMatchObject({
      success: false,
      executionState: 'unknown',
      retryable: false,
      error: expect.stringContaining('SQL_OUTCOME_REQUIRES_RECONCILIATION'),
    });
    expect(result.error).not.toContain('MYSQL_STATEMENT_TIMEOUT');
    expect(worker.release).toHaveBeenCalledOnce();
    expect(worker.destroy).not.toHaveBeenCalled();
    expect(worker.query.mock.calls.map(([sql]) => sql)).toEqual([
      'SET SESSION innodb_lock_wait_timeout = 15',
      'SET SESSION lock_wait_timeout = 15',
      'INSERT INTO t (id) VALUES (1)',
      'SET SESSION innodb_lock_wait_timeout = DEFAULT',
      'SET SESSION lock_wait_timeout = DEFAULT',
    ]);
  });
});
