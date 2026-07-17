import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationError, MigrationRunner, splitSqlStatements } from '../src/migrations/runner.js';

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
