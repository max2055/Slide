import { readFileSync } from 'node:fs';
import mysql, { type Pool } from 'mysql2/promise';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { registerCronRoutes } from './cron-routes.js';
import { actorContextService } from '../auth/actor-context.js';
import { CronJobDatabaseService } from './cron-job-service.js';
import { AgentRunner } from '@slide/agent-core';
import { CronExecutor } from './cron-executor.js';
import { createCronToolRegistry, getPlatformTool } from '../adapter/get-agent-engine.js';
import { CronManager } from './cron-manager.js';
import { cronJobService } from './cron-job-service.js';
import { CONTROL_MAINTENANCE } from './script-policy.js';
import { splitSqlStatements } from '../migrations/runner.js';

// Opt-in, dedicated disposable localhost MySQL only; never reads application .env.
const port = Number(process.env.CRON_TEST_MYSQL_PORT);
describe.skipIf(!port)('Cron API + isolated MySQL security', () => {
  let pool: Pool;
  let admin: Pool;
  let app: FastifyInstance;
  let manager: CronManager;
  const database = `cron_security_${process.pid}`;
  const actors = {
    global: { userId: 7, username: 'global-manager', permissions: ['cron:manage', 'cron:view', 'instance:*'], instanceScopes: {} },
    scoped: { userId: 8, username: 'scoped-manager', permissions: ['cron:manage', 'cron:view'], instanceScopes: { 9: 'read-write' } },
    viewer: { userId: 9, username: 'viewer', permissions: ['cron:view'], instanceScopes: {} },
  };
  const authorityMigration = splitSqlStatements(readFileSync(new URL('../../sql/migrations/105_cron_execution_authority.sql', import.meta.url), 'utf8'));
  const migration = splitSqlStatements(readFileSync(new URL('../../sql/migrations/092_cron_script_binding.sql', import.meta.url), 'utf8'));
  const request = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: any, actor = 'global') =>
    app.inject({ method, url: `/api/cron/${url}`, payload, headers: { 'x-test-actor': actor } });
  async function createScript(content = 'SELECT 1 AS value') {
    const response = await request('POST', 'scripts', { name: `script-${Math.random()}`, content, target_db_type: 'mysql' });
    expect(response.statusCode).toBe(201);
    return response.json().id as number;
  }
  const jobBody = (scriptId: number, extra = {}) => ({ name: `job-${Math.random()}`, task_description: 'isolated test',
    task_type: 'script', script_id: scriptId, target_instance_id: null, cron_expr: '0 0 1 1 *', ...extra });
  async function createJob(scriptId: number, extra = {}) {
    const response = await request('POST', 'jobs', jobBody(scriptId, extra));
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as number;
  }
  async function lastLog(id: number) {
    const result = await cronJobService.getLogs(id);
    return result.logs[0];
  }

  beforeAll(async () => {
    admin = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 8 });
    for (const sql of [
      `CREATE TABLE users (id INT UNSIGNED PRIMARY KEY, username VARCHAR(100), status VARCHAR(20), session_version BIGINT DEFAULT 1)`,
      `CREATE TABLE roles (id INT PRIMARY KEY, name VARCHAR(100))`,
      `CREATE TABLE permissions (id INT PRIMARY KEY, code VARCHAR(100))`,
      `CREATE TABLE user_roles (user_id INT, role_id INT, grant_expiry DATETIME)`,
      `CREATE TABLE role_permissions (role_id INT, permission_id INT)`,
      `CREATE TABLE instance_permissions (user_id INT, instance_id INT, access_level VARCHAR(20), grant_expiry DATETIME)`,
      `CREATE TABLE database_instances (id INT PRIMARY KEY, name VARCHAR(100))`,
      `CREATE TABLE agent_tool_audit (id INT AUTO_INCREMENT PRIMARY KEY, phase VARCHAR(20), actor_id INT, agent_id VARCHAR(100),
        request_id VARCHAR(100), tool_name VARCHAR(100), allowed BOOLEAN, reason_code VARCHAR(100), resource_json JSON,
        policy_snapshot JSON, args_redacted JSON, result_redacted JSON, approval_id VARCHAR(100))`,
      `CREATE TABLE cron_scripts (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), description TEXT,
        script_type VARCHAR(20), content TEXT, target_db_type VARCHAR(20), created_at DATETIME DEFAULT NOW(), updated_at DATETIME DEFAULT NOW())`,
      `CREATE TABLE cron_jobs (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), task_description TEXT, output_schema JSON,
        cron_expr VARCHAR(100), enabled BOOLEAN DEFAULT TRUE, task_type VARCHAR(20), handler_key VARCHAR(100), script_id INT UNSIGNED,
        target_instance_id INT, timezone VARCHAR(50), description TEXT, last_run_at DATETIME, next_run_at DATETIME, last_result VARCHAR(50),
        timeout_seconds INT DEFAULT 300, retry_count INT DEFAULT 0, created_at DATETIME DEFAULT NOW(), updated_at DATETIME DEFAULT NOW(), FOREIGN KEY (target_instance_id) REFERENCES database_instances(id) ON DELETE SET NULL)`,
      `CREATE TABLE cron_job_logs (id INT AUTO_INCREMENT PRIMARY KEY, job_id INT, started_at DATETIME, finished_at DATETIME,
        status VARCHAR(20), result_summary TEXT, error_message TEXT, result JSON, structured_result JSON, tools_used JSON, tool_events JSON,
        \`usage\` JSON, stop_reason VARCHAR(50), duration_ms INT, partial_trace TEXT, error_trace TEXT)`,
      'CREATE TABLE metric_baselines (id INT PRIMARY KEY, computed_at DATETIME) ENGINE=InnoDB',
      'CREATE TABLE silence_periods (id INT PRIMARY KEY, silenced_until DATETIME) ENGINE=InnoDB',
    ]) await pool.query(sql);
    await pool.query("INSERT INTO users VALUES (7, 'global-manager', 'active', 1), (8, 'scoped-manager', 'active', 1), (9, 'viewer', 'active', 1)");
    await pool.query("INSERT INTO roles VALUES (1, 'global'), (2, 'scoped'), (3, 'viewer')");
    await pool.query("INSERT INTO permissions VALUES (1, '*'), (2, 'cron:manage'), (3, 'cron:view'), (4, 'instance:view'), (5, 'metric:view'), (6, 'alert:view')");
    await pool.query("INSERT INTO user_roles VALUES (7,1,NULL),(8,2,NULL),(9,3,NULL)");
    await pool.query("INSERT INTO role_permissions VALUES (1,1),(2,2),(2,3),(2,4),(2,5),(2,6),(3,3)");
    for (const sql of migration) await pool.query(sql);
    for (const sql of authorityMigration) await pool.query(sql);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    manager = new CronManager(cronJobService, {} as any);
    app = Fastify();
    registerCronRoutes(app, async (req, reply) => {
      const actor = actors[req.headers['x-test-actor'] as keyof typeof actors];
      if (!actor) return reply.code(401).send({ error: 'Unauthorized' });
      (req as any).user = await actorContextService.loadActiveActor(actor.userId);
    }, () => manager);
    await app.ready();
  });

  beforeEach(async () => {
    await manager.stop();
    await pool.query("UPDATE users SET status = 'active', session_version = 1");
    await pool.query('DELETE FROM instance_permissions');
    await pool.query("INSERT INTO instance_permissions VALUES (8,9,'read-write',NULL)");
    await pool.query('DELETE FROM database_instances');
    await pool.query("INSERT INTO database_instances VALUES (9,'A'),(10,'B')");
    await pool.query('DELETE FROM agent_tool_audit');
    for (const table of ['cron_job_logs', 'cron_jobs', 'cron_scripts', 'metric_baselines', 'silence_periods']) await pool.query(`DELETE FROM ${table}`);
  });
  afterAll(async () => {
    await manager?.stop();
    await app?.close();
    vi.restoreAllMocks();
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE ${database}`); await admin.end(); }
  });

  it('covers permission denial on create, update, toggle, manual run and shared script mutation', async () => {
    const scriptId = await createScript();
    const jobId = await createJob(scriptId);
    expect((await request('POST', 'jobs', jobBody(scriptId), 'scoped')).statusCode).toBe(403);
    expect((await request('POST', 'jobs', jobBody(scriptId), 'viewer')).statusCode).toBe(403);
    expect((await request('PUT', `jobs/${jobId}`, { enabled: true }, 'scoped')).statusCode).toBe(404);
    expect((await request('POST', `jobs/${jobId}/run`, {}, 'scoped')).statusCode).toBe(404);
    expect((await request('POST', `jobs/${jobId}/toggle`, { enabled: true }, 'scoped')).statusCode).toBe(404);
    expect((await request('PUT', `scripts/${scriptId}`, { content: 'DELETE FROM metric_baselines' }, 'scoped')).statusCode).toBe(403);
    expect((await request('DELETE', `scripts/${scriptId}`, undefined, 'scoped')).statusCode).toBe(403);
    const scopedId = await createJob(scriptId, { target_instance_id: 9 });
    expect((await request('PUT', `jobs/${scopedId}`, { target_instance_id: null }, 'scoped')).statusCode).toBe(403);
    await request('POST', `jobs/${jobId}/toggle`, { enabled: false });
    expect((await request('PUT', `scripts/${scriptId}`, { description: 'also protected when disabled' }, 'scoped')).statusCode).toBe(403);
    expect((await cronJobService.getLogs(jobId)).logs).toHaveLength(0);
  });

  it('checks ALL shared target references, and permits an accessible-only edit', async () => {
    const scriptId = await createScript();
    await createJob(scriptId, { target_instance_id: 9 });
    expect((await request('PUT', `scripts/${scriptId}`, { content: 'SELECT 2' }, 'scoped')).statusCode).toBe(200);
    await createJob(scriptId, { target_instance_id: 10 });
    expect((await request('PUT', `scripts/${scriptId}`, { content: 'SELECT 3' }, 'scoped')).statusCode).toBe(403);
  });

  it.each(['DELETE FROM metric_baselines', 'DROP TABLE metric_baselines', 'SELECT 1; DELETE FROM metric_baselines'])('rejects unapproved null-target SQL at create and update: %s', async content => {
    const bad = await createScript(content);
    expect((await request('POST', 'jobs', jobBody(bad))).statusCode).toBe(400);
    const good = await createJob(await createScript());
    expect((await request('PUT', `jobs/${good}`, { script_id: bad })).statusCode).toBe(400);
  });

  it('runs pinned read-only SQL via manual and scheduled execution after the source changes', async () => {
    const scriptId = await createScript('SELECT 1 AS pinned');
    const jobId = await createJob(scriptId);
    expect((await request('PUT', `scripts/${scriptId}`, { content: 'DROP TABLE metric_baselines' })).statusCode).toBe(200);
    expect((await request('POST', `jobs/${jobId}/run`, {})).statusCode).toBe(200);
    expect((await lastLog(jobId)).structured_result).toMatchObject({ success: true, columns: ['pinned'], capability: 'read-only', authorized_by: '7' });
    await manager.start();
    await (manager as any).jobs.get(jobId).fireOnTick();
    await vi.waitFor(async () => {
      const { logs } = await cronJobService.getLogs(jobId);
      expect(logs).toHaveLength(2);
      expect(logs.every(log => log.status === 'success')).toBe(true);
    });
    await pool.query('SELECT * FROM metric_baselines');
  });

  it.each(['baseline-cleanup-v1', 'silence-cleanup-v1'] as const)('executes explicitly authorized %s and records the exact grant', async capability => {
    const table = capability === 'baseline-cleanup-v1' ? 'metric_baselines' : 'silence_periods';
    await pool.query(`INSERT INTO ${table} VALUES (1, NOW() - INTERVAL 40 DAY), (2, NOW() + INTERVAL 1 DAY)`);
    const scriptId = await createScript(CONTROL_MAINTENANCE[capability]);
    expect((await request('POST', 'jobs', jobBody(scriptId))).statusCode).toBe(400);
    const jobId = await createJob(scriptId, { control_sql_capability: capability });
    await request('POST', `jobs/${jobId}/run`, {});
    expect((await lastLog(jobId)).structured_result).toMatchObject({ success: true, rowCount: 1, capability, authorized_by: '7' });
    const [rows] = await pool.query(`SELECT id FROM ${table}`);
    expect(rows).toEqual([{ id: 2 }]);
    await request('PUT', `scripts/${scriptId}`, { content: `DELETE FROM ${table};` });
    expect((await request('PUT', `jobs/${jobId}`, { script_id: scriptId, control_sql_capability: capability })).statusCode).toBe(400);
    await request('POST', `jobs/${jobId}/run`, {});
    expect((await lastLog(jobId)).status).toBe('success');
    expect((await pool.query(`SELECT id FROM ${table}`))[0]).toEqual([{ id: 2 }]);
  });

  it('migration preserves legacy reads but grants no legacy mutation authority', async () => {
    const read = await createJob(await createScript());
    const badScript = await createScript('DELETE FROM metric_baselines');
    const bad = await cronJobService.createJob(jobBody(badScript) as any);
    await pool.query(migration[1]);
    await request('POST', `jobs/${read}/run`, {});
    await request('POST', `jobs/${bad}/run`, {});
    expect((await lastLog(read)).status).toBe('success');
    expect((await lastLog(bad)).error_message).toBe('CRON_CONTROL_SQL_DENIED');
  });

  it('rejects legacy mutation from the scheduler and reports read execution failures', async () => {
    const bad = await cronJobService.createJob(jobBody(await createScript('DELETE FROM metric_baselines')) as any);
    await pool.query(migration[1]);
    await cronJobService.toggleJob(bad, true);
    await manager.start();
    await (manager as any).jobs.get(bad).fireOnTick();
    await vi.waitFor(async () => expect((await lastLog(bad))?.error_message).toBe('CRON_CONTROL_SQL_DENIED'));
    const missing = await createJob(await createScript('SELECT * FROM missing_table'));
    await request('POST', `jobs/${missing}/run`, {});
    expect((await lastLog(missing)).status).toBe('error');
    expect((await lastLog(missing)).error_message).toBe('ER_NO_SUCH_TABLE');
  });

  it('does not accept client-supplied bindings or a capability on a managed target', async () => {
    const bad = await createScript('DELETE FROM metric_baselines');
    expect((await request('POST', 'jobs', jobBody(bad, { script_binding: { capability: 'baseline-cleanup-v1' } }))).statusCode).toBe(400);
    const fixed = await createScript(CONTROL_MAINTENANCE['baseline-cleanup-v1']);
    expect((await request('POST', 'jobs', jobBody(fixed, { target_instance_id: 9, control_sql_capability: 'baseline-cleanup-v1' }), 'scoped')).statusCode).toBe(400);
    const changed = await createScript(CONTROL_MAINTENANCE['baseline-cleanup-v1'] + ' ');
    expect((await request('POST', 'jobs', jobBody(changed, { control_sql_capability: 'baseline-cleanup-v1' }))).statusCode).toBe(400);
  });

  it('rolls back a maintenance write if the atomic outcome audit fails', async () => {
    await pool.query('INSERT INTO metric_baselines VALUES (1, NOW() - INTERVAL 40 DAY)');
    const jobId = await createJob(await createScript(CONTROL_MAINTENANCE['baseline-cleanup-v1']), { control_sql_capability: 'baseline-cleanup-v1' });
    await pool.query(`CREATE TRIGGER reject_success BEFORE UPDATE ON cron_job_logs FOR EACH ROW
      BEGIN IF NEW.status = 'success' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'isolated audit failure'; END IF; END`);
    try {
      await request('POST', `jobs/${jobId}/run`, {});
      expect((await lastLog(jobId)).status).toBe('error');
      expect((await pool.query('SELECT id FROM metric_baselines'))[0]).toEqual([{ id: 1 }]);
    } finally { await pool.query('DROP TRIGGER reject_success'); }
  });

  it('bounds a blocked maintenance write and leaves the row intact', async () => {
    await pool.query('INSERT INTO metric_baselines VALUES (1, NOW() - INTERVAL 40 DAY)');
    const jobId = await createJob(await createScript(CONTROL_MAINTENANCE['baseline-cleanup-v1']), { control_sql_capability: 'baseline-cleanup-v1', timeout_seconds: 1 });
    const locker = await pool.getConnection();
    await locker.beginTransaction();
    await locker.query('SELECT * FROM metric_baselines FOR UPDATE');
    try {
      const start = Date.now();
      await request('POST', `jobs/${jobId}/run`, {});
      expect(Date.now() - start).toBeLessThan(2500);
      expect((await lastLog(jobId)).status).toBe('error');
    } finally { await locker.rollback(); locker.release(); }
    expect((await pool.query('SELECT id FROM metric_baselines'))[0]).toEqual([{ id: 1 }]);
  });
  it('preserves owner/scope/script binding across service and scheduler recreation', async () => {
    const id = await createJob(await createScript(), { target_instance_id: 9 });
    const before = await cronJobService.getJobById(id);
    const fresh = new CronJobDatabaseService();
    expect(await fresh.getJobById(id)).toMatchObject({ owner_user_id: 7, principal_type: 'user', identity_status: 'bound',
      resource_scope: { version: 1, instanceIds: [9], serverIds: [], networkDeviceIds: [] }, script_binding: before!.script_binding });
    const restarted = new CronManager(fresh, { execute: async () => { throw new Error('script must not use Agent'); } } as any);
    await restarted.start();
    expect(restarted.getStatus().scheduledJobs).toBe(1);
    await restarted.stop();
  });

  it('manual admin triggering executes as the limited owner and rejects B with persistent tool/run audit', async () => {
    const response = await request('POST', 'jobs', { name: 'limited-agent', task_description: 'request B', cron_expr: '0 0 1 1 *', target_instance_id: 9 }, 'scoped');
    expect(response.statusCode, response.body).toBe(201);
    const id = response.json().id;
    const tool = (await getPlatformTool('get_instance_summary'))!;
    const original = tool.handler;
    const handler = vi.spyOn(tool, 'handler').mockResolvedValue({ success: true });
    const provider = { getDefaultModel: () => 'fake', chat: async (messages: any[]) => messages.some(m => m.role === 'tool')
      ? { content: 'done', usage: {}, finishReason: 'stop', toolCalls: [], hasToolCalls: false, shouldExecuteTools: false }
      : { content: null, usage: {}, finishReason: 'tool_calls', hasToolCalls: true, shouldExecuteTools: true,
        toolCalls: [{ id: 'B', name: 'get_instance_summary', arguments: { instance_id: 10 } }] } };
    const executionManager = new CronManager(cronJobService,
      new CronExecutor(new AgentRunner(provider as any), createCronToolRegistry, provider as any));
    try {
      await executionManager.executeJob((await cronJobService.getJobById(id))!, await actorContextService.loadActiveActor(7));
      expect(handler).not.toHaveBeenCalled();
      const log = await lastLog(id);
      expect((log as any).execution_authority).toMatchObject({ owner_user_id: 8, triggered_by: 7, principal_type: 'user' });
      const [rows] = await pool.query('SELECT actor_id, allowed, reason_code FROM agent_tool_audit');
      expect(rows).toEqual([expect.objectContaining({ actor_id: 8, allowed: 0, reason_code: 'INSTANCE_SCOPE_DENIED' })]);
      await pool.query('DELETE FROM instance_permissions WHERE user_id = 8');
      expect((await request('POST', `jobs/${id}/run`, {})).statusCode).toBe(403);
      expect((await lastLog(id)).error_message).toBe('CRON_TARGET_ACCESS_REVOKED');
    } finally { tool.handler = original; }
  });

  it('migration backfills trustworthy script authorizers and pauses unknown Agent owners without granting admin/system', async () => {
    const bound = await createJob(await createScript());
    const unknown = await cronJobService.createJob({ name: 'legacy-agent', task_description: 'read', cron_expr: '0 0 1 1 *' });
    const legacy = await createJob(await createScript());
    await pool.query("UPDATE cron_jobs SET owner_user_id=NULL, identity_status='owner-required', script_binding=JSON_SET(script_binding, '$.authorizedBy', 'migration:092') WHERE id=?", [legacy]);
    await pool.query("UPDATE cron_jobs SET owner_user_id=NULL, identity_status='owner-required', enabled=1 WHERE id IN (?,?)", [bound, unknown]);
    // Apply only data migration statements: schema already exists.
    for (const sql of authorityMigration.slice(2)) await pool.query(sql);
    expect(await cronJobService.getJobById(bound)).toMatchObject({ owner_user_id: 7, identity_status: 'bound' });
    expect(await cronJobService.getJobById(unknown)).toMatchObject({ owner_user_id: null, principal_type: 'user', enabled: false, identity_status: 'owner-required' });
    expect(await cronJobService.getJobById(legacy)).toMatchObject({ owner_user_id: null, enabled: false,
      identity_status: 'owner-required', script_binding: { authorizedBy: 'migration:092' } });
    expect((await request('POST', `jobs/${unknown}/toggle`, { enabled: true })).statusCode).toBe(400);
    expect((await request('PUT', `jobs/${unknown}`, { owner_user_id: 8, target_instance_id: 9 })).statusCode).toBe(200);
    expect(await cronJobService.getJobById(unknown)).toMatchObject({ owner_user_id: 8, identity_status: 'bound', enabled: false });
  });

  it('rejects client system authority and records no dispatch when run audit fails', async () => {
    expect((await request('POST', 'jobs', { name: 'spoof', task_description: 'arbitrary', cron_expr: '0 0 1 1 *', principal_type: 'system-maintenance' })).statusCode).toBe(400);
    const id = await createJob(await createScript());
    await pool.query(`CREATE TRIGGER reject_authority BEFORE UPDATE ON cron_job_logs FOR EACH ROW
      BEGIN IF NEW.execution_authority IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'isolated authority audit failure'; END IF; END`);
    try {
      expect((await request('POST', `jobs/${id}/run`, {})).statusCode).toBe(500);
      expect((await lastLog(id)).status).toBe('error');
      expect((await lastLog(id)).structured_result).toEqual(expect.objectContaining({ error_trace: expect.any(String) }));
    } finally { await pool.query('DROP TRIGGER reject_authority'); }
  });

  it.each(['owner-disabled', 'owner-deleted', 'target-deleted'])('fails closed after persisted %s without invoking the Agent', async change => {
    const res = await request('POST', 'jobs', { name: 'lifecycle', task_description: 'inspect', cron_expr: '0 0 1 1 *', target_instance_id: 9 }, 'scoped');
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    if (change === 'owner-disabled') await pool.query("UPDATE users SET status='disabled' WHERE id=8");
    if (change === 'owner-deleted') await pool.query('DELETE FROM users WHERE id=8');
    if (change === 'target-deleted') await pool.query('DELETE FROM database_instances WHERE id=9');
    try {
      const response = await request('POST', `jobs/${id}/run`, {});
      expect(response.statusCode).toBe(change === 'target-deleted' ? 400 : 403);
      expect((await lastLog(id)).error_message).toBe(change === 'target-deleted' ? 'CRON_TARGET_CHANGED' : 'CRON_OWNER_UNAVAILABLE');
      expect((await lastLog(id)).status).toBe('error');
    } finally {
      if (change === 'owner-deleted') await pool.query("INSERT INTO users VALUES (8,'scoped-manager','active',1)");
    }
  });

});
