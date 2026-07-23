import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationError, MigrationRunner, splitSqlStatements, statementsForExecution } from '../src/migrations/runner.js';

class FakePool {
  entries = new Map<string, any>();
  calls: string[] = [];
  lockAvailable = true;
  async getConnection() { return { query: this.query.bind(this), release() {} }; }
  async query(sql: string, values: any[] = []): Promise<any> {
    this.calls.push(sql);
    if (sql.includes('GET_LOCK')) return [[{ locked: this.lockAvailable ? 1 : 0 }]];
    if (sql.includes('RELEASE_LOCK') || sql.startsWith('CREATE TABLE')) return [[{}]];
    if (sql.includes('COUNT(*) AS count') || sql.includes('information_schema.TABLES')) return [[]];
    if (sql.includes("TABLE_NAME = 'alerts'")) {
      return [[{ column_type: "enum('info','warning','error','critical','p0')" }]];
    }
    if (sql.includes('information_schema.COLUMNS')) return [[
      ...['id', 'username', 'password_hash', 'session_version'].map((column_name) => ({ table_name: 'users', column_name })),
      ...['id', 'token_hash', 'user_id', 'session_version', 'revoked'].map((column_name) => ({ table_name: 'refresh_tokens', column_name })),
      ...['id', 'status', 'operation_id'].map((column_name) => ({ table_name: 'approval_requests', column_name })),
      ...['id', 'actor_id', 'idempotency_key', 'state', 'correlation_id'].map((column_name) => ({ table_name: 'operations', column_name })),
      ...['id', 'operation_id', 'to_state', 'reason_code'].map((column_name) => ({ table_name: 'operation_events', column_name })),
      ...['id', 'session_id', 'granted_by', 'recipient_user_id'].map((column_name) => ({ table_name: 'chat_session_shares', column_name })),
      ...['id', 'name', 'deployment_type', 'api_format'].map((column_name) => ({ table_name: 'llm_providers', column_name })),
      ...['id', 'analysis_type', 'execution_trace', 'analysis_envelope'].map((column_name) => ({ table_name: 'ai_analysis', column_name })),
      ...['id', 'instance_id', 'health_score', 'status', 'dimensions', 'checks'].map((column_name) => ({ table_name: 'health_check_history', column_name })),
    ]];
    if (sql.includes('information_schema.STATISTICS')) return [[
      { table_name: 'refresh_tokens', index_name: 'idx_rt_user_session' },
      { table_name: 'operations', index_name: 'uq_operations_actor_idempotency' },
      { table_name: 'operation_events', index_name: 'idx_operation_events_operation_created' },
    ]];
    if (sql.includes('information_schema.REFERENTIAL_CONSTRAINTS')) return [[
      { table_name: 'sql_execution_history', constraint_name: 'fk_sql_history_approval' },
      { table_name: 'approval_requests', constraint_name: 'fk_approval_operation' },
      { table_name: 'operations', constraint_name: 'fk_operation_approval' },
      { table_name: 'operation_events', constraint_name: 'fk_operation_events_operation' },
    ]];
    if (sql.startsWith('SELECT migration_id')) return [[this.entries.get(values[0])].filter(Boolean)];
    if (sql.startsWith('INSERT INTO app_schema_migrations')) {
      this.entries.set(values[0], { migration_id: values[0], checksum: values[1], status: sql.includes("'running'") ? 'running' : 'baselined' });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE app_schema_migrations SET status = \'completed\'')) {
      this.entries.get(values[0]).status = 'completed';
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE app_schema_migrations SET status = \'failed\'')) {
      this.entries.get(values[2]).status = 'failed';
      return [{ affectedRows: 1 }];
    }
    return [[{}]];
  }
}

const dirs: string[] = [];
async function migrationDirectory(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'slide-migrations-'));
  dirs.push(dir);
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(dir, name), content)));
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('MigrationRunner', () => {
  it('preserves semicolons inside quoted migration SQL', () => {
    expect(splitSqlStatements("INSERT INTO t VALUES ('a;b'); -- ignored;\nSELECT 1;")).toEqual([
      "INSERT INTO t VALUES ('a;b')",
      '-- ignored;\nSELECT 1',
    ]);
  });

  it('uses the MySQL 9 compatibility spelling without changing historical migration content', () => {
    const sql = 'ALTER TABLE cron_job_logs ADD COLUMN stop_reason VARCHAR(50) AFTER usage;';
    expect(statementsForExecution({ id: '010_add_task_description_log_columns.sql', sql, checksum: 'historic' })).toEqual([
      'ALTER TABLE cron_job_logs ADD COLUMN stop_reason VARCHAR(50) AFTER `usage`',
    ]);
    expect(statementsForExecution({ id: '011_other.sql', sql, checksum: 'other' })).toEqual([
      'ALTER TABLE cron_job_logs ADD COLUMN stop_reason VARCHAR(50) AFTER usage',
    ]);
    const cronSql = "ALTER TABLE `cron_jobs` ADD COLUMN `task_type` ENUM('script', 'agent') NOT NULL DEFAULT 'agent' AFTER `enabled` COMMENT 'Execution mode: script (SQL/shell) or agent (AI-driven)', ADD COLUMN `script_id` INT UNSIGNED DEFAULT NULL AFTER `task_type` COMMENT 'FK referencing cron_scripts.id for script mode', ADD COLUMN `target_instance_id` INT UNSIGNED DEFAULT NULL AFTER `script_id` COMMENT 'FK referencing database_instances.id — target managed DB instance for script execution';";
    expect(statementsForExecution({ id: '017_add_cron_scripts.sql', sql: cronSql, checksum: 'historic' })[0]).toContain("COMMENT 'Execution mode: script (SQL/shell) or agent (AI-driven)' AFTER `enabled`");
  });

  it('uses a ledger and runs completed migrations only once', async () => {
    const directory = await migrationDirectory({ '100_example.sql': 'CREATE TABLE example (id INT);' });
    const pool = new FakePool();
    const runner = new MigrationRunner(pool as any, directory);
    await runner.run();
    const firstRunCalls = pool.calls.filter((sql) => sql.startsWith('CREATE TABLE example')).length;
    await runner.run();
    expect(firstRunCalls).toBe(1);
    expect(pool.calls.filter((sql) => sql.startsWith('CREATE TABLE example'))).toHaveLength(1);
  });

  it('blocks changed checksums and unavailable migration locks', async () => {
    const directory = await migrationDirectory({ '100_example.sql': 'SELECT 1;' });
    const pool = new FakePool();
    const runner = new MigrationRunner(pool as any, directory);
    const checksum = createHash('sha256').update('old').digest('hex');
    pool.entries.set('100_example.sql', { migration_id: '100_example.sql', checksum, status: 'completed' });
    await expect(runner.run()).rejects.toThrow('Checksum mismatch');
    pool.entries.clear();
    pool.lockAvailable = false;
    await expect(runner.run()).rejects.toBeInstanceOf(MigrationError);
  });
});
