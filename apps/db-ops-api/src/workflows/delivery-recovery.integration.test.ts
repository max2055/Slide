import { readFileSync } from 'node:fs';
import * as https from 'node:https';
import * as http from 'node:http';
import * as outbound from '../security/outbound-policy.js';
import { randomUUID } from 'node:crypto';
import mysql, { type Pool } from 'mysql2/promise';
import Fastify from 'fastify';
import nodemailer from 'nodemailer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MysqlDeliveryStore } from './delivery-store.js';
import { MysqlWorkflowStore, WorkerRuntime, type ClaimedJob, type JobExecutionContext } from './worker-runtime.js';
import { JobRegistry } from './job-registry.js';
import { registerNotificationHandlers } from './notification-handlers.js';
import { registerDeliveryRoutes } from './delivery-routes.js';
import { requirePermission } from '../auth/require-permission.js';
import { NotificationService } from '../notification-service.js';
import { splitSqlStatements } from '../migrations/runner.js';
import { smtpRecipient, deferred } from './delivery-test-recipients.js';

vi.mock('node:https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: vi.fn(actual.request) };
});

// Explicit opt-in dedicated localhost MySQL, never application .env or real recipients.
const port = Number(process.env.DELIVERY_TEST_MYSQL_PORT);
describe.skipIf(!port)('delivery recovery with isolated MySQL and SMTP', () => {
  let admin: Pool;
  let pool: Pool;
  let secondPool: Pool;
  let gate: MysqlDeliveryStore;
  let workflows: MysqlWorkflowStore;
  const database = `delivery_recovery_${process.pid}`;
  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '0123456789abcdef0123456789abcdef');
    admin = mysql.createPool({ host: '127.0.0.1', timezone: 'Z', port, user: 'root', password: '' });
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', timezone: 'Z', port, user: 'root', password: '', database, connectionLimit: 8 });
    secondPool = mysql.createPool({ host: '127.0.0.1', timezone: 'Z', port, user: 'root', password: '', database, connectionLimit: 8 });
    await pool.query('CREATE TABLE report_configs (id INT PRIMARY KEY, format VARCHAR(32))');
    await pool.query('CREATE TABLE notification_records (id INT AUTO_INCREMENT PRIMARY KEY, alert_id BIGINT, channel_id INT, status VARCHAR(32), sent_at DATETIME)');
    for (const file of ['032_workflow_outbox_jobs.sql', '036_notification_delivery_audit.sql', '041_report_notification_delivery.sql', '093_delivery_recovery.sql', '093_delivery_recovery.sql']) {
      for (const sql of splitSqlStatements(readFileSync(new URL(`../../sql/migrations/${file}`, import.meta.url), 'utf8'))) await pool.query(sql);
    }
  });
  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS fail_delivery_audit');
    for (const table of ['notification_delivery_replays', 'notification_delivery_attempts', 'report_notification_deliveries', 'notification_delivery_states', 'notification_records', 'workflow_jobs']) await pool.query(`DELETE FROM ${table}`);
    gate = new MysqlDeliveryStore(() => pool);
    workflows = new MysqlWorkflowStore(() => pool as any);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await pool?.end(); await secondPool?.end(); if (admin) { await admin.query(`DROP DATABASE ${database}`); await admin.end(); } vi.unstubAllEnvs(); });
  async function enqueue(type = 'report.notify', channelId = 1) {
    const id = randomUUID();
    await workflows.enqueue({ id, type, schemaVersion: 1, payload: { reportId: 1, alertId: 1, channelId }, idempotencyKey: id, availableAt: new Date(Date.now() - 10000) });
    return id;
  }
  async function claim(owner = 'a'): Promise<[ClaimedJob, JobExecutionContext]> {
    const job = (await workflows.claim(owner, 30))!;
    expect(job).not.toBeNull();
    return [job, { workerId: owner, fencingToken: job.fencingToken, signal: new AbortController().signal }];
  }
  function registry(channel: any, store = gate) {
    const registry = new JobRegistry();
    registerNotificationHandlers(registry, {
      getAlertById: async () => ({ id: 1, level: 'warning', title: 'isolated', message: 'isolated', created_at: new Date() }) as any,
      getChannelById: async () => channel,
    }, new NotificationService(), {
      getReportById: async () => ({ id: 1, name: 'isolated', type: 'health', format: 'html', status: 'completed' }) as any,
    }, store);
    return registry;
  }
  const frozen = { channel: { id: 1, type: 'webhook', config: { webhook_url: 'https://receiver.example.test' }, enabled: true }, message: { text: 'frozen' } } as any;

  it('two independent connections grant only one send right, and cancelled acquisition sends nothing', async () => {
    const id = await enqueue();
    const [job, context] = await claim();
    const other = new MysqlDeliveryStore(() => secondPool);
    const results = await Promise.allSettled([gate.acquire(job, context, frozen), other.acquire(job, context, frozen)]);
    expect(results.filter(r => r.status === 'fulfilled' && r.value)).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(gate.acquire(job, { ...context, signal: cancelled.signal }, frozen)).rejects.toThrow();
    const view = await gate.inspect(id);
    expect(view?.attempts).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain('receiver.example.test');
  });

  it.each(['notification.deliver', 'report.notify'])('%s never resends after accepted SMTP then audit failure, including restart and occurrence replay', async type => {
    const smtp = await smtpRecipient();
    try {
      const id = await enqueue(type);
      const [job, context] = await claim();
      await pool.query(type === 'notification.deliver'
        ? "CREATE TRIGGER fail_delivery_audit BEFORE INSERT ON notification_records FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INJECTED_AUDIT_FAILURE'"
        : "CREATE TRIGGER fail_delivery_audit BEFORE UPDATE ON report_notification_deliveries FOR EACH ROW BEGIN IF NEW.status = 'sent' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INJECTED_AUDIT_FAILURE'; END IF; END");
      await expect(registry(smtp.channel).execute(job, context)).rejects.toThrow('INJECTED_AUDIT_FAILURE');
      expect(smtp.messages).toHaveLength(1);
      expect((await gate.inspect(id))?.delivery.state).toBe('unknown');
      await pool.execute("UPDATE workflow_jobs SET state = 'dead_letter', lease_expires_at = NULL WHERE id = ?", [id]);
      expect(await workflows.replayDeadLetter(id)).toBe(false);
      // Independent job for the same business occurrence cannot bypass the gate either.
      const duplicate = await enqueue(type);
      const [retry, retryContext] = await claim('b');
      await expect(registry(smtp.channel, new MysqlDeliveryStore(() => secondPool)).execute(retry, retryContext)).rejects.toThrow('DELIVERY_RECONCILIATION_REQUIRED');
      expect(smtp.messages).toHaveLength(1);
      expect((await gate.inspect(duplicate))?.delivery.state).toBe('unknown');
    } finally { await smtp.close(); }
  });

  it.each(['notification.deliver', 'report.notify'])('two real workers: %s lease takeover during accepted SMTP cannot resend or let old worker finish', async type => {
    const acknowledgement = deferred<void>();
    const smtp = await smtpRecipient(acknowledgement.promise);
    const id = await enqueue(type);
    const a = new WorkerRuntime(workflows, 'a', 30);
    const b = new WorkerRuntime(new MysqlWorkflowStore(() => secondPool as any), 'b', 30);
    const production = registry(smtp.channel);
    const first = a.runOnce((job, context) => production.execute(job, context));
    try {
      await Promise.race([smtp.received.promise, first.then(result => { throw new Error(`Worker ended before receipt: ${result}`); })]);
      await pool.execute('UPDATE workflow_jobs SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?', [id]);
      expect(await b.runOnce((job, context) => production.execute(job, context))).toBe('retry');
      acknowledgement.resolve();
      await first;
      expect(smtp.messages).toHaveLength(1);
      const view = await gate.inspect(id);
      expect(view?.delivery.state).toBe('unknown');
      expect(view?.attempts.map(a => a.status)).toEqual(['unknown']);
    } finally { acknowledgement.resolve(); await first; await a.shutdown(); await b.shutdown(); await smtp.close(); }
  });

  it('SMTP accepted but response timeout is unknown and not retried', async () => {
    const acknowledgement = deferred<void>();
    const smtp = await smtpRecipient(acknowledgement.promise);
    const original = nodemailer.createTransport.bind(nodemailer);
    vi.spyOn(nodemailer, 'createTransport').mockImplementation(((options: any) => original({ ...options, socketTimeout: 100 })) as any);
    try {
      const id = await enqueue();
      const [job, context] = await claim();
      await expect(registry(smtp.channel).execute(job, context)).rejects.toThrow('DELIVERY_TRANSPORT_UNCERTAIN');
      await expect(registry(smtp.channel).execute(job, context)).rejects.toThrow('DELIVERY_RECONCILIATION_REQUIRED');
      expect(smtp.messages).toHaveLength(1);
      expect((await gate.inspect(id))?.delivery.state).toBe('unknown');
    } finally { acknowledgement.resolve(); await smtp.close(); }
  });

  it('sending committed then process crash is unknown, and stale completion cannot overwrite recovery', async () => {
    const id = await enqueue();
    const [job, context] = await claim();
    const send = (await gate.acquire(job, context, frozen))!;
    await pool.execute('UPDATE workflow_jobs SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?', [id]);
    const view = (await gate.inspect(id))!;
    expect(view.delivery.state).toBe('unknown');
    await gate.recover(id, 7, { version: view.delivery.version, decision: 'sent', reason: 'confirmed', reconciliation: 'isolated receiver receipt' });
    await expect(gate.finish(job, context, send, 'sent')).rejects.toThrow('DELIVERY_LEASE_LOST');
    expect((await gate.inspect(id))?.decisions).toHaveLength(1);
  });

  it('pre-send failure is safely retryable and invokes no SMTP request', async () => {
    const smtp = await smtpRecipient();
    try {
      await enqueue();
      const [job, context] = await claim();
      await expect(registry({ ...smtp.channel, config: {} }).execute(job, context)).rejects.toThrow('EMAIL_CONFIGURATION_INVALID');
      expect(smtp.messages).toHaveLength(0);
      expect((await gate.inspect(job.id))?.delivery.state).toBe('retryable');
      expect((await gate.inspect(job.id))?.attempts[0].error_code).toBe('DELIVERY_PREPARATION_FAILED');
      await pool.execute("UPDATE workflow_jobs SET state = 'retry', lease_expires_at = NULL WHERE id = ?", [job.id]);
      const [retry, retryContext] = await claim('b');
      await registry(smtp.channel).execute(retry, retryContext);
      expect(smtp.messages).toHaveLength(1);
    } finally { await smtp.close(); }
  });

  it('recovery API enforces admin, reason, reconciliation, CAS and explicit duplicate risk; replay does not reset audit identity', async () => {
    const id = await enqueue();
    const [job, context] = await claim();
    const send = (await gate.acquire(job, context, frozen))!;
    await gate.finish(job, context, send, 'unknown');
    await pool.execute("UPDATE workflow_jobs SET state = 'dead_letter', lease_expires_at = NULL WHERE id = ?", [id]);
    const app = Fastify();
    registerDeliveryRoutes(app, {
      verifyToken: async request => { if (request.headers['x-role'] !== 'anonymous') (request as any).user = { userId: 7, permissions: request.headers['x-role'] === 'admin' ? ['admin:*', 'notification:view'] : ['notification:view'] }; },
      requirePermission,
    }, gate);
    try {
      const url = `/api/notification/jobs/${id}/recover`;
      const view = (await app.inject({ method: 'GET', url: `/api/notification/jobs/${id}/delivery` })).json();
      const payload = { version: view.delivery.version, decision: 'retry', reason: 'reviewed', reconciliation: 'receiver could not confirm', acceptDuplicateRisk: true };
      expect((await app.inject({ method: 'POST', url, payload, headers: { 'x-role': 'anonymous' } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, payload: { ...payload, reason: '' }, headers: { 'x-role': 'admin' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url, payload: { ...payload, acceptDuplicateRisk: false }, headers: { 'x-role': 'admin' } })).statusCode).toBe(400);
      const replies = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url, payload, headers: { 'x-role': 'admin' } })));
      expect(replies.map(r => r.statusCode).sort()).toEqual([200, 409]);
      const [retry, retryContext] = await claim('b');
      const next = await gate.acquire(retry, retryContext, { ...frozen, message: { text: 'changed' } });
      expect(next?.request.message).toEqual({ text: 'frozen' });
      expect(next?.attemptId).not.toBe(send.attemptId);
      expect((await gate.inspect(id))?.attempts.map(a => a.attempt_number)).toEqual([2, 1]);
      expect((await gate.inspect(id))?.decisions).toHaveLength(1);
    } finally { await app.close(); }
  });

  it('legacy successful and uncertain sends remain protected after migration', async () => {
    const id = await enqueue();
    await pool.execute("INSERT INTO report_notification_deliveries (workflow_job_id,report_id,channel_id,attempt_number,status) VALUES (?,1,1,1,'failed')", [id]);
    const [job, context] = await claim();
    await expect(gate.acquire(job, context, frozen)).rejects.toThrow('DELIVERY_RECONCILIATION_REQUIRED');
    expect((await gate.inspect(id))?.delivery.state).toBe('unknown');
  });
  it.each([true, false])('isolated HTTP receiver: contracted=%s retries freeze payload/key, ordinary webhooks remain unknown', async contracted => {
    const received: Array<{ key: string | undefined; body: string }> = [];
    const effects = new Set<string>();
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const key = request.headers['idempotency-key'] as string | undefined;
        received.push({ key, body });
        effects.add(key ?? String(received.length));
        if (received.length === 1) response.destroy(); // applied, response lost
        else { response.writeHead(200); response.end('{}'); }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const localPort = (server.address() as { port: number }).port;
    // Only test routing is replaced: production request creation, body, headers and response handling remain real.
    vi.spyOn(outbound, 'resolveOutboundTarget').mockImplementation(async value => ({ url: new URL(value), addresses: ['127.0.0.1'] }));
    vi.mocked(https.request).mockImplementation(((options: any, callback: any) => http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: localPort }, callback)) as any);
    const channel = { ...frozen.channel, config: { ...frozen.channel.config,
      ...(contracted ? { idempotency_contract: 'receiver-deduplicates', idempotency_retention_seconds: 60 } : {}) } };
    try {
      const id = await enqueue();
      const [job, context] = await claim();
      await expect(registry(channel).execute(job, context)).rejects.toThrow('DELIVERY_TRANSPORT_UNCERTAIN');
      await pool.execute("UPDATE workflow_jobs SET state = 'retry', lease_expires_at = NULL WHERE id = ?", [id]);
      const [retry, retryContext] = await claim('b');
      const action = registry({ ...channel, config: { webhook_url: 'https://changed.example.test' } }).execute(retry, retryContext);
      if (contracted) {
        await action;
        expect(received).toHaveLength(2);
        expect(received[1]).toEqual(received[0]);
        expect(received[0].key).toBe('report:1:1');
        expect((await gate.inspect(id))?.delivery.state).toBe('sent');
      } else {
        await expect(action).rejects.toThrow('DELIVERY_RECONCILIATION_REQUIRED');
        expect(received).toHaveLength(1);
        expect(received[0].key).toBeUndefined();
      }
      expect(effects.size).toBe(1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('contract retention expiry forbids automatic retry', async () => {
    const id = await enqueue();
    const [job, context] = await claim();
    const request = { ...frozen, channel: { ...frozen.channel, config: { ...frozen.channel.config,
      idempotency_contract: 'receiver-deduplicates', idempotency_retention_seconds: 1 } } };
    const sending = (await gate.acquire(job, context, request))!;
    await gate.finish(job, context, sending, 'unknown');
    await pool.execute('UPDATE notification_delivery_states SET idempotent_until = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE business_key = ?', [sending.key]);
    await expect(gate.acquire(job, context, request)).rejects.toThrow('DELIVERY_RECONCILIATION_REQUIRED');
    expect((await gate.inspect(id))?.attempts).toHaveLength(1);
  });

  it('cancellation immediately after acquiring the gate never opens SMTP', async () => {
    const smtp = await smtpRecipient();
    try {
      const id = await enqueue();
      const [job, context] = await claim();
      const cancelled = new AbortController();
      const acquire = gate.acquire.bind(gate);
      vi.spyOn(gate, 'acquire').mockImplementation(async (...args) => {
        const result = await acquire(...args);
        cancelled.abort(new Error('LEASE_CANCELLED'));
        return result;
      });
      await expect(registry(smtp.channel).execute(job, { ...context, signal: cancelled.signal })).rejects.toThrow('LEASE_CANCELLED');
      expect(smtp.messages).toHaveLength(0);
      await pool.execute('UPDATE workflow_jobs SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?', [id]);
      expect((await gate.inspect(id))?.delivery.state).toBe('unknown');
    } finally { await smtp.close(); }
  });

  it.each(['sent', 'abandon'] as const)('recovery %s rejects active lease and settles both delivery and workflow after lease ends', async decision => {
    const id = await enqueue();
    const [job, context] = await claim();
    const sending = (await gate.acquire(job, context, frozen))!;
    await gate.finish(job, context, sending, 'unknown');
    const view = (await gate.inspect(id))!;
    const input = { version: view.delivery.version, decision, reason: 'operator reviewed', reconciliation: 'receiver log checked' };
    await expect(gate.recover(id, 7, input)).rejects.toThrow('DELIVERY_RECOVERY_CONFLICT');
    await pool.execute("UPDATE workflow_jobs SET state = 'dead_letter', lease_expires_at = NULL WHERE id = ?", [id]);
    await gate.recover(id, 7, input);
    const [jobs] = await pool.execute<any[]>('SELECT state FROM workflow_jobs WHERE id = ?', [id]);
    expect(jobs[0].state).toBe(decision === 'sent' ? 'completed' : 'cancelled');
    expect((await gate.inspect(id))?.delivery.state).toBe(decision === 'sent' ? 'sent' : 'failed');
    await expect(gate.recover(id, 7, input)).rejects.toThrow('DELIVERY_RECOVERY_CONFLICT');
  });

  it('preparation failure cannot erase legacy uncertainty on a later configuration fix', async () => {
    const id = await enqueue();
    await pool.execute("INSERT INTO report_notification_deliveries (workflow_job_id,report_id,channel_id,attempt_number,status) VALUES ('old',1,1,1,'started')");
    const [job, context] = await claim();
    await gate.preflightFailed(job, context);
    await pool.execute("UPDATE workflow_jobs SET state = 'retry', lease_expires_at = NULL WHERE id = ?", [id]);
    const [retry, retryContext] = await claim('b');
    await expect(gate.acquire(retry, retryContext, frozen)).rejects.toThrow('DELIVERY_RECONCILIATION_REQUIRED');
  });

  it('an explicitly approved retry can recover legacy uncertainty without a prior new-style attempt UUID', async () => {
    const id = await enqueue();
    await pool.execute("INSERT INTO report_notification_deliveries (workflow_job_id,report_id,channel_id,attempt_number,status) VALUES ('legacy',1,1,1,'started')");
    const [job, context] = await claim();
    await expect(gate.acquire(job, context, frozen)).rejects.toThrow('DELIVERY_RECONCILIATION_REQUIRED');
    await pool.execute("UPDATE workflow_jobs SET state = 'dead_letter', lease_expires_at = NULL WHERE id = ?", [id]);
    const view = (await gate.inspect(id))!;
    await gate.recover(id, 7, { version: view.delivery.version, decision: 'retry', reason: 'reviewed migration', reconciliation: 'receiver cannot confirm old attempt', acceptDuplicateRisk: true });
    const [retry, retryContext] = await claim('b');
    expect(await gate.acquire(retry, retryContext, frozen)).not.toBeNull();
  });

});
