/** Explicit real-MySQL acceptance for #626/#627.
 * MAX675_MYSQL=1 MAX675_MYSQL_CONFIG=<JSON connection options> MAX675_EVIDENCE_DIR=<owned directory>
 * pnpm --filter slide-api exec vitest run src/user-preference-service.mysql.test.ts
 */
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { DEFAULT_PREFERENCES, userPreferenceService } from './user-preference-service.js';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from './testing/owned-fixture.js';

describe.skipIf(process.env.MAX675_MYSQL !== '1')('real MySQL preference preservation (#626/#627)', () => {
  let admin: mysql.Pool;
  let pool: mysql.Pool;
  let peer: mysql.Pool;
  let owned: OwnedDatabase | undefined;

  beforeAll(async () => {
    if (!process.env.MAX675_MYSQL_CONFIG || !process.env.MAX675_EVIDENCE_DIR) {
      throw new Error('Explicit acceptance requires MAX675_MYSQL_CONFIG and MAX675_EVIDENCE_DIR');
    }
    const config = JSON.parse(process.env.MAX675_MYSQL_CONFIG) as mysql.PoolOptions;
    admin = mysql.createPool({ ...config, connectionLimit: 1, connectTimeout: 3000 });
    owned = await createOwnedDatabase(admin, {
      nonce: generateRunNonce(), purpose: 'max675', handleDir: process.env.MAX675_EVIDENCE_DIR,
    });
    // Each service has only one connection: nested pool checkout would deadlock.
    pool = mysql.createPool({ ...config, database: owned.database, connectionLimit: 1 });
    peer = mysql.createPool({ ...config, database: owned.database, connectionLimit: 1 });
    await pool.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY) ENGINE=InnoDB');
    await pool.query('INSERT INTO users VALUES (7), (8)');
    await pool.query(readFileSync(new URL('../sql/migrations/014_add_user_preferences.sql', import.meta.url), 'utf8'));
    const [environment] = await admin.query('SELECT VERSION() AS version, @@transaction_isolation AS isolation');
    console.log('MAX675 environment', { database: owned.database, connectionLimit: 1, environment });
  }, 15000);
  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS reject_preferences');
    await pool.query('DELETE FROM user_preferences');
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try {
      const closed = await Promise.allSettled([pool?.end(), peer?.end()]);
      await owned?.drop();
      for (const result of closed) if (result.status === 'rejected') throw result.reason;
      console.log('MAX675 cleanup: verified owned schema removed; both service pools closed');
    } finally { await admin?.end(); }
  }, 10000);

  async function seed(preferences: unknown) {
    await pool.execute('INSERT INTO user_preferences (user_id, preferences) VALUES (7, ?)', [JSON.stringify(preferences)]);
  }
  async function raw() {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT user_id, CAST(preferences AS CHAR) AS preferences, updated_at FROM user_preferences ORDER BY user_id');
    return rows;
  }
  async function stored() {
    return JSON.parse((await raw())[0].preferences);
  }

  it('#626 inserts defaults only for a confirmed first save, including explicit empty lists', async () => {
    expect(await userPreferenceService.savePreferences(7, { visibleTabs: [], visibleTabsConfigured: true }))
      .toEqual({ success: true });
    expect(await stored()).toEqual({ ...DEFAULT_PREFERENCES, visibleTabsConfigured: true });
  });
  it.each([null, [], 42, 'broken-json'])('#626 preserves non-object JSON %j and returns identifiable failure', async (value) => {
    await seed(value);
    const before = await raw();
    expect(await userPreferenceService.savePreferences(7, { locale: 'zh-CN' }))
      .toEqual({ success: false, error: '用户偏好数据损坏：必须是 JSON 对象' });
    expect(await raw()).toEqual(before);
  });
  it.each([true, false])('#626 rolls back SELECT failure with existing=%s and preserves all rows', async (existing) => {
    if (existing) await seed({ navWidth: 333, notificationEnabled: false, themeMode: 'dark' });
    const before = await raw();
    const getConnection = pool.getConnection.bind(pool);
    vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
      const connection = await getConnection();
      const original = connection.execute.bind(connection);
      vi.spyOn(connection, 'execute').mockImplementation((async (sql: string, values: unknown[]) => {
        if (sql.startsWith('SELECT preferences')) throw new Error('MAX675 injected read failure');
        return original(sql, values);
      }) as typeof connection.execute);
      return connection;
    });
    expect(await userPreferenceService.savePreferences(7, { defaultPageSize: 100 }))
      .toEqual({ success: false, error: 'MAX675 injected read failure' });
    expect(await raw()).toEqual(before);
  });
  it.each([true, false])('#626 real UPDATE rejection rolls back with existing=%s', async (existing) => {
    if (existing) await seed({ navWidth: 333 });
    const before = await raw();
    await pool.query(`CREATE TRIGGER reject_preferences BEFORE UPDATE ON user_preferences FOR EACH ROW
      BEGIN IF JSON_EXTRACT(NEW.preferences, '$.locale') = 'reject' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MAX675 rejected update';
      END IF; END`);
    expect(await userPreferenceService.savePreferences(7, { locale: 'reject' }))
      .toEqual({ success: false, error: 'MAX675 rejected update' });
    expect(await raw()).toEqual(before);
  });

  async function waitForTwoLocks() {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const [rows] = await admin.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(DISTINCT w.REQUESTING_THREAD_ID) AS waiting
         FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l
         ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
         WHERE l.OBJECT_SCHEMA = ? AND l.OBJECT_NAME = 'user_preferences'`, [owned!.database]);
      if (Number(rows[0].waiting) >= 2) return;
      await setTimeout(10);
    }
    throw new Error('Two concurrent preference writers did not reach observed InnoDB lock waits');
  }
  it.each([true, false])('#627 competing saves retain both patches with existing=%s', async (existing) => {
    if (existing) await seed({ navWidth: 333, notificationEnabled: true, defaultModel: 'retained' });
    const pending: Array<Promise<{ success: boolean; error?: string }>> = [];
    try {
      const held = await peer.getConnection();
      try {
        await held.beginTransaction();
        await held.execute('INSERT INTO user_preferences (user_id, preferences) VALUES (7, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)',
          [JSON.stringify(DEFAULT_PREFERENCES)]);
        // A second independent single-connection pool competes with the first.
        const config = JSON.parse(process.env.MAX675_MYSQL_CONFIG!);
        const other = mysql.createPool({ ...config, database: owned!.database, connectionLimit: 1 });
        try {
          vi.mocked(dbConnection.getPool).mockReturnValueOnce(pool).mockReturnValueOnce(other);
          pending.push(userPreferenceService.savePreferences(7, { navWidth: 410, visibleTabs: [], visibleTabsConfigured: true }));
          pending.push(userPreferenceService.savePreferences(7, { notificationEnabled: false, defaultPageSize: 100 }));
          await waitForTwoLocks();
          console.log('MAX675 observed two InnoDB lock waits', { existing });
        } finally {
          // Roll back the placeholder, so the absent-row case is a genuine first save.
          await held.rollback();
          const results = await Promise.allSettled(pending);
          await other.end();
          expect(results).toEqual(pending.map(() => ({ status: 'fulfilled', value: { success: true } })));
        }
      } finally { held.release(); }
    } finally { await Promise.allSettled(pending); }
    expect(await stored()).toMatchObject({ navWidth: 410, visibleTabs: [], visibleTabsConfigured: true,
      notificationEnabled: false, defaultPageSize: 100, ...(existing ? { defaultModel: 'retained' } : {}) });
    // A later explicit field update overrides only that field.
    expect(await userPreferenceService.savePreferences(7, { navWidth: 420 })).toEqual({ success: true });
    expect(await stored()).toMatchObject({ navWidth: 420, notificationEnabled: false, defaultPageSize: 100 });
  }, 10000);
  it('isolates users and rejects a missing foreign-key owner without leaving a row', async () => {
    await seed({ navWidth: 333 });
    expect(await userPreferenceService.savePreferences(8, { navWidth: 444 })).toEqual({ success: true });
    expect((await userPreferenceService.savePreferences(999, {})).success).toBe(false);
    expect((await raw()).map(row => row.user_id)).toEqual([7, 8]);
    expect(await stored()).toEqual({ navWidth: 333 });
  });
});
