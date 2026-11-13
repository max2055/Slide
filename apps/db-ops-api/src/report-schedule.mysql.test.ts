/** MAX-411: explicit opt-in; production config handlers + real persistence and workflow scan. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import ts from 'typescript';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import { dbConnection } from './db-connection.js';
import { MigrationRunner } from './migrations/runner.js';
import { createOwnedDatabase } from './testing/owned-fixture.js';
import { reportConfigService } from './report-config-database-service.js';
import { InvalidReportCronError } from './report-cron.js';
import { ReportSchedulePartialFailure, MysqlReportOccurrenceStore, createReportScheduleJob } from './report-scheduler.js';
import { registerReportScheduleHandler } from './workflows/report-schedule-handler.js';
import { JobRegistry } from './workflows/job-registry.js';
import { MysqlWorkflowStore, WorkerRuntime } from './workflows/worker-runtime.js';
import { notificationDatabaseService } from './notification-database-service.js';
import { actorContextService, signAccessToken } from './auth/actor-context.js';
import { createVerifyToken } from './auth-middleware.js';
import { requirePermission } from './auth/require-permission.js';
import { hasInstanceAccess } from './auth/require-instance-access.js';

describe.skipIf(process.env.SLIDE_REPORT_MYSQL !== '1')('MAX-411 real MySQL config and scheduling acceptance', () => {
  let root: mysql.Pool, pool: mysql.Pool, token: string;
  let owned: Awaited<ReturnType<typeof createOwnedDatabase>>;
  const app = Fastify();
  beforeAll(async () => {
    const file = process.env.SLIDE_TEST_PROFILES_FILE;
    const handleDir = process.env.SLIDE_TEST_HANDLE_DIR;
    if (!file || !handleDir) throw Error('explicit profiles and handle directory required');
    const c = JSON.parse(readFileSync(file, 'utf8'))['mysql-test'];
    if (Number(c.port) === 3306) throw Error('platform database forbidden');
    root = mysql.createPool({ host: c.host, port: c.port, user: c.user, password: c.password });
    owned = await createOwnedDatabase(root as any, { nonce: randomBytes(8).toString('hex'), purpose: 'reportcron', handleDir });
    pool = mysql.createPool({ host: c.host, port: c.port, user: c.user, password: c.password, database: owned.database, connectionLimit: 3, timezone: 'Z' });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    console.info('MAX411 phase: formal migrations');
    await new MigrationRunner(pool as any).run();
    await pool.query("INSERT INTO database_instances(id,name,host,port,username,password_encrypted) VALUES(701,'report fixture','fixture.invalid',3307,'fixture','unused')");
    await pool.query("INSERT INTO users(id,username,password_hash) VALUES(701,'report-fixture','no-login')");
    await pool.query("INSERT INTO roles(id,name) VALUES(701,'report-fixture')");
    await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code='report:create'");
    await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(701,701)');
    await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(701,701,'read-write')");
    const secret = randomBytes(32).toString('hex');
    token = signAccessToken(await actorContextService.loadActiveActor(701), secret);
    // Execute the exact production POST/PUT registration blocks without starting unrelated workers.
    // This is handler-level HTTP acceptance, not a full server startup test.
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const start = source.indexOf("  fastify.post('/api/reports/configs'");
    const end = source.indexOf('  // 删除报表配置', start);
    if (start < 0 || end < 0) throw Error('production config route boundaries missing');
    const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    new Function('fastify', 'verifyToken', 'requirePermission', 'hasInstanceAccess', 'reportConfigService', 'notificationDatabaseService', 'InvalidReportCronError', code)(app, createVerifyToken(secret), requirePermission, hasInstanceAccess, reportConfigService, notificationDatabaseService, InvalidReportCronError);
  }, 120000);
  afterAll(async () => {
    console.info('MAX411 phase: cleanup');
    await app.close(); vi.restoreAllMocks(); await pool?.end();
    try { await owned?.drop(); } finally { await root?.end(); }
    console.info('MAX411 cleanup: success');
  });
  const request = (method: 'POST' | 'PUT', payload: Record<string, unknown>, id?: number) => app.inject({ method, url: '/api/reports/configs' + (id ? `/${id}` : ''), headers: { authorization: `Bearer ${token}` }, payload });
  it('rejects invalid create/update as HTTP 400, keeps stored values and accepts runtime syntax', async () => {
    const value = { name: 'report', cron: '0 9 * JAN MON', type: 'health', instance_id: 701 };
    for (const cron of ['bad', '61 * * * * *', ' ', 7, null]) expect((await request('POST', { ...value, cron })).statusCode).toBe(400);
    const created = await request('POST', value);
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    const before = await reportConfigService.getConfigById(id);
    expect((await request('PUT', { cron: 'bad', name: 'must not persist' }, id)).statusCode).toBe(400);
    expect(await reportConfigService.getConfigById(id)).toEqual(before);
    for (const cron of ['* * * * *', '0 */5 * * * *', '@daily']) {
      expect((await request('PUT', { cron }, id)).statusCode).toBe(200);
      expect((await reportConfigService.getConfigById(id))?.cron).toBe(cron);
    }
    expect((await app.inject({ method: 'POST', url: '/api/reports/configs', payload: value })).statusCode).toBe(401);
  });
  it('production report.schedule records partial failure while later healthy config persists exactly once', async () => {
    await pool.query('DELETE FROM report_configs');
    for (const [id, cron] of [[801, 'bad'], [802, '* * * * *'], [803, '* * * * *']] as const) {
      await pool.execute("INSERT INTO report_configs(id,name,cron,type,instance_id,enabled,created_at) VALUES(?, 'history', ?, 'health', 701, 1, '2026-01-01 00:00:00')", [id, cron]);
    }
    await pool.query("UPDATE report_configs SET created_at = DATE_ADD('2026-01-01 00:00:00', INTERVAL (804-id) SECOND)");
    expect((await reportConfigService.getEnabledConfigs()).map(c => c.id)).toEqual([801, 802, 803]);
    // Single-row durable write failure; healthy occurrence + workflow job use real transactions.
    await pool.query("CREATE TRIGGER max411_fail BEFORE INSERT ON report_schedule_occurrences FOR EACH ROW BEGIN IF NEW.config_id = 802 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MAX411_INJECTED_WRITE'; END IF; END");
    const registry = new JobRegistry(); const workflows = new MysqlWorkflowStore(() => pool as any);
    registerReportScheduleHandler(registry, {
      reportConfigService, createOccurrenceStore: () => new MysqlReportOccurrenceStore(() => pool),
      enqueueReportSchedule: date => workflows.enqueue(createReportScheduleJob(date)).then(() => {}),
      serverReportService: { generateAndPersist: async () => { throw Error('unexpected generation'); } },
      reportService: { generateReport: async () => { throw Error('unexpected generation'); } },
    });
    const job = { ...createReportScheduleJob(), attempts: 1, maxAttempts: 5, fencingToken: 1 } as any;
    const error = await registry.executeWithResult(job).catch(e => e);
    expect(error).toBeInstanceOf(ReportSchedulePartialFailure);
    if (!(error instanceof ReportSchedulePartialFailure)) throw error;
    expect(error.failures.map((f: any) => [f.configId, f.stage]).sort()).toEqual([[801, 'nextOccurrence'], [802, 'schedule']]);
    expect(error.due).toMatchObject([{ configId: 803 }]);
    const [rows] = await pool.query<any[]>('SELECT config_id, workflow_job_id FROM report_schedule_occurrences');
    expect(rows.map(r => r.config_id)).toEqual([803]);
    const [jobs] = await pool.query<any[]>("SELECT job_type FROM workflow_jobs");
    expect(jobs.map(r => r.job_type).sort()).toEqual(['report.occurrence', 'report.schedule']);
    // The worker must persist the failed scan instead of acknowledging it as completed.
    const scan = createReportScheduleJob(new Date('2026-01-01T00:00:00Z'));
    await workflows.enqueue(scan);
    const worker = new WorkerRuntime(workflows, 'max411-acceptance');
    expect(await worker.runOnce((job, context) => registry.execute(job, context))).toBe('retry');
    const [failed] = await pool.execute<any[]>('SELECT state,last_error FROM workflow_jobs WHERE id=?', [scan.id]);
    expect(failed[0].state).toBe('retry');
    expect(failed[0].last_error).toContain('REPORT_SCHEDULE_PARTIAL_FAILURE:801/nextOccurrence,802/schedule');
    expect((await request('PUT', { enabled: false }, 801)).statusCode).toBe(200);
    expect((await request('PUT', { enabled: true }, 801)).statusCode).toBe(400);
    await pool.query('DROP TRIGGER max411_fail');
    await expect(reportConfigService.updateConfig(801, { cron: '@daily', enabled: true })).resolves.toBe(true);
  });
});
