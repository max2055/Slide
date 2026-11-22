import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { loadMigrations, MigrationRunner, splitSqlStatements } from '../migrations/runner.js';
import type { MigrationPool } from '../migrations/types.js';
import { dbConnection } from '../db-connection.js';
import { CronRunStore } from './cron-run-store.js';

// Opt-in disposable MySQL, with the same 0900 server default as CI.
const port = Number(process.env.CRON_TEST_MYSQL_PORT);
const mysqlConfig = { host: '127.0.0.1', port, user: 'root', password: process.env.CRON_TEST_MYSQL_PASSWORD ?? '' };
describe.skipIf(!port)('Cron run migration + startup recovery on MySQL 8', () => {
  it.each(['fresh', 'upgrade'] as const)('%s preserves run mapping and business evidence after restart', async mode => {
    const database = `cron_upgrade_${randomUUID().replaceAll('-', '')}`;
    const admin = await mysql.createConnection(mysqlConfig);
    const directory = await mkdtemp(join(tmpdir(), 'cron-migrations-'));
    let pool: mysql.Pool | undefined;
    let restore = () => {};
    try {
      await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
      pool = mysql.createPool({ ...mysqlConfig, database });
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

  it.each([false, true])('MAX-709 installs one collector when both names are taken (numbered name taken: %s)', async numberedNameTaken => {
    const database = `cron_upgrade_${randomUUID().replaceAll('-', '')}`;
    const admin = await mysql.createConnection(mysqlConfig);
    const directory = await mkdtemp(join(tmpdir(), 'cron-migrations-'));
    let pool: mysql.Pool | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
      const db = pool = mysql.createPool({ ...mysqlConfig, database });
      const migrationId = '166_database_log_collection_cron.sql';
      const migrations = await loadMigrations();
      const collectorMigration = migrations.find(migration => migration.id === migrationId)!;
      for (const migration of migrations.filter(migration => migration.id < migrationId)) {
        await writeFile(join(directory, migration.id), migration.sql);
      }
      const migrationPool = db as unknown as MigrationPool;
      await new MigrationRunner(migrationPool, directory).run();

      const [users] = await db.query<mysql.RowDataPacket[]>('SELECT id FROM users ORDER BY id LIMIT 1');
      const ownerId = users[0].id;
      const defaultName = '数据库日志采集';
      const systemName = '数据库日志采集（系统）';
      const [taken] = await db.execute<mysql.ResultSetHeader>(`UPDATE cron_jobs
        SET owner_user_id = ?, identity_status = 'bound', task_description = 'user-defined script',
            cron_expr = '0 */7 * * * *', timezone = 'UTC', enabled = 1
        WHERE name = ? AND task_type = 'script'`, [ownerId, defaultName]);
      expect(taken.affectedRows).toBe(1);
      const names = [systemName];
      if (numberedNameTaken) {
        const [[firstJob]] = await db.query<mysql.RowDataPacket[]>('SELECT id FROM cron_jobs ORDER BY id LIMIT 1');
        names.push(`${systemName} #${firstJob.id}`);
      }
      for (const name of names) {
        await db.execute(`INSERT INTO cron_jobs
          (name, task_description, cron_expr, enabled, task_type, owner_user_id, principal_type, identity_status)
          VALUES (?, 'user-defined agent job', '0 */11 * * * *', 0, 'agent', ?, 'user', 'bound')`, [name, ownerId]);
      }
      const readUserJobs = async () => (await db.execute<mysql.RowDataPacket[]>(
        'SELECT * FROM cron_jobs WHERE owner_user_id = ? ORDER BY id', [ownerId],
      ))[0];
      const userJobs = await readUserJobs();
      expect(userJobs.map(job => [job.name, job.enabled])).toEqual([
        [defaultName, 1], ...names.map(name => [name, 0]),
      ]);

      const assertJobs = async () => {
        expect(await readUserJobs()).toEqual(userJobs);
        const [collectors] = await db.query<mysql.RowDataPacket[]>(`SELECT id, name, enabled, task_type, principal_type,
          identity_status, owner_user_id, script_id FROM cron_jobs WHERE handler_key = 'database.logs.collect'`);
        expect(collectors).toEqual([expect.objectContaining({
          enabled: 0, task_type: 'agent', principal_type: 'system-maintenance', identity_status: 'bound',
          owner_user_id: null, script_id: null,
        })]);
        expect([defaultName, ...names]).not.toContain(collectors[0].name);
        return collectors[0];
      };
      const runner = new MigrationRunner(migrationPool);
      await runner.run();
      const collector = await assertJobs();
      await runner.run();
      expect(await assertJobs()).toEqual(collector);
      for (const statement of splitSqlStatements(collectorMigration.sql)) {
        await db.query(statement);
      }
      expect(await assertJobs()).toEqual(collector);
      expect((await runner.inspect()).filter(row => row.migration_id === migrationId)).toEqual([
        expect.objectContaining({ status: 'completed', checksum: collectorMigration.checksum }),
      ]);
    } finally {
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
