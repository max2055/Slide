import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { loadMigrations, MigrationRunner } from './runner.js';
import { dbConnection } from '../db-connection.js';
import { aiAnalysisDatabaseService } from '../ai-analysis-database-service.js';
import { reportDatabaseService } from '../report-database-service.js';
import { AnalysisDispatchStore } from '../analysis/analysis-dispatch-store.js';
import { CronRunStore } from '../cron/cron-run-store.js';

// Only run inside run-environment.sh's own disposable container. No .env loading.
const container = process.env.AUDIT_UPGRADE_CONTAINER;
describe.skipIf(!container)('W14 audited baseline upgrade and snapshot rollback', () => {
  it('upgrades 7916d44 data, preserves legacy reads on repeat recovery, and restores the pre-upgrade snapshot', async () => {
    expect(container).toMatch(/^slide-qualification-\d+-\d+$/);
    expect(process.env.DB_HOST).toBe('127.0.0.1');
    expect(process.env.DB_NAME).toMatch(/^slide_qualification_\d+$/);
    const database = `${process.env.DB_NAME}_upgrade`;
    const restored = `${process.env.DB_NAME}_rollback`;
    const directory = await mkdtemp(join(tmpdir(), 'slide-audit-baseline-'));
    const options = { host: '127.0.0.1', port: Number(process.env.DB_PORT), user: 'root', password: process.env.DB_PASSWORD };
    const admin = await mysql.createConnection(options);
    let pool: mysql.Pool | undefined;
    let rollback: mysql.Pool | undefined;
    let restorePool = () => {};
    try {
      const migrations = await loadMigrations();
      const baseline = migrations.filter(m => m.id < '105_');
      // Audited git tree: 7916d44f3fb4ca82a1a2735298efa441b4c4550f.
      // Pin the complete SQL set, so shallow CI checkouts need no git fetch.
      const digest = createHash('sha256');
      for (const migration of baseline) {
        digest.update(`${migration.id}\0${migration.checksum}\n`);
        await writeFile(join(directory, migration.id), migration.sql);
      }
      expect(baseline).toHaveLength(108);
      expect(digest.digest('hex')).toBe('75ac10941fde3172e0371ebb192eff510903bc3a4ae999683e96d9fe78552aa5');
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
      pool = mysql.createPool({ ...options, database });
      const old = new MigrationRunner(pool as any, directory);
      await old.run();
      await pool.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted) VALUES (42,'legacy instance','not-connected.invalid',3306,'fake','fake-not-used')");
      await pool.query("INSERT INTO ai_analysis (id,analysis_type,instance_id,status,result) VALUES (42,'fault_diagnosis',42,'completed','{\"summary\":\"old completed result\"}'),(43,'fault_diagnosis',42,'running','{\"summary\":\"old uncertain result\"}'),(44,'fault_diagnosis',42,'pending',NULL)");
      await pool.query("INSERT INTO reports (id,name,type,instance_id,status,content,data) VALUES (42,'old report','health',42,'completed','old report content','{\"old\":true}')");
      await pool.query("INSERT INTO report_configs (id,name,cron,type,instance_id) VALUES (42,'old config','0 0 * * *','health',42)");
      await pool.query("INSERT INTO report_schedule_occurrences (config_id,occurrence_at,state,report_id) VALUES (42,'2026-10-01 00:00:00','completed',42),(42,'2026-10-02 00:00:00','running',NULL)");
      await pool.query("INSERT INTO cron_jobs (id,name,cron_expr,task_description,enabled,task_type) VALUES (4242,'ownerless legacy','0 0 1 1 *','legacy task',1,'agent')");
      await pool.query("INSERT INTO cron_job_logs (job_id,status,started_at,result_summary) VALUES (4242,'success',NOW(),'old runner ended')");
      await pool.query("INSERT INTO metric_v2_observations (id,series_hash,stage,observed_at,stored_at,valid_value,payload,payload_hash) VALUES ('old-raw',REPEAT('a',64),'raw',NOW(),NOW(),1,'{\"value\":7}',REPEAT('b',64))");
      const before = await old.inspect();
      const dump = execFileSync('docker', ['exec', '-e', `MYSQL_PWD=${options.password}`, container!, 'mysqldump', '-uroot', '--single-transaction', database], { maxBuffer: 16 * 1024 * 1024 });

      const runner = new MigrationRunner(pool as any);
      await runner.run();
      const upgradedLedger = await runner.inspect();
      await runner.run();
      expect(await runner.inspect()).toEqual(upgradedLedger);
      expect(upgradedLedger.filter(row => row.migration_id < '105_')).toEqual(before);
      expect(upgradedLedger).toHaveLength(migrations.length);
      expect(upgradedLedger.filter(row => row.migration_id >= '105_').every(row => row.status === 'completed')).toBe(true);
      restorePool = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool).mockRestore;
      const analysis = new AnalysisDispatchStore(() => pool!);
      await analysis.assertSchema();
      // Migration never invents paid execution provenance or durable ownership.
      expect(await aiAnalysisDatabaseService.getAnalysisById(42)).toMatchObject({ status: 'completed', result: { summary: 'old completed result' } });
      const report = await reportDatabaseService.getReportById(42);
      expect(report).toMatchObject({ status: 'completed', content: 'old report content', data: { old: true } });
      await analysis.recoverLegacy(); await analysis.recoverLegacy();
      await new CronRunStore().recover(); await new CronRunStore().recover();
      expect(await aiAnalysisDatabaseService.getAnalysisById(43)).toMatchObject({ status: 'unknown', result: { summary: 'old uncertain result' } });
      expect(await aiAnalysisDatabaseService.getAnalysisById(44)).toMatchObject({ status: 'unknown', result: null });
      expect(await reportDatabaseService.getReportById(42)).toEqual(report);
      const rows = async (sql: string) => (await pool!.query<mysql.RowDataPacket[]>(sql))[0];
      expect((await rows('SELECT enabled,identity_status,owner_user_id FROM cron_jobs WHERE id=4242'))[0]).toMatchObject({ enabled: 0, identity_status: 'owner-required', owner_user_id: null });
      expect((await rows('SELECT status,run_id,result_summary FROM cron_job_logs WHERE job_id=4242'))[0]).toMatchObject({ status: 'success', run_id: null, result_summary: 'old runner ended' });
      expect(await rows('SELECT state,report_id,workflow_job_id,staged_report_id FROM report_schedule_occurrences ORDER BY occurrence_at')).toEqual([
        expect.objectContaining({ state: 'completed', report_id: 42, workflow_job_id: null, staged_report_id: null }),
        expect.objectContaining({ state: 'running', report_id: null, workflow_job_id: null, staged_report_id: null }),
      ]);
      expect((await rows("SELECT payload,tombstone FROM metric_v2_observations WHERE id='old-raw'"))[0]).toMatchObject({ payload: { value: 7 }, tombstone: null });
      expect((await rows('SELECT lifecycle_state FROM database_instances WHERE id=42'))[0].lifecycle_state).toBe('available');
      expect(await rows('SELECT * FROM analysis_dispatches')).toEqual([]);
      expect(await rows("SELECT * FROM workflow_jobs WHERE job_type IN ('analysis.dispatch','cron.execute','report.occurrence')")).toEqual([]);

      // Rehearse a database snapshot rollback, never reverse-DDL a live ledger.
      await admin.query(`CREATE DATABASE \`${restored}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
      const restore = spawnSync('docker', ['exec', '-i', '-e', `MYSQL_PWD=${options.password}`, container!, 'mysql', '-uroot', restored], { input: dump, encoding: 'utf8', timeout: 30_000 });
      expect(restore.error).toBeUndefined(); expect(restore.status, restore.stderr).toBe(0);
      rollback = mysql.createPool({ ...options, database: restored });
      const restoredRunner = new MigrationRunner(rollback as any, directory);
      expect(await restoredRunner.inspect()).toEqual(before);
      await restoredRunner.run();
      const [oldResults] = await rollback.query<mysql.RowDataPacket[]>('SELECT id,status,result FROM ai_analysis ORDER BY id');
      expect(oldResults).toEqual([
        expect.objectContaining({ id: 42, status: 'completed', result: { summary: 'old completed result' } }),
        expect.objectContaining({ id: 43, status: 'running', result: { summary: 'old uncertain result' } }),
        expect.objectContaining({ id: 44, status: 'pending', result: null }),
      ]);
      const [oldJob] = await rollback.query<mysql.RowDataPacket[]>('SELECT enabled FROM cron_jobs WHERE id=4242');
      expect(oldJob[0].enabled).toBe(1);
      // A restored snapshot can be upgraded again with identical old results.
      await new MigrationRunner(rollback as any).run();
      const [again] = await rollback.query<mysql.RowDataPacket[]>('SELECT id,status,result FROM ai_analysis ORDER BY id');
      expect(again).toEqual(oldResults);
      console.log(`W14 upgrade passed: baseline=7916d44 migrations=${baseline.length}->${migrations.length}; legacy reads, recovery twice, snapshot restore and re-upgrade`);
    } finally {
      restorePool(); await rollback?.end(); await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.query(`DROP DATABASE IF EXISTS \`${restored}\``);
      await admin.end(); await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
