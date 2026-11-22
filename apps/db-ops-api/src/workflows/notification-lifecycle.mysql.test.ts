import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { notificationDatabaseService as source } from '../notification-database-service.js';
import { NotificationService } from '../notification-service.js';
import { splitSqlStatements } from '../migrations/runner.js';
import { MysqlWorkflowStore, WorkerRuntime } from './worker-runtime.js';
import { MysqlDeliveryStore } from './delivery-store.js';
import { JobRegistry } from './job-registry.js';
import { registerWorkflowHandlers } from './register-workflow-handlers.js';
import { createNotificationDispatchJob, NotificationDispatchReconciler, NotificationDispatchScheduler } from './notification-dispatch.js';
import { WorkerStartup } from '../lifecycle/worker-startup.js';
import { BoundedWorkflowRuntime } from './bounded-worker.js';
import { mountWorkflowTimer } from './notification-dispatch-timer-fixture.js';
import { smtpRecipient } from './delivery-test-recipients.js';

// Explicit configuration only. No developer .env, default DB or private credential reads.
const config = process.env.NOTIFICATION_LIFECYCLE_MYSQL;
describe.skipIf(!config)('MAX-593 isolated MySQL notification lifecycle (#396/#540/#629)', () => {
  const database = `max593_${process.pid}_${randomUUID().slice(0, 8)}`;
  let admin: Pool, pool: Pool, workflows: MysqlWorkflowStore, gate: MysqlDeliveryStore;
  let smtp: Awaited<ReturnType<typeof smtpRecipient>>;
  let registry: JobRegistry;
  const service = new NotificationService();
  const signal = new AbortController().signal;
  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '0123456789abcdef0123456789abcdef');
    const connection = JSON.parse(config!);
    if (connection.database) throw new Error('INJECT_SERVER_CONFIG_WITHOUT_DATABASE');
    admin = mysql.createPool({ ...connection, timezone: 'Z' });
    const [version] = await admin.query<any[]>('SELECT VERSION() AS version');
    console.info('MAX593_ENV', { host: connection.host, port: connection.port, schema: database, mysql: version[0].version, node: process.version });
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...connection, database, timezone: 'Z', connectionLimit: 4 });
    for (const sql of [
      'CREATE TABLE report_configs (id INT PRIMARY KEY, format VARCHAR(32))',
      'CREATE TABLE reports (id INT PRIMARY KEY, name VARCHAR(100), type VARCHAR(32), format VARCHAR(32), status VARCHAR(32))',
      'CREATE TABLE database_instances (id INT PRIMARY KEY, name VARCHAR(100), host VARCHAR(100))',
      `CREATE TABLE alerts (id BIGINT PRIMARY KEY, instance_id INT, server_id INT, network_device_id INT,
        source VARCHAR(32), status VARCHAR(32), alert_type VARCHAR(32), level VARCHAR(32), title VARCHAR(100),
        message TEXT, metric_name VARCHAR(32), metric_value DOUBLE, threshold_value DOUBLE, tags JSON, created_at DATETIME)`,
      `CREATE TABLE notification_channels (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), type VARCHAR(32), config JSON,
        enabled BOOLEAN, delivery_start_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
      'CREATE TABLE notification_records (id BIGINT AUTO_INCREMENT PRIMARY KEY, alert_id BIGINT, channel_id INT, status VARCHAR(32), sent_at DATETIME)',
    ]) await pool.query(sql);
    for (const file of ['032_workflow_outbox_jobs.sql', '036_notification_delivery_audit.sql', '041_report_notification_delivery.sql', '093_delivery_recovery.sql']) {
      for (const sql of splitSqlStatements(readFileSync(new URL(`../../sql/migrations/${file}`, import.meta.url), 'utf8'))) await pool.query(sql);
    }
  }, 20000);
  beforeEach(async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    smtp = await smtpRecipient();
    workflows = new MysqlWorkflowStore(() => pool as any);
    gate = new MysqlDeliveryStore(() => pool);
    registry = new JobRegistry();
    const scheduler = new NotificationDispatchScheduler(source, service, workflows);
    registerWorkflowHandlers(registry, {
      faultDiagnosisService: { diagnoseUnhealthyInstances: async () => {} },
      databaseLogService: { collectLogs: async () => ({ succeeded: 0, unavailable: 0, failed: 0 }) },
      monitorCollector: { collectCapacityNow: async () => {} }, baselineCalculator: { cleanupOldBaselines: async () => {} },
      alertEngine: { triggerEvaluation: async () => {} }, workflowStore: workflows,
      capacityConsistencyMonitor: { runOnce: async () => {} }, notificationScheduler: scheduler,
      enqueueNotificationDispatch: at => workflows.enqueue(createNotificationDispatchJob(at)),
      reportSchedule: {} as any, notificationDatabaseService: source, notificationService: service,
      reportDatabaseService: { getReportById: async reportId => {
        const [reports] = await pool.execute<any[]>('SELECT * FROM reports WHERE id=?', [reportId]);
        return reports[0] ?? null;
      } },
    });
    // The production registrar's default gate also resolves dbConnection's injected pool.
    await pool.execute("INSERT INTO notification_channels (id,name,type,config,enabled,delivery_start_at) VALUES (1,'isolated','email',?,1,'2020-01-01')", [JSON.stringify(smtp.channel.config)]);
    await pool.query("INSERT INTO reports VALUES (1,'isolated','health','html','completed')");
    await pool.query("INSERT INTO alerts (id,status,level,title,message,created_at) VALUES (1,'unread','warning','one','test','2025-01-01'),(2,'unread','warning','two','test','2025-01-01')");
  });
  afterEach(async () => {
    await smtp?.close();
    for (const table of ['notification_delivery_states', 'notification_delivery_attempts', 'report_notification_deliveries', 'notification_records', 'workflow_jobs', 'notification_channels', 'alerts', 'reports']) await pool.query(`DELETE FROM ${table}`);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE ${database}`); console.info('MAX593_CLEANUP', { schema: database, dropped: true }); await admin.end(); }
    vi.unstubAllEnvs();
  });
  function worker(type: string) {
    const lane = {
      claim: (id: string, seconds: number) => workflows.claim(id, seconds, { types: [type], exclude: false }),
      heartbeat: workflows.heartbeat.bind(workflows), complete: workflows.complete.bind(workflows), fail: workflows.fail.bind(workflows),
    };
    return new WorkerRuntime(lane, randomUUID());
  }
  async function run(type: string) {
    // MySQL DATETIME rounds subsecond enqueue times; make delivery jobs due explicitly.
    if (type !== 'notification.dispatch') await pool.execute("UPDATE workflow_jobs SET available_at='2020-01-01' WHERE job_type=? AND state IN ('queued','retry')", [type]);
    const runtime = worker(type);
    try { return await runtime.runOnce((job, context) => registry.execute(job, context)); }
    finally { await runtime.shutdown(); }
  }
  async function scan() { return new NotificationDispatchScheduler(source, service, workflows).enqueuePending(signal); }
  async function rows(sql: string, values: any[] = []) { return (await pool.execute<any[]>(sql, values))[0]; }

  it('five real scan read failures exhaust a job but leave a successor and observable errors; recovery sends each alert once', async () => {
    await workflows.enqueue(createNotificationDispatchJob(new Date(Date.now() - 20000)));
    await pool.query('RENAME TABLE alerts TO unavailable_alerts');
    try {
      for (let attempt = 1; attempt <= 5; attempt++) {
        expect(await run('notification.dispatch')).toBe(attempt === 5 ? 'dead_letter' : 'retry');
        await pool.query("UPDATE workflow_jobs SET available_at='2020-01-01' WHERE state='retry'");
      }
      const failed = await rows("SELECT attempts,last_error FROM workflow_jobs WHERE state='dead_letter'");
      expect(failed).toEqual([expect.objectContaining({ attempts: 5, last_error: 'NOTIFICATION_ALERTS_UNAVAILABLE' })]);
      expect((await rows("SELECT id FROM workflow_jobs WHERE state='queued' AND job_type='notification.dispatch'")).length).toBeGreaterThan(0);
    } finally { await pool.query('RENAME TABLE unavailable_alerts TO alerts'); }
    await pool.query("UPDATE workflow_jobs SET available_at='2020-01-01' WHERE state='queued'");
    expect(await run('notification.dispatch')).toBe('completed');
    expect(await run('notification.deliver')).toBe('completed');
    expect(await run('notification.deliver')).toBe('completed');
    await scan();
    expect(await run('notification.deliver')).toBe('idle');
    expect(smtp.messages).toHaveLength(2);
    expect(await rows('SELECT state FROM notification_delivery_states')).toEqual([{ state: 'sent' }, { state: 'sent' }]);
  });

  it('partial enqueue is idempotent across recovery and process restart; cancelled repair adds no tick', async () => {
    await pool.query("CREATE TRIGGER max593_partial BEFORE INSERT ON workflow_jobs FOR EACH ROW BEGIN IF NEW.job_type='notification.deliver' AND JSON_EXTRACT(NEW.payload,'$.alertId')=2 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='PARTIAL_QUEUE_FAILURE'; END IF; END");
    try { await expect(scan()).rejects.toThrow('PARTIAL_QUEUE_FAILURE'); }
    finally { await pool.query('DROP TRIGGER max593_partial'); }
    expect(await rows("SELECT id FROM workflow_jobs WHERE job_type='notification.deliver'")).toHaveLength(1);
    // A separate Node process repairs a durable scan slot and exits. The parent
    // then resumes it with fresh runtimes, exercising real process persistence.
    const child = `import mysql from 'mysql2/promise';
      import { MysqlWorkflowStore } from './src/workflows/worker-runtime.ts';
      import { NotificationDispatchReconciler } from './src/workflows/notification-dispatch.ts';
      const pool=mysql.createPool({...JSON.parse(process.env.NOTIFICATION_LIFECYCLE_MYSQL),database:process.env.MAX593_SCHEMA,timezone:'Z'});
      try { await new NotificationDispatchReconciler(new MysqlWorkflowStore(()=>pool)).ensure(new AbortController().signal, new Date(Date.now()-2000)); }
      finally { await pool.end(); }`;
    await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], {
      cwd: new URL('../../', import.meta.url), env: { ...process.env, MAX593_SCHEMA: database }, timeout: 15000,
    });
    expect(await run('notification.dispatch')).toBe('completed');
    expect(await run('notification.deliver')).toBe('completed');
    expect(await run('notification.deliver')).toBe('completed');
    expect(smtp.messages).toHaveLength(2);
    const repair = new NotificationDispatchReconciler(workflows);
    await repair.ensure(signal);
    const before = await rows("SELECT id FROM workflow_jobs WHERE job_type='notification.dispatch'");
    await repair.ensure(signal);
    const abort = new AbortController(); abort.abort();
    expect(() => repair.ensure(abort.signal, new Date(Date.now() + 30000))).toThrow();
    expect(await rows("SELECT id FROM workflow_jobs WHERE job_type='notification.dispatch'")).toEqual(before);
    await scan(); expect(await run('notification.deliver')).toBe('idle');
  });

  it('recovers after five queue storage failures without relying on a live job', async () => {
    await pool.query("CREATE TRIGGER max593_store BEFORE INSERT ON workflow_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='QUEUE_STORE_OFFLINE'");
    const repair = new NotificationDispatchReconciler(workflows);
    try { for (let i = 0; i < 5; i++) await expect(repair.ensure(signal)).rejects.toThrow('QUEUE_STORE_OFFLINE'); }
    finally { await pool.query('DROP TRIGGER max593_store'); }
    await repair.ensure(signal, new Date(Date.now() - 2000));
    expect(await run('notification.dispatch')).toBe('completed');
    expect(await run('notification.deliver')).toBe('completed');
    expect(await run('notification.deliver')).toBe('completed');
    expect(smtp.messages).toHaveLength(2);
  });

  it('repeated enabled edits preserve activation and pending alerts; only false→true refreshes it, including concurrent saves', async () => {
    for (let i = 0; i < 2; i++) expect(await source.updateChannel(1, { enabled: true, name: `edited-${i}`, config: { severity: 'info' } })).toEqual({ success: true });
    expect((await rows('SELECT delivery_start_at FROM notification_channels'))[0].delivery_start_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(await scan()).toBe(2);
    expect(await run('notification.deliver')).toBe('completed');
    expect(await run('notification.deliver')).toBe('completed');
    expect(smtp.messages).toHaveLength(2);
    await source.updateChannel(1, { enabled: false });
    const results = await Promise.all([source.updateChannel(1, { enabled: true }), source.updateChannel(1, { enabled: true, name: 'concurrent' })]);
    expect(results.every(r => r.success)).toBe(true);
    const at = (await source.getChannelById(1))!.delivery_start_at!;
    expect(at.getTime()).toBeGreaterThan(Date.parse('2025-01-01'));
    await source.updateChannel(1, { enabled: true });
    expect((await source.getChannelById(1))!.delivery_start_at).toEqual(at);
    expect(await scan()).toBe(0);
    await pool.query("INSERT INTO alerts (id,status,level,title,message,created_at) VALUES (3,'unread','warning','new','test',DATE_ADD(NOW(), INTERVAL 1 SECOND))");
    expect(await scan()).toBe(1);
  });

  it.each(['notification.deliver', 'report.notify'])('%s with a saved retryable snapshot completes as skipped when disabled and never sends after reenable', async type => {
    const id = randomUUID();
    await workflows.enqueue({ id, type, schemaVersion: 1, payload: { alertId: 1, reportId: 1, channelId: 1 }, idempotencyKey: id });
    await pool.execute("UPDATE workflow_jobs SET available_at='2020-01-01' WHERE id=?", [id]);
    const job = (await workflows.claim('freeze', 30))!;
    const context = { workerId: 'freeze', fencingToken: job.fencingToken, signal };
    const claim = (await gate.acquire(job, context, { channel: smtp.channel, message: { text: 'frozen' } }))!;
    await gate.finish(job, context, claim, 'retryable', 'BEFORE_SEND');
    await workflows.fail(job, 'freeze', new Error('BEFORE_SEND'), new Date(Date.now() - 1000));
    await pool.query('RENAME TABLE notification_channels TO unavailable_channels');
    try {
      expect(await run(type)).toBe('retry');
      expect((await gate.inspect(id))?.delivery.state).toBe('retryable');
    } finally { await pool.query('RENAME TABLE unavailable_channels TO notification_channels'); }
    await source.updateChannel(1, { enabled: false });
    expect(await run(type)).toBe('completed');
    const view = await gate.inspect(id);
    expect(view?.delivery.state).toBe('skipped');
    expect(view?.delivery.error_code).toBe('DELIVERY_CHANNEL_DISABLED');
    expect((await rows('SELECT state,attempts FROM workflow_jobs WHERE id=?', [id]))[0]).toEqual({ state: 'completed', attempts: 3 });
    await source.updateChannel(1, { enabled: true });
    // Simulate an accidental duplicate job for the same business identity.
    await workflows.enqueue({ id: randomUUID(), type, schemaVersion: 1, payload: job.payload, idempotencyKey: randomUUID() });
    expect(await run(type)).toBe('completed');
    expect(smtp.messages).toHaveLength(0);
  });

  it.each(['sent', 'unknown', 'sending', 'interrupted'])('disable preserves %s outcome, lease fencing and cancellation', async state => {
    const id = randomUUID();
    await workflows.enqueue({ id, type: 'report.notify', schemaVersion: 1, payload: { reportId: 1, channelId: 1 }, idempotencyKey: id });
    await pool.execute("UPDATE workflow_jobs SET available_at='2020-01-01' WHERE id=?", [id]);
    const job = (await workflows.claim('owner', 30))!;
    const context = { workerId: 'owner', fencingToken: job.fencingToken, signal };
    const claim = (await gate.acquire(job, context, { channel: smtp.channel, message: {} }))!;
    if (state === 'sent' || state === 'unknown') await gate.finish(job, context, claim, state);
    if (state === 'interrupted') {
      // A new execution owns the job after the old sender's process disappeared.
      await pool.execute('UPDATE workflow_jobs SET fencing_token=fencing_token+1 WHERE id=?', [id]);
      job.fencingToken++; context.fencingToken++;
    }
    const cancelled = new AbortController(); cancelled.abort();
    await expect(gate.skipDisabled(job, { ...context, signal: cancelled.signal })).rejects.toThrow();
    await expect(gate.skipDisabled(job, { ...context, workerId: 'stale' })).rejects.toThrow('DELIVERY_LEASE_LOST');
    await gate.skipDisabled(job, context);
    expect((await gate.inspect(id))?.delivery.state).toBe(state === 'interrupted' ? 'unknown' : state);
    expect(smtp.messages).toHaveLength(0);
  });

  it.each([false, true])('R1: actual server timer keeps independent MySQL lanes running under a repair row lock (cancel=%s)', async cancel => {
    let at = new Date(Date.now() + 60_000);
    const seed = createNotificationDispatchJob(at);
    await workflows.enqueue(seed);
    // Two distinct report business keys ensure two polling passes can send.
    await pool.query("INSERT INTO reports VALUES (2,'independent','health','html','completed')");
    for (const reportId of [1, 2]) await workflows.enqueue({
      id: randomUUID(), type: 'report.notify', schemaVersion: 1,
      payload: { reportId, channelId: 1 }, idempotencyKey: `r1-report-${reportId}`, availableAt: new Date(0),
    });
    const lock = await pool.getConnection();
    let locked = true;
    await lock.beginTransaction();
    await lock.execute('SELECT id FROM workflow_jobs WHERE id=? FOR UPDATE', [seed.id]);
    const enqueue = vi.spyOn(workflows, 'enqueue');
    const repair = new NotificationDispatchReconciler(workflows);
    const runtime = new BoundedWorkflowRuntime(workflows, randomUUID(), 3, async job => [job.type]);
    const startup = new WorkerStartup({ acquire: async () => true, renew: async () => true, release: async () => {} }, async () => { await runtime.shutdown(); });
    await startup.start(async () => {}, async () => {});
    const timer = mountWorkflowTimer(startup, { ensure: s => repair.ensure(s, at) }, runtime, registry);
    let nextStartup: WorkerStartup | undefined;
    let nextTimer: ReturnType<typeof mountWorkflowTimer> | undefined;
    const pending = (s: WorkerStartup) => (s as unknown as { pending: Set<unknown> }).pending.size;
    const sqlWaiting = async () => (await admin.execute<any[]>(
      "SELECT STATE FROM information_schema.PROCESSLIST WHERE DB=? AND INFO LIKE 'INSERT INTO workflow_jobs%'", [database],
    ))[0];
    try {
      for (let i = 0; i < 25; i++) { timer.tick(); await new Promise(resolve => setTimeout(resolve, 3)); }
      await vi.waitFor(async () => {
        expect(await sqlWaiting()).toHaveLength(1);
        expect(await rows("SELECT id FROM workflow_jobs WHERE job_type='report.notify' AND state='completed'")).toHaveLength(2);
      }, { timeout: 2000, interval: 10 });
      const observed = { simulatedTicks: 25, SQLWrites: enqueue.mock.calls.length, pending: pending(startup),
        completedReports: 2, receivedMessages: smtp.messages.length, pendingSql: await sqlWaiting() };
      console.info('R1_REAL_MYSQL_LOCK', observed);
      expect(observed).toMatchObject({ SQLWrites: 1, pending: 1, receivedMessages: 2 });
      expect(timer.ready()).toBe(true);
      if (cancel) {
        await startup.stop();
        for (let i = 0; i < 25; i++) timer.tick();
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(pending(startup)).toBe(1);
        let drained = false;
        const draining = startup.drain().then(() => { drained = true; });
        await new Promise(resolve => setImmediate(resolve));
        expect(drained).toBe(false); // No replacement while the original SQL is unknown.
        await lock.rollback(); locked = false;
        await draining;
        expect(pending(startup)).toBe(0);
        timer.close();
        const nextRuntime = new BoundedWorkflowRuntime(workflows, randomUUID(), 3, async job => [job.type]);
        nextStartup = new WorkerStartup({ acquire: async () => true, renew: async () => true, release: async () => {} }, async () => { await nextRuntime.shutdown(); });
        await nextStartup.start(async () => {}, async () => {});
        nextTimer = mountWorkflowTimer(nextStartup, { ensure: s => repair.ensure(s, at) }, nextRuntime, registry);
        nextTimer.tick();
        await vi.waitFor(() => { expect(enqueue).toHaveBeenCalledTimes(2); expect(pending(nextStartup!)).toBe(0); });
        expect(await rows("SELECT id FROM workflow_jobs WHERE job_type='notification.dispatch'")).toHaveLength(1);
      } else {
        await lock.rollback(); locked = false;
        await vi.waitFor(() => expect(pending(startup)).toBe(0));
      }
      at = new Date(at.getTime() + 20_000);
      (nextTimer ?? timer).tick();
      await vi.waitFor(async () => {
        expect(pending(nextStartup ?? startup)).toBe(0);
        expect(await rows("SELECT id FROM workflow_jobs WHERE job_type='notification.dispatch'")).toHaveLength(2);
      });
      expect(enqueue).toHaveBeenCalledTimes(cancel ? 3 : 2);
      expect(smtp.messages).toHaveLength(2);
    } finally {
      timer.close(); nextTimer?.close();
      if (locked) await lock.rollback();
      lock.release();
      await startup.drain(); await nextStartup?.drain();
    }
  });

});
