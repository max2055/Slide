/** Real MySQL acceptance; creates and drops only its own random database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import { loadMigrations, MigrationRunner } from '../src/migrations/runner.js';
import { assertSchemaInvariants } from '../src/migrations/invariants.js';
import type { MigrationPool, MigrationQuery } from '../src/migrations/types.js';

const config = {
  host: process.env.MIGRATION_TEST_MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MIGRATION_TEST_MYSQL_PORT || 3306),
  user: process.env.MIGRATION_TEST_MYSQL_USER || 'root',
  password: process.env.MIGRATION_TEST_MYSQL_PASSWORD || '',
};
const database = `slide_repair_test_${randomUUID().replaceAll('-', '')}`;
const admin = await mysql.createConnection(config);
const directory = await mkdtemp(join(tmpdir(), 'slide-repair-mysql-'));
let pool: mysql.Pool | undefined;
let releaseVerification = () => {};
const concurrent: Promise<unknown>[] = [];

async function waitForSessions(needle: string, count: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [processes] = await admin.query<mysql.RowDataPacket[]>('SHOW FULL PROCESSLIST');
    const matches = processes.filter(row => row.db === database && row.Info?.includes(needle));
    if (matches.length >= count) return matches;
    await delay(25);
  }
  assert.fail(`Expected ${count} MySQL sessions executing ${needle}`);
}

try {
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
  pool = mysql.createPool({ ...config, database, connectionLimit: 5 });
  const migrationPool = pool as unknown as MigrationPool;
  await new MigrationRunner(migrationPool).run();
  console.log('PASS: current production migrations bootstrap and global invariants');

  const id = '999_partial_repair.sql';
  await writeFile(join(directory, id), `
CREATE TABLE repair_probe (id INT NOT NULL PRIMARY KEY COMMENT 'Identifier') COMMENT='Repair probe';
ALTER TABLE repair_probe ADD COLUMN value INT NOT NULL DEFAULT 0 COMMENT 'Repaired value';
INSERT INTO missing_repair_source VALUES (1);
`);
  const [migration] = await loadMigrations(directory);
  const runnerWithoutVerifier = new MigrationRunner(migrationPool, directory);
  await assert.rejects(runnerWithoutVerifier.run(), /failed/);
  const readEntry = async () => {
    const [rows] = await pool!.query<mysql.RowDataPacket[]>(
      'SELECT * FROM app_schema_migrations WHERE migration_id = ?', [id]);
    return rows[0];
  };
  const original = await readEntry();
  assert.equal(original.status, 'failed');
  assert.equal(original.statement_index, 2);
  await assert.rejects(runnerWithoutVerifier.run(), /explicit repair/);
  await assert.rejects(runnerWithoutVerifier.repair(id, 'mysql-test', 'manual repair'), /verification/);
  assert.equal((await readEntry()).error, original.error);
  console.log('PASS: partial committed DDL stays failed; run and legacy repair cannot bypass it');

  // This migration-specific data effect is invisible to global schema invariants.
  const verify = async (connection: MigrationQuery) => {
    const [columns] = await connection.query<Array<{ column_type: string }>>(
      `SELECT COLUMN_TYPE AS column_type FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'repair_probe' AND COLUMN_NAME = 'value'`);
    assert.equal(columns[0]?.column_type, 'int');
    const [rows] = await connection.query<Array<{ count: number }>>('SELECT COUNT(*) AS count FROM missing_repair_source WHERE id = 1');
    assert.equal(Number(rows[0]?.count), 1, 'migration-specific data effect missing');
  };
  const verifications = { [id]: { checksum: migration.checksum, verify } };
  const runner = new MigrationRunner(migrationPool, directory, verifications);
  await assert.rejects(runner.acknowledgeExternallyRepairedMigration(id, 'mysql-test', 'not fixed'));
  assert.equal((await readEntry()).status, 'failed');
  // Complete the missing external prerequisite, but not the migration's data effect.
  await pool.query("CREATE TABLE missing_repair_source (id INT PRIMARY KEY COMMENT 'Identifier') COMMENT='Repair source'");
  await assertSchemaInvariants(migrationPool);
  await assert.rejects(runner.acknowledgeExternallyRepairedMigration(id, 'mysql-test', 'still incomplete'), /data effect missing/);
  await pool.query('INSERT INTO missing_repair_source VALUES (1)');
  // A real global invariant failure still blocks a satisfied specific verifier.
  await pool.query("ALTER TABLE repair_probe COMMENT = ''");
  await assert.rejects(runner.acknowledgeExternallyRepairedMigration(id, 'mysql-test', 'global incomplete'), /missing comment repair_probe/);
  await pool.query("ALTER TABLE repair_probe COMMENT = 'Repair probe'");
  console.log('PASS: both real global invariants and migration-specific data checks block acknowledgement');

  let enteredVerification!: () => void;
  const entered = new Promise<void>(resolve => { enteredVerification = resolve; });
  const gate = new Promise<void>(resolve => { releaseVerification = resolve; });
  verifications[id].verify = async connection => {
    await verify(connection);
    enteredVerification();
    await gate;
  };
  const first = runner.acknowledgeExternallyRepairedMigration(id, 'mysql-test', 'completed externally');
  // If verification fails, propagate instead of waiting forever for the barrier.
  await Promise.race([entered, first.then(() => { throw new Error('verification barrier skipped'); })]);
  const pendingRun = runner.run();
  const pendingRepair = runner.repair(id, 'second-operator', 'duplicate acknowledgement');
  const outcomes = Promise.allSettled([first, pendingRun, pendingRepair]);
  concurrent.push(outcomes);
  await waitForSessions("GET_LOCK('slide:db-ops:migrations:v1'", 2);
  assert.equal((await readEntry()).status, 'failed');
  releaseVerification();
  const [confirmed, ran, duplicate] = await outcomes;
  assert.equal(confirmed.status, 'fulfilled');
  assert.equal(ran.status, 'fulfilled');
  assert.equal(duplicate.status, 'rejected');
  if (duplicate.status === 'rejected') assert.match(String(duplicate.reason), /not failed/);
  const repaired = await readEntry();
  assert.equal(repaired.status, 'completed');
  assert.equal(repaired.checksum, original.checksum);
  assert.equal(repaired.statement_index, original.statement_index);
  assert.equal(repaired.started_at.getTime(), original.started_at.getTime());
  assert.deepEqual(JSON.parse(repaired.error), {
    action: 'acknowledgeExternallyRepairedMigration', actor: 'mysql-test', reason: 'completed externally',
    checksum: original.checksum, previousError: original.error,
  });
  await runner.run();
  const [data] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM missing_repair_source');
  assert.equal(Number(data[0].count), 1);
  console.log('PASS: concurrent run/repair serialize; audit/history preserved; no DDL or DML replay');

  for (const scenario of ['completed', 'disconnected']) {
    const interruptedId = `999_${scenario}_repair.sql`;
    const probe = `repair_${scenario}_probe`;
    const pauseLock = `repair:${database}`;
    await writeFile(join(directory, interruptedId), `
CREATE TABLE ${probe} (id INT PRIMARY KEY COMMENT 'Identifier') COMMENT='Repair receipt probe';
SELECT GET_LOCK('${pauseLock}', 20);
SELECT RELEASE_LOCK('${pauseLock}');
INSERT INTO ${probe} VALUES (1);
`);
    const migration = (await loadMigrations(directory)).find(item => item.id === interruptedId)!;
    const readProbe = async (connection: MigrationQuery) => {
      const [rows] = await connection.query<Array<{ id: number }>>(`SELECT id FROM ${probe} ORDER BY id`);
      return rows.map(row => row.id);
    };
    let verificationCalls = 0;
    const repairRunner = new MigrationRunner(migrationPool, directory, {
      [interruptedId]: {
        checksum: migration.checksum,
        verify: async (connection) => {
          verificationCalls++;
          assert.deepEqual(await readProbe(connection), [1], 'missing receipt probe data');
        },
      },
    });
    await admin.query('SELECT GET_LOCK(?, 0)', [pauseLock]);
    const execution = Promise.allSettled([repairRunner.run()]);
    concurrent.push(execution);
    const [active] = await waitForSessions(`GET_LOCK('${pauseLock}'`, 1);
    const readInterruptedEntry = async () => {
      const [rows] = await pool!.query<mysql.RowDataPacket[]>(
        'SELECT * FROM app_schema_migrations WHERE migration_id = ?', [interruptedId]);
      return rows[0];
    };
    const activeEntry = await readInterruptedEntry();
    assert.equal(activeEntry.status, 'running');
    const maintenance = Promise.allSettled([
      repairRunner.inspectMigrationForRepair(interruptedId),
      repairRunner.acknowledgeExternallyRepairedMigration(interruptedId, 'mysql-test', 'while running'),
    ]);
    concurrent.push(maintenance);
    await waitForSessions("GET_LOCK('slide:db-ops:migrations:v1'", 2);
    assert.deepEqual(await readInterruptedEntry(), activeEntry);
    assert.equal(verificationCalls, 0, 'active runner must retain exclusive access');
    if (scenario === 'disconnected') await admin.query('KILL CONNECTION ?', [active.Id]);
    await admin.query('SELECT RELEASE_LOCK(?)', [pauseLock]);

    const [runResult] = await execution;
    const [inspection, prematureConfirmation] = await maintenance;
    assert.ok(prematureConfirmation.status === 'rejected', 'confirmation should have failed');
    if (scenario === 'completed') {
      assert.equal(runResult.status, 'fulfilled');
      assert.equal(inspection.status, 'rejected');
      assert.match(String(prematureConfirmation.reason), /not failed or running/);
      assert.equal(verificationCalls, 0);
      assert.equal((await readInterruptedEntry()).status, 'completed');
      console.log('PASS: maintenance waits for an active migration and rejects its completed entry');
      continue;
    }
    assert.ok(runResult.status === 'rejected', 'disconnected migration should have failed');
    assert.match(String(runResult.reason), /failed at statement 1.*cleanup failed/);
    assert.match(String(prematureConfirmation.reason), /missing receipt probe data/);
    assert.deepEqual(await readInterruptedEntry(), activeEntry, 'failed verification must not change running entry');
    assert.deepEqual(inspection, {
      status: 'fulfilled',
      value: {
        migration_id: interruptedId, checksum: migration.checksum, status: 'running',
        statement_index: null, error: null, executionOutcome: 'unknown',
      },
    });
    await assert.rejects(repairRunner.run(), /requires explicit repair: running/);
    assert.deepEqual(await readProbe(migrationPool), []);
    console.log('PASS: killing the real MySQL session leaves an unknown receipt and blocks startup/replay');

    await pool.query(`INSERT INTO ${probe} VALUES (1)`);
    await repairRunner.acknowledgeExternallyRepairedMigration(interruptedId, 'mysql-test', 'verified external data repair');
    const acknowledged = await readInterruptedEntry();
    assert.equal(acknowledged.status, 'completed');
    assert.equal(acknowledged.checksum, activeEntry.checksum);
    assert.equal(acknowledged.started_at.getTime(), activeEntry.started_at.getTime());
    assert.equal(acknowledged.statement_index, null);
    assert.deepEqual(JSON.parse(acknowledged.error), {
      action: 'acknowledgeExternallyRepairedMigration', actor: 'mysql-test', reason: 'verified external data repair',
      checksum: migration.checksum, previousError: null, previousStatus: 'running', previousExecutionOutcome: 'unknown',
    });
    await repairRunner.run();
    assert.deepEqual(await readProbe(migrationPool), [1]);
    console.log('PASS: external repair is verified and acknowledged with the unknown receipt retained, without replay');
  }
} finally {
  releaseVerification();
  await admin.query('SELECT RELEASE_ALL_LOCKS()');
  await Promise.allSettled(concurrent);
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}
