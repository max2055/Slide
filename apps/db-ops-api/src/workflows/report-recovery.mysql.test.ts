import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mysql, { type Pool } from 'mysql2/promise';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MysqlReportOccurrenceStore, ReportScheduler, createReportOccurrenceJob } from '../report-scheduler.js';
import type { ReportConfig } from '../report-config-database-service.js';
import { reportDatabaseService } from '../report-database-service.js';
import { dbConnection } from '../db-connection.js';
import { splitSqlStatements } from '../migrations/runner.js';
import { MysqlWorkflowStore, WorkerRuntime } from './worker-runtime.js';
import { JobRegistry } from './job-registry.js';
import { registerReportScheduleHandler } from './report-schedule-handler.js';
import { MysqlDeliveryStore } from './delivery-store.js';
import { reportRecoveryInventory } from './report-recovery-inventory.js';
import { smtpRecipient, deferred } from './delivery-test-recipients.js';
import { registerNotificationHandlers } from './notification-handlers.js';
import { NotificationService } from '../notification-service.js';

const port = Number(process.env.REPORT_TEST_MYSQL_PORT);
describe.skipIf(!port)('report recovery in isolated MySQL', () => {
  let pool: Pool;
  let secondPool: Pool;
  let admin: Pool;
  let store: MysqlReportOccurrenceStore;
  let workflows: MysqlWorkflowStore;
  const database = `report_recovery_${process.pid}`;
  const first = { configId: 1, occurrenceAt: new Date('2026-10-03T00:01:00Z') };
  const config = { id: 1, name: 'test', type: 'server_health', server_id: 1, instance_id: null,
    cron: '0 * * * * *', created_at: '2026-10-03T00:00:00Z', notification_channel_ids: [1, 1], format: 'html' } as ReportConfig;
  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '0123456789abcdef0123456789abcdef');
    const options = { host: '127.0.0.1', port, user: 'root', password: process.env.REPORT_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database });
    secondPool = mysql.createPool({ ...options, database });
    await pool.query('CREATE TABLE reports (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), type VARCHAR(32), format VARCHAR(32), instance_id INT, server_id INT, content TEXT, data JSON, generated_by INT, status VARCHAR(32), created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    await pool.query('CREATE TABLE report_configs (id INT PRIMARY KEY, format VARCHAR(32), type VARCHAR(32), instance_id INT, server_id INT)');
    await pool.query('CREATE TABLE notification_records (id INT AUTO_INCREMENT PRIMARY KEY, alert_id BIGINT, channel_id INT, status VARCHAR(32), sent_at DATETIME)');
    for (const file of ['032_workflow_outbox_jobs.sql', '034_report_schedule_occurrences.sql', '036_notification_delivery_audit.sql', '041_report_notification_delivery.sql', '093_delivery_recovery.sql', '108_report_occurrence_recovery.sql']) {
      for (const sql of splitSqlStatements(readFileSync(new URL(`../../sql/migrations/${file}`, import.meta.url), 'utf8'))) await pool.query(sql);
    }
  });
  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS fail_report_commit');
    for (const table of ['report_schedule_occurrences', 'outbox_events', 'workflow_jobs', 'reports', 'notification_delivery_states', 'notification_delivery_attempts', 'report_notification_deliveries', 'report_configs']) await pool.query(`DELETE FROM ${table}`);
    await pool.query("INSERT INTO report_configs (id, type, server_id, notification_channel_ids) VALUES (1, 'server_health', 1, '[1]')");
    store = new MysqlReportOccurrenceStore(() => pool);
    workflows = new MysqlWorkflowStore(() => pool as any);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await pool?.end(); await secondPool?.end(); if (admin) { await admin.query(`DROP DATABASE ${database}`); await admin.end(); } vi.unstubAllEnvs(); });
  const rows = async (sql: string) => (await pool.query<any[]>(sql))[0];
  async function ready() { await pool.query("UPDATE workflow_jobs SET available_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE state = 'queued'"); }
  async function enqueue() { await store.schedule(first, config); await ready(); }
  async function claim(owner = 'a') {
    const job = (await workflows.claim(owner, 30))!;
    expect(job).not.toBeNull();
    const context = { signal: new AbortController().signal, workerId: owner, fencingToken: job.fencingToken };
    return (await store.claim(first, job, context))!;
  }
  async function expire() { await pool.query("UPDATE workflow_jobs SET available_at = DATE_SUB(NOW(), INTERVAL 1 SECOND), lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE job_type = 'report.occurrence'"); }
  function registry() {
    const generation = vi.fn(async () => {
      const report = await reportDatabaseService.createReport({ name: 'test', type: 'server_health', status: 'pending' });
      await reportDatabaseService.updateReportStatus(report.id, 'completed', 'generated', { test: true });
      return { success: true, reportId: report.id };
    });
    const registry = new JobRegistry();
    registerReportScheduleHandler(registry, {
      reportConfigService: { getEnabledConfigs: async () => [] }, enqueueReportSchedule: async () => {},
      serverReportService: { generateAndPersist: generation }, reportService: { generateReport: async () => { throw new Error('UNEXPECTED_DATABASE_REPORT'); } },
      createOccurrenceStore: () => new MysqlReportOccurrenceStore(() => secondPool),
    });
    return { registry, generation };
  }
  async function run(h = registry()) {
    const worker = new WorkerRuntime(workflows, 'restarted');
    try { return await worker.runOnce((job, context) => h.registry.execute(job, context)); }
    finally { await worker.shutdown(); }
  }
  function crash(window: string) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./report-recovery-child.ts', import.meta.url)), window], {
      env: { ...process.env, REPORT_TEST_DATABASE: database }, encoding: 'utf8', timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(77);
  }
  async function finalIntent() {
    const occurrences = await rows("SELECT * FROM report_schedule_occurrences WHERE state = 'completed'");
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].report_id).toBe(occurrences[0].staged_report_id);
    expect(await rows('SELECT * FROM reports')).toHaveLength(1);
    expect(await rows('SELECT * FROM outbox_events WHERE published_at IS NOT NULL')).toHaveLength(1);
    expect(await rows("SELECT * FROM workflow_jobs WHERE job_type = 'report.notify'")).toHaveLength(1);
  }
  it('another due occurrence succeeds even when the first generation fails', async () => {
    const configs = [config, { ...config, id: 2 }];
    await new ReportScheduler({ getEnabledConfigs: async () => configs }, store).scheduleDue(first.occurrenceAt);
    expect(await rows("SELECT * FROM report_schedule_occurrences WHERE state = 'running'")).toHaveLength(0);
    await ready();
    const h = registry(); h.generation.mockRejectedValueOnce(new Error('generation failed'));
    expect(await run(h)).toBe('retry');
    expect(await run(h)).toBe('completed');
    expect(await rows("SELECT * FROM report_schedule_occurrences WHERE state = 'completed'")).toHaveLength(1);
    expect(await rows("SELECT * FROM report_schedule_occurrences WHERE state = 'running'")).toHaveLength(0);
  });
  it.each(['claimed', 'pending', 'saved', 'committed'])('restart recovers real child process exit after %s', async window => {
    await enqueue(); crash(window);
    const before = await rows('SELECT * FROM reports');
    await expire();
    const h = registry(); expect(await run(h)).toBe('completed');
    await finalIntent();
    expect(h.generation).toHaveBeenCalledTimes(window === 'saved' || window === 'committed' ? 0 : 1);
    if (before.length) expect((await rows('SELECT * FROM reports'))[0].id).toBe(before[0].id);
  });
  it.each(['outbox_events', 'workflow_jobs', 'report_schedule_occurrences'])('rolls back final commit if writing %s fails, then reuses reportId', async table => {
    await enqueue(); const owned = await claim();
    const report = await store.createReport(owned, { name: 'saved', type: 'server_health', status: 'completed' });
    const trigger = table === 'report_schedule_occurrences'
      ? "BEFORE UPDATE ON report_schedule_occurrences FOR EACH ROW BEGIN IF NEW.state = 'completed' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INJECTED_COMMIT_FAILURE'; END IF; END"
      : `BEFORE INSERT ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INJECTED_COMMIT_FAILURE'`;
    await pool.query(`CREATE TRIGGER fail_report_commit ${trigger}`);
    await expect(store.complete(owned, report.id)).rejects.toThrow('INJECTED_COMMIT_FAILURE');
    expect((await rows('SELECT * FROM report_schedule_occurrences'))[0]).toMatchObject({ state: 'running', report_id: null, staged_report_id: report.id });
    expect(await rows('SELECT * FROM outbox_events')).toHaveLength(0);
    expect(await rows("SELECT * FROM workflow_jobs WHERE job_type = 'report.notify'")).toHaveLength(0);
    await pool.query('DROP TRIGGER fail_report_commit'); await expire();
    const h = registry(); expect(await run(h)).toBe('completed'); expect(h.generation).not.toHaveBeenCalled();
    await finalIntent();
  });
  it('expired and superseded owners cannot create, update, fail or finalize reports', async () => {
    await enqueue(); const old = await claim();
    const report = await store.createReport(old, { name: 'pending', type: 'server_health', status: 'pending' });
    await expire();
    await expect(store.updateReport(old, report.id, 'completed', 'late')).rejects.toThrow('REPORT_OCCURRENCE_LEASE_LOST');
    const current = await claim('b');
    expect(current.context.fencingToken).toBeGreaterThan(old.context.fencingToken);
    await expect(store.claim(first, old.job, old.context)).rejects.toThrow('REPORT_OCCURRENCE_LEASE_LOST');
    await expect(store.createReport(old, { name: 'late', type: 'server_health' })).rejects.toThrow('REPORT_OCCURRENCE_LEASE_LOST');
    await expect(store.fail(old, new Error('late'))).rejects.toThrow('REPORT_OCCURRENCE_LEASE_LOST');
    await expect(store.complete(old, report.id)).rejects.toThrow('REPORT_OCCURRENCE_LEASE_LOST');
    await store.updateReport(current, report.id, 'completed', 'current'); await store.complete(current, report.id);
    await finalIntent();
  });
  it('concurrent scans preserve one job and advance past failed occurrences', async () => {
    await Promise.all([store.schedule(first, config), new MysqlReportOccurrenceStore(() => secondPool).schedule(first, config)]);
    expect(await rows("SELECT * FROM workflow_jobs WHERE job_type = 'report.occurrence'")).toHaveLength(1);
    await ready(); const owned = await claim(); await store.fail(owned, new Error('failed'));
    await new ReportScheduler({ getEnabledConfigs: async () => [config] }, store).scheduleDue(new Date('2026-10-03T00:02:00Z'));
    expect(await rows('SELECT * FROM report_schedule_occurrences')).toHaveLength(2);
  });
  it('does not automatically bind or replay an unconfirmed legacy running row', async () => {
    await pool.execute("INSERT INTO report_schedule_occurrences (config_id, occurrence_at, state) VALUES (?, ?, 'running')", [first.configId, first.occurrenceAt]);
    expect(await store.schedule(first, config)).toBe(false);
    expect(await rows('SELECT * FROM workflow_jobs')).toHaveLength(0);
  });
  it('generation does not retain a database transaction while waiting for external work', async () => {
    await enqueue(); const started = deferred<void>(); const finish = deferred<void>(); const h = registry();
    const generate = h.generation.getMockImplementation()!;
    h.generation.mockImplementation(async () => { started.resolve(); await finish.promise; return generate(); });
    const running = run(h);
    try {
      await started.promise;
      const connection = await secondPool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query("SELECT * FROM workflow_jobs WHERE job_type = 'report.occurrence' FOR UPDATE NOWAIT");
        await connection.query('SELECT * FROM report_schedule_occurrences FOR UPDATE NOWAIT');
        await connection.rollback();
      } finally { connection.release(); }
    } finally { finish.resolve(); await running; }
    await finalIntent();
  });
  it('lease expiring inside a final transaction rolls back every side effect', async () => {
    await enqueue(); const owned = await claim();
    const report = await store.createReport(owned, { name: 'saved', type: 'server_health', status: 'completed' });
    await pool.execute('UPDATE workflow_jobs SET lease_expires_at = DATE_ADD(NOW(), INTERVAL 1 SECOND) WHERE id = ?', [owned.job.id]);
    await pool.query('CREATE TRIGGER fail_report_commit BEFORE INSERT ON outbox_events FOR EACH ROW DO SLEEP(2)');
    await expect(store.complete(owned, report.id)).rejects.toThrow('REPORT_OCCURRENCE_LEASE_LOST');
    expect(await rows('SELECT * FROM outbox_events')).toHaveLength(0);
    expect((await rows('SELECT * FROM report_schedule_occurrences'))[0].state).toBe('running');
  });
  it('dry-run lists legacy uncertainty and existing report/delivery links without changing rows', async () => {
    await pool.query("INSERT INTO reports (id,name,type,server_id,status) VALUES (42,'legacy','server_health',1,'completed')");
    await pool.execute("INSERT INTO report_schedule_occurrences (config_id,occurrence_at,state,report_id) VALUES (1,?,'running',42)", [first.occurrenceAt]);
    await pool.query("INSERT INTO report_notification_deliveries (workflow_job_id, report_id, channel_id, attempt_number, status) VALUES ('legacy',42,1,1,'started')");
    const before = await rows('SELECT * FROM report_schedule_occurrences');
    const inventory = await reportRecoveryInventory(pool);
    expect(inventory.entries).toHaveLength(1);
    expect(inventory.entries[0]).toMatchObject({ reportId: 42, reportStatus: 'completed', resolution: 'unknown_requires_receiver_reconciliation' });
    expect(inventory.entries[0].deliveries).toHaveLength(1);
    expect(await rows('SELECT * FROM report_schedule_occurrences')).toEqual(before);
    expect(await rows('SELECT * FROM workflow_jobs')).toHaveLength(0);
  });
  it('actual SMTP acceptance followed by lost response remains unknown after occurrence replay', async () => {
    await enqueue(); const owned = await claim();
    const report = await store.createReport(owned, { name: 'saved', type: 'server_health', status: 'completed' });
    await store.complete(owned, report.id);
    await workflows.complete(owned.job.id, owned.context.workerId, owned.context.fencingToken);
    await ready();
    const notify = (await workflows.claim('sender', 30))!;
    const context = { workerId: 'sender', fencingToken: notify.fencingToken, signal: new AbortController().signal };
    const gate = new MysqlDeliveryStore(() => pool);
    const smtp = await smtpRecipient();
    const actualSender = new NotificationService();
    const send = vi.fn(async (...args: Parameters<NotificationService['send']>) => {
      const result = await actualSender.send(...args);
      expect(result.success).toBe(true);
      throw new Error('INJECTED_RESPONSE_LOSS');
    });
    const notifications = new JobRegistry();
    registerNotificationHandlers(notifications, { getAlertById: async () => null, getChannelById: async () => smtp.channel },
      { send, buildMessage: actualSender.buildMessage.bind(actualSender) }, { getReportById: async () => report }, gate);
    try {
      await expect(notifications.execute(notify, context)).rejects.toThrow('INJECTED_RESPONSE_LOSS');
      expect(smtp.messages).toHaveLength(1);
      await workflows.fail(notify, context.workerId, new Error('response lost'), new Date(Date.now() - 1000));
      await store.schedule(first, config);
      const retry = (await workflows.claim('sender2', 30))!;
      await expect(notifications.execute(retry, { ...context, workerId: 'sender2', fencingToken: retry.fencingToken })).rejects.toThrow('DELIVERY_RECONCILIATION_REQUIRED');
      expect((await gate.inspect(notify.id))?.delivery.state).toBe('unknown');
      expect(send).toHaveBeenCalledOnce(); expect(smtp.messages).toHaveLength(1);
      await finalIntent();
      expect(createReportOccurrenceJob(first).id).toBe(owned.job.id);
    } finally { await smtp.close(); }
  });
});
