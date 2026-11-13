/** #524 real schema acceptance. Opt in with MAX496_MYSQL=1, MAX496_MYSQL_CONFIG
 * (JSON mysql2 options), MAX496_EVIDENCE_DIR (owned handle directory).
 * pnpm --filter slide-api exec vitest run src/llm-database-service.usage.mysql.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { llmDatabaseService } from './llm-database-service.js';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from './testing/owned-fixture.js';

describe.skipIf(process.env.MAX496_MYSQL !== '1')('usage daily distinct real MySQL (#524)', () => {
  let admin: mysql.Pool | undefined;
  let pool: mysql.Pool;
  let owned: OwnedDatabase | undefined;
  const evidence: { environment?: unknown; audits: unknown[]; cleaned?: boolean } = { audits: [] };
  const base = { provider_id: 1, provider_name: 'fixture', model: 'model', session_id: 's1', user_id: 1,
    input_tokens: 2, output_tokens: 3, duration_ms: 20, cost_usd: 0.01 };

  beforeAll(async () => {
    if (!process.env.MAX496_MYSQL_CONFIG || !process.env.MAX496_EVIDENCE_DIR) throw new Error('Explicit acceptance requires config and evidence directory');
    const config = JSON.parse(process.env.MAX496_MYSQL_CONFIG) as mysql.PoolOptions;
    admin = mysql.createPool({ ...config, connectionLimit: 1, connectTimeout: 3000 });
    owned = await createOwnedDatabase(admin, { nonce: generateRunNonce(), purpose: 'max496', handleDir: process.env.MAX496_EVIDENCE_DIR });
    pool = mysql.createPool({ ...config, database: owned.database, connectionLimit: 4, connectTimeout: 3000, timezone: '+08:00' });
    const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
    for (const table of ['llm_usage_records', 'llm_usage_daily_stats']) {
      const ddl = schema.match(new RegExp('CREATE TABLE IF NOT EXISTS `' + table + '` \\([\\s\\S]*?ENGINE=InnoDB[^;]*;'))?.[0];
      if (!ddl) throw new Error('Missing usage schema');
      await pool.query(ddl);
    }
    const [env] = await admin.query('SELECT VERSION() version, @@transaction_isolation isolation, @@global.time_zone time_zone');
    evidence.environment = { schema: owned.database, host: config.host, port: config.port, env, poolLimit: 4 };
    console.log('MAX496 environment', evidence.environment);
  }, 10000);
  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS fail_usage');
    await pool.query('DELETE FROM llm_usage_records');
    await pool.query('DELETE FROM llm_usage_daily_stats');
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try {
      if (pool) await pool.end();
      await owned?.drop();
      evidence.cleaned = true;
      if (process.env.MAX496_EVIDENCE_DIR) writeFileSync(join(process.env.MAX496_EVIDENCE_DIR, 'mysql-audit.json'), JSON.stringify(evidence, null, 2));
      console.log('MAX496 cleanup: owned database dropped');
    }
    finally { await admin?.end(); }
  }, 10000);

  async function write(overrides: Partial<Parameters<typeof llmDatabaseService.recordUsage>[0]> = {}) {
    expect(await llmDatabaseService.recordUsage({ ...base, ...overrides })).toEqual({ success: true });
  }
  async function audit() {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(`SELECT s.provider_id, s.model, s.date,
      s.unique_users, s.unique_sessions, COUNT(DISTINCT r.user_id) detail_users,
      COUNT(DISTINCT r.session_id) detail_sessions, s.total_requests, COUNT(r.id) detail_requests
      FROM llm_usage_daily_stats s LEFT JOIN llm_usage_records r ON r.provider_id = s.provider_id
      AND r.model = s.model AND r.created_at >= s.date AND r.created_at < DATE_ADD(s.date, INTERVAL 1 DAY)
      GROUP BY s.id ORDER BY s.provider_id, s.model, s.date`);
    for (const row of rows) {
      expect(row.unique_users).toBe(row.detail_users);
      expect(row.unique_sessions).toBe(row.detail_sessions);
      expect(row.total_requests).toBe(row.detail_requests);
    }
    evidence.audits.push(rows);
    console.log('MAX496 COUNT(DISTINCT) audit', rows);
    return rows;
  }

  it('counts different users/sessions once and excludes null/omitted anonymous users', async () => {
    await write(); await write(); await write({ user_id: 2, session_id: 's2', status: 'error' });
    await write({ user_id: null, session_id: 'anon' }); await write({ user_id: undefined, session_id: 'anon' });
    const [row] = await audit();
    expect([row.unique_users, row.unique_sessions, row.total_requests]).toEqual([2, 3, 5]);
    const [stats] = await pool.query<mysql.RowDataPacket[]>('SELECT * FROM llm_usage_daily_stats');
    expect(stats[0]).toMatchObject({ total_input_tokens: 10, total_output_tokens: 15, total_tokens: 25, failed_requests: 1, avg_duration_ms: 20 });
    expect(Number(stats[0].total_cost_usd)).toBeCloseTo(0.05);
  });

  it('records anonymous-only traffic as zero users and preserves the empty session string in DISTINCT', async () => {
    await write({ user_id: null, session_id: '' });
    await write({ user_id: undefined, session_id: '' });
    const [row] = await audit();
    expect([row.unique_users, row.unique_sessions]).toEqual([0, 1]);
  });

  it('serializes competing first writes and duplicates under REPEATABLE READ with a small pool', async () => {
    await Promise.all(Array.from({ length: 60 }, (_, i) => write({ user_id: i % 7, session_id: `s${i % 11}` })));
    const [row] = await audit();
    expect([row.unique_users, row.unique_sessions, row.total_requests]).toEqual([7, 11, 60]);
  }, 15000);

  it('uses database collation and isolates Provider/model/date buckets', async () => {
    await write({ session_id: 'Case' }); await write({ session_id: 'case' });
    await write({ provider_id: 2, session_id: 'other' }); await write({ model: 'other', user_id: 2 });
    // A different date remains independent, even with the same identities.
    await pool.query(`INSERT INTO llm_usage_records
      (provider_id, provider_name, model, user_id, session_id, created_at)
      VALUES (1, 'fixture', 'model', 999, 'old', CURRENT_DATE - INTERVAL 1 DAY)`);
    const rows = await audit();
    expect(rows).toHaveLength(3);
    expect(rows[0].unique_sessions).toBe(1);
    expect(rows[0].unique_users).toBe(1);
  });

  it('repairs an existing fixed-one bucket using its historical details on the next write', async () => {
    await write(); await write({ user_id: 2, session_id: 's2' });
    await pool.query('UPDATE llm_usage_daily_stats SET unique_users = 1, unique_sessions = 1');
    await write({ user_id: 3, session_id: 's3' });
    const [row] = await audit();
    expect([row.unique_users, row.unique_sessions]).toEqual([3, 3]);
  });

  it('aligns details and daily buckets in a non-UTC database session across UTC midnight', async () => {
    const held = await pool.getConnection();
    await held.query("SET time_zone = '+08:00'");
    await held.query("SET timestamp = UNIX_TIMESTAMP('2026-11-14 00:30:00')");
    const release = vi.spyOn(held, 'release').mockImplementation(() => {});
    vi.spyOn(pool, 'getConnection').mockResolvedValueOnce(held);
    try {
      await write();
      const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT CAST(date AS CHAR) day FROM llm_usage_daily_stats");
      expect(rows[0].day).toBe('2026-11-14');
      await audit();
    } finally {
      // Hold ownership until the session clock is reset.
      await held.query('SET timestamp = DEFAULT');
      await held.query('SET time_zone = DEFAULT');
      release.mockRestore();
      held.release();
    }
  });

  for (const existing of [false, true]) it(`rolls back details and aggregate on update failure (existing=${existing})`, async () => {
    if (existing) await write();
    await pool.query(`CREATE TRIGGER fail_usage BEFORE UPDATE ON llm_usage_daily_stats FOR EACH ROW
      BEGIN IF NEW.total_requests > OLD.total_requests THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MAX496 aggregate failure'; END IF; END`);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await llmDatabaseService.recordUsage(base)).toEqual({ success: false, error: 'MAX496 aggregate failure' });
    for (const table of ['llm_usage_records', 'llm_usage_daily_stats']) {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) n FROM ${table}`);
      expect(rows[0].n).toBe(existing ? 1 : 0);
    }
    if (existing) await audit();
    log.mockRestore();
  });
});
