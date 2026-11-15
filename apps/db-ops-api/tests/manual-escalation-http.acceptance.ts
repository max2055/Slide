// Explicit opt-in: ESCALATION_MYSQL_CONFIG supplies an authorized test connection.
// Production route + JWT/RBAC + full migrations + notification worker/local SMTP.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import { dbConnection } from '../src/db-connection.js';
import { MigrationRunner } from '../src/migrations/runner.js';
import { alertEscalationService } from '../src/alert-escalation-service.js';
import { registerAlertEscalationRoute } from '../src/alert-escalation-routes.js';
import { createVerifyToken } from '../src/auth-middleware.js';
import { actorContextService, signAccessToken } from '../src/auth/actor-context.js';
import { smtpRecipient } from '../src/workflows/delivery-test-recipients.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../src/workflows/worker-runtime.js';
import { JobRegistry } from '../src/workflows/job-registry.js';
import { registerNotificationHandlers } from '../src/workflows/notification-handlers.js';
import { notificationDatabaseService } from '../src/notification-database-service.js';
import { notificationService } from '../src/notification-service.js';
import { reportDatabaseService } from '../src/report-database-service.js';

assert(process.env.ESCALATION_MYSQL_CONFIG, 'ESCALATION_MYSQL_CONFIG is required');
const options = JSON.parse(process.env.ESCALATION_MYSQL_CONFIG);
assert.equal(options.port, 3308);
delete options.database;
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
const schema = 'max576_full_' + Date.now();
const admin = await mysql.createConnection(options);
const app = Fastify();
const smtp = await smtpRecipient();
let worker: WorkerRuntime | undefined;
try {
  await admin.query('CREATE DATABASE ' + schema);
  assert(await dbConnection.initialize({ ...options, database: schema }));
  const pool = dbConnection.getPool()!;
  await new MigrationRunner(pool as any).run();
  console.log('full migration chain installed');
  await pool.query("INSERT INTO database_instances(id,name,host,port,database_name,username,password_encrypted) VALUES(576,'fixture','fixture.invalid',3308,'fixture','fixture','unused')");
  await pool.query("INSERT INTO users(id,username,password_hash) VALUES(576,'max576','no-login')");
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT 576,id FROM roles WHERE name='admin'");
  const actor = await actorContextService.loadActiveActor(576);
  const secret = randomBytes(32).toString('hex');
  await registerAlertEscalationRoute(app, createVerifyToken(secret));
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const headers = { authorization: 'Bearer ' + signAccessToken(actor, secret), 'content-type': 'application/json' };
  const api = async (id: number, body: unknown, status: number, authenticated = true) => {
    const response = await fetch(url + `/api/alerts/${id}/escalate`, {
      method: 'POST', headers: authenticated ? headers : { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, status);
    return response.json() as Promise<any>;
  };
  await pool.execute("INSERT INTO notification_channels(id,name,type,config,enabled,delivery_start_at) VALUES(1,'controlled','email',?,1,DATE_SUB(NOW(),INTERVAL 2 DAY))", [JSON.stringify(smtp.channel.config)]);
  const registry = new JobRegistry();
  registerNotificationHandlers(registry, notificationDatabaseService, notificationService, reportDatabaseService);
  worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool as any), 'max576', 30);
  const runWorker = async () => {
    // MySQL DATETIME(0) can round available_at into the next second. Wait for
    // that stored due time once, without resending or changing queued jobs.
    const [due] = await pool.query<any[]>("SELECT COALESCE(MAX(TIMESTAMPDIFF(MICROSECOND,NOW(3),available_at)),0)/1000 ms FROM workflow_jobs WHERE state='queued'");
    const ms = Math.max(0, Number(due[0].ms));
    assert(ms <= 2000, 'unexpected future job schedule');
    if (ms) await delay(ms + 25);
    return worker!.runOnce((job, context) => registry.execute(job, context));
  };
  let nextId = 576;
  const createAlert = async (level = 'warning', status = 'unread') => {
    const id = nextId++;
    await pool.execute("INSERT INTO alerts(id,instance_id,alert_type,level,title,message,status,created_at) VALUES(?,576,'performance',?,'fixture','fixture',?,DATE_SUB(NOW(),INTERVAL 1 DAY))", [id, level, status]);
    return id;
  };
  const count = async (table: string) => Number((await pool.query<any[]>('SELECT COUNT(*) n FROM ' + table))[0][0].n);
  const snapshot = async (id: number) => ({
    alert: (await pool.query<any[]>('SELECT level,status FROM alerts WHERE id=?', [id]))[0],
    logs: await count('alert_event_logs'), jobs: await count('workflow_jobs'), messages: smtp.messages.length,
  });
  const id = await createAlert();
  const unchanged = await snapshot(id);
  for (const new_level of ['not-a-level', 'ERROR', ' error ', '', null, 1, {}]) {
    assert.equal((await api(id, { new_level }, 400)).error, 'ESCALATION_INPUT');
    assert.equal((await alertEscalationService.manualEscalation(id, new_level as string, actor)).error, 'ESCALATION_LEVEL');
    assert.deepEqual(await snapshot(id), unchanged);
  }
  for (const body of [{}, { new_level: 'error', extra: true }]) await api(id, body, 400);
  await api(id, { new_level: 'error' }, 401, false);
  await api(999999, { new_level: 'error' }, 404);
  assert.deepEqual(await snapshot(id), unchanged);
  let rejected = 0;
  for (const status of ['resolved', 'closed']) {
    const terminalId = await createAlert('warning', status);
    const before = await snapshot(terminalId);
    assert.equal((await api(terminalId, { new_level: 'critical' }, 409)).error, 'ESCALATION_STATUS');
    assert.equal((await alertEscalationService.manualEscalation(terminalId, 'critical', actor)).error, 'ESCALATION_STATUS');
    assert.deepEqual(await snapshot(terminalId), before);
    rejected++;
  }
  const levels = ['info', 'warning', 'error', 'critical', 'p0'];
  let accepted = 0;
  for (const status of ['unread', 'read', 'acknowledged']) {
    for (const from of levels) for (const to of levels.slice(1)) {
      const alertId = await createAlert(from, status);
      const before = await snapshot(alertId);
      if (levels.indexOf(to) <= levels.indexOf(from)) {
        assert.equal((await api(alertId, { new_level: to }, 409)).error, 'ESCALATION_DIRECTION');
        assert.deepEqual(await snapshot(alertId), before);
        rejected++;
      } else {
        assert.deepEqual(await api(alertId, { new_level: to }, 200), { success: true, changed: true });
        const after = await snapshot(alertId);
        assert.deepEqual(after.alert, [{ level: to, status }]);
        assert.equal(after.logs, before.logs + 1); assert.equal(after.jobs, before.jobs + 1);
        assert.equal(after.messages, before.messages);
        assert.equal(await runWorker(), 'completed');
        assert.equal(smtp.messages.length, before.messages + 1);
        assert.equal(await runWorker(), 'idle');
        const sent = await snapshot(alertId);
        assert.equal((await api(alertId, { new_level: to }, 409)).error, 'ESCALATION_DIRECTION');
        assert.deepEqual(await snapshot(alertId), sent);
        accepted++;
      }
    }
  }
  console.log(`PASS severity/status matrix: ${accepted} accepted once; ${rejected} conflicts unchanged; invalid targets rejected at HTTP and service`);
  // Concurrent manual requests serialize on the alert row; only the winner sends.
  const concurrent = await createAlert();
  const beforeConcurrent = await snapshot(concurrent);
  const responses = await Promise.all([1, 2].map(() => fetch(url + `/api/alerts/${concurrent}/escalate`, {
    method: 'POST', headers, body: JSON.stringify({ new_level: 'error' }),
  })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  await Promise.all(responses.map(r => r.json()));
  const afterConcurrent = await snapshot(concurrent);
  assert.equal(afterConcurrent.logs, beforeConcurrent.logs + 1);
  assert.equal(afterConcurrent.jobs, beforeConcurrent.jobs + 1);
  assert.equal(await runWorker(), 'completed');
  assert.equal(smtp.messages.length, beforeConcurrent.messages + 1);
  assert.equal(await runWorker(), 'idle');
  // A log failure must roll back severity and leave no queued or delivered notice.
  const failing = await createAlert();
  const beforeFailure = await snapshot(failing);
  await pool.query("CREATE TRIGGER max576_fail BEFORE INSERT ON alert_event_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected'");
  assert.equal((await api(failing, { new_level: 'error' }, 503)).error, 'ESCALATION_STATE_UNKNOWN');
  assert.deepEqual(await snapshot(failing), beforeFailure);
  await pool.query('DROP TRIGGER max576_fail');
  assert.equal(await runWorker(), 'idle');
  // Existing JWT must lose access immediately after role removal.
  await pool.query('DELETE FROM user_roles WHERE user_id=576');
  await api(failing, { new_level: 'error' }, 403);
  assert.deepEqual(await snapshot(failing), beforeFailure);
  console.log('PASS concurrent HTTP winner once; log failure rollback; live permission revocation; local SMTP only');
} finally {
  await worker?.shutdown();
  await app.close();
  await smtp.close();
  await dbConnection.close();
  await admin.query('DROP DATABASE IF EXISTS ' + schema);
  await admin.end();
  console.log('CLEANUP completed');
}
