import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { SqlExecutionIntentStore, sqlIntentEnumAccepts } from '../src/audit/sql-execution-intent.js';
import { hashApprovedSql } from '../src/security/approval-execution-authorizer.js';
import { assertSchemaInvariants } from '../src/migrations/invariants.js';
import { loadMigrations, MigrationRunner } from '../src/migrations/runner.js';
import type { MigrationPool } from '../src/migrations/types.js';

// Explicit opt-in. Default collection does not read credentials or open a database.
const port = Number(process.env.SQL_INTENT_TEST_PORT);
const host = process.env.SQL_INTENT_TEST_HOST || '127.0.0.1';
const user = process.env.SQL_INTENT_TEST_USER || 'root';
const password = process.env.SQL_INTENT_TEST_PASSWORD ?? '';
const enabled = Number.isInteger(port) && port > 0;

const migration091 = new URL('../sql/migrations/091_sql_execution_intents.sql', import.meta.url);
const migration154 = new URL('../sql/migrations/154_sql_execution_intent_receipts.sql', import.meta.url);
const created: string[] = [];

function databaseName(prefix: string): string {
  const name = `${prefix}${randomBytes(4).toString('hex')}`;
  if (!/^max374_[a-z0-9_]+$/.test(name)) throw new Error('refusing unsafe database name');
  return name;
}

async function adminConnection() {
  return mysql.createConnection({ host, port, user, password, multipleStatements: false });
}

async function withDatabase(prefix: string, run: (pool: Pool) => Promise<void>): Promise<void> {
  const name = databaseName(prefix);
  const admin = await adminConnection();
  let createdOk = false;
  let pool: Pool | undefined;
  let failure: unknown;
  let cleanupFailure: unknown;
  try {
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    createdOk = true;
    created.push(name);
    pool = mysql.createPool({ host, port, user, password, database: name, connectionLimit: 4, timezone: 'Z' });
    await run(pool);
  } catch (error) {
    failure = error;
  } finally {
    await pool?.end().catch((error: unknown) => { cleanupFailure ??= error; });
    if (createdOk) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
        const [left] = await admin.query<RowDataPacket[]>(
          'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]);
        if (left.length) cleanupFailure ??= new Error(`cleanup left ${name}`);
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    await admin.end().catch((error: unknown) => { cleanupFailure ??= error; });
  }
  if (failure && cleanupFailure) {
    throw new Error(`${failure instanceof Error ? failure.message : String(failure)}; cleanup: ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`);
  }
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
}

function sessionPool(base: Pool, sqlMode: '' | 'STRICT_TRANS_TABLES'): Pool {
  return {
    getConnection: async () => {
      const connection = await base.getConnection();
      await connection.query(sqlMode === '' ? "SET SESSION sql_mode = ''" : "SET SESSION sql_mode = 'STRICT_TRANS_TABLES'");
      const restore = connection.release.bind(connection);
      let released = false;
      connection.release = () => {
        if (released) return;
        released = true;
        void connection.query('SET SESSION sql_mode = DEFAULT').catch(() => undefined).finally(() => restore());
      };
      return connection;
    },
  } as Pool;
}

async function insertIntent(pool: Pool, operationId: string, approvalId: number): Promise<void> {
  await pool.execute(
    `INSERT INTO sql_execution_intents
      (operation_id, approval_request_id, instance_id, sql_text, reviewer_id, actor_id)
     VALUES (?, ?, 374, 'UPDATE probe SET id=1', 2, '2')`,
    [operationId, approvalId]);
}

async function readState(pool: Pool, operationId: string): Promise<{ state: string; enum_index: number }> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT state, state+0 AS enum_index FROM sql_execution_intents WHERE operation_id = ?', [operationId]);
  return { state: String(rows[0]?.state ?? ''), enum_index: Number(rows[0]?.enum_index) };
}

async function expectReceiptInvariant(pool: Pool): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_TYPE AS column_type, COLUMN_DEFAULT AS column_default, IS_NULLABLE AS is_nullable,
            COLUMN_COMMENT AS column_comment
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sql_execution_intents' AND COLUMN_NAME = 'state'`);
  const column = rows[0];
  expect(column).toBeTruthy();
  for (const state of ['unknown', 'succeeded', 'reconciled_applied', 'reconciled_not_applied', 'rolled_back', 'not_executed']) {
    expect(sqlIntentEnumAccepts(String(column.column_type), state)).toBe(true);
  }
  expect(column.column_default).toBe('unknown');
  expect(column.is_nullable).toBe('NO');
  expect(String(column.column_comment)).toContain('rolled_back');
  expect(String(column.column_comment)).toContain('not_executed');
}

describe.skipIf(!enabled)('MAX-374 receipt ledger on isolated MySQL', () => {
  afterAll(async () => {
    if (!enabled || created.length === 0) return;
    const admin = await adminConnection();
    try {
      const [left] = await admin.query<RowDataPacket[]>(
        `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA
         WHERE SCHEMA_NAME IN (${created.map(() => '?').join(',')})`, created);
      expect(left).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('keeps unknown when migration 154 is absent, in strict and non-strict sessions', async () => {
    await withDatabase('max374_ledger_', async (pool) => {
      const [globalMode] = await pool.query<RowDataPacket[]>('SELECT @@GLOBAL.sql_mode AS mode');
      const globalSqlMode = String(globalMode[0].mode);
      expect(globalSqlMode).toContain('STRICT_TRANS_TABLES');
      await pool.query(await readFile(migration091, 'utf8'));

      await insertIntent(pool, 'hazard', 1);
      const hazard = await pool.getConnection();
      try {
        await hazard.query("SET SESSION sql_mode = ''");
        const [updated] = await hazard.query<ResultSetHeader>(
          `UPDATE sql_execution_intents SET state = 'rolled_back', result_json = '{"receipt":"rolled_back"}'
           WHERE operation_id = 'hazard' AND state = 'unknown' AND reconciliation_json IS NULL`);
        expect(updated.affectedRows).toBe(1);
        const [warnings] = await hazard.query<RowDataPacket[]>('SHOW WARNINGS');
        expect(warnings.some((warning) => Number(warning.Code) === 1265)).toBe(true);
      } finally {
        hazard.release();
      }
      expect(await readState(pool, 'hazard')).toEqual({ state: '', enum_index: 0 });
      await insertIntent(pool, 'hazard-prepared', 6);
      const prepared = await pool.getConnection();
      try {
        await prepared.query("SET SESSION sql_mode = ''");
        const [updated] = await prepared.execute<ResultSetHeader>(
          `UPDATE sql_execution_intents SET state = ?, result_json = ?
           WHERE operation_id = ? AND state = 'unknown' AND reconciliation_json IS NULL`,
          ['rolled_back', '{"receipt":"rolled_back"}', 'hazard-prepared']);
        expect(updated.affectedRows).toBe(1);
      } finally {
        prepared.release();
      }
      expect(await readState(pool, 'hazard-prepared')).toEqual({ state: '', enum_index: 0 });
      await insertIntent(pool, 'hazard-strict', 7);
      const strict = await pool.getConnection();
      try {
        await strict.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES'");
        await expect(strict.execute(
          `UPDATE sql_execution_intents SET state = ?, result_json = ?
           WHERE operation_id = ? AND state = 'unknown' AND reconciliation_json IS NULL`,
          ['not_executed', '{"receipt":"not_executed"}', 'hazard-strict'])).rejects.toThrow();
      } finally {
        strict.release();
      }
      expect(await readState(pool, 'hazard-strict')).toEqual({ state: 'unknown', enum_index: 1 });
      const [fallback] = await pool.query<ResultSetHeader>(
        `UPDATE sql_execution_intents SET state = 'unknown'
         WHERE operation_id = 'hazard' AND state = 'unknown' AND reconciliation_json IS NULL`);
      expect(fallback.affectedRows).toBe(0);

      let approvalId = 2;
      for (const sqlMode of ['', 'STRICT_TRANS_TABLES'] as const) {
        for (const receipt of ['rolled_back', 'not_executed'] as const) {
          const operationId = `old-${sqlMode || 'empty'}-${receipt}`;
          await insertIntent(pool, operationId, approvalId);
          approvalId += 1;
          const store = new SqlExecutionIntentStore(() => sessionPool(pool, sqlMode));
          await expect(store.finish(operationId, receipt, { receipt })).rejects.toThrow('SQL_INTENT_STATE_UNSUPPORTED');
          expect(await readState(pool, operationId)).toEqual({ state: 'unknown', enum_index: 1 });
        }
      }
      const preserved = new SqlExecutionIntentStore(() => pool);
      await preserved.reconcile('old-empty-rolled_back', false, 'max374', '154 absent; non-strict session left the row unknown');
      expect((await readState(pool, 'old-empty-rolled_back')).state).toBe('reconciled_not_applied');
      const [globalAfter] = await pool.query<RowDataPacket[]>('SELECT @@GLOBAL.sql_mode AS mode');
      expect(String(globalAfter[0].mode)).toBe(globalSqlMode);
    });
  });

  it('stores both receipts after migration 154 and still rejects a repeated operation', async () => {
    await withDatabase('max374_ledger_', async (pool) => {
      await pool.query(await readFile(migration091, 'utf8'));
      const upgrade = await readFile(migration154, 'utf8');
      await pool.query(upgrade);
      await pool.query(upgrade);
      await expectReceiptInvariant(pool);
      await pool.query(`CREATE TABLE approval_requests (
        id INT PRIMARY KEY, instance_id INT, sql_hash VARCHAR(64), status VARCHAR(32),
        operation_id VARCHAR(128), reviewed_by INT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        target_database VARCHAR(255))`);
      const sql = 'UPDATE probe SET id = 1';
      const grant = { approvalRequestId: 90, operationId: 'repeat-op', reviewerId: 2 };
      await pool.execute(
        `INSERT INTO approval_requests (id, instance_id, sql_hash, status, operation_id, reviewed_by, target_database)
         VALUES (90, 374, ?, 'executing', 'repeat-op', 2, NULL)`, [hashApprovedSql(sql)]);
      const store = new SqlExecutionIntentStore(() => sessionPool(pool, ''));
      await store.begin({ instanceId: 374, sql }, grant);
      await expect(store.begin({ instanceId: 374, sql }, grant)).rejects.toThrow('SQL_OPERATION_ALREADY_RECORDED_RECONCILE_DO_NOT_RETRY');
      expect(await readState(pool, grant.operationId)).toEqual({ state: 'unknown', enum_index: 1 });

      let nextApprovalId = 200;
      for (const sqlMode of ['', 'STRICT_TRANS_TABLES'] as const) {
        for (const receipt of ['rolled_back', 'not_executed'] as const) {
          const operationId = `new-${sqlMode || 'empty'}-${receipt}`;
          await insertIntent(pool, operationId, nextApprovalId);
          nextApprovalId += 1;
          const modeStore = new SqlExecutionIntentStore(() => sessionPool(pool, sqlMode));
          await modeStore.finish(operationId, receipt, { receipt });
          expect(await readState(pool, operationId)).toMatchObject({ state: receipt });
          await expect(modeStore.finish(operationId, receipt, { receipt })).rejects.toThrow('SQL_INTENT_RESULT_NOT_RECORDED');
          const ledger = new SqlExecutionIntentStore(() => pool);
          await expect(ledger.reconcile(operationId, false, 'max374', 'receipt already stored')).rejects.toThrow('SQL_INTENT_NOT_RECONCILABLE');
          expect((await readState(pool, operationId)).state).toBe(receipt);
        }
      }
      const ledger = new SqlExecutionIntentStore(() => pool);
      await ledger.reconcile(grant.operationId, false, 'max374', 'duplicate begin left the first unknown row reconcilable');
      expect((await readState(pool, grant.operationId)).state).toBe('reconciled_not_applied');
    });
  });

  it('bootstraps an empty database, upgrades a pre-154 ledger, and repeats cleanly', async () => {
    await withDatabase('max374_mig_', async (pool) => {
      const migrationPool = pool as unknown as MigrationPool;
      await new MigrationRunner(migrationPool).run();
      await new MigrationRunner(migrationPool).run();
      await assertSchemaInvariants(migrationPool);
      await expectReceiptInvariant(pool);
      const [ledger] = await pool.query<RowDataPacket[]>(
        "SELECT checksum, status FROM app_schema_migrations WHERE migration_id = '154_sql_execution_intent_receipts.sql'");
      expect(ledger).toEqual([expect.objectContaining({ status: 'completed' })]);
    });
    await withDatabase('max374_up_', async (pool) => {
      const directory = await mkdtemp(join(tmpdir(), 'max374-migrations-'));
      try {
        const migrations = await loadMigrations();
        const receipt = migrations.find((migration) => migration.id === '154_sql_execution_intent_receipts.sql');
        expect(receipt).toBeTruthy();
        for (const migration of migrations.filter((migration) => migration.id < receipt!.id)) {
          await writeFile(join(directory, migration.id), migration.sql);
        }
        const migrationPool = pool as unknown as MigrationPool;
        await new MigrationRunner(migrationPool, directory).run();
        await insertIntent(pool, 'upgrade-row', 7);
        expect(await readState(pool, 'upgrade-row')).toEqual({ state: 'unknown', enum_index: 1 });
        const legacy = new SqlExecutionIntentStore(() => sessionPool(pool, ''));
        await expect(legacy.finish('upgrade-row', 'rolled_back', { receipt: 'rolled_back' })).rejects.toThrow('SQL_INTENT_STATE_UNSUPPORTED');
        expect(await readState(pool, 'upgrade-row')).toEqual({ state: 'unknown', enum_index: 1 });
        await new MigrationRunner(migrationPool).run();
        await expectReceiptInvariant(pool);
        expect(await readState(pool, 'upgrade-row')).toEqual({ state: 'unknown', enum_index: 1 });
        const upgraded = new SqlExecutionIntentStore(() => sessionPool(pool, ''));
        await upgraded.finish('upgrade-row', 'rolled_back', { receipt: 'rolled_back' });
        expect(await readState(pool, 'upgrade-row')).toMatchObject({ state: 'rolled_back' });
        await new MigrationRunner(migrationPool).run();
        const [ledger] = await pool.query<RowDataPacket[]>(
          "SELECT checksum, status FROM app_schema_migrations WHERE migration_id = '154_sql_execution_intent_receipts.sql'");
        expect(ledger).toEqual([expect.objectContaining({ checksum: receipt!.checksum, status: 'completed' })]);
        expect((await readState(pool, 'upgrade-row')).state).toBe('rolled_back');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }, 360_000);
});
