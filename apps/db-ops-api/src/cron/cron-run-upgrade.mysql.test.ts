import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { loadMigrations, MigrationRunner } from '../migrations/runner.js';
import type { MigrationPool } from '../migrations/types.js';
import { dbConnection } from '../db-connection.js';
import { CronRunStore } from './cron-run-store.js';

// Opt-in disposable MySQL, with the same 0900 server default as CI.
const port = Number(process.env.CRON_TEST_MYSQL_PORT);
describe.skipIf(!port)('Cron run migration + startup recovery on MySQL 8', () => {
  it.each(['fresh', 'upgrade'] as const)('%s preserves run mapping and business evidence after restart', async mode => {
    const database = `cron_upgrade_${randomUUID().replaceAll('-', '')}`;
    const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '' });
    const directory = await mkdtemp(join(tmpdir(), 'cron-migrations-'));
    let pool: mysql.Pool | undefined;
    let restore = () => {};
    try {
      await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
      pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database });
      const migrations = await loadMigrations();
      const original = migrations.find(m => m.id === '106_cron_runs.sql')!;
      for (const migration of migrations.filter(m => m.id <= original.id)) {
        await writeFile(join(directory, migration.id), migration.sql);
      }
      const migrationPool = pool as unknown as MigrationPool;
      await new MigrationRunner(migrationPool, mode === 'upgrade' ? directory : undefined).run();
      restore = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool).mockRestore;
      const store = new CronRunStore();
      const [jobs] = await pool.query<mysql.RowDataPacket[]>('SELECT id FROM cron_jobs LIMIT 1');
      const jobId = jobs[0].id;
      const queued = await store.enqueue(jobId, null, 'queued', {}, null);
      const expected = [];
      for (const status of ['failure', 'partial', null] as const) {
        const run = await store.enqueue(jobId, null, `running-${status}`, {}, null);
        await store.start(run.runId);
        const [log] = await pool.query<mysql.ResultSetHeader>(
          "INSERT INTO cron_job_logs (job_id, started_at, status) VALUES (?, NOW(), 'running')", [jobId]);
        await store.bindLog(run.runId, log.insertId);
        const completion = status ? { status, summary: `persisted-${status}`, result: { value: 1 } } : null;
        if (completion) await store.saveCompletion(run.runId, completion);
        expected.push({ runId: run.runId, status: status === 'failure' ? 'failed' : status ?? 'unknown', completion });
      }
      await pool.query("INSERT INTO cron_job_logs (job_id, started_at, status) VALUES (?, NOW(), 'success')", [jobId]);
      if (mode === 'upgrade') {
        const [columns] = await pool.query<mysql.RowDataPacket[]>(`SELECT TABLE_NAME, COLLATION_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('cron_runs','cron_job_logs') AND COLUMN_NAME = 'run_id' ORDER BY TABLE_NAME`);
        expect(columns.map(c => c.COLLATION_NAME)).toEqual(['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci']);
        await new MigrationRunner(migrationPool).run();
      }
      // Repeat bootstrap must neither reject 106's recorded checksum nor rewrite run state.
      await new MigrationRunner(migrationPool).run();
      const [ledger] = await pool.query<mysql.RowDataPacket[]>("SELECT checksum, status FROM app_schema_migrations WHERE migration_id = '106_cron_runs.sql'");
      expect(ledger[0]).toMatchObject({ checksum: original.checksum, status: 'completed' });
      const restarted = new CronRunStore();
      await restarted.recover();
      await restarted.recover();
      expect(await restarted.get(queued.runId)).toMatchObject({ status: 'queued', runnerFinishedAt: null });
      const [intents] = await pool.query<mysql.RowDataPacket[]>('SELECT id FROM workflow_jobs WHERE id = ?', [queued.runId]);
      expect(intents).toEqual([expect.objectContaining({ id: queued.runId })]);
      for (const run of expected) {
        expect(await restarted.get(run.runId)).toMatchObject({ ...run, runnerFinishedAt: expect.anything() });
        const [logs] = await pool.query<mysql.RowDataPacket[]>('SELECT status, structured_result FROM cron_job_logs WHERE run_id = ?', [run.runId]);
        expect(logs[0]).toMatchObject({ status: run.status === 'failed' ? 'error' : run.status, structured_result: run.completion });
      }
      const [legacy] = await pool.query<mysql.RowDataPacket[]>('SELECT status FROM cron_job_logs WHERE run_id IS NULL');
      expect(legacy).toEqual([expect.objectContaining({ status: 'success' })]);
    } finally {
      restore();
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
