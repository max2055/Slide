import { randomBytes } from 'node:crypto';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./llm-service.js', () => ({ llmService: { chatWithTracking: vi.fn() } }));
vi.mock('./database-service.js', () => ({ databaseService: { getConnection: vi.fn(), getExplainPlan: vi.fn() } }));
vi.mock('./db-connection.js', () => ({ dbConnection: { getPool: vi.fn() } }));

import { sqlAuditService } from './sql-audit-service.js';
import { llmService } from './llm-service.js';
import { databaseService } from './database-service.js';
import { dbConnection } from './db-connection.js';
import { MigrationRunner } from './migrations/runner.js';

// Explicit opt-in. CI collection never loads a developer's credential files.
describe.skipIf(process.env.SQL_AUDIT_MYSQL_TEST !== '1')('MAX-545/547/550 real MySQL audit persistence and metadata', () => {
  const schema = `max545_${randomBytes(8).toString('hex')}`;
  let admin: Pool;
  let pool: Pool;
  let created = false;
  beforeAll(async () => {
    if (!process.env.SQL_AUDIT_MYSQL_PORT || !process.env.SQL_AUDIT_MYSQL_USER) {
      throw new Error('Explicit SQL_AUDIT_MYSQL_PORT and SQL_AUDIT_MYSQL_USER are required');
    }
    const config = {
      host: process.env.SQL_AUDIT_MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.SQL_AUDIT_MYSQL_PORT), user: process.env.SQL_AUDIT_MYSQL_USER,
      password: process.env.SQL_AUDIT_MYSQL_PASSWORD || '', connectionLimit: 2,
    };
    admin = mysql.createPool(config);
    await admin.query(`CREATE DATABASE ${schema}`);
    created = true;
    pool = mysql.createPool({ ...config, database: schema });
    await new MigrationRunner(pool as any).run();
    await pool.query(`INSERT INTO database_instances(id,name,host,port,username,password_encrypted)
      VALUES (1,'max545','127.0.0.1',3308,'fixture','fixture')`);
    await pool.query('CREATE TABLE audit_subject (id INT PRIMARY KEY, note TEXT)');
    await pool.query("INSERT INTO audit_subject VALUES (1,'original')");
    await pool.query(`INSERT INTO index_info(instance_id,table_name,index_name,column_name,seq_in_index,non_unique,index_type)
      SELECT 1,TABLE_NAME,INDEX_NAME,COLUMN_NAME,SEQ_IN_INDEX,NON_UNIQUE,INDEX_TYPE
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME='audit_subject'`, [schema]);
    vi.mocked(dbConnection.getPool).mockReturnValue(pool);
    vi.mocked(databaseService.getConnection).mockReturnValue({ connected: true, pool, config: { database: schema } } as any);
    vi.mocked(databaseService.getExplainPlan).mockImplementation(async (_id, sql) => JSON.stringify((await pool.query(`EXPLAIN ${sql}`))[0]));
    vi.mocked(llmService.chatWithTracking).mockResolvedValue({ success: true, content: '{"summary":"fixture"}' } as any);
    console.log('MAX545 environment', { schema, port: config.port, version: (await pool.query<any[]>('SELECT VERSION() version'))[0][0].version });
  }, 180000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await pool?.end();
    if (admin) {
      try {
        if (created) await admin.query(`DROP DATABASE ${schema}`);
        const [rows] = await admin.query<any[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [schema]);
        expect(rows).toHaveLength(0);
        console.log('MAX545 cleanup: owned schema removed');
      } finally { await admin.end(); }
    }
  });

  it('submits audits, persists corrected risks and supplies real table metadata to the model boundary', async () => {
    const values = Array.from({ length: 101 }, (_, i) => i).join(',');
    const cases = [
      { sql: `SELECT * FROM ${schema}.audit_subject WHERE note='from secrets'`, risk: 'P2', missing: false, large: false },
      { sql: 'UPDATE audit_subject SET note=\'changed\'', risk: 'P0', missing: true, large: false },
      { sql: 'DELETE FROM audit_subject', risk: 'P0', missing: true, large: false },
      { sql: 'SELECT COUNT(*) FROM audit_subject', risk: 'P2', missing: true, large: false },
      { sql: `SELECT * FROM audit_subject WHERE id IN (${values})`, risk: 'P2', missing: false, large: true },
      { sql: `SELECT 'in (${values})' FROM audit_subject WHERE id=1`, risk: 'P2', missing: false, large: false },
    ];
    for (const item of cases) {
      const submitted = await sqlAuditService.submitAudit(item.sql, 1, 'max545');
      await vi.waitFor(async () => {
        const [rows] = await pool.query<any[]>('SELECT status,risk_level FROM sql_audit_records WHERE id=?', [submitted.recordId]);
        expect(rows[0]).toMatchObject({ status: 'completed', risk_level: item.risk });
      });
      const [analyses] = await pool.query<any[]>('SELECT status,result FROM ai_analysis WHERE id=?', [submitted.analysisId]);
      expect(analyses[0].status).toBe('completed');
      const result = analyses[0].result;
      expect(result.index_info).toContain('PRIMARY (id)');
      expect(result.table_stats).toContain('表: audit_subject');
      expect(result.index_info).not.toContain('secrets');
      expect(result.explain_plan).not.toContain('失败');
      const patterns = result.pre_audit_results.map((r: any) => r.pattern);
      expect(patterns.includes('MISSING WHERE')).toBe(item.missing);
      expect(patterns.includes('LARGE IN CLAUSE')).toBe(item.large);
    }
    expect(llmService.chatWithTracking).toHaveBeenCalledTimes(cases.length);
    expect((await pool.query<any[]>('SELECT note FROM audit_subject'))[0]).toEqual([{ note: 'original' }]);
    console.log('MAX545: 6 submissions completed; metadata and stored risks verified; audited writes were not executed; model stub only');
  }, 15000);
});
