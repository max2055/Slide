/**
 * SQL 执行服务
 * 安全执行 SQL 查询，支持 SELECT 直接执行、DDL/DML 走审批流
 */
import mysql from 'mysql2/promise';
import { sqlExecutionIntent } from './audit/sql-execution-intent.js';
import { databaseService } from './database-service';
import { auditLogManager } from './audit/audit-log';
import { classifySql } from './sql-validator.js';
import { dbConnection } from './db-connection.js';
import { authorizeApprovedSqlExecution, type ApprovalExecutionGrant } from './security/approval-execution-authorizer.js';
import { securityEventService } from './security/security-event-service.js';
import { withInstanceExecutionLock } from './instance-execution-lock.js';

const DEFAULT_SQL_TIMEOUT_MS = 15_000;
const MAX_SQL_TIMEOUT_MS = 30_000;
const MAX_SQL_ROWS = 1_000;

type DamengSession = {
  execute: (sql: string, binds?: unknown[], options?: { maxRows?: number; autoCommit?: boolean }) => Promise<any>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  close?: () => Promise<void>;
  // dmdb copies ConnectionAttributes.sessionTimeout onto each statement as queryTimeout.
  // The public attribute is integer seconds; 0 disables the server limit.
  conn_prop_sessionTimeout?: number;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function damengTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function quoteDamengIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function damengCell(result: any): string {
  const row = result?.rows?.[0];
  const value = Array.isArray(row) ? row[0] : row && Object.values(row)[0];
  if (typeof value !== 'string' || !value.trim()) throw new Error('DAMENG_SCHEMA_UNAVAILABLE');
  return value;
}

type MysqlSession = {
  threadId?: number;
  query: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]>;
  release: () => void;
  destroy: () => void;
};

type MysqlPool = {
  getConnection: () => Promise<MysqlSession>;
};

const MYSQL_KILL_ACQUIRE_BUDGET_MS = 1_000;
const MYSQL_KILL_RECEIPT_BUDGET_MS = 1_000;
const MYSQL_STOP_PROOF_BUDGET_MS = 1_000;
const MYSQL_PROCESSLIST_SQL = 'SELECT COMMAND AS command, INFO AS info FROM information_schema.processlist WHERE ID = ?';
const MYSQL_THREAD_PROOF_SQL = 'SELECT COUNT(*) AS threads FROM information_schema.processlist WHERE ID = ?';
const MYSQL_TRX_PROOF_SQL = 'SELECT COUNT(*) AS transactions FROM information_schema.innodb_trx WHERE trx_mysql_thread_id = ?';

type MysqlBudget<T> = { status: 'ok'; value: T } | { status: 'error'; error: unknown } | { status: 'budget' };
type MysqlQueryOutcome = { ok: true; value: [unknown, unknown] } | { ok: false; error: unknown };

function budgeted<T>(work: Promise<T>, budgetMs: number): Promise<MysqlBudget<T>> {
  const guarded = work.then(
    (value) => ({ status: 'ok' as const, value }),
    (error) => ({ status: 'error' as const, error }),
  );
  if (budgetMs <= 0) return Promise.resolve({ status: 'budget' });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'budget' }), budgetMs);
    void guarded.then((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function mysqlStatementTimeoutError(stopConfirmed: boolean): Error {
  const detail = stopConfirmed
    ? 'the statement was cancelled or hit the server lock wait limit'
    : 'the statement exceeded its timeout and the session was isolated; server stop was not confirmed';
  const error = new Error(
    `MYSQL_STATEMENT_TIMEOUT: ${detail}; outcome may be unknown; do not retry or claim a confirmed rollback`,
  );
  (error as Error & { code: string }).code = 'MYSQL_STATEMENT_TIMEOUT';
  return error;
}

function isMysqlStatementTimeout(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'MYSQL_STATEMENT_TIMEOUT');
}

function isMysqlServerTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const errno = Number((error as { errno?: unknown }).errno);
  const code = String((error as { code?: unknown }).code ?? '');
  return errno === 1205 || errno === 1317 || code === 'ER_LOCK_WAIT_TIMEOUT' || code === 'ER_QUERY_INTERRUPTED';
}

function mysqlLockWaitSeconds(timeoutMs: number): number {
  const seconds = Math.ceil(timeoutMs / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 30) {
    throw new Error('MYSQL_LOCK_WAIT_TIMEOUT_INVALID');
  }
  return seconds;
}

function positiveThreadId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

class SqlExecutor {
  private readonly retiredDamengSessions = new WeakSet<object>();

  private normalizeTimeout(timeoutMs?: number): number {
    if (!Number.isFinite(timeoutMs)) return DEFAULT_SQL_TIMEOUT_MS;
    return Math.max(100, Math.min(Math.trunc(timeoutMs!), MAX_SQL_TIMEOUT_MS));
  }

  private serializeForInstance<T>(instanceId: number, action: () => Promise<T>): Promise<T> {
    return withInstanceExecutionLock(instanceId, action);
  }

  private async mysqlThreadId(connection: MysqlSession): Promise<number | null> {
    const direct = positiveThreadId(connection.threadId);
    if (direct) return direct;
    const [rows] = await connection.query('SELECT CONNECTION_ID() AS connection_id');
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || typeof row !== 'object') return null;
    return positiveThreadId((row as { connection_id?: unknown }).connection_id);
  }

  private releaseMysqlSession(connection: MysqlSession): void {
    try { connection.release(); } catch { this.destroyMysqlSession(connection); }
  }

  private destroyMysqlSession(connection: MysqlSession): void {
    try { connection.destroy(); } catch { /* The socket is already closing. */ }
  }

  /**
   * Borrow a pooled session. A checkout that arrives after the budget, or after
   * the original statement has already finished, is released and never used.
   */
  private async borrowMysqlSession(
    pool: MysqlPool,
    budgetMs: number,
    abandon: { current: boolean },
    finished: () => boolean,
  ): Promise<MysqlSession | undefined> {
    const acquired = pool.getConnection().then(
      (candidate) => {
        if (abandon.current || finished()) {
          this.releaseMysqlSession(candidate);
          return undefined;
        }
        return candidate;
      },
      () => undefined,
    );
    const winner = await budgeted(acquired, budgetMs);
    if (winner.status !== 'ok' || !winner.value) {
      abandon.current = true;
      return undefined;
    }
    return winner.value;
  }

  private async mysqlStatementStillRunning(
    killer: MysqlSession,
    threadId: number,
  ): Promise<boolean | 'budget' | 'error'> {
    const seen = await budgeted(killer.query(MYSQL_PROCESSLIST_SQL, [threadId]), MYSQL_KILL_RECEIPT_BUDGET_MS);
    if (seen.status === 'budget') return 'budget';
    if (seen.status === 'error') return 'error';
    const [rows] = seen.value;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || typeof row !== 'object') return false;
    const command = String((row as { command?: unknown }).command ?? '').toLowerCase();
    if (!command || command === 'sleep') return false;
    return true;
  }

  /**
   * Observe that the server thread and its InnoDB transaction are gone.
   * mysql2 destroy() only sets _closing and ends the socket; it does not reject
   * the in-flight query, so this probe is the stop evidence.
   */
  private async proveMysqlStopped(pool: MysqlPool, threadId: number): Promise<boolean> {
    const deadline = Date.now() + MYSQL_STOP_PROOF_BUDGET_MS;
    while (Date.now() < deadline) {
      const abandon = { current: false };
      const remaining = Math.max(1, deadline - Date.now());
      const observer = await this.borrowMysqlSession(pool, remaining, abandon, () => false);
      if (!observer) return false;
      const threads = await budgeted(observer.query(MYSQL_THREAD_PROOF_SQL, [threadId]), Math.max(1, deadline - Date.now()));
      if (threads.status === 'budget') {
        this.destroyMysqlSession(observer);
        return false;
      }
      const transactions = threads.status === 'ok'
        ? await budgeted(observer.query(MYSQL_TRX_PROOF_SQL, [threadId]), Math.max(1, deadline - Date.now()))
        : threads;
      if (transactions.status === 'budget') {
        this.destroyMysqlSession(observer);
        return false;
      }
      this.releaseMysqlSession(observer);
      if (threads.status === 'ok' && transactions.status === 'ok') {
        const threadRow = Array.isArray(threads.value[0]) ? threads.value[0][0] : undefined;
        const trxRow = Array.isArray(transactions.value[0]) ? transactions.value[0][0] : undefined;
        const threadCount = Number((threadRow as { threads?: unknown } | undefined)?.threads);
        const trxCount = Number((trxRow as { transactions?: unknown } | undefined)?.transactions);
        if (threadCount === 0 && trxCount === 0) return true;
      }
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return false;
  }

  /**
   * Cancel shares ownership with the statement. No KILL or destroy is issued
   * after the statement promise settles, and the caller must not release or
   * hand off the worker until this method returns. A KILL that has no receipt
   * retires both sessions so a late command cannot hit a reused thread.
   */
  private async cancelMysqlStatement(
    pool: MysqlPool,
    connection: MysqlSession,
    threadId: number | null,
    lease: { querySettled: boolean; sideEffect: 'none' | 'kill' | 'destroy' },
  ): Promise<'aborted' | 'stopped' | 'unconfirmed'> {
    const finished = () => lease.querySettled && lease.sideEffect === 'none';
    const retireWorker = () => {
      if (finished()) return;
      lease.sideEffect = lease.sideEffect === 'none' ? 'destroy' : lease.sideEffect;
      this.destroyMysqlSession(connection);
    };
    if (threadId === null) {
      if (finished()) return 'aborted';
      retireWorker();
      return 'unconfirmed';
    }

    const pooled = await this.borrowMysqlSession(
      pool,
      MYSQL_KILL_ACQUIRE_BUDGET_MS,
      { current: false },
      finished,
    );
    const pooledAttempt = pooled
      ? await this.issueMysqlKill(pooled, threadId, lease, finished, 'pool')
      : 'failed' as const;
    if (pooledAttempt === 'stopped') {
      retireWorker();
      return 'stopped';
    }
    if (pooledAttempt === 'aborted' || finished()) return 'aborted';

    // A saturated pool cannot lend a killer. A direct session uses the pool's
    // own connection settings and does not take a pooled slot.
    const direct = await this.openDirectMysqlSession(pool);
    if (!direct) {
      retireWorker();
      return await this.proveMysqlStopped(pool, threadId) ? 'stopped' : 'unconfirmed';
    }
    const directAttempt = await this.issueMysqlKill(direct, threadId, lease, finished, 'direct');
    if (directAttempt === 'aborted' || finished()) return 'aborted';
    retireWorker();
    if (directAttempt === 'stopped') return 'stopped';
    return await this.proveMysqlStopped(pool, threadId) ? 'stopped' : 'unconfirmed';
  }

  /**
   * KILL only while the original statement is still executing. The killer is
   * closed before this returns: a pooled session goes back only when no KILL
   * was left in flight, and a direct session is always destroyed.
   */
  private async issueMysqlKill(
    killer: MysqlSession,
    threadId: number,
    lease: { querySettled: boolean; sideEffect: 'none' | 'kill' | 'destroy' },
    finished: () => boolean,
    kind: 'pool' | 'direct',
  ): Promise<'aborted' | 'stopped' | 'failed'> {
    let open = true;
    let dispose: 'release' | 'destroy' = kind === 'direct' ? 'destroy' : 'release';
    const closeKiller = () => {
      if (!open) return;
      open = false;
      if (dispose === 'release') this.releaseMysqlSession(killer);
      else this.destroyMysqlSession(killer);
    };
    try {
      if (finished()) return 'aborted';
      const stillRunning = await this.mysqlStatementStillRunning(killer, threadId);
      if (finished() || stillRunning === false) return 'aborted';
      if (stillRunning !== true) {
        dispose = 'destroy';
        return 'failed';
      }
      if (finished()) return 'aborted';
      lease.sideEffect = 'kill';
      const receipt = await budgeted(killer.query(`KILL QUERY ${threadId}`), MYSQL_KILL_RECEIPT_BUDGET_MS);
      if (receipt.status !== 'ok') {
        dispose = 'destroy';
        return 'failed';
      }
      return 'stopped';
    } finally {
      closeKiller();
    }
  }

  private async openDirectMysqlSession(pool: MysqlPool): Promise<MysqlSession | undefined> {
    const source = (pool as {
      pool?: { config?: { connectionConfig?: { host?: unknown; port?: unknown; user?: unknown; password?: unknown; database?: unknown; socketPath?: unknown; ssl?: unknown } } };
    }).pool?.config?.connectionConfig;
    if (!source || typeof source.user !== 'string') return undefined;
    if (typeof source.host !== 'string' && typeof source.socketPath !== 'string') return undefined;
    let abandon = false;
    const connecting = mysql.createConnection({
      host: typeof source.host === 'string' ? source.host : undefined,
      port: typeof source.port === 'number' ? source.port : undefined,
      user: source.user,
      password: typeof source.password === 'string' ? source.password : undefined,
      database: typeof source.database === 'string' ? source.database : undefined,
      socketPath: typeof source.socketPath === 'string' ? source.socketPath : undefined,
      ssl: source.ssl as never,
      connectTimeout: MYSQL_KILL_ACQUIRE_BUDGET_MS,
      multipleStatements: false,
    }).then((connection) => {
      if (abandon) {
        this.destroyMysqlSession(connection as unknown as MysqlSession);
        return undefined;
      }
      return connection as unknown as MysqlSession;
    });
    const opened = await budgeted(connecting, MYSQL_KILL_ACQUIRE_BUDGET_MS);
    if (opened.status !== 'ok' || !opened.value) {
      abandon = true;
      return undefined;
    }
    return opened.value;
  }

  private async queryMysql(
    pool: MysqlPool,
    connection: MysqlSession,
    sql: string,
    timeoutMs: number,
  ): Promise<[unknown, unknown]> {
    if (timeoutMs <= 0) return connection.query(sql);
    const threadId = await this.mysqlThreadId(connection);
    const lease: { querySettled: boolean; sideEffect: 'none' | 'kill' | 'destroy' } = {
      querySettled: false,
      sideEffect: 'none',
    };
    const pending: Promise<MysqlQueryOutcome> = connection.query(sql).then(
      (value) => {
        lease.querySettled = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        lease.querySettled = true;
        return { ok: false as const, error };
      },
    );
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([
      pending.then((result) => ({ kind: 'done' as const, result })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timeoutTimer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    ]);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (first.kind === 'done') {
      if (first.result.ok === false) {
        if (isMysqlServerTimeout(first.result.error)) throw mysqlStatementTimeoutError(true);
        throw first.result.error;
      }
      return first.result.value;
    }

    // The statement, the cancel, and retirement stay joined. The session is not
    // released until this function returns, which is after cancel has either
    // aborted with no side effect or finished its KILL/destroy.
    const outcome = await this.cancelMysqlStatement(pool, connection, threadId, lease);
    if (lease.sideEffect === 'none') {
      if (!lease.querySettled) {
        // mysql2 destroy does not reject the in-flight query. Do not wait for it.
        this.destroyMysqlSession(connection);
        const proven = threadId !== null && await this.proveMysqlStopped(pool, threadId);
        throw mysqlStatementTimeoutError(proven);
      }
      const driver = await pending;
      if (driver.ok === true) return driver.value;
      if (isMysqlServerTimeout(driver.error)) throw mysqlStatementTimeoutError(true);
      throw driver.error;
    }
    if (lease.querySettled) {
      const driver = await pending;
      const driverSawServerStop = driver.ok === false && isMysqlServerTimeout(driver.error);
      throw mysqlStatementTimeoutError(outcome === 'stopped' || driverSawServerStop);
    }
    // The driver promise is still pending. The queue stays held only until cancel
    // has finished its bounded KILL, destroy, and process-list proof above.
    throw mysqlStatementTimeoutError(outcome === 'stopped');
  }

  private async acquireOwnedDameng(instanceId: number) {
    let conn = databaseService.getConnection(instanceId);
    if (conn?.dmConnection && this.retiredDamengSessions.has(conn.dmConnection)) {
      conn.connected = false;
      const replaced = await databaseService.reconnect(instanceId).catch(() => false);
      if (!replaced) throw new Error('实例未连接或重连失败');
    }
    const alive = await databaseService.ensureConnectionAlive(instanceId);
    if (!alive) throw new Error('实例未连接或重连失败');
    conn = databaseService.getConnection(instanceId);
    if (!conn?.dmConnection || conn.db_type !== 'dameng' || this.retiredDamengSessions.has(conn.dmConnection)) {
      throw new Error('实例未连接或重连失败');
    }
    return conn;
  }

  private async quarantineDamengSession(
    instanceId: number,
    dm: DamengSession,
    context: { userId?: string; username?: string; ipAddress?: string; approvalGrant?: ApprovalExecutionGrant } | undefined,
    sql: string,
    instanceName: string,
    detail: string,
  ): Promise<void> {
    this.retiredDamengSessions.add(dm);
    const current = databaseService.getConnection(instanceId);
    if (current?.dmConnection === dm) current.connected = false;
    try { await dm.close?.(); } catch { /* The session is already unusable. */ }
    let rebuilt = false;
    try { rebuilt = await databaseService.reconnect(instanceId); } catch { rebuilt = false; }
    const userId = context?.userId || (context?.approvalGrant ? String(context.approvalGrant.reviewerId) : '');
    if (!userId) return;
    await auditLogManager.logSqlExecution({
      userId,
      username: context?.username || 'unknown',
      instanceId,
      instanceName,
      dbType: 'dameng',
      sqlText: sql.substring(0, 500),
      durationMs: 0,
      status: 'error',
      errorMessage: `${detail} reconnect=${rebuilt ? 'ok' : 'failed'}`,
      ipAddress: context?.ipAddress,
      approvalRequestId: context?.approvalGrant?.approvalRequestId,
    }).catch(() => undefined);
  }

  /**
   * 执行 SQL 查询（仅 SELECT）
   */
  async executeSql(instanceId: number, sql: string, context?: {
    userId?: string; username?: string; ipAddress?: string; database?: string; timeoutMs?: number;
    approvalGrant?: ApprovalExecutionGrant;
  }): Promise<{
    success: boolean;
    columns?: string[];
    rows?: any[];
    rowCount?: number;
    truncated?: boolean;
    duration_ms?: number;
    error?: string;
    executionState?: 'succeeded' | 'unknown' | 'not_started';
    operationId?: string;
    retryable?: false;
  }> {
    const startTime = Date.now();
    let approvalAuthorized = false;

    const verifyApproval = async (): Promise<boolean> => {
      if (approvalAuthorized) return true;
      const pool = dbConnection.getPool();
      approvalAuthorized = Boolean(pool && context?.approvalGrant && await authorizeApprovedSqlExecution(
        pool as any,
        context.approvalGrant,
        { instanceId, sql },
      ));
      return approvalAuthorized;
    };

    // Classify SQL BEFORE connection check — reject non-read statements even
    // when the target instance is unreachable.
    const classification = classifySql(sql, 'mysql'); // db_type hint; re-classified after connection
    if (classification.commandType !== 'read') {
      if (
        classification.reasonCode === 'MULTI_STATEMENT' ||
        ['transaction', 'session', 'procedure'].includes(classification.commandType)
      ) {
        return {
          success: false,
          error: `SQL_STATEMENT_NOT_ALLOWED_${classification.reasonCode === 'UNCLASSIFIED'
            ? classification.commandType
            : classification.reasonCode}`,
        };
      }
      if (!await verifyApproval()) {
        await securityEventService.record({
          eventType: 'approval_execution_denied', reasonCode: classification.reasonCode,
          actorId: context?.approvalGrant?.reviewerId, resourceType: 'database-instance', resourceId: String(instanceId),
        }).catch(() => undefined);
        return { success: false, error: `SQL_APPROVAL_REQUIRED_${classification.reasonCode}` };
      }
    }

    // Approval above returns before any probe. Dameng shares one session, so its
    // probe, reconnect and the handle used for the statement stay inside the lock.
    const preview = databaseService.getConnection(instanceId);
    const damengOwned = preview?.db_type === 'dameng' && Boolean(preview.dmConnection);
    if (!damengOwned) {
      const alive = await databaseService.ensureConnectionAlive(instanceId);
      if (!alive) {
        return { success: false, error: '实例未连接或重连失败' };
      }
    }

    let conn = databaseService.getConnection(instanceId);
    if (!conn) {
      return { success: false, error: '实例未连接' };
    }

    // Re-classify with actual db_type for dialect-specific rules
    const reclassification = classifySql(sql, conn.db_type as 'mysql' | 'postgresql' | 'oracle' | 'dameng');
    if (reclassification.commandType !== 'read') {
      if (!['write', 'ddl'].includes(reclassification.commandType)) {
        return {
          success: false,
          error: `SQL_STATEMENT_NOT_ALLOWED_${reclassification.reasonCode === 'UNCLASSIFIED'
            ? reclassification.commandType
            : reclassification.reasonCode}`,
        };
      }
      if (!await verifyApproval()) {
        return { success: false, error: `SQL_APPROVAL_REQUIRED_${reclassification.reasonCode}` };
      }
    }

    const isMutation = reclassification.commandType !== 'read';
    const operationId = context?.approvalGrant?.operationId;
    let intentStarted = false;
    const rejectIntent = (error: { message?: string }) => ({
      success: false as const,
      executionState: error.message === 'SQL_OPERATION_ALREADY_RECORDED_RECONCILE_DO_NOT_RETRY' ? 'unknown' as const : 'not_started' as const,
      operationId,
      retryable: false as const,
      error: `SQL_INTENT_REJECTED: ${error.message}; inspect operation before any retry`,
    });
    const beginIntent = async () => {
      await sqlExecutionIntent.begin({ instanceId, sql, database: context?.database, userId: context?.userId }, context!.approvalGrant!);
      intentStarted = true;
    };
    if (isMutation && !damengOwned) {
      try {
        await beginIntent();
      } catch (error: any) {
        return rejectIntent(error);
      }
    }
    let targetAcknowledged = false;
    try {
      let result: any;
      const isReadOnly = reclassification.commandType === 'read';
      const timeoutMs = this.normalizeTimeout(context?.timeoutMs);

      if (conn.db_type === 'mysql' && conn.pool) {
        const pool = conn.pool as unknown as MysqlPool;
        result = await this.serializeForInstance(instanceId, async () => {
          const connection = await pool.getConnection();
          let transactionStarted = false;
          let discard = false;
          const discardConnection = () => {
            if (discard) return;
            discard = true;
            try { connection.destroy(); } catch { /* The socket is already closing. */ }
          };
          try {
            // MySQL max_execution_time bounds SELECT only, not DML/DDL.
            if (isReadOnly) await connection.query(`SET SESSION max_execution_time = ${timeoutMs}`);
            if (isReadOnly) await connection.query(`SET SESSION sql_select_limit = ${MAX_SQL_ROWS + 1}`);
            if (context?.database) {
              const escapedDb = context.database.replace(/`/g, '``');
              await connection.query('USE `' + escapedDb + '`');
            }
            if (isReadOnly) {
              await connection.query('START TRANSACTION READ ONLY');
              transactionStarted = true;
            } else {
              // Server-side ceilings for row locks and metadata locks. They are
              // whole seconds, so the client also KILL QUERY at timeoutMs.
              // The queue stays held until that statement has actually ended.
              const lockWaitSeconds = mysqlLockWaitSeconds(timeoutMs);
              await connection.query(`SET SESSION innodb_lock_wait_timeout = ${lockWaitSeconds}`);
              await connection.query(`SET SESSION lock_wait_timeout = ${lockWaitSeconds}`);
            }
            const [rows, fields] = await this.queryMysql(pool, connection, sql, isReadOnly ? 0 : timeoutMs);
            if (transactionStarted) {
              await connection.query('COMMIT');
              transactionStarted = false;
            }
            return { rows, fields };
          } catch (error) {
            if (transactionStarted) await connection.query('ROLLBACK').catch(() => undefined);
            if (!isReadOnly && isMysqlStatementTimeout(error)) {
              discardConnection();
              const userId = context?.userId || (context?.approvalGrant ? String(context.approvalGrant.reviewerId) : '');
              if (userId) {
                await auditLogManager.logSqlExecution({
                  userId,
                  username: context?.username || 'unknown',
                  instanceId,
                  instanceName: conn.name,
                  dbType: 'mysql',
                  sqlText: sql.substring(0, 500),
                  durationMs: Date.now() - startTime,
                  status: 'error',
                  errorMessage: errorText(error),
                  ipAddress: context?.ipAddress,
                  approvalRequestId: context?.approvalGrant?.approvalRequestId,
                }).catch(() => undefined);
              }
            }
            throw error;
          } finally {
            if (isReadOnly) {
              await connection.query('SET SESSION max_execution_time = 0').catch(() => undefined);
              await connection.query('SET SESSION sql_select_limit = DEFAULT').catch(() => undefined);
            } else if (!discard) {
              try {
                await connection.query('SET SESSION innodb_lock_wait_timeout = DEFAULT');
                await connection.query('SET SESSION lock_wait_timeout = DEFAULT');
              } catch {
                discardConnection();
              }
            }
            if (discard) discardConnection();
            else connection.release();
          }
        });
      } else if (conn.db_type === 'postgresql' && conn.pgClient) {
        result = await this.serializeForInstance(instanceId, async () => {
          let transactionStarted = false;
          try {
            await conn.pgClient!.query(isReadOnly ? 'BEGIN READ ONLY' : 'BEGIN');
            transactionStarted = true;
            await conn.pgClient!.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
            if (context?.database) {
              await conn.pgClient!.query('SET LOCAL search_path TO ' + conn.pgClient!.escapeIdentifier(context.database));
            }
            const cleanSql = sql.trim().replace(/;+\s*$/, '');
            const boundedSql = isReadOnly
              ? `SELECT * FROM (${cleanSql}) AS slide_read_limit LIMIT ${MAX_SQL_ROWS + 1}`
              : cleanSql;
            const pgResult = await conn.pgClient!.query(boundedSql);
            await conn.pgClient!.query('COMMIT');
            transactionStarted = false;
            return { rows: pgResult.rows, fields: pgResult.fields };
          } catch (error) {
            if (transactionStarted) await conn.pgClient!.query('ROLLBACK').catch(() => undefined);
            throw error;
          }
        });
      } else if (conn.db_type === 'oracle' && conn.oracleConnection) {
        result = await this.serializeForInstance(instanceId, async () => {
          const fromPool = Boolean(conn.oraclePool);
          const oracleConnection = fromPool ? await conn.oraclePool.getConnection() : conn.oracleConnection!;
          const previousCallTimeout = oracleConnection.callTimeout;
          // DDL commits inside Oracle. DML does not: releasing a pooled connection
          // rolls the change back, so a write is succeeded only after commit().
          let readOnlyTransaction = false;
          try {
            oracleConnection.callTimeout = timeoutMs;
            if (isReadOnly) {
              await oracleConnection.execute('SET TRANSACTION READ ONLY', [], { autoCommit: false });
              readOnlyTransaction = true;
            }
            const oracleResult = await oracleConnection.execute(sql, [], {
              maxRows: isReadOnly ? MAX_SQL_ROWS + 1 : 0,
              autoCommit: false,
            });
            if (readOnlyTransaction) {
              await oracleConnection.rollback();
              readOnlyTransaction = false;
            } else if (reclassification.commandType === 'write') {
              await oracleConnection.commit();
            }
            const fields = oracleResult.metaData?.map((m: any) => ({ name: m.name })) || [];
            const rows = Array.isArray(oracleResult.rows) && oracleResult.rows.length > 0 && !Array.isArray(oracleResult.rows[0])
              ? oracleResult.rows
              : (oracleResult.rows || []).map((row: any) => {
                  const obj: any = {};
                  fields.forEach((f: any, i: number) => { obj[f.name] = row[i]; });
                  return obj;
                });
            return { rows, fields };
          } catch (error) {
            if (readOnlyTransaction || reclassification.commandType === 'write') {
              await oracleConnection.rollback().catch(() => undefined);
            }
            throw error;
          } finally {
            oracleConnection.callTimeout = previousCallTimeout;
            if (fromPool) await oracleConnection.close().catch(() => undefined);
          }
        });
      } else if (conn.db_type === 'dameng' && conn.dmConnection) {
        // One shared session. Ownership covers the production probe, reconnect,
        // statement, commit/rollback, schema restore and timeout restore.
        // An external ensure/reconnect also waits on this lock before close.
        // dmdb socketTimeout (error 20010) drops the socket and is not a cancel.
        // sessionTimeout is the server statement limit (DM8 error -608). It is
        // integer seconds, so a sub-second request becomes one second; 0 would disable it.
        const owned = await this.serializeForInstance(instanceId, async () => {
          const live = await this.acquireOwnedDameng(instanceId);
          conn = live;
          if (isMutation && !intentStarted) {
            try {
              await beginIntent();
            } catch (error: any) {
              return { intentRejected: error as { message?: string } };
            }
          }
          const dm = live.dmConnection as DamengSession;
          const previousTimeout = dm.conn_prop_sessionTimeout;
          dm.conn_prop_sessionTimeout = damengTimeoutSeconds(timeoutMs);
          let readOnlyTransaction = false;
          let restoreSchema: string | null = null;
          let primaryError: unknown;
          let rollbackError: unknown;
          let restoreError: unknown;
          try {
            if (context?.database) {
              const current = await dm.execute(
                "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL",
                [],
                { maxRows: 1, autoCommit: true },
              );
              restoreSchema = damengCell(current);
              await dm.execute(`SET SCHEMA ${quoteDamengIdentifier(context.database)}`, [], { autoCommit: true });
            }
            if (isReadOnly) {
              await dm.execute('SET TRANSACTION READ ONLY', [], { autoCommit: false });
              readOnlyTransaction = true;
            }
            const dmResult = await dm.execute(sql, [], {
              maxRows: isReadOnly ? MAX_SQL_ROWS + 1 : 0,
              autoCommit: false,
            });
            if (readOnlyTransaction) {
              await dm.rollback();
              readOnlyTransaction = false;
            } else if (reclassification.commandType === 'write') {
              await dm.commit();
            }
            const fields = dmResult.metaData?.map((m: any) => ({ name: m.name })) || [];
            const rows = Array.isArray(dmResult.rows) && dmResult.rows.length > 0 && !Array.isArray(dmResult.rows[0])
              ? dmResult.rows
              : (dmResult.rows || []).map((row: any) => {
                  const obj: any = {};
                  fields.forEach((f: any, i: number) => { obj[f.name] = row[i]; });
                  return obj;
                });
            return { statement: { rows, fields } };
          } catch (error) {
            primaryError = error;
            if (readOnlyTransaction || reclassification.commandType === 'write') {
              try {
                await dm.rollback();
                readOnlyTransaction = false;
              } catch (rollbackFailure) {
                rollbackError = rollbackFailure;
              }
            }
            throw error;
          } finally {
            // SET SCHEMA auto-commits. Skip it when rollback did not clear the transaction.
            if (restoreSchema && !rollbackError) {
              try {
                await dm.execute(`SET SCHEMA ${quoteDamengIdentifier(restoreSchema)}`, [], { autoCommit: true });
              } catch (error) {
                restoreError = error;
              }
            }
            const dirty = Boolean(rollbackError || restoreError);
            if (!dirty) dm.conn_prop_sessionTimeout = previousTimeout;
            if (dirty) {
              const parts = ['DAMENG_SESSION_QUARANTINED'];
              if (rollbackError) parts.push(`rollback=${errorText(rollbackError)}`);
              if (restoreError) parts.push(`schema=${errorText(restoreError)}`);
              if (primaryError) parts.push(`cause=${errorText(primaryError)}`);
              try {
                await this.quarantineDamengSession(instanceId, dm, context, sql, live.name, parts.join(' '));
              } catch { /* Keep the statement error. */ }
            }
            if (restoreError && !primaryError) throw restoreError;
          }
        });
        if (owned.intentRejected) return rejectIntent(owned.intentRejected);
        if (!owned.statement) throw new Error('实例未连接或重连失败');
        result = owned.statement;
      } else {
        return { success: false, error: `不支持的数据库类型: ${conn.db_type}` };
      }

      targetAcknowledged = true;
      const duration_ms = Date.now() - startTime;
      const allRows = Array.isArray(result.rows) ? result.rows : [];
      const truncated = isReadOnly && allRows.length > MAX_SQL_ROWS;
      const rows = truncated ? allRows.slice(0, MAX_SQL_ROWS) : allRows;
      const columns = Array.isArray(result.fields)
        ? result.fields.map((f: any) => f.name)
        : Object.keys(rows[0] || {});

      // 审计记录
      if (context?.userId || isMutation) {
        try {
          await auditLogManager.logSqlExecution({
            userId: context?.userId || String(context!.approvalGrant!.reviewerId),
            username: context?.username || 'unknown',
            instanceId,
            instanceName: conn.name,
            dbType: conn.db_type,
            sqlText: sql.substring(0, 500),
            durationMs: duration_ms,
            status: 'success',
            rowCount: rows.length,
            ipAddress: context?.ipAddress,
            approvalRequestId: context?.approvalGrant?.approvalRequestId,
          });
        } catch (error) { if (isMutation) throw error; }
      }

      if (isMutation) await sqlExecutionIntent.finish(operationId!, 'succeeded', { duration_ms, targetAcknowledged: true });
      return { success: true, columns, rows, rowCount: rows.length, truncated, duration_ms,
        ...(isMutation ? { executionState: 'succeeded' as const, operationId, retryable: false as const } : {}) };
    } catch (error: any) {
      if (isMutation && intentStarted) {
        await sqlExecutionIntent.finish(operationId!, 'unknown', { targetAcknowledged, error: 'SQL_EXECUTION_OR_AUDIT_FAILED' }).catch(() => undefined);
        const timedOut = isMysqlStatementTimeout(error);
        return { success: false, executionState: 'unknown', operationId, retryable: false,
          error: timedOut
            ? `${error.message}; inspect durable intent and target database`
            : 'SQL_OUTCOME_REQUIRES_RECONCILIATION: SQL may have committed; do not retry; inspect durable intent and target database' };
      }
      if (isMutation) {
        return { success: false, executionState: 'not_started', operationId, retryable: false, error: error.message };
      }
      const duration_ms = Date.now() - startTime;
      if (context?.userId || isMutation) {
        try {
          await auditLogManager.logSqlExecution({
            userId: context?.userId || String(context!.approvalGrant!.reviewerId),
            username: context?.username || 'unknown',
            instanceId,
            instanceName: conn.name,
            dbType: conn.db_type,
            sqlText: sql.substring(0, 500),
            durationMs: duration_ms,
            status: 'error',
            errorMessage: error.message,
            ipAddress: context?.ipAddress,
            approvalRequestId: context?.approvalGrant?.approvalRequestId,
          });
        } catch { /* audit non-blocking */ }
      }
      return { success: false, error: error.message };
    }
  }
}

export const sqlExecutor = new SqlExecutor();
