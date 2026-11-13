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
      if (String(sql).includes('information_schema.processlist') && String(sql).includes('COMMAND')) {
        return [[{ command: 'Query', info: 'UPDATE t SET note = "waiting" WHERE id = 1' }], []];
      }
      if (sql === 'KILL QUERY 81') {
        rejectUpdate(Object.assign(new Error('Query execution was interrupted'), { errno: 1317, code: 'ER_QUERY_INTERRUPTED' }));
      }
      return [[], []];
    });
    const reader = session(83);
    reader.query.mockImplementation(async (sql: string) => {
      events.push(`reader:${sql}`);
      if (String(sql).includes('COUNT(*) AS threads')) return [[{ threads: 0 }], []];
      if (String(sql).includes('innodb_trx')) return [[{ transactions: 0 }], []];
      if (sql === 'SELECT 1 AS ready') return [[{ ready: 1 }], [{ name: 'ready' }]];
      return [[], []];
    });
    const acquired: Session[] = [worker, killer];
    const pool = {
      getConnection: vi.fn(async () => {
        const next = acquired.shift() ?? reader;
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

  it('destroys a session when no killer is available and proves the server thread is gone before releasing the queue', async () => {
    let querySettled = false;
    const blocked = new Promise<[unknown, unknown]>(() => undefined);
    void blocked.then(() => { querySettled = true; }, () => { querySettled = true; });
    const worker = session(84);
    worker.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DELETE ')) return blocked;
      return [[], []];
    });
    const observer = session(85);
    const proof: string[] = [];
    observer.query.mockImplementation(async (sql: string) => {
      proof.push(String(sql));
      if (String(sql).includes('COUNT(*) AS threads')) return [[{ threads: 0 }], []];
      if (String(sql).includes('innodb_trx')) return [[{ transactions: 0 }], []];
      if (sql === 'SELECT 1 AS ready') return [[{ ready: 1 }], [{ name: 'ready' }]];
      return [[], []];
    });
    let checkouts = 0;
    const pool = {
      getConnection: vi.fn(async () => {
        checkouts += 1;
        if (checkouts === 1) return worker;
        if (checkouts === 2) throw new Error('pool exhausted');
        return observer;
      }),
    };
    mocks.getConnection.mockReturnValue({ id: 3732, name: 'mysql', db_type: 'mysql', pool });

    const started = Date.now();
    const update = sqlExecutor.executeSql(3732, 'DELETE FROM t WHERE id = 1', {
      approvalGrant: { ...grant, operationId: 'max373-destroy' }, timeoutMs: 80, userId: '9', username: 'max373',
    });
    await vi.waitUntil(() => worker.query.mock.calls.some(([sql]) => sql === 'DELETE FROM t WHERE id = 1'));
    let followFinishedFirst = false;
    const follow = sqlExecutor.executeSql(3732, 'SELECT 1 AS ready', { timeoutMs: 1000, userId: '9', username: 'max373' })
      .then((result) => {
        if (!updateDone) followFinishedFirst = true;
        return result;
      });
    let updateDone = false;
    const updateResult = await update;
    updateDone = true;
    const followResult = await follow;

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(querySettled).toBe(false);
    expect(updateResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false, operationId: 'max373-destroy' });
    expect(updateResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
    expect(updateResult.error).toContain('outcome may be unknown');
    expect(updateResult.error).not.toContain('server stop was not confirmed');
    expect(proof.some((sql) => sql.includes('COMMAND AS command'))).toBe(true);
    expect(proof.some((sql) => sql.includes('innodb_trx'))).toBe(true);
    expect(worker.destroy).toHaveBeenCalled();
    expect(worker.release).not.toHaveBeenCalled();
    expect(observer.release).toHaveBeenCalled();
    expect(followFinishedFirst).toBe(false);
    expect(followResult).toMatchObject({ success: true, rows: [{ ready: 1 }] });
    expect(worker.query.mock.calls.filter(([sql]) => sql === 'DELETE FROM t WHERE id = 1')).toHaveLength(1);
    expect(mocks.finishIntent).toHaveBeenCalledWith('max373-destroy', 'unknown', expect.anything());
  });

  it('reports an isolated session when destroy cannot be shown to have stopped the server', async () => {
    const blocked = new Promise<[unknown, unknown]>(() => undefined);
    const seen: string[] = [];
    let stopped = false;
    const worker = session(184);
    worker.query.mockImplementation(async (sql: string) => {
      seen.push(`worker:${sql}`);
      if (sql.startsWith('DELETE ')) return blocked;
      return [[], []];
    });
    const observer = session(185);
    observer.query.mockImplementation(async (sql: string) => {
      seen.push(`observer:${sql}`);
      if (String(sql).includes('COMMAND AS command')) {
        seen.push(stopped ? 'proof:clear' : 'proof:busy');
        return stopped
          ? [[{ command: 'Sleep', info: null }], []]
          : [[{ command: 'Query', info: 'DELETE FROM t WHERE id = 2' }], []];
      }
      if (String(sql).includes('innodb_trx')) return [[{ transactions: stopped ? 0 : 1 }], []];
      if (sql === 'UPDATE t SET note = "recovered" WHERE id = 2') return [[{ affectedRows: 1 }], []];
      return [[], []];
    });
    let checkouts = 0;
    const pool = {
      getConnection: vi.fn(async () => {
        checkouts += 1;
        if (checkouts === 1) return worker;
        if (checkouts === 2) throw new Error('pool exhausted');
        return observer;
      }),
    };
    mocks.getConnection.mockReturnValue({ id: 37321, name: 'mysql', db_type: 'mysql', pool });

    const started = Date.now();
    let updateDone = false;
    const update = sqlExecutor.executeSql(37321, 'DELETE FROM t WHERE id = 2', {
      approvalGrant: { ...grant, operationId: 'max373-unconfirmed' }, timeoutMs: 40, userId: '9', username: 'max373',
    });
    await vi.waitUntil(() => worker.query.mock.calls.some(([sql]) => sql.startsWith('DELETE ')));
    let followFinishedFirst = false;
    const followSql = 'UPDATE t SET note = "blocked-next" WHERE id = 2';
    const follow = sqlExecutor.executeSql(37321, followSql, {
      approvalGrant: { ...grant, operationId: 'max373-unconfirmed-next' }, timeoutMs: 1000, userId: '9', username: 'max373',
    }).then((result) => {
      if (!updateDone) followFinishedFirst = true;
      return result;
    });
    const updateResult = await update;
    updateDone = true;
    const followResult = await follow;
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(8_000);
    expect(followFinishedFirst).toBe(false);
    expect(updateResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(updateResult.error).toContain('server stop was not confirmed');
    expect(updateResult.error).toContain('session was isolated');
    expect(updateResult.error).toContain('do not retry');
    expect(updateResult.error?.toLowerCase()).not.toContain('rolled back');
    expect(worker.destroy).toHaveBeenCalled();
    expect(worker.release).not.toHaveBeenCalled();
    expect(followResult).toMatchObject({ success: false, executionState: 'not_started', retryable: false });
    expect(followResult.error).toContain('MYSQL_INSTANCE_ISOLATED');
    expect(followResult.error).toContain('was not sent');
    expect(seen.some((line) => line.includes('blocked-next'))).toBe(false);
    expect(mocks.beginIntent).toHaveBeenCalledTimes(1);
    expect(mocks.finishIntent).toHaveBeenCalledWith('max373-unconfirmed', 'unknown', expect.anything());
    expect(mocks.finishIntent).not.toHaveBeenCalledWith('max373-unconfirmed', 'succeeded', expect.anything());

    stopped = true;
    const recovered = await sqlExecutor.executeSql(37321, 'UPDATE t SET note = "recovered" WHERE id = 2', {
      approvalGrant: { ...grant, operationId: 'max373-unconfirmed-recovered' }, timeoutMs: 1000, userId: '9', username: 'max373',
    });
    expect(recovered).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
    const clearAt = seen.indexOf('proof:clear');
    const recoveredAt = seen.indexOf('observer:UPDATE t SET note = "recovered" WHERE id = 2');
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(recoveredAt).toBeGreaterThan(clearAt);
    expect(mocks.beginIntent).toHaveBeenCalledTimes(2);
    expect(mocks.finishIntent).toHaveBeenCalledWith('max373-unconfirmed-recovered', 'succeeded', expect.anything());
  }, 15_000);

  it('does not treat a KILL receipt as a stop while the statement and transaction remain', async () => {
    const blocked = new Promise<[unknown, unknown]>(() => undefined);
    const seen: string[] = [];
    let stopped = false;
    const worker = session(201);
    worker.query.mockImplementation(async (sql: string) => {
      seen.push(`worker:${sql}`);
      if (sql.startsWith('UPDATE ')) return blocked;
      return [[], []];
    });
    const killer = session(202);
    killer.query.mockImplementation(async (sql: string) => {
      seen.push(`killer:${sql}`);
      if (String(sql).includes('COMMAND AS command')) {
        return [[{ command: 'Query', info: 'UPDATE t SET note = "ack" WHERE id = 1' }], []];
      }
      if (String(sql).startsWith('KILL ')) return [[], []];
      return [[], []];
    });
    const observer = session(203);
    observer.query.mockImplementation(async (sql: string) => {
      seen.push(`observer:${sql}`);
      if (String(sql).includes('COMMAND AS command')) {
        seen.push(stopped ? 'proof:clear' : 'proof:busy');
        return stopped
          ? [[{ command: 'Sleep', info: null }], []]
          : [[{ command: 'Query', info: 'UPDATE t SET note = "ack" WHERE id = 1' }], []];
      }
      if (String(sql).includes('innodb_trx')) return [[{ transactions: stopped ? 0 : 1 }], []];
      if (sql === 'UPDATE t SET note = "after-stop" WHERE id = 1') return [[{ affectedRows: 1 }], []];
      return [[], []];
    });
    const queue = [worker, killer];
    const pool = { getConnection: vi.fn(async () => queue.shift() ?? observer) };
    mocks.getConnection.mockReturnValue({ id: 37322, name: 'mysql', db_type: 'mysql', pool });

    const started = Date.now();
    const update = sqlExecutor.executeSql(37322, 'UPDATE t SET note = "ack" WHERE id = 1', {
      approvalGrant: { ...grant, operationId: 'max373-ack' }, timeoutMs: 40, userId: '9', username: 'max373',
    });
    await vi.waitUntil(() => seen.some((line) => line.includes('note = "ack"')));
    const follow = sqlExecutor.executeSql(37322, 'UPDATE t SET note = "still-running" WHERE id = 1', {
      approvalGrant: { ...grant, operationId: 'max373-ack-next' }, timeoutMs: 1000, userId: '9', username: 'max373',
    });
    const updateResult = await update;
    const followResult = await follow;

    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(seen.some((line) => line.startsWith('killer:KILL '))).toBe(true);
    expect(updateResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(updateResult.error).toContain('server stop was not confirmed');
    expect(updateResult.error).toContain('do not retry');
    expect(followResult).toMatchObject({ success: false, executionState: 'not_started', retryable: false });
    expect(followResult.error).toContain('MYSQL_INSTANCE_ISOLATED');
    expect(followResult.error).toContain('was not sent');
    expect(seen.some((line) => line.includes('still-running'))).toBe(false);
    expect(worker.destroy).toHaveBeenCalled();
    expect(worker.release).not.toHaveBeenCalled();
    expect(killer.release).toHaveBeenCalled();
    expect(mocks.beginIntent.mock.calls.map((call) => call[1].operationId)).toEqual(['max373-ack']);

    stopped = true;
    const recovered = await sqlExecutor.executeSql(37322, 'UPDATE t SET note = "after-stop" WHERE id = 1', {
      approvalGrant: { ...grant, operationId: 'max373-ack-recovered' }, timeoutMs: 1000, userId: '9', username: 'max373',
    });
    expect(recovered).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
    const clearAt = seen.lastIndexOf('proof:clear');
    const recoveredAt = seen.indexOf('observer:UPDATE t SET note = "after-stop" WHERE id = 1');
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(recoveredAt).toBeGreaterThan(clearAt);
    expect(seen.some((line) => line.includes('still-running'))).toBe(false);
    expect(mocks.beginIntent.mock.calls.map((call) => call[1].operationId)).toEqual(['max373-ack', 'max373-ack-recovered']);
    expect(mocks.finishIntent).toHaveBeenCalledWith('max373-ack', 'unknown', expect.anything());
    expect(mocks.finishIntent).not.toHaveBeenCalledWith('max373-ack', 'succeeded', expect.anything());
  }, 15_000);

  it('admits the next change only after a KILL receipt is followed by server stop evidence', async () => {
    const blocked = new Promise<[unknown, unknown]>(() => undefined);
    const seen: string[] = [];
    const worker = session(211);
    worker.query.mockImplementation(async (sql: string) => {
      seen.push(`worker:${sql}`);
      if (sql.startsWith('DELETE ')) return blocked;
      return [[], []];
    });
    const killer = session(212);
    killer.query.mockImplementation(async (sql: string) => {
      seen.push(`killer:${sql}`);
      if (String(sql).includes('COMMAND AS command')) {
        return [[{ command: 'Query', info: 'DELETE FROM t WHERE id = 4' }], []];
      }
      if (String(sql).startsWith('KILL ')) return [[], []];
      return [[], []];
    });
    const observer = session(213);
    observer.query.mockImplementation(async (sql: string) => {
      seen.push(`observer:${sql}`);
      if (String(sql).includes('COMMAND AS command')) {
        seen.push('proof:clear');
        return [[{ command: 'Sleep', info: null }], []];
      }
      if (String(sql).includes('innodb_trx')) return [[{ transactions: 0 }], []];
      return [[], []];
    });
    const follower = session(214);
    follower.query.mockImplementation(async (sql: string) => {
      seen.push(`follower:${sql}`);
      if (sql === 'UPDATE t SET note = "next-write" WHERE id = 4') return [[{ affectedRows: 1 }], []];
      return [[], []];
    });
    const queue = [worker, killer, observer, follower];
    const pool = {
      getConnection: vi.fn(async () => {
        const next = queue.shift();
        if (!next) throw new Error('unexpected checkout');
        return next;
      }),
    };
    mocks.getConnection.mockReturnValue({ id: 37323, name: 'mysql', db_type: 'mysql', pool });

    const update = sqlExecutor.executeSql(37323, 'DELETE FROM t WHERE id = 4', {
      approvalGrant: { ...grant, operationId: 'max373-kill-observed' }, timeoutMs: 40, userId: '9', username: 'max373',
    });
    await vi.waitUntil(() => seen.some((line) => line.startsWith('worker:DELETE ')));
    const follow = sqlExecutor.executeSql(37323, 'UPDATE t SET note = "next-write" WHERE id = 4', {
      approvalGrant: { ...grant, operationId: 'max373-kill-observed-next' }, timeoutMs: 1000, userId: '9', username: 'max373',
    });
    const updateResult = await update;
    const followResult = await follow;

    expect(updateResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(updateResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
    expect(updateResult.error).toContain('cancelled');
    expect(updateResult.error).not.toContain('server stop was not confirmed');
    expect(followResult).toMatchObject({ success: true, executionState: 'succeeded' });
    const killAt = seen.findIndex((line) => line.startsWith('killer:KILL '));
    const proofAt = seen.indexOf('proof:clear');
    const followAt = seen.indexOf('follower:UPDATE t SET note = "next-write" WHERE id = 4');
    expect(killAt).toBeGreaterThanOrEqual(0);
    expect(proofAt).toBeGreaterThan(killAt);
    expect(followAt).toBeGreaterThan(proofAt);
    expect(worker.query.mock.calls.filter(([sql]) => String(sql).startsWith('DELETE '))).toHaveLength(1);
    expect(worker.release).not.toHaveBeenCalled();
    expect(killer.release).toHaveBeenCalled();
    expect(mocks.finishIntent).toHaveBeenCalledWith('max373-kill-observed', 'unknown', expect.anything());
    expect(mocks.finishIntent).toHaveBeenCalledWith('max373-kill-observed-next', 'succeeded', expect.anything());
  });

  it('bounds a KILL that never returns and does not put either session back in the pool', async () => {
    const blocked = new Promise<[unknown, unknown]>(() => undefined);
    const worker = session(87);
    worker.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE ')) return blocked;
      return [[], []];
    });
    const killer = session(88);
    let killStarted = false;
    killer.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('COMMAND AS command')) {
        return [[{ command: 'Query', info: 'UPDATE t SET note = "hang" WHERE id = 1' }], []];
      }
      if (String(sql).startsWith('KILL ')) {
        killStarted = true;
        return new Promise(() => undefined);
      }
      return [[], []];
    });
    const observer = session(89);
    observer.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('COUNT(*) AS threads')) return [[{ threads: 0 }], []];
      if (String(sql).includes('innodb_trx')) return [[{ transactions: 0 }], []];
      if (sql === 'SELECT 1 AS ready') return [[{ ready: 1 }], []];
      return [[], []];
    });
    let checkouts = 0;
    const pool = {
      getConnection: vi.fn(async () => {
        checkouts += 1;
        if (checkouts === 1) return worker;
        if (checkouts === 2) return killer;
        return observer;
      }),
    };
    mocks.getConnection.mockReturnValue({ id: 3735, name: 'mysql', db_type: 'mysql', pool });

    const started = Date.now();
    let updateDone = false;
    const update = sqlExecutor.executeSql(3735, 'UPDATE t SET note = "hang" WHERE id = 1', {
      approvalGrant: { ...grant, operationId: 'max373-kill-budget' }, timeoutMs: 40, userId: '9', username: 'max373',
    });
    await vi.waitUntil(() => worker.query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE ')));
    let followFinishedFirst = false;
    const follow = sqlExecutor.executeSql(3735, 'SELECT 1 AS ready').then((result) => {
      if (!updateDone) followFinishedFirst = true;
      return result;
    });
    const updateResult = await update;
    updateDone = true;
    const followResult = await follow;

    expect(killStarted).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(followFinishedFirst).toBe(false);
    expect(updateResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(updateResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
    expect(updateResult.error).not.toContain('server stop was not confirmed');
    expect(worker.destroy).toHaveBeenCalled();
    expect(worker.release).not.toHaveBeenCalled();
    expect(killer.destroy).toHaveBeenCalled();
    expect(killer.release).not.toHaveBeenCalled();
    expect(followResult.success).toBe(true);
    expect(mocks.finishIntent).toHaveBeenCalledWith('max373-kill-budget', 'unknown', expect.anything());
  });

  it('does not KILL or destroy when the statement finishes before a delayed killer arrives', async () => {
    const events: string[] = [];
    let finishUpdate: (value: [unknown, unknown]) => void = () => undefined;
    const update = new Promise<[unknown, unknown]>((resolve) => { finishUpdate = resolve; });
    const worker = session(91);
    worker.query.mockImplementation(async (sql: string) => {
      events.push(`worker:${sql}`);
      if (sql.startsWith('UPDATE ')) return update;
      if (sql === 'SELECT 1 AS ready') return [[{ ready: 1 }], []];
      return [[], []];
    });
    worker.release.mockImplementation(() => { events.push('worker:release'); });
    worker.destroy.mockImplementation(() => { events.push('worker:destroy'); });
    let releaseKillerCheckout: ((session: Session) => void) | undefined;
    const killerGate = new Promise<Session>((resolve) => { releaseKillerCheckout = resolve; });
    const killer = session(92);
    killer.query.mockImplementation(async (sql: string) => {
      events.push(`killer:${sql}`);
      return [[], []];
    });
    killer.destroy.mockImplementation(() => { events.push('killer:destroy'); });
    killer.release.mockImplementation(() => { events.push('killer:release'); });
    let checkouts = 0;
    const pool = {
      getConnection: vi.fn(() => {
        checkouts += 1;
        if (checkouts === 1) return Promise.resolve(worker);
        if (checkouts === 2) return killerGate;
        return Promise.resolve(worker);
      }),
    };
    mocks.getConnection.mockReturnValue({ id: 3736, name: 'mysql', db_type: 'mysql', pool });

    const first = sqlExecutor.executeSql(3736, 'UPDATE t SET note = "late" WHERE id = 1', {
      approvalGrant: { ...grant, operationId: 'max373-late-killer' }, timeoutMs: 40, userId: '9', username: 'max373',
    });
    await vi.waitUntil(() => events.includes('worker:UPDATE t SET note = "late" WHERE id = 1'));
    // normalizeTimeout floors at 100ms. Wait past that floor before the statement succeeds.
    await new Promise((resolve) => setTimeout(resolve, 150));
    finishUpdate([[{ affectedRows: 1 }], []]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(events).not.toContain('worker:release');
    expect(events).not.toContain('worker:destroy');
    releaseKillerCheckout!(killer);
    const result = await first;
    const follow = await sqlExecutor.executeSql(3736, 'SELECT 1 AS ready', { timeoutMs: 1000, userId: '9', username: 'max373' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(result).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
    expect(follow).toMatchObject({ success: true, rows: [{ ready: 1 }] });
    expect(events.filter((event) => event.startsWith('killer:'))).toEqual(['killer:release']);
    expect(events).not.toContain('worker:destroy');
    expect(events).not.toContain('killer:destroy');
    expect(events).toContain('worker:release');
    const releaseAt = events.indexOf('worker:release');
    expect(events.indexOf('worker:SET SESSION innodb_lock_wait_timeout = DEFAULT')).toBeLessThan(releaseAt);
    expect(events.indexOf('worker:SELECT 1 AS ready')).toBeGreaterThan(releaseAt);
    expect(mocks.finishIntent).toHaveBeenCalledWith('max373-late-killer', 'succeeded', expect.anything());
    expect(mocks.auditSql).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'error', sqlText: expect.stringContaining('late') }));
  });

  it('does not destroy a finished statement when the killer arrives after the acquire budget', async () => {
    const events: string[] = [];
    let finishUpdate: (value: [unknown, unknown]) => void = () => undefined;
    const update = new Promise<[unknown, unknown]>((resolve) => { finishUpdate = resolve; });
    const worker = session(93);
    worker.query.mockImplementation(async (sql: string) => {
      events.push(`worker:${sql}`);
      if (sql.startsWith('INSERT ')) return update;
      if (sql === 'SELECT 1 AS ready') return [[{ ready: 1 }], []];
      return [[], []];
    });
    worker.release.mockImplementation(() => { events.push('worker:release'); });
    worker.destroy.mockImplementation(() => { events.push('worker:destroy'); });
    let releaseKillerCheckout: ((session: Session) => void) | undefined;
    const killerGate = new Promise<Session>((resolve) => { releaseKillerCheckout = resolve; });
    const killer = session(94);
    killer.query.mockImplementation(async (sql: string) => {
      events.push(`killer:${sql}`);
      return [[], []];
    });
    killer.destroy.mockImplementation(() => { events.push('killer:destroy'); });
    killer.release.mockImplementation(() => { events.push('killer:release'); });
    let checkouts = 0;
    const pool = {
      getConnection: vi.fn(() => {
        checkouts += 1;
        if (checkouts === 1) return Promise.resolve(worker);
        if (checkouts === 2) return killerGate;
        return Promise.resolve(worker);
      }),
    };
    mocks.getConnection.mockReturnValue({ id: 3737, name: 'mysql', db_type: 'mysql', pool });

    const started = Date.now();
    const first = sqlExecutor.executeSql(3737, 'INSERT INTO t (id, note) VALUES (7, "budget")', {
      approvalGrant: { ...grant, operationId: 'max373-budget-arrival' }, timeoutMs: 40, userId: '9', username: 'max373',
    });
    await vi.waitUntil(() => events.some((event) => event.startsWith('worker:INSERT ')));
    await new Promise((resolve) => setTimeout(resolve, 150));
    finishUpdate([[{ affectedRows: 1 }], []]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).not.toContain('worker:release');
    expect(events).not.toContain('worker:destroy');
    const result = await first;
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(4_000);
    releaseKillerCheckout!(killer);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const follow = await sqlExecutor.executeSql(3737, 'SELECT 1 AS ready', { userId: '9', username: 'max373' });

    expect(result).toMatchObject({ success: true, executionState: 'succeeded' });
    expect(follow.success).toBe(true);
    expect(events).not.toContain('worker:destroy');
    expect(events).not.toContain('killer:destroy');
    expect(events.filter((event) => event.startsWith('killer:'))).toEqual(['killer:release']);
    expect(events.filter((event) => event.startsWith('worker:INSERT '))).toHaveLength(1);
  });

  it('does not send KILL when the acquired killer sees the statement is already idle', async () => {
    let finishUpdate: (value: [unknown, unknown]) => void = () => undefined;
    const update = new Promise<[unknown, unknown]>((resolve) => { finishUpdate = resolve; });
    const worker = session(95);
    worker.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE ')) return update;
      return [[], []];
    });
    const killer = session(96);
    const killerSql: string[] = [];
    killer.query.mockImplementation(async (sql: string) => {
      killerSql.push(String(sql));
      if (String(sql).includes('COMMAND AS command')) {
        finishUpdate([[{ affectedRows: 1 }], []]);
        return [[], []];
      }
      return [[], []];
    });
    const acquired = [worker, killer];
    const pool = {
      getConnection: vi.fn(async () => {
        const next = acquired.shift();
        if (!next) throw new Error('unexpected checkout');
        return next;
      }),
    };
    mocks.getConnection.mockReturnValue({ id: 3738, name: 'mysql', db_type: 'mysql', pool });

    const result = await sqlExecutor.executeSql(3738, 'UPDATE t SET note = "idle" WHERE id = 1', {
      approvalGrant: { ...grant, operationId: 'max373-idle' }, timeoutMs: 40, userId: '9', username: 'max373',
    });

    expect(result).toMatchObject({ success: true, executionState: 'succeeded' });
    expect(killerSql.some((sql) => sql.startsWith('KILL '))).toBe(false);
    expect(worker.destroy).not.toHaveBeenCalled();
    expect(worker.release).toHaveBeenCalled();
    expect(killer.release).toHaveBeenCalled();
    expect(killer.destroy).not.toHaveBeenCalled();
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

  async function transportLossLeavesTheInstanceIsolated(options: {
    instanceId: number;
    operationId: string;
    threadId: number;
    lose: 'borrow' | 'kill-ack' | 'proof';
  }) {
    const seen: string[] = [];
    let stopped = false;
    let rejectUpdate: (error: Error) => void = () => undefined;
    const blocked = new Promise<never>((_, reject) => { rejectUpdate = reject; });
    const lost = Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true });
    const worker = session(options.threadId);
    worker.query.mockImplementation(async (sql: string) => {
      seen.push(`worker:${sql}`);
      if (sql.startsWith('UPDATE ')) return blocked;
      return [[], []];
    });
    let releaseKiller: ((session: Session) => void) | undefined;
    const killerGate = new Promise<Session>((resolve) => { releaseKiller = resolve; });
    const killer = session(options.threadId + 1);
    killer.query.mockImplementation(async (sql: string) => {
      seen.push(`killer:${sql}`);
      if (String(sql).includes('COMMAND AS command')) {
        return [[{ command: 'Query', info: 'UPDATE t SET note = "transport" WHERE id = 1' }], []];
      }
      if (String(sql).startsWith('KILL ')) {
        if (options.lose === 'kill-ack') rejectUpdate(lost);
        return [[], []];
      }
      return [[], []];
    });
    const observer = session(options.threadId + 2);
    observer.query.mockImplementation(async (sql: string) => {
      seen.push(`observer:${sql}`);
      if (options.lose === 'proof' && String(sql).includes('COMMAND AS command')) rejectUpdate(lost);
      if (String(sql).includes('COMMAND AS command')) {
        seen.push(stopped ? 'proof:clear' : 'proof:busy');
        return stopped
          ? [[{ command: 'Sleep', info: null }], []]
          : [[{ command: 'Query', info: 'UPDATE t SET note = "transport" WHERE id = 1' }], []];
      }
      if (String(sql).includes('innodb_trx')) return [[{ transactions: stopped ? 0 : 1 }], []];
      if (sql === 'UPDATE t SET note = "after-transport" WHERE id = 1') return [[{ affectedRows: 1 }], []];
      return [[], []];
    });
    const queue: Array<Session | Promise<Session>> = [
      worker,
      options.lose === 'borrow' ? killerGate : killer,
    ];
    const pool = { getConnection: vi.fn(async () => queue.shift() ?? observer) };
    mocks.getConnection.mockReturnValue({ id: options.instanceId, name: 'mysql', db_type: 'mysql', pool });

    const sql = 'UPDATE t SET note = "transport" WHERE id = 1';
    const followSql = 'UPDATE t SET note = "still-running" WHERE id = 1';
    const update = sqlExecutor.executeSql(options.instanceId, sql, {
      approvalGrant: { ...grant, operationId: options.operationId }, timeoutMs: 40, userId: '9', username: 'max373',
    });
    await vi.waitUntil(() => seen.some((line) => line === `worker:${sql}`));
    if (options.lose === 'borrow') {
      await new Promise((resolve) => setTimeout(resolve, 120));
      rejectUpdate(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      releaseKiller!(killer);
    }
    const follow = sqlExecutor.executeSql(options.instanceId, followSql, {
      approvalGrant: { ...grant, operationId: `${options.operationId}-next` }, timeoutMs: 1000, userId: '9', username: 'max373',
    });
    const updateResult = await update;
    const followResult = await follow;

    expect(updateResult).toMatchObject({ success: false, executionState: 'unknown', retryable: false });
    expect(updateResult.error).toContain('MYSQL_STATEMENT_TIMEOUT');
    expect(updateResult.error).toContain('server stop was not confirmed');
    expect(updateResult.error).toContain('do not retry');
    expect(updateResult.error).not.toContain('Connection lost');
    expect(updateResult.error).not.toContain('ECONNRESET');
    expect(followResult).toMatchObject({ success: false, executionState: 'not_started', retryable: false });
    expect(followResult.error).toContain('MYSQL_INSTANCE_ISOLATED');
    expect(seen.some((line) => line.includes('still-running'))).toBe(false);
    expect(seen.some((line) => line === 'proof:busy')).toBe(true);
    expect(worker.destroy).toHaveBeenCalled();
    expect(worker.release).not.toHaveBeenCalled();
    expect(mocks.beginIntent.mock.calls.map((call) => call[1].operationId)).toEqual([options.operationId]);
    expect(mocks.finishIntent).toHaveBeenCalledWith(options.operationId, 'unknown', expect.anything());
    expect(mocks.finishIntent).not.toHaveBeenCalledWith(options.operationId, 'succeeded', expect.anything());
    expect(mocks.auditSql).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      dbType: 'mysql',
      errorMessage: expect.stringContaining('server stop was not confirmed'),
    }));

    stopped = true;
    const recovered = await sqlExecutor.executeSql(options.instanceId, 'UPDATE t SET note = "after-transport" WHERE id = 1', {
      approvalGrant: { ...grant, operationId: `${options.operationId}-recovered` }, timeoutMs: 1000, userId: '9', username: 'max373',
    });
    expect(recovered).toMatchObject({ success: true, executionState: 'succeeded', retryable: false });
    expect(seen.filter((line) => line === `worker:${sql}`)).toHaveLength(1);
    expect(seen.indexOf('proof:clear')).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf('observer:UPDATE t SET note = "after-transport" WHERE id = 1')).toBeGreaterThan(seen.indexOf('proof:clear'));
    expect(mocks.beginIntent.mock.calls.map((call) => call[1].operationId)).toEqual([
      options.operationId,
      `${options.operationId}-recovered`,
    ]);
  }

  it('keeps isolation when the worker connection drops while the killer is still being borrowed', async () => {
    await transportLossLeavesTheInstanceIsolated({
      instanceId: 37324, operationId: 'max373-transport-borrow', threadId: 301, lose: 'borrow',
    });
  }, 15_000);

  it('keeps isolation when KILL is acknowledged and the worker then loses the connection', async () => {
    await transportLossLeavesTheInstanceIsolated({
      instanceId: 37325, operationId: 'max373-transport-ack', threadId: 311, lose: 'kill-ack',
    });
  }, 15_000);

  it('does not let a late transport reject replace an unconfirmed stop', async () => {
    await transportLossLeavesTheInstanceIsolated({
      instanceId: 37326, operationId: 'max373-transport-proof', threadId: 321, lose: 'proof',
    });
  }, 15_000);
});
