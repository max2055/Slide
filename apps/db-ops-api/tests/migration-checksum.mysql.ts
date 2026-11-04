/** #535: explicit endpoint, disposable schema and SQL copies; no application config. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { LEGACY_MIGRATION_CHECKSUMS, MigrationRunner, loadMigrations } from '../src/migrations/runner.js';

assert.ok(process.env.MIGRATION_TEST_MYSQL_HOST, 'explicit test host required');
assert.ok(process.env.MIGRATION_TEST_MYSQL_PORT, 'explicit test port required');
const config = {
  host: process.env.MIGRATION_TEST_MYSQL_HOST,
  port: Number(process.env.MIGRATION_TEST_MYSQL_PORT),
  user: process.env.MIGRATION_TEST_MYSQL_USER || 'root',
  password: process.env.MIGRATION_TEST_MYSQL_PASSWORD || '',
};
const database = `slide_checksum_${randomUUID().replaceAll('-', '')}`;
const admin = await mysql.createConnection(config);
const directories: string[] = [];
let pool: mysql.Pool | undefined;
try {
  await admin.query(`CREATE DATABASE \`${database}\``);
  pool = mysql.createPool({ ...config, database, connectionLimit: 2 });
  const [version] = await admin.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version');
  console.log(JSON.stringify({ database, endpoint: `${config.host}:${config.port}`, version: version[0].version }));
  await new MigrationRunner(pool as any).run();
  const migrations = await loadMigrations();
  for (const [id, pairs] of Object.entries(LEGACY_MIGRATION_CHECKSUMS)) {
    const migration = migrations.find(item => item.id === id)!;
    for (const pair of pairs) {
      assert.equal(migration.checksum, pair.currentChecksum);
      for (const status of ['completed', 'baselined']) {
        const directory = await mkdtemp(join(tmpdir(), 'slide-checksum-'));
        directories.push(directory);
        const file = join(directory, id);
        await writeFile(file, migration.sql);
        const runner = new MigrationRunner(pool as any, directory);
        for (const checksum of [pair.currentChecksum, pair.recordedChecksum]) {
          await pool.query('UPDATE app_schema_migrations SET checksum = ?, status = ? WHERE migration_id = ?', [checksum, status, id]);
          await runner.run();
        }
        const ledger = async () => {
          const [rows] = await pool!.query<mysql.RowDataPacket[]>('SELECT * FROM app_schema_migrations ORDER BY migration_id');
          return rows;
        };
        const before = await ledger();
        // The later edit lives only in a temporary copy, never in repository SQL.
        await writeFile(file, migration.sql + '\n-- unreviewed later edit\n');
        await assert.rejects(runner.run(), new RegExp(`Checksum mismatch for ${id}`));
        assert.deepEqual(await ledger(), before, 'rejected change must preserve entire ledger');
        await writeFile(file, migration.sql);
        await pool.query('UPDATE app_schema_migrations SET checksum = ? WHERE migration_id = ?', ['0'.repeat(64), id]);
        const badOld = await ledger();
        await assert.rejects(runner.run(), /Checksum mismatch/);
        assert.deepEqual(await ledger(), badOld);
        await pool.query('UPDATE app_schema_migrations SET checksum = ? WHERE migration_id = ?', [pair.recordedChecksum, id]);
        await rm(file);
        const wrongId = '999_wrong_id.sql';
        await writeFile(join(directory, wrongId), migration.sql);
        await pool.query("INSERT INTO app_schema_migrations (migration_id, checksum, status) VALUES (?, ?, ?)", [wrongId, pair.recordedChecksum, status]);
        const badId = await ledger();
        await assert.rejects(runner.run(), /Checksum mismatch for 999_wrong_id.sql/);
        assert.deepEqual(await ledger(), badId);
        await pool.query('DELETE FROM app_schema_migrations WHERE migration_id = ?', [wrongId]);
        await pool.query('UPDATE app_schema_migrations SET checksum = ?, status = ? WHERE migration_id = ?', [migration.checksum, 'completed', id]);
        const [locks] = await admin.query<mysql.RowDataPacket[]>("SELECT IS_FREE_LOCK('slide:db-ops:migrations:v1') AS free");
        assert.equal(Number(locks[0].free), 1, 'failed validation must release its migration lock');
        console.log(`PASS ${id} ${status}: identical + historical accepted; edited SQL + wrong old + wrong ID rejected; ledger unchanged; lock free`);
      }
    }
  }
  await new MigrationRunner(pool as any).run();
  console.log('PASS final full migration run after all rejection scenarios');
} finally {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.end();
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
  console.log(`CLEANUP dropped ${database} and temporary SQL copies`);
}
