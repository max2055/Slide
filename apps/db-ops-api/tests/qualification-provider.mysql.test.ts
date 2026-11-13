/** #458: explicit real-MySQL acceptance; configuration is injected, never read from private files.
 * MAX490_MYSQL=1 MAX490_MYSQL_CONFIG=<JSON> MAX490_EVIDENCE_DIR=<owned directory>
 * pnpm --filter slide-api exec vitest run tests/qualification-provider.mysql.test.ts
 */
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { dbConnection } from '../src/db-connection.js';
import { llmDatabaseService } from '../src/llm-database-service.js';
import { configureQualificationProvider } from '../../../scripts/qualification/configure-provider.js';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../src/testing/owned-fixture.js';

const exec = promisify(execFile);
const scripts = ['configure-deepseek.ts', 'configure-cancellable-provider.ts'];
describe.skipIf(process.env.MAX490_MYSQL !== '1')('#458 real MySQL qualification entrypoints', () => {
  let admin: mysql.Pool | undefined;
  let pool: mysql.Pool;
  let owned: OwnedDatabase | undefined;
  let config: mysql.PoolOptions;
  beforeAll(async () => {
    if (!process.env.MAX490_MYSQL_CONFIG || !process.env.MAX490_EVIDENCE_DIR) {
      throw new Error('MAX490_MYSQL_CONFIG and MAX490_EVIDENCE_DIR are required');
    }
    config = JSON.parse(process.env.MAX490_MYSQL_CONFIG);
    admin = mysql.createPool({ ...config, connectionLimit: 1, connectTimeout: 3000 });
    owned = await createOwnedDatabase(admin, {
      nonce: generateRunNonce(), purpose: 'max490', handleDir: process.env.MAX490_EVIDENCE_DIR,
    });
    pool = mysql.createPool({ ...config, database: owned.database, connectionLimit: 2, connectTimeout: 3000 });
    const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
    const ddl = schema.match(/CREATE TABLE IF NOT EXISTS `llm_providers` \([\s\S]*?ENGINE=InnoDB[^;]*;/)?.[0];
    if (!ddl) throw new Error('Provider DDL missing');
    await pool.query(ddl);
    await pool.query(readFileSync(new URL('../sql/migrations/011_add_api_format_to_llm_providers.sql', import.meta.url), 'utf8'));
    const [server] = await admin.query('SELECT VERSION() AS version, @@transaction_isolation AS isolation');
    console.log('MAX490 environment', { schema: owned.database, server, poolLimit: 2 });
  }, 10000);
  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS fail_target');
    await pool.query('DELETE FROM llm_providers');
    await pool.query(`INSERT INTO llm_providers (name, display_name, enabled, is_default, api_key_encrypted)
      VALUES ('alpha', 'Original', 1, 1, 'opaque-original'), ('deepseek', 'DeepSeek', 0, 0, 'opaque-target')`);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      if (pool) await pool.end();
      await owned?.drop();
      console.log('MAX490 cleanup: owned schema dropped');
    } finally { await admin?.end(); }
  }, 10000);
  async function snapshot() {
    const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT * FROM llm_providers ORDER BY id');
    return rows;
  }
  async function entry(script: string) {
    try {
      // Same documented entry as serve-e2e.sh; no application defaults can select 3306.
      const result = await exec('pnpm', ['--filter', 'slide-api', 'exec', 'tsx', `../../scripts/qualification/${script}`], {
        cwd: new URL('../../../', import.meta.url), timeout: 10000,
        env: { ...process.env, DB_HOST: String(config.host), DB_PORT: String(config.port),
          DB_USER: String(config.user), DB_PASSWORD: String(config.password), DB_NAME: owned!.database,
          ENCRYPTION_KEY: 'a'.repeat(64), QUALIFICATION_DEEPSEEK_API_KEY: 'fixture-never-sent-to-model',
          QUALIFICATION_CANCELLABLE_LLM_PORT: '28901' },
      });
      return { code: 0, output: result.stdout + result.stderr };
    } catch (error: any) {
      return { code: error.code, output: String(error.stdout) + String(error.stderr) };
    }
  }
  async function assertConfigured(script: string) {
    const rows = await snapshot();
    expect(rows.filter(row => row.enabled || row.is_default).map(row => row.name)).toEqual(['deepseek']);
    const target = rows.find(row => row.name === 'deepseek')!;
    expect([target.enabled, target.is_default, target.deployment_type, target.api_format]).toEqual([1, 1, 'api', 'openai-completions']);
    expect(target.display_name).toBe(script === scripts[0] ? 'Qualification DeepSeek' : 'Qualification Cancellable');
    expect(target.default_model).toBe(script === scripts[0] ? 'deepseek-chat' : 'qualification-cancellable');
    expect(target.api_base_url).toBe(script === scripts[0] ? 'https://api.deepseek.com/v1' : 'http://127.0.0.1:28901/v1');
    expect(rows[0].api_key_encrypted).toBe('opaque-original');
  }
  for (const script of scripts) {
    it(`${script}: normal switch and repeat via documented entry`, async () => {
      expect((await entry(script)).code).toBe(0);
      await assertConfigured(script);
      expect((await entry(script)).code).toBe(0);
      await assertConfigured(script);
    }, 15000);
    it(`${script}: missing target preserves original configuration and fails`, async () => {
      await pool.query("DELETE FROM llm_providers WHERE name = 'deepseek'");
      const before = await snapshot();
      const result = await entry(script);
      expect(result.code).not.toBe(0);
      expect(result.output).not.toContain('provider configured');
      expect(await snapshot()).toEqual(before);
    }, 15000);
    it(`${script}: second update failure rolls back first update`, async () => {
      await pool.query(`CREATE TRIGGER fail_target BEFORE UPDATE ON llm_providers FOR EACH ROW
        BEGIN IF NEW.name = 'deepseek' AND NEW.enabled = 1 THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MAX490 target write rejected'; END IF; END`);
      const before = await snapshot();
      const result = await entry(script);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('MAX490 target write rejected');
      expect(result.output).not.toContain('provider configured');
      expect(await snapshot()).toEqual(before);
    }, 15000);
    it(`${script}: trigger silently suppressing target state fails verification and rolls back`, async () => {
      await pool.query(`CREATE TRIGGER fail_target BEFORE UPDATE ON llm_providers FOR EACH ROW
        BEGIN IF NEW.name = 'deepseek' THEN SET NEW.enabled = 0; END IF; END`);
      const before = await snapshot();
      expect((await entry(script)).code).not.toBe(0);
      expect(await snapshot()).toEqual(before);
    }, 15000);
  }
  it('unchanged target succeeds with actual affectedRows=0 and one pool connection', async () => {
    const single = mysql.createPool({ ...config, database: owned!.database, connectionLimit: 1, flags: '-FOUND_ROWS' });
    const fixed = { displayName: 'Stable', encryptedApiKey: 'opaque-fixed', baseUrl: 'http://localhost/v1', model: 'fixed' };
    try {
      await configureQualificationProvider(single, fixed);
      const [result] = await single.query<mysql.ResultSetHeader>(
        "UPDATE llm_providers SET enabled = 1 WHERE name = 'deepseek' AND enabled = 1",
      );
      expect(result.affectedRows).toBe(0);
      await configureQualificationProvider(single, fixed);
    } finally { await single.end(); }
  }, 10000);
  it('concurrent actual script entries serialize and retain one complete configuration', async () => {
    const results = await Promise.all([entry(scripts[0]), entry(scripts[1]), entry(scripts[0]), entry(scripts[1])]);
    expect(results.map(row => row.code)).toEqual([0, 0, 0, 0]);
    const rows = await snapshot();
    const winner = rows.find(row => row.name === 'deepseek')!.display_name;
    await assertConfigured(winner === 'Qualification DeepSeek' ? scripts[0] : scripts[1]);
  }, 15000);
  it('shares MAX-493 collection lock order, waits on a real row lock, then completes without deadlock', async () => {
    const blocker = await pool.getConnection();
    const spy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    let child: ReturnType<typeof entry> | undefined;
    let service: ReturnType<typeof llmDatabaseService.setDefaultProvider> | undefined;
    try {
      await blocker.beginTransaction();
      await blocker.execute('SELECT id FROM llm_providers ORDER BY id FOR UPDATE');
      child = entry(scripts[1]);
      const deadline = Date.now() + 5000;
      let observed = false;
      while (Date.now() < deadline) {
        const [rows] = await admin!.query<mysql.RowDataPacket[]>(
          `SELECT w.REQUESTING_ENGINE_TRANSACTION_ID FROM performance_schema.data_lock_waits w
           JOIN performance_schema.threads t ON t.THREAD_ID = w.REQUESTING_THREAD_ID
           WHERE t.PROCESSLIST_DB = ?`, [owned!.database]);
        if (rows.length) { observed = true; break; }
        await setTimeout(20);
      }
      expect(observed).toBe(true);
      service = llmDatabaseService.setDefaultProvider('deepseek');
      await blocker.commit();
      expect((await child).code).toBe(0);
      expect((await service).success).toBe(true);
      await assertConfigured(scripts[1]);
    } finally {
      await blocker.rollback(); blocker.release(); spy.mockRestore();
      if (child) await child;
      if (service) await service;
    }
  }, 15000);
});
