import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import { validateBinding, type ScriptBinding } from './script-policy.js';

async function cancelServerConnection(connection: PoolConnection): Promise<void> {
  // A separate connection avoids waiting behind the timed-out statement or a
  // saturated ORM pool. MySQL permits an account to kill its own connections.
  const { host, port, user, password, socketPath, ssl, authPlugins } = connection.config;
  const cancel = await mysql.createConnection({ host, port, user, password, socketPath, ssl, authPlugins, connectTimeout: 1000 });
  try {
    await cancel.query({ sql: `KILL CONNECTION ${Number(connection.threadId)}`, timeout: 1000 });
  } catch (error: any) {
    if (error.code !== 'ER_NO_SUCH_THREAD') throw error;
  } finally {
    cancel.destroy();
  }
}

/** Only receives a persisted, exact script capability; never a raw user SQL string. */
export async function executeControlSql(pool: Pool, binding: ScriptBinding, timeoutSeconds: number, logId: number) {
  validateBinding(binding, binding.scriptId, null);
  const timeoutMs = Number.isFinite(timeoutSeconds)
    ? Math.max(100, Math.min(timeoutSeconds * 1000, 30_000)) : 15_000;
  const start = Date.now();
  const connection = await pool.getConnection();
  let expired = false;
  // Discard the connection on every path: no session state leaks to ORM callers.
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      connection.destroy();
      reject(new Error('CRON_SQL_TIMEOUT'));
    }, timeoutMs);
  });
  const bounded = <T>(query: Promise<T>) => Promise.race([query, deadline]);
  try {
    await bounded(connection.query(`SET SESSION max_execution_time = ${Math.trunc(timeoutMs)}`));
    await bounded(connection.query(`SET SESSION innodb_lock_wait_timeout = ${Math.max(1, Math.ceil(timeoutMs / 1000))}`));
    await bounded(connection.query('SET SESSION sql_select_limit = 1001'));
    await bounded(connection.query(binding.capability === 'read-only' ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION'));
    const [rows, fields] = await bounded(connection.execute({ sql: binding.content, timeout: timeoutMs }));
    if (expired) throw new Error('CRON_SQL_TIMEOUT');
    const result = {
      success: true, columns: fields?.map(field => field.name) ?? [],
      rowCount: Array.isArray(rows) ? Math.min(rows.length, 1000) : (rows as { affectedRows?: number }).affectedRows ?? 0,
      truncated: Array.isArray(rows) && rows.length > 1000,
      duration_ms: Date.now() - start,
    };
    // Persist the outcome in the same transaction as maintenance writes. An audit
    // failure must roll back the write, rather than report an unaudited success.
    if (binding.capability === 'read-only') await bounded(connection.commit());
    const [audit] = await bounded(connection.execute(
      `UPDATE cron_job_logs SET status = 'success', finished_at = NOW(), structured_result = ? WHERE id = ? AND status = 'running'`,
      [JSON.stringify({ ...result, script_id: binding.scriptId, sha256: binding.sha256,
        capability: binding.capability, authorized_by: binding.authorizedBy }), logId],
    ));
    if ((audit as { affectedRows: number }).affectedRows !== 1) throw new Error('CRON_AUDIT_UNAVAILABLE');
    await bounded(connection.commit());
    return result;
  } catch (error: any) {
    // Closing the socket alone may leave a server statement running. Explicitly
    // cancel and await the acknowledgement before releasing the Cron run guard.
    if (expired || error.code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
      try { await cancelServerConnection(connection); }
      catch { return { success: false, error: 'CRON_SQL_CANCELLATION_FAILED', duration_ms: Date.now() - start }; }
    }
    return { success: false, error: expired ? 'CRON_SQL_TIMEOUT' : error.code || error.message, duration_ms: Date.now() - start };
  } finally {
    clearTimeout(timer!);
    connection.destroy();
  }
}
