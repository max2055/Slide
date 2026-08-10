import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MigrationConnection, MigrationLedgerEntry, MigrationPool, SqlMigration } from './types.js';
import { assertSchemaInvariants } from './invariants.js';

const here = dirname(fileURLToPath(import.meta.url));
const defaultDirectory = join(here, '../../sql/migrations');
const lockName = 'slide:db-ops:migrations:v1';
const snapshotId = '000_schema_baseline.sql';

export class MigrationError extends Error {}

export async function loadMigrations(directory = defaultDirectory): Promise<SqlMigration[]> {
  const files = (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  return Promise.all(files.map(async (id) => {
    const sql = await readFile(join(directory, id), 'utf8');
    return { id, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

// MySQL migrations use quoted strings and comments; a plain split(';') corrupts them.
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];
    if (lineComment) { current += char; if (char === '\n') lineComment = false; continue; }
    if (blockComment) { current += char; if (char === '*' && next === '/') { current += next; i++; blockComment = false; } continue; }
    if (!quote && char === '-' && next === '-' && /\s/.test(sql[i + 2] ?? '')) { current += char; lineComment = true; continue; }
    if (!quote && char === '#') { current += char; lineComment = true; continue; }
    if (!quote && char === '/' && next === '*') { current += char; blockComment = true; continue; }
    current += char;
    if (quote) {
      if (char === '\\') { current += next ?? ''; i++; continue; }
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === ';') {
      const statement = current.slice(0, -1).trim();
      if (statement && !/^--[^\n]*(\n|$)\s*$/.test(statement)) statements.push(statement);
      current = '';
    }
  }
  const trailing = current.trim();
  if (trailing && !/^--[^\n]*(\n|$)\s*$/.test(trailing)) statements.push(trailing);
  return statements;
}

/**
 * Historical migration files are checksum-immutable. MySQL 9 made `usage` a
 * reserved word, while the already-recorded 010 migration used it unquoted in
 * an AFTER clause. Preserve the ledger checksum and execute the one
 * semantically equivalent compatibility spelling on newer servers.
 */
export function statementsForExecution(migration: SqlMigration): string[] {
  const statements = splitSqlStatements(migration.sql);
  if (migration.id === '010_add_task_description_log_columns.sql') {
    return statements.map((statement) => statement.replace(/\bAFTER usage\b/, 'AFTER `usage`'));
  }
  if (migration.id === '015_add_output_schema.sql') {
    return statements.map((statement) => statement.replace(
      /DEFAULT NULL AFTER (task_description|result)\s+COMMENT ('[^']*')/,
      'DEFAULT NULL COMMENT $2 AFTER $1',
    ));
  }
  if (migration.id === '017_add_cron_scripts.sql') {
    return statements.map((statement) => statement.replace(
      /ADD COLUMN `task_type` ENUM\('script', 'agent'\) NOT NULL DEFAULT 'agent' AFTER `enabled`\s+COMMENT 'Execution mode: script \(SQL\/shell\) or agent \(AI-driven\)',\s+ADD COLUMN `script_id` INT UNSIGNED DEFAULT NULL AFTER `task_type`\s+COMMENT 'FK referencing cron_scripts\.id for script mode',\s+ADD COLUMN `target_instance_id` INT UNSIGNED DEFAULT NULL AFTER `script_id`\s+COMMENT 'FK referencing database_instances\.id — target managed DB instance for script execution'/,
      "ADD COLUMN `task_type` ENUM('script', 'agent') NOT NULL DEFAULT 'agent' COMMENT 'Execution mode: script (SQL/shell) or agent (AI-driven)' AFTER `enabled`,\n  ADD COLUMN `script_id` INT UNSIGNED DEFAULT NULL COMMENT 'FK referencing cron_scripts.id for script mode' AFTER `task_type`,\n  ADD COLUMN `target_instance_id` INT UNSIGNED DEFAULT NULL COMMENT 'FK referencing database_instances.id — target managed DB instance for script execution' AFTER `script_id`",
    ));
  }
  return statements;
}

export class MigrationRunner {
  constructor(private readonly pool: MigrationPool, private readonly directory = defaultDirectory) {}

  async inspect(): Promise<MigrationLedgerEntry[]> {
    await this.ensureLedger();
    const [rows] = await this.pool.query<MigrationLedgerEntry[]>('SELECT migration_id, checksum, status, statement_index, error FROM app_schema_migrations ORDER BY migration_id');
    return rows;
  }

  async run(): Promise<void> {
    await this.ensureLedger();
    const connection = await this.pool.getConnection();
    try {
      const [locks] = await connection.query<Array<{ locked: number }>>('SELECT GET_LOCK(?, 30) AS locked', [lockName]);
      if (Number(locks[0]?.locked) !== 1) throw new MigrationError('Could not acquire migration lock');
      try {
        await this.runLocked(connection);
        await assertSchemaInvariants(this.pool);
      }
      finally { await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); }
    } finally { connection.release(); }
  }

  async baseline(actor: string, reason: string): Promise<void> {
    if (!actor.trim() || !reason.trim()) throw new MigrationError('Baseline requires actor and reason');
    await this.ensureLedger();
    const migrations = await loadMigrations(this.directory);
    const [existing] = await this.pool.query<MigrationLedgerEntry[]>('SELECT migration_id FROM app_schema_migrations LIMIT 1');
    if (existing.length) throw new MigrationError('Schema migration ledger is not empty');
    const [tables] = await this.pool.query<Array<{ name: string }>>(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('users', 'approval_requests', 'operations')`,
    );
    if (tables.length < 3) throw new MigrationError('Schema cannot be baselined: required tables are missing');
    await assertSchemaInvariants(this.pool);
    for (const migration of migrations) {
      await this.pool.query(
        `INSERT INTO app_schema_migrations (migration_id, checksum, status, finished_at, error)
         VALUES (?, ?, 'baselined', NOW(), ?)`,
        [migration.id, migration.checksum, `baseline by ${actor}: ${reason}`],
      );
    }
  }

  async repair(id: string, actor: string, reason: string): Promise<void> {
    if (!actor.trim() || !reason.trim()) throw new MigrationError('Repair requires actor and reason');
    const migrations = await loadMigrations(this.directory);
    const migration = migrations.find((item) => item.id === id);
    if (!migration) throw new MigrationError(`Unknown migration ${id}`);
    const [result] = await this.pool.query<{ affectedRows: number }>(
      `UPDATE app_schema_migrations SET status = 'completed', error = ?, finished_at = NOW()
       WHERE migration_id = ? AND status = 'failed'`,
      [`repair by ${actor}: ${reason}`, id],
    );
    if (!Number(result.affectedRows)) throw new MigrationError(`Migration ${id} is not failed`);
  }

  private async runLocked(connection: MigrationConnection): Promise<void> {
    const migrations = await loadMigrations(this.directory);
    const [ledgerRows] = await connection.query<Array<{ count: number }>>('SELECT COUNT(*) AS count FROM app_schema_migrations');
    const [existingTables] = await connection.query<Array<{ name: string }>>(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`,
    );
    if (Number(ledgerRows[0]?.count ?? 0) === 0 && existingTables.length > 0) {
      throw new MigrationError('Existing schema has no migration ledger; run explicit baseline after inspection');
    }
    for (const migration of migrations) {
      const [rows] = await connection.query<MigrationLedgerEntry[]>('SELECT migration_id, checksum, status, statement_index, error FROM app_schema_migrations WHERE migration_id = ?', [migration.id]);
      const recorded = rows[0];
      if (recorded) {
        if (recorded.checksum !== migration.checksum) throw new MigrationError(`Checksum mismatch for ${migration.id}`);
        if (recorded.status === 'completed' || recorded.status === 'baselined') continue;
        throw new MigrationError(`Migration ${migration.id} requires explicit repair: ${recorded.error ?? recorded.status}`);
      }
      await this.apply(connection, migration);
      if (migration.id === snapshotId) await this.recordSnapshotCoverage(connection, migrations);
    }
  }

  private async apply(connection: MigrationConnection, migration: SqlMigration): Promise<void> {
    await connection.query('INSERT INTO app_schema_migrations (migration_id, checksum, status, started_at) VALUES (?, ?, \'running\', NOW())', [migration.id, migration.checksum]);
    const statements = statementsForExecution(migration);
    let statementIndex = 0;
    try {
      for (; statementIndex < statements.length; statementIndex++) await connection.query(statements[statementIndex]);
      await connection.query(`UPDATE app_schema_migrations SET status = 'completed', finished_at = NOW(), statement_index = NULL, error = NULL WHERE migration_id = ?`, [migration.id]);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 4096) : String(error).slice(0, 4096);
      await connection.query(`UPDATE app_schema_migrations SET status = 'failed', finished_at = NOW(), statement_index = ?, error = ? WHERE migration_id = ?`, [statementIndex, message, migration.id]);
      throw new MigrationError(`Migration ${migration.id} failed: ${message}`);
    }
  }

  private async recordSnapshotCoverage(connection: MigrationConnection, migrations: SqlMigration[]): Promise<void> {
    // The legacy snapshot has non-contiguous coverage. It lacks the cron base
    // tables (009/010), their output schema (015), report scripts (017), and
    // all server/resource work from 019 onward; those migrations must execute
    // on an empty install.
    const coveredBySnapshot = (id: string) =>
      id > snapshotId && (
        (id < '009_' && !id.startsWith('007_')) ||
        (id >= '011_' && id < '017_' && id !== '015_add_output_schema.sql') ||
        id.startsWith('018_')
      );
    for (const migration of migrations.filter((item) => coveredBySnapshot(item.id))) {
      await connection.query(
        `INSERT INTO app_schema_migrations (migration_id, checksum, status, finished_at, error)
         VALUES (?, ?, 'baselined', NOW(), 'covered by 000_schema_baseline.sql')`,
        [migration.id, migration.checksum],
      );
    }
  }

  private async ensureLedger(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS app_schema_migrations (
      migration_id VARCHAR(255) NOT NULL PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      status ENUM('running','completed','failed','baselined') NOT NULL,
      statement_index INT NULL,
      error TEXT NULL,
      started_at DATETIME NULL,
      finished_at DATETIME NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
}
