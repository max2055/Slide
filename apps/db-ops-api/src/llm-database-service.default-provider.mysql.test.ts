/** #523 real InnoDB acceptance. Explicit opt-in; credentials are injected in memory.
 * MAX493_MYSQL=1 MAX493_MYSQL_CONFIG=<JSON connection options> MAX493_EVIDENCE_DIR=<owned output dir>
 * pnpm --filter slide-api exec vitest run src/llm-database-service.default-provider.mysql.test.ts
 */
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { llmDatabaseService } from './llm-database-service.js';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from './testing/owned-fixture.js';

describe.skipIf(process.env.MAX493_MYSQL !== '1')('default Provider real MySQL (#523)', () => {
  let admin: mysql.Pool | undefined;
  let pool: mysql.Pool;
  let owned: OwnedDatabase | undefined;

  beforeAll(async () => {
    if (!process.env.MAX493_MYSQL_CONFIG || !process.env.MAX493_EVIDENCE_DIR) {
      throw new Error('Explicit MySQL acceptance requires MAX493_MYSQL_CONFIG and MAX493_EVIDENCE_DIR');
    }
    const config = JSON.parse(process.env.MAX493_MYSQL_CONFIG) as mysql.PoolOptions;
    admin = mysql.createPool({ ...config, connectionLimit: 1, connectTimeout: 3000 });
    owned = await createOwnedDatabase(admin, {
      nonce: generateRunNonce(), purpose: 'max493', handleDir: process.env.MAX493_EVIDENCE_DIR,
    });
    pool = mysql.createPool({ ...config, database: owned.database, connectionLimit: 2, connectTimeout: 3000 });
    // Use the repository's actual Provider schema (indexes, collation and InnoDB included).
    const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
    const ddl = schema.match(/CREATE TABLE IF NOT EXISTS `llm_providers` \([\s\S]*?ENGINE=InnoDB[^;]*;/)?.[0];
    if (!ddl) throw new Error('Provider schema not found');
    await pool.query(ddl);
    const [server] = await admin.query('SELECT VERSION() AS version, @@transaction_isolation AS isolation');
    console.log('MAX493 environment', { schema: owned.database, poolLimit: 2, server });
  }, 10000);

  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS fail_default');
    await pool.query('DELETE FROM llm_providers');
    await pool.query(`INSERT INTO llm_providers (name, display_name, is_default, api_key_encrypted)
      VALUES ('alpha', 'Alpha', TRUE, 'opaque-fixture-value'), ('beta', 'Beta', FALSE, NULL), ('gamma', 'Gamma', FALSE, NULL)`);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try {
      if (pool) await pool.end();
      await owned?.drop();
      console.log('MAX493 cleanup: owned schema dropped');
    } finally {
      await admin?.end();
    }
  }, 10000);

  async function defaults() {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT name FROM llm_providers WHERE is_default = TRUE ORDER BY name',
    );
    return rows.map(row => row.name);
  }

  async function waitForLock(connection: mysql.PoolConnection) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const [rows] = await admin!.query<mysql.RowDataPacket[]>(
        `SELECT w.REQUESTING_ENGINE_TRANSACTION_ID FROM performance_schema.data_lock_waits w
         JOIN performance_schema.threads t ON t.THREAD_ID = w.REQUESTING_THREAD_ID
         WHERE t.PROCESSLIST_ID = ?`,
        [connection.threadId],
      );
      if (rows.length > 0) return;
      await setTimeout(20);
    }
    throw new Error('Expected an observed InnoDB lock wait');
  }

  it('rolls back the first write when a real trigger rejects the target update', async () => {
    await pool.query(`CREATE TRIGGER fail_default BEFORE UPDATE ON llm_providers FOR EACH ROW
      BEGIN IF NEW.name = 'beta' AND NEW.is_default = TRUE THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MAX493 injected second write failure';
      END IF; END`);
    const result = await llmDatabaseService.setDefaultProvider('beta');
    expect(result).toEqual({ success: false, error: 'MAX493 injected second write failure' });
    expect(await defaults()).toEqual(['alpha']);
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT api_key_encrypted FROM llm_providers WHERE name = 'alpha'");
    expect(rows[0].api_key_encrypted).toBe('opaque-fixture-value');
  });

  it('leaves the original default intact for an absent target, including an empty collection', async () => {
    expect((await llmDatabaseService.setDefaultProvider('missing')).success).toBe(false);
    expect(await defaults()).toEqual(['alpha']);
    await pool.query('DELETE FROM llm_providers');
    expect((await llmDatabaseService.setDefaultProvider('missing')).success).toBe(false);
    expect(await defaults()).toEqual([]);
  });

  it('supports switching, repeated selection and the database name collation with one pooled connection', async () => {
    const held = await pool.getConnection();
    try {
      // Holding one of two connections exposes any nested pool acquisition.
      expect(await llmDatabaseService.setDefaultProvider('BETA')).toEqual({ success: true });
      expect(await llmDatabaseService.setDefaultProvider('beta')).toEqual({ success: true });
      expect(await defaults()).toEqual(['beta']);
    } finally { held.release(); }
  }, 5000);

  it('serializes 60 competing switches on two real connections, leaving exactly one default after each pair', async () => {
    for (let round = 0; round < 30; round++) {
      const results = await Promise.all([
        llmDatabaseService.setDefaultProvider('beta'), llmDatabaseService.setDefaultProvider('gamma'),
      ]);
      expect(results).toEqual([{ success: true }, { success: true }]);
      const current = await defaults();
      expect(current).toHaveLength(1);
      expect(['beta', 'gamma']).toContain(current[0]);
    }
  }, 15000);

  it('does not report success when a concurrent deletion commits before the switch obtains its lock', async () => {
    const deleter = await pool.getConnection();
    const switcher = await pool.getConnection();
    vi.spyOn(pool, 'getConnection').mockResolvedValueOnce(switcher);
    let switching: ReturnType<typeof llmDatabaseService.setDefaultProvider> | undefined;
    try {
      await deleter.beginTransaction();
      await deleter.execute("DELETE FROM llm_providers WHERE name = 'beta'");
      switching = llmDatabaseService.setDefaultProvider('beta');
      await waitForLock(switcher);
      await deleter.commit();
      expect(await switching).toEqual({ success: false, error: '提供商不存在' });
      expect(await defaults()).toEqual(['alpha']);
    } finally {
      await deleter.rollback();
      deleter.release();
      if (switching) await switching;
      else switcher.release();
    }
  }, 10000);

  it('holds the target lock through commit when switching wins the deletion race', async () => {
    const switcher = await pool.getConnection();
    const deleter = await pool.getConnection();
    vi.spyOn(pool, 'getConnection').mockResolvedValueOnce(switcher);
    let unlock!: () => void;
    const barrier = new Promise<void>(resolve => { unlock = resolve; });
    let locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const execute = switcher.execute.bind(switcher);
    vi.spyOn(switcher, 'execute').mockImplementation((async (sql: string, values?: unknown[]) => {
      const result = await execute(sql, values);
      if (sql.includes('ORDER BY id FOR UPDATE')) { locked(); await barrier; }
      return result;
    }) as typeof switcher.execute);
    let deleting: Promise<unknown> | undefined;
    const switching = llmDatabaseService.setDefaultProvider('beta');
    try {
      await acquired;
      await deleter.beginTransaction();
      deleting = deleter.execute<mysql.RowDataPacket[]>("SELECT is_default FROM llm_providers WHERE name = 'beta' FOR UPDATE");
      await waitForLock(deleter);
      unlock();
      expect(await switching).toEqual({ success: true });
      const [rows] = await deleting as [mysql.RowDataPacket[], unknown];
      expect(rows[0].is_default).toBe(1);
      await deleter.execute("DELETE FROM llm_providers WHERE name = 'beta'");
      await deleter.commit();
      expect(await defaults()).toEqual([]); // The later deletion is a separate, successful operation.
    } finally {
      unlock();
      await switching;
      if (deleting) await deleting;
      await deleter.rollback();
      deleter.release();
    }
  }, 10000);
});
