import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { llmDatabaseService } from './llm-database-service.js';

const port = Number(process.env.LLM_TEST_MYSQL_PORT);
describe.skipIf(!port)('default provider transactions in MySQL', () => {
  const database = `llm_default_${process.pid}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    const options = { host: '127.0.0.1', port, user: 'root', password: process.env.LLM_TEST_MYSQL_PASSWORD ?? '' };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE \`${database}\``);
    pool = mysql.createPool({ ...options, database, connectionLimit: 10 });
    await pool.query('CREATE TABLE llm_providers (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) NOT NULL UNIQUE, is_default BOOLEAN NOT NULL DEFAULT FALSE, INDEX (is_default)) ENGINE=InnoDB');
  });
  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS fail_default');
    await pool.query('DELETE FROM llm_providers');
    await pool.query("INSERT INTO llm_providers (name, is_default) VALUES ('alpha', TRUE), ('beta', FALSE), ('gamma', FALSE)");
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP DATABASE \`${database}\``); await admin.end(); } });

  async function defaults() {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT name FROM llm_providers WHERE is_default = TRUE ORDER BY name');
    return rows.map(row => row.name);
  }

  it('rolls back the original default when the target update fails', async () => {
    await pool.query("CREATE TRIGGER fail_default BEFORE UPDATE ON llm_providers FOR EACH ROW BEGIN IF NEW.name = 'beta' AND NEW.is_default = TRUE THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected failure'; END IF; END");
    expect((await llmDatabaseService.setDefaultProvider('beta')).success).toBe(false);
    expect(await defaults()).toEqual(['alpha']);
    await pool.query('DROP TRIGGER fail_default');
    expect((await llmDatabaseService.setDefaultProvider('beta')).success).toBe(true);
    expect(await defaults()).toEqual(['beta']);
  });

  it('preserves the default when the target does not exist', async () => {
    expect((await llmDatabaseService.setDefaultProvider('missing')).success).toBe(false);
    expect(await defaults()).toEqual(['alpha']);
  });

  it('serializes concurrent switches', async () => {
    for (let i = 0; i < 20; i++) {
      const results = await Promise.all(['alpha', 'beta', 'gamma'].map(name => llmDatabaseService.setDefaultProvider(name)));
      expect(results.every(result => result.success)).toBe(true);
      expect(await defaults()).toHaveLength(1);
    }
  });

  it('does not report success when a concurrent deletion wins', async () => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("DELETE FROM llm_providers WHERE name = 'beta'");
      const switching = llmDatabaseService.setDefaultProvider('beta');
      await connection.commit();
      expect((await switching).success).toBe(false);
      expect(await defaults()).toEqual(['alpha']);
    } finally { connection.release(); }
  });
});
