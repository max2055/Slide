import mysql, { type RowDataPacket } from 'mysql2/promise';
import { expect, it } from 'vitest';
import { alertDatabaseService } from './alert-database-service.js';
import { CapacityConsistencyMonitor, createCapacityConsistencyJob } from './capacity-consistency-monitor.js';
import { ConsistencyChecker } from './consistency-checker.js';
import { dbConnection } from './db-connection.js';
import { MigrationRunner } from './migrations/runner.js';
import { createOwnedDatabase, generateRunNonce } from './testing/owned-fixture.js';
import { MysqlWorkflowStore, WorkerRuntime } from './workflows/worker-runtime.js';

// Explicit opt-in only. Configuration is injected; default CI never reads private credentials.
it.skipIf(process.env.MAX512_MYSQL !== '1')('OCR-0738: real recovery failure rolls back, records retry, and recovers idempotently', async () => {
  if (!process.env.MAX512_MYSQL_CONFIG || !process.env.MAX512_EVIDENCE_DIR) throw new Error('MAX512_MYSQL_CONFIG_AND_EVIDENCE_DIR_REQUIRED');
  const config = JSON.parse(process.env.MAX512_MYSQL_CONFIG);
  const root = mysql.createPool({ ...config, database: undefined, connectionLimit: 2 });
  const owned = await createOwnedDatabase(root, { nonce: generateRunNonce(), purpose: 'capacityrecovery', handleDir: process.env.MAX512_EVIDENCE_DIR });
  try {
    expect(await dbConnection.initialize({ ...config, database: owned.database })).toBe(true);
    const pool = dbConnection.getPool()!;
    await new MigrationRunner(pool).run();
    await pool.execute("INSERT INTO database_instances(id,name,host,port,username,password_encrypted,data_size_gb) VALUES(1,'capacity-fixture','127.0.0.1',1,'unused','unused',10)");
    await pool.execute('INSERT INTO capacity_history(instance_id,total_size_gb) VALUES(1,10)');
    for (const id of [41, 42, 43]) {
      await pool.execute("INSERT INTO alerts(id,alert_type,level,title,message,source,metric_name) VALUES(?,'capacity','warning','fixture','fixture','capacity-consistency-monitor','capacity_sum_match')", [id]);
    }
    const checker = new ConsistencyChecker();
    const monitorPool = pool as unknown as NonNullable<ReturnType<ConstructorParameters<typeof CapacityConsistencyMonitor>[0]>>;
    const monitor = new CapacityConsistencyMonitor(() => monitorPool, checker, alertDatabaseService);
    const store = new MysqlWorkflowStore(() => monitorPool);
    const runtime = new WorkerRuntime(store, 'max512-owned-worker');
    const job = createCapacityConsistencyJob(new Date(Date.now() - 1000));
    await store.enqueue(job);
    await pool.query("CREATE TRIGGER max512_reject_recovery BEFORE UPDATE ON alerts FOR EACH ROW BEGIN IF OLD.id=42 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='LOCAL_FIXTURE_UPDATE_FAILED'; END IF; END");
    expect((await checker._checkCapacitySumMatch()).status).toBe('pass');
    expect(await runtime.runOnce((_job, { signal }) => monitor.runOnce(signal).then(() => {}))).toBe('retry');
    const [failed] = await pool.execute<RowDataPacket[]>('SELECT state,last_error,attempts FROM workflow_jobs WHERE id=?', [job.id]);
    expect(failed[0]).toMatchObject({ state: 'retry', attempts: 1 });
    expect(failed[0].last_error).toContain('CAPACITY_CONSISTENCY_ALERT_RESOLVE_FAILED:42:LOCAL_FIXTURE_UPDATE_FAILED');
    const [alerts] = await pool.execute<RowDataPacket[]>('SELECT id,status FROM alerts ORDER BY id');
    expect(alerts.map(row => [Number(row.id), row.status])).toEqual([[41, 'resolved'], [42, 'unread'], [43, 'resolved']]);
    expect((await checker._checkCapacitySumMatch()).status).toBe('pass');
    await pool.query('DROP TRIGGER max512_reject_recovery');
    // Expedite this owned retry; production uses the runtime backoff.
    await pool.execute('UPDATE workflow_jobs SET available_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE id=?', [job.id]);
    expect(await runtime.runOnce((_job, { signal }) => monitor.runOnce(signal).then(() => {}))).toBe('completed');
    const [completed] = await pool.execute<RowDataPacket[]>('SELECT state,attempts FROM workflow_jobs WHERE id=?', [job.id]);
    expect(completed[0]).toMatchObject({ state: 'completed', attempts: 2 });
    const [before] = await pool.execute<RowDataPacket[]>('SELECT id,status,resolved_at FROM alerts ORDER BY id');
    expect(before.every(row => row.status === 'resolved')).toBe(true);
    expect(await alertDatabaseService.resolveAlert(42)).toEqual({ success: true });
    expect((await monitor.runOnce()).status).toBe('pass');
    const [after] = await pool.execute<RowDataPacket[]>('SELECT id,status,resolved_at FROM alerts ORDER BY id');
    expect(after).toEqual(before);

    await pool.execute("INSERT INTO alerts(id,alert_type,level,title,message,source,metric_name) VALUES(44,'capacity','warning','fixture','fixture','capacity-consistency-monitor','capacity_sum_match'),(45,'capacity','warning','fixture','fixture','capacity-consistency-monitor','capacity_sum_match')");
    const controller = new AbortController();
    const reason = new Error('MAX512_CANCELLED');
    const cancelled = new CapacityConsistencyMonitor(() => monitorPool, checker, {
      createAlert: data => alertDatabaseService.createAlert(data as Parameters<typeof alertDatabaseService.createAlert>[0]),
      resolveAlert: async id => {
        const result = await alertDatabaseService.resolveAlert(id);
        controller.abort(reason);
        return result;
      },
    });
    await expect(cancelled.runOnce(controller.signal)).rejects.toBe(reason);
    const [remaining] = await pool.execute<RowDataPacket[]>("SELECT COUNT(*) AS count FROM alerts WHERE status='unread'");
    expect(Number(remaining[0].count)).toBe(1);
    expect((await monitor.runOnce()).status).toBe('pass');
    console.log('MAX512_ACCEPTANCE: partial rollback + durable retry + unchanged pass + successful retry + repeated recovery + cancellation PASS');
  } finally {
    await dbConnection.close();
    try { await owned.drop(); } finally { await root.end(); }
  }
}, 60_000);
