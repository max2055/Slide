import mysql, { type Pool } from 'mysql2/promise';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { transpileModule } from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@slide/agent-core';
import { MigrationRunner } from '../migrations/runner.js';
import type { MigrationPool } from '../migrations/types.js';
import { InstanceRemovalResponseSchema } from '../contracts/public-api.js';

const control = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock('../db-connection', () => ({ dbConnection: { getPool: () => control.pool, isConnected: () => !!control.pool },
  encryptData: (value: string) => value, decryptData: (value: string) => value, needsEncryptionMigration: () => false }));
// Only the outbound address authorization is substituted; IO uses disposable MySQL.
vi.mock('../security/database-target-policy', () => ({
  authorizeDatabaseTarget: async (target: { host: string; port: number }) => ({ address: target.host, port: target.port }),
}));
import { databaseService } from '../database-service.js';
import { instanceDatabaseService } from '../instance-database-service.js';
import { CronManager } from '../cron/cron-manager.js';
import { CronExecutor } from '../cron/cron-executor.js';
import { cronJobService } from '../cron/cron-job-service.js';
import { cronAuthorityService } from '../cron/cron-authority.js';
import { cronRunStore } from '../cron/cron-run-store.js';
import { instanceAccessLifecycle, InstanceAccessLifecycle } from './instance-access-lifecycle.js';
import { instanceRemovalService, instanceRemovalStore, InstanceRemovalService } from './instance-removal-service.js';
import { instanceHistoryContext } from './instance-history-context.js';
import { monitorCollector } from '../monitor-collector.js';
import { MysqlInstanceHostStore } from './instance-host-service.js';
import { MysqlResourceRelationStore } from './resource-service.js';
import { DatabaseAuditLogStore } from '../audit/audit-log.js';

const port = Number(process.env.INSTANCE_REMOVAL_TEST_MYSQL_PORT);
describe.skipIf(!port)('instance removal / isolated MySQL', () => {
  let admin: Pool, pool: Pool, instanceId: number, serverId: number;
  let manager: CronManager;
  let sequence = 0;
  const database = `max119_removal_${process.pid}`;

  beforeAll(async () => {
    admin = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 12 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    control.pool = pool;
    instanceAccessLifecycle.configure(id => instanceRemovalStore.available(id));
  }, 120_000);
  afterAll(async () => {
    control.pool = null;
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });
  afterEach(async () => {
    await manager?.stop();
    await databaseService.removeConnection(instanceId);
    await pool.query('DROP TRIGGER IF EXISTS reject_tombstone');
    await pool.query('DROP TRIGGER IF EXISTS reject_detach');
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    const [instance] = await pool.execute<any>(`INSERT INTO database_instances
      (name, environment, db_type, host, port, username, password_encrypted, database_name)
      VALUES (?, 'testing', 'mysql', '127.0.0.1', ?, 'root', 'fake', ?)`, [`fixture-${++sequence}`, port, database]);
    instanceId = instance.insertId;
    const [server] = await pool.execute<any>(`INSERT INTO servers (host, port, label, os_type, credential_type, credential_encrypted)
      VALUES (?, 22, 'fixture', 'linux', 'password', 'fake')`, [`fake-${sequence}`]);
    serverId = server.insertId;
    vi.spyOn(cronJobService, 'ensureSeedData').mockResolvedValue(undefined);
    const executor = { execute: vi.fn() } as unknown as CronExecutor;
    manager = new CronManager(cronJobService, executor);
    instanceRemovalService.configure({
      stopTasks: id => manager.stopInstance(id),
      stopCollection: id => monitorCollector.stopInstance(id),
      closeConnections: id => databaseService.removeConnection(id),
    });
  });

  async function seedJob(scopeIds = [instanceId], target: number | null = instanceId) {
    const [result] = await pool.execute<any>(`INSERT INTO cron_jobs
      (name, task_description, cron_expr, enabled, task_type, target_instance_id, principal_type, identity_status, resource_scope)
      VALUES (?, 'fixture', '0 0 1 1 *', 1, 'agent', ?, 'user', 'bound', ?)`,
      [`cron-${sequence}-${scopeIds.join('-')}`, target,
        JSON.stringify({ version: 1, targetInstanceId: target, instanceIds: scopeIds, serverIds: [], networkDeviceIds: [] })]);
    return (await cronJobService.getJobById(result.insertId))!;
  }
  async function connect() {
    expect(await databaseService.addConnection(instanceId, 'fixture', { host: '127.0.0.1', port, user: 'root', password: '', database, db_type: 'mysql' })).toBe(true);
    return databaseService.getConnection(instanceId)!;
  }
  async function snapshot() {
    const [rows] = await pool.execute<any[]>('SELECT * FROM database_instances WHERE id = ?', [instanceId]);
    return rows[0];
  }
  async function routeApp() {
    const app = Fastify();
    const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
    const routes = source.slice(source.indexOf("  fastify.delete('/api/database/instances/:id'"), source.indexOf('  // 重新加载实例连接'));
    const register = new Function('fastify', 'verifyToken', 'requirePermission', 'requireInstanceAccess', 'instanceDatabaseService', 'InstanceRemovalResponseSchema', transpileModule(routes, {}).outputText);
    register(app, async () => {}, () => async () => {}, () => async () => {}, instanceDatabaseService, InstanceRemovalResponseSchema);
    return app;
  }

  it('connected target with Cron, metrics, relations and audit becomes a readable tombstone; repeated HTTP deletion converges', async () => {
    const conn = await connect();
    const retainedPool = conn.pool!;
    const [before] = await retainedPool.query<any[]>('SELECT 7 AS value');
    expect(before[0].value).toBe(7);
    const job = await seedJob();
    const queued = await cronRunStore.enqueue(job.id, null, 'queued-fixture', {}, null);
    await pool.execute(`INSERT INTO workflow_jobs (id, job_type, schema_version, payload, idempotency_key)
      VALUES (UUID(), 'metrics.collect', 1, ?, ?)`, [JSON.stringify({ resource: { type: 'instance', id: instanceId }, revision: 1 }), `metric-fixture-${instanceId}`]);
    await manager.start();
    const scheduledBefore = manager.getStatus().scheduledJobs;
    expect(scheduledBefore).toBeGreaterThan(0);
    await pool.execute(`INSERT INTO resource_relations (source_type, source_id, target_type, target_id, relation_type, provenance, valid_from)
      VALUES ('instance', ?, 'server', ?, 'runs_on', 'manual', DATE_SUB(NOW(6), INTERVAL 1 DAY))`, [instanceId, serverId]);
    await pool.execute('INSERT INTO metrics_history (instance_id, cpu_usage) VALUES (?, 42)', [instanceId]);
    await pool.execute("INSERT INTO health_check_history (instance_id, health_score, status, checks) VALUES (?, 80, 'healthy', JSON_ARRAY())", [instanceId]);
    await pool.execute(`INSERT INTO sql_execution_history (instance_id, instance_name, db_type, sql_text, status)
      VALUES (?, 'fixture', 'mysql', 'SELECT 7', 'success')`, [instanceId]);
    const app = await routeApp();
    try {
      for (let retry = 0; retry < 2; retry++) {
        const response = await app.inject({ method: 'DELETE', url: `/api/database/instances/${instanceId}` });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ message: '删除成功', lifecycle_state: 'deleted' });
      }
    } finally { await app.close(); }
    const tombstone = await snapshot();
    expect(tombstone).toMatchObject({ lifecycle_state: 'deleted', status: 'inactive', password_encrypted: '', removal_reasons: null });
    expect(tombstone.removed_at).toBeTruthy();
    expect(await cronJobService.getJobById(job.id)).toMatchObject({ enabled: false, target_instance_id: instanceId });
    expect(await cronRunStore.get(queued.runId)).toMatchObject({ status: 'cancelled', errorCode: 'INSTANCE_REMOVED' });
    const [queuedWork] = await pool.execute<any[]>(`SELECT state FROM workflow_jobs WHERE id = ? OR idempotency_key = ?`, [queued.runId, `metric-fixture-${instanceId}`]);
    expect(queuedWork.map(row => row.state)).toEqual(['cancelled', 'cancelled']);
    expect(manager.getStatus().scheduledJobs).toBe(scheduledBefore - 1);
    expect(databaseService.getConnection(instanceId)).toBeNull();
    await expect(retainedPool.query('SELECT 8')).rejects.toThrow('INSTANCE_REMOVED');
    await expect(monitorCollector.collectInstanceNow(instanceId)).rejects.toThrow('INSTANCE_REMOVED');
    expect(await databaseService.reconnect(instanceId, conn.name, conn.config)).toBe(false);
    expect(await instanceDatabaseService.listActiveInstanceIds()).not.toContain(instanceId);
    const [relations] = await pool.execute<any[]>('SELECT valid_until FROM resource_relations WHERE source_id = ?', [instanceId]);
    expect(relations[0].valid_until).toBeTruthy();
    const [metrics] = await pool.execute<any[]>('SELECT cpu_usage FROM metrics_history WHERE instance_id = ?', [instanceId]);
    expect(Number(metrics[0].cpu_usage)).toBe(42);
    const audit = await new DatabaseAuditLogStore(pool).query({ eventType: 'sql_execution', resourceId: String(instanceId) });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].details).toMatchObject({ instanceLifecycleState: 'deleted', sql: 'SELECT 7' });
    const historyApp = Fastify();
    const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
    const historyRoutes = source.slice(source.indexOf("  fastify.get('/api/database/instances/:id/health-history'"), source.indexOf('  // 获取最新一次健康检查'));
    const registerHistory = new Function('fastify', 'verifyToken', 'requirePermission', 'requireInstanceAccess', 'instanceDatabaseService', 'instanceHistoryContext', transpileModule(historyRoutes, {}).outputText);
    registerHistory(historyApp, async () => {}, () => async () => {}, () => async () => {}, instanceDatabaseService, instanceHistoryContext);
    try {
      const response = await historyApp.inject({ method: 'GET', url: `/api/database/instances/${instanceId}/health-history` });
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-instance-lifecycle-state']).toBe('deleted');
      expect(response.json()).toHaveLength(1);
    } finally { await historyApp.close(); }
  });

  it('multi-instance scopes are disabled without nulling targets; late scheduled and manual executions never reach the executor', async () => {
    const job = await seedJob([instanceId, 99999], null);
    await instanceRemovalService.remove(instanceId);
    expect(await cronJobService.getJobById(job.id)).toMatchObject({ enabled: false, target_instance_id: null });
    const execute = vi.fn();
    manager = new CronManager(cronJobService, { execute } as unknown as CronExecutor);
    await manager.executeJob(job);
    await expect(manager.triggerJob(job)).rejects.toThrow('INSTANCE_REMOVED');
    expect(execute).not.toHaveBeenCalled();
    expect((await cronJobService.getJobById(job.id))!.resource_scope!.instanceIds).toEqual([instanceId, 99999]);
  });

  it('cancels a cooperative in-flight Cron runner before acknowledging deletion', async () => {
    const job = await seedJob();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let cancelled = false;
    const runner = { run: async ({ signal }: { signal: AbortSignal }) => {
      started();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
      return { stopReason: 'cancelled', finalContent: null, messages: [], toolEvents: [], toolsUsed: [], usage: {}, hadInjections: false };
    } };
    vi.spyOn(cronAuthorityService, 'authorize').mockResolvedValue({ audit: {}, actor: {} as any, refreshActor: async () => ({} as any) });
    const executor = new CronExecutor(runner as any, new ToolRegistry(), { getDefaultModel: () => 'fake' } as any);
    manager = new CronManager(cronJobService, executor);
    const execution = manager.executeJob(job);
    await ready;
    expect(await instanceRemovalService.remove(instanceId)).toMatchObject({ success: true });
    await execution;
    expect(cancelled).toBe(true);
  });

  it('driver failure keeps deleting and tries relation cleanup; retry closes the retained handle', async () => {
    const conn = await connect();
    const original = conn.pool!.end.bind(conn.pool);
    const end = vi.spyOn(conn.pool!, 'end').mockRejectedValueOnce(new Error('fake secret'));
    end.mockImplementationOnce(original);
    expect(await instanceRemovalService.remove(instanceId)).toMatchObject({ success: false, reasons: ['CONNECTION_CLEANUP_PENDING'] });
    expect(await snapshot()).toMatchObject({ lifecycle_state: 'deleting', removal_reasons: ['CONNECTION_CLEANUP_PENDING'] });
    expect(await instanceRemovalService.remove(instanceId)).toMatchObject({ success: true });
  });

  it('tombstone SQL failure is reported as pending and cannot resurrect the resource', async () => {
    await connect();
    await pool.query(`CREATE TRIGGER reject_tombstone BEFORE UPDATE ON database_instances FOR EACH ROW
      BEGIN IF NEW.lifecycle_state = 'deleted' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture'; END IF; END`);
    const app = await routeApp();
    try {
      const response = await app.inject({ method: 'DELETE', url: `/api/database/instances/${instanceId}` });
      expect(response.statusCode).toBe(409);
      expect(response.json().reasons).toEqual(['TOMBSTONE_COMMIT_FAILED']);
    } finally { await app.close(); }
    expect((await snapshot()).lifecycle_state).toBe('deleting');
    await expect(instanceDatabaseService.markInstanceActive(instanceId)).rejects.toThrow('INSTANCE_REMOVED');
    await pool.query('DROP TRIGGER reject_tombstone');
    expect(await instanceRemovalService.remove(instanceId)).toMatchObject({ success: true });
  });

  it('relation insert and host replacement cannot create associations after deletion intent', async () => {
    await instanceRemovalStore.begin(instanceId);
    await expect(new MysqlInstanceHostStore(() => pool as any).replaceInstanceHosts(instanceId, [{ serverId, role: 'primary' }])).rejects.toThrow('INSTANCE_NOT_FOUND');
    await expect(new MysqlResourceRelationStore(() => pool as any).insertRelation({
      source: { type: 'instance', id: instanceId }, target: { type: 'server', id: serverId },
      relationType: 'runs_on', provenance: 'manual', validFrom: new Date(),
    })).rejects.toThrow('RESOURCE_NOT_FOUND');
    // Simulate process interruption: replay using a fresh service and access fence.
    expect(await instanceRemovalStore.pendingIds()).toContain(instanceId);
    const restartedAccess = new InstanceAccessLifecycle(id => instanceRemovalStore.available(id));
    await expect(restartedAccess.assertAvailable(instanceId)).rejects.toThrow('INSTANCE_REMOVED');
    const restarted = new InstanceRemovalService(instanceRemovalStore, restartedAccess, {
      stopTasks: id => manager.stopInstance(id), stopCollection: id => monitorCollector.stopInstance(id),
      closeConnections: id => databaseService.removeConnection(id),
    });
    expect(await restarted.remove(instanceId)).toMatchObject({ success: true });
  });

  it('cleanup transaction interruption rolls back related writes and repeated cleanup converges', async () => {
    const job = await seedJob();
    await pool.query(`CREATE TRIGGER reject_detach BEFORE UPDATE ON cron_jobs FOR EACH ROW
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture'`);
    expect(await instanceRemovalService.remove(instanceId)).toMatchObject({ success: false, reasons: ['RELATION_CLEANUP_PENDING'] });
    expect((await snapshot()).lifecycle_state).toBe('deleting');
    expect(await cronJobService.getJobById(job.id)).toMatchObject({ target_instance_id: instanceId, enabled: true });
    // The durable access fence protects even though the configuration cleanup rolled back.
    await expect(manager.triggerJob(job)).rejects.toThrow('INSTANCE_REMOVED');
    await pool.query('DROP TRIGGER reject_detach');
    expect(await instanceRemovalService.remove(instanceId)).toMatchObject({ success: true });
    expect(await cronJobService.getJobById(job.id)).toMatchObject({ enabled: false, target_instance_id: instanceId });
  });

  it('a late script retains its removed target and cannot become a control-database script', async () => {
    const job = await seedJob();
    await pool.execute("UPDATE cron_jobs SET task_type = 'script' WHERE id = ?", [job.id]);
    await instanceRemovalService.remove(instanceId);
    const log = vi.spyOn(cronJobService, 'startLog');
    await manager.executeJob(job);
    expect(log).not.toHaveBeenCalled();
    expect(await cronJobService.getJobById(job.id)).toMatchObject({ task_type: 'script', target_instance_id: instanceId });
  });
});
