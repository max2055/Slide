import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueue, explain } = vi.hoisted(() => ({ enqueue: vi.fn(), explain: vi.fn() }));
vi.mock('../src/analysis/analysis-runtime.js', () => ({ analysisDispatchStore: { enqueue } }));
vi.mock('../src/analysis/analysis-identity.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/analysis/analysis-identity.js')>(),
  analysisConfigurationVersion: async () => 'max536-test-provider',
}));
vi.mock('../src/database-service.js', () => ({ databaseService: { getConnection: () => ({ db_type: 'mysql' }), getExplainPlan: explain } }));
import { dbConnection } from '../src/db-connection.js';
import { actorContextService } from '../src/auth/actor-context.js';
import { metricsDatabaseService } from '../src/metrics-database-service.js';
import { topsqlAnalysisService } from '../src/topsql-analysis-service.js';
import { evidenceHash } from '../src/analysis/analysis-evidence.js';

// Explicit opt-in: default test collection never reads credentials or connects.
// Real MySQL persistence/lookup + production evidence/bridge; session refresh,
// target EXPLAIN, provider identity and durable enqueue are controlled substitutes.
const enabled = process.env.MAX536_MYSQL_ACCEPTANCE === '1';
const actor = { userId: 7, username: 'op', roles: [], permissions: ['ai:manage'], sessionVersion: 1, instanceScopes: { 42: 'read-only' as const }, requestId: 'MAX-536' };
const schema = `max536_${randomBytes(6).toString('hex')}`;
let admin: mysql.Connection | undefined;
let pool: mysql.Pool | undefined;
let owned = false;
let ended = false;

describe.skipIf(!enabled)('MAX-536 real isolated MySQL acceptance', () => {
  beforeAll(async () => {
    const { MAX536_MYSQL_HOST: host, MAX536_MYSQL_PORT: port, MAX536_MYSQL_USER: user, MAX536_MYSQL_PASSWORD: password } = process.env;
    if (host !== '127.0.0.1' || port !== '3308' || !user || password === undefined) {
      throw new Error('MAX536 real acceptance requires injected 127.0.0.1:3308 user/password');
    }
    admin = await mysql.createConnection({ host, port: Number(port), user, password });
    await admin.query(`CREATE DATABASE \`${schema}\``);
    owned = true;
    pool = mysql.createPool({ host, port: Number(port), user, password, database: schema, connectionLimit: 2 });
    const ddl = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
    const slowQueriesDdl = ddl.match(/CREATE TABLE IF NOT EXISTS `slow_queries` \([\s\S]*?ENGINE=InnoDB[^;]*;/)?.[0];
    if (!slowQueriesDdl) throw new Error('slow_queries production DDL missing');
    await pool.query(slowQueriesDdl);
    await pool.query('CREATE TABLE database_instances (id INT PRIMARY KEY)');
    await pool.query('INSERT INTO database_instances VALUES (42), (43)');
    for (let id = 1; id <= 102; id++) {
      await pool.execute('INSERT INTO slow_queries (id,instance_id,sql_text,sql_hash,avg_time_ms,max_time_ms,min_time_ms,total_time_ms) VALUES (?,42,?,?,?,NULL,0,2.50)',
        [id, 'SELECT 1', `hash${id}`, id > 100 ? 1.25 : 1000 + id]);
    }
    vi.spyOn(dbConnection, 'getPool').mockImplementation(() => pool!);
    vi.spyOn(actorContextService, 'revalidateActor').mockResolvedValue(actor);
    console.log(JSON.stringify({ stage: 'setup', schema, endpoint: '127.0.0.1:3308', schemaSource: 'sql/schema.sql slow_queries', records: 102 }));
  }, 15000);

  beforeEach(() => {
    enqueue.mockReset(); enqueue.mockResolvedValue({ analysisId: 900, success: true, cached: false, status: 'pending' });
    explain.mockReset(); explain.mockResolvedValue('MySQL 执行计划:\n  constant');
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      if (pool && !ended) await pool.end();
    } finally {
      if (admin) {
        try {
          if (owned) {
            await admin.query(`DROP DATABASE \`${schema}\``);
            const [rows] = await admin.query<any[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [schema]);
            expect(rows).toHaveLength(0);
            console.log(JSON.stringify({ stage: 'cleanup', schema, remaining: rows.length }));
          }
        } finally { await admin.end(); }
      }
    }
  });

  it.each(['analyzeSlowQuery', 'reanalyzeSlowQuery'] as const)('%s accepts rank >100 and freezes the correct evidence before admission', async method => {
    const list = await metricsDatabaseService.getSlowQueries(42, 100, { strict: true });
    expect(list).toHaveLength(100);
    expect(list.some(row => row.id === 101)).toBe(false);
    await expect(topsqlAnalysisService[method](101, 42, 'manual', actor)).resolves.toBe(900);
    const accepted = enqueue.mock.calls[0][0];
    expect(accepted.relatedId).toBe(101);
    expect(accepted.ttlMs).toBe(method === 'analyzeSlowQuery' ? 86400000 : 0);
    const evidence = accepted.request.evidence;
    expect(evidence.subject).toEqual({ type: 'instance', id: 42 });
    expect(evidence.data.metrics).toMatchObject({ avg_time_ms: 1.25, max_time_ms: null, min_time_ms: 0, total_time_ms: 2.5 });
    expect(evidence.hash).toBe(evidenceHash(evidence.data));
    expect(accepted.request.evidenceVersion).toBe(evidence.hash);
    console.log(JSON.stringify({ stage: method, id: 101, excludedFromTop100: true, evidenceHash: evidence.hash }));
  });

  it.each(['analyzeSlowQuery', 'reanalyzeSlowQuery'] as const)('%s hides another instance record with the same requested ID', async method => {
    await expect(metricsDatabaseService.getSlowQueryById(43, 101)).resolves.toBeNull();
    await expect(topsqlAnalysisService[method](101, 43, 'manual', actor)).rejects.toThrow('慢查询 #101 不存在');
    expect(enqueue).not.toHaveBeenCalled(); expect(explain).not.toHaveBeenCalled();
  });

  it('both entrances reject a deleted record', async () => {
    await pool!.execute('DELETE FROM slow_queries WHERE id = 102');
    for (const method of ['analyzeSlowQuery', 'reanalyzeSlowQuery'] as const) {
      await expect(topsqlAnalysisService[method](102, 42, 'manual', actor)).rejects.toThrow('慢查询 #102 不存在');
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('current authorization revocation blocks evidence collection and admission', async () => {
    vi.mocked(actorContextService.revalidateActor).mockResolvedValueOnce({ ...actor, permissions: [] });
    await expect(topsqlAnalysisService.analyzeSlowQuery(101, 42, 'manual', actor)).rejects.toThrow('ANALYSIS_AUTHORITY_REVOKED');
    expect(enqueue).not.toHaveBeenCalled(); expect(explain).not.toHaveBeenCalled();
  });

  it('both entrances distinguish a closed real pool from missing records', async () => {
    await pool!.end(); ended = true;
    for (const method of ['analyzeSlowQuery', 'reanalyzeSlowQuery'] as const) {
      await expect(topsqlAnalysisService[method](101, 42, 'manual', actor)).rejects.toThrow('SLOW_QUERIES_QUERY_FAILED');
    }
    expect(enqueue).not.toHaveBeenCalled(); expect(explain).not.toHaveBeenCalled();
  });
});
