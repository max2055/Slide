import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, type LLMProvider } from '@slide/agent-core';
import { DirectAdapter } from './adapter/direct-adapter.js';
import { randomBytes } from 'node:crypto';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./database-service.js', () => ({ databaseService: { getConnection: vi.fn(), getExplainPlan: vi.fn() } }));
vi.mock('./db-connection.js', () => ({ dbConnection: { getPool: vi.fn() } }));

import { sqlAuditService } from './sql-audit-service.js';
import { databaseService } from './database-service.js';
import { dbConnection } from './db-connection.js';
import { MigrationRunner } from './migrations/runner.js';
import { actorContextService, type ActorContext } from './auth/actor-context.js';
import { analysisDispatchStore } from './analysis/analysis-runtime.js';
import { authorizeAnalysisRequest, analysisConfigurationVersion } from './analysis/analysis-identity.js';
import { MysqlWorkflowStore } from './workflows/worker-runtime.js';
import { JobRegistry } from './workflows/job-registry.js';
import { registerAnalysisDispatchHandler } from './analysis/analysis-dispatch-handler.js';

// Explicit opt-in. Default collection never reads credentials or opens a connection.
describe.skipIf(process.env.SQL_AUDIT_MYSQL_TEST !== '1')('MAX-533 real MySQL audit admission, cache and lifecycle', () => {
  const schema = `max533_${randomBytes(8).toString('hex')}`;
  let admin: Pool, pool: Pool, actor: ActorContext, jobs: MysqlWorkflowStore;
  let created = false, sends = 0;
  const submit = (sql = 'SELECT * FROM audit_subject WHERE id=1', who = actor) => sqlAuditService.submitAudit(sql, 1, who);
  const rows = async (sql: string, values: unknown[] = []) => (await pool.query<any[]>(sql, values))[0];

  beforeAll(async () => {
    if (!process.env.SQL_AUDIT_MYSQL_PORT || !process.env.SQL_AUDIT_MYSQL_USER) {
      throw new Error('Explicit SQL_AUDIT_MYSQL_PORT and SQL_AUDIT_MYSQL_USER are required');
    }
    const config = {
      host: process.env.SQL_AUDIT_MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.SQL_AUDIT_MYSQL_PORT), user: process.env.SQL_AUDIT_MYSQL_USER,
      password: process.env.SQL_AUDIT_MYSQL_PASSWORD || '', connectionLimit: 2, timezone: 'Z',
    };
    admin = mysql.createPool(config);
    await admin.query(`CREATE DATABASE ${schema}`); created = true;
    pool = mysql.createPool({ ...config, database: schema });
    pool.on('connection', connection => {
      (connection as any).query("SET time_zone = '+00:00'");
    });
    await new MigrationRunner(pool as any).run();
    await pool.query(`INSERT INTO database_instances(id,name,host,port,username,password_encrypted)
      VALUES (1,'max533','127.0.0.1',3308,'fixture','fixture'),(2,'other','127.0.0.1',3309,'fixture','fixture')`);
    await pool.query('CREATE TABLE audit_subject (id INT PRIMARY KEY, note TEXT)');
    await pool.query("INSERT INTO audit_subject VALUES (1,'original')");
    await pool.query(`INSERT INTO index_info(instance_id,table_name,index_name,column_name,seq_in_index,non_unique,index_type)
      SELECT 1,TABLE_NAME,INDEX_NAME,COLUMN_NAME,SEQ_IN_INDEX,NON_UNIQUE,INDEX_TYPE
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME='audit_subject'`, [schema]);
    await pool.query("INSERT INTO users(id,username,password_hash) VALUES (53301,'max533-a','fixture'),(53302,'max533-b','fixture')");
    await pool.query("INSERT INTO roles(id,name) VALUES (53301,'max533')");
    await pool.query("INSERT IGNORE INTO permissions(code,name,resource,action) VALUES ('sql:audit','SQL audit','sql','audit')");
    await pool.query('INSERT INTO role_permissions(role_id,permission_id) SELECT 53301,id FROM permissions WHERE code IN (\'sql:audit\',\'instance:view\')');
    await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES (53301,53301),(53302,53301)');
    await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES (53301,1,'read-only'),(53301,2,'read-only'),(53302,1,'read-only')");
    await pool.query('UPDATE llm_providers SET is_default=0');
    await pool.query(`INSERT INTO llm_providers(name,display_name,default_model,enabled,is_default,supports_function_call)
      VALUES ('max533','fixture','model-a',1,1,1)`);
    vi.mocked(dbConnection.getPool).mockReturnValue(pool);
    vi.mocked(databaseService.getConnection).mockReturnValue({ connected: true, pool, config: { database: schema, db_type: 'mysql' } } as any);
    const realDatabase = await vi.importActual<typeof import('./database-service.js')>('./database-service.js');
    vi.mocked(databaseService.getExplainPlan).mockImplementation(async (id, sql) =>
      (realDatabase.databaseService as any).getMySQLExplainPlan({ id, pool }, sql));
    actor = await actorContextService.loadActiveActor(53301);
    jobs = new MysqlWorkflowStore(() => pool as any);
    expect(actor.permissions).toContain('sql:audit');
    expect(actor.permissions).not.toContain('ai:manage');
    console.log('MAX533 environment', { schema, port: config.port, version: (await rows('SELECT VERSION() version'))[0].version });
  }, 180000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await pool?.end();
    if (admin) try {
      if (created) await admin.query(`DROP DATABASE ${schema}`);
      expect((await admin.query<any[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [schema]))[0]).toHaveLength(0);
      console.log('MAX533 cleanup: owned schema removed; no external model requests');
    } finally { await admin.end(); }
  });

  // Production handler + store + live authorization, controlled engine at the model boundary.
  async function run(id: number, mode: 'complete' | 'unknown' | 'revoke' | 'config' = 'complete') {
    const [dispatch] = await rows('SELECT job_id FROM analysis_dispatches WHERE analysis_id=?', [id]);
    await pool.query("UPDATE workflow_jobs SET available_at=DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE state IN ('queued','retry')");
    await pool.query('UPDATE workflow_jobs SET available_at=DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id=?', [dispatch.job_id]);
    const job = (await jobs.claim('max533', 30))!;
    expect(job.id).toBe(dispatch.job_id);
    const registry = new JobRegistry();
    registerAnalysisDispatchHandler(registry, {
      store: analysisDispatchStore, authorize: authorizeAnalysisRequest, configurationVersion: analysisConfigurationVersion,
      engine: async () => ({ invoke: async (_s: string, _m: string, _p: string, options: any) => {
        await options.beforeProviderRequest(); sends++;
        if (mode === 'unknown') return { stopReason: 'error', error: 'fixture unknown' };
        if (mode === 'revoke') {
          await pool.query('DELETE FROM instance_permissions WHERE user_id=53301 AND instance_id=1');
        }
        const completed = await options.completeAnalysis({
          schemaVersion: 1, analysisType: 'sql_audit', subject: { type: 'instance', id: 1 },
          conclusions: ['fixture'], hypotheses: [], evidenceRefs: [], confidence: 0,
          recommendations: [], displayMarkdown: 'fixture SQL audit',
          provenance: { modelVersion: 'fixture', promptVersion: 'fixture', toolVersions: {} },
          createdAt: new Date().toISOString(),
        });
        expect(completed.success).toBe(true);
        return { stopReason: 'completed' };
      } } as any),
    });
    const work = registry.execute(job, { workerId: 'max533', fencingToken: job.fencingToken, signal: new AbortController().signal });
    if (mode === 'revoke') await expect(work).rejects.toThrow('ANALYSIS_AUTHORITY_REVOKED');
    else if (mode === 'config') await expect(work).rejects.toThrow('ANALYSIS_CONFIGURATION_CHANGED');
    else await work;
    await jobs.complete(job.id, 'max533', job.fencingToken);
  }

  it('reuses a completed result inside 30 minutes, preserves risks, and deduplicates concurrent admission', async () => {
    const sql = 'UPDATE audit_subject SET note=\'changed\'';
    const accepted = await Promise.all([submit(sql), submit(sql)]);
    expect(accepted[0]).toEqual(accepted[1]);
    expect(await rows('SELECT * FROM sql_audit_records')).toHaveLength(1);
    await run(accepted[0].analysisId);
    const before = sends;
    const reused = await submit(sql);
    expect(reused).toEqual(accepted[0]);
    expect(reused.preAuditResults).toContainEqual(expect.objectContaining({ pattern: 'MISSING WHERE', level: 'error' }));
    expect(sends).toBe(before);
    const [analysis] = await rows('SELECT status,result FROM ai_analysis WHERE id=?', [reused.analysisId]);
    expect(analysis.status).toBe('completed');
    expect(analysis.result.pre_audit_results).toEqual(reused.preAuditResults);
    expect(analysis.result.index_info).toContain('PRIMARY (id)');
    expect(analysis.result.table_stats).toContain('表: audit_subject');
    expect(analysis.result.explain_plan).not.toContain('失败');
    expect((await rows('SELECT status,risk_level FROM sql_audit_records WHERE id=?', [reused.recordId]))[0]).toMatchObject({ status: 'completed', risk_level: 'P0' });
    expect(await rows('SELECT note FROM audit_subject')).toEqual([{ note: 'original' }]);
  });

  it('expires results at the TTL and reanalyzes evidence/config/authorization changes', async () => {
    const first = await submit(); await run(first.analysisId);
    const same = await submit(); expect(same.analysisId).toBe(first.analysisId);
    await pool.query('UPDATE ai_analysis SET completed_at=DATE_SUB(NOW(), INTERVAL 31 MINUTE) WHERE id=?', [first.analysisId]);
    const expired = await submit(); expect(expired.analysisId).not.toBe(first.analysisId); await run(expired.analysisId);
    await pool.query("UPDATE index_info SET index_type='HASH' WHERE instance_id=1");
    const evidence = await submit(); expect(evidence.analysisId).not.toBe(expired.analysisId); await run(evidence.analysisId);
    await pool.query("UPDATE llm_providers SET default_model='model-b' WHERE name='max533'");
    const config = await submit(); expect(config.analysisId).not.toBe(evidence.analysisId); await run(config.analysisId);
    await pool.query("UPDATE instance_permissions SET access_level='read-write' WHERE user_id=53301 AND instance_id=1");
    const auth = await submit(); expect(auth.analysisId).not.toBe(config.analysisId); await run(auth.analysisId);
    const other = await submit(undefined, await actorContextService.loadActiveActor(53302));
    expect(other.analysisId).not.toBe(auth.analysisId); await run(other.analysisId);
    const instance = await sqlAuditService.submitAudit('SELECT * FROM audit_subject WHERE id=1', 2, actor);
    expect(instance.analysisId).not.toBe(auth.analysisId);
    const literal = await submit('SELECT * FROM audit_subject WHERE id=2');
    expect(literal.analysisId).not.toBe(auth.analysisId);
  });

  it('rolls back the audit row if durable intent insertion fails', async () => {
    const count = (await rows('SELECT COUNT(*) n FROM sql_audit_records'))[0].n;
    await pool.query("CREATE TRIGGER max533_fail BEFORE INSERT ON analysis_dispatches FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected'");
    try { await expect(submit('SELECT 533')).rejects.toThrow('injected'); }
    finally { await pool.query('DROP TRIGGER max533_fail'); }
    expect((await rows('SELECT COUNT(*) n FROM sql_audit_records'))[0].n).toBe(count);
  });

  it('rejects a changed configuration before send and permits a fresh admission after settlement', async () => {
    const accepted = await submit('SELECT 536');
    const before = sends;
    await pool.query("UPDATE llm_providers SET max_tokens=max_tokens+1 WHERE name='max533'");
    await expect(submit('SELECT 536')).rejects.toThrow('SQL_AUDIT_ACTIVE_IDENTITY_CHANGED');
    await run(accepted.analysisId, 'config');
    expect(sends).toBe(before);
    expect((await rows('SELECT status FROM sql_audit_records WHERE id=?', [accepted.recordId]))[0].status).toBe('failed');
    const fresh = await submit('SELECT 536');
    expect(fresh.analysisId).not.toBe(accepted.analysisId);
    await run(fresh.analysisId);
  });

  it('runs the real DirectAdapter completion tool and then reuses the persisted result', async () => {
    const submitted = await submit('SELECT 537');
    const [dispatch] = await rows('SELECT job_id FROM analysis_dispatches WHERE analysis_id=?', [submitted.analysisId]);
    await pool.query("UPDATE workflow_jobs SET available_at=DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE state IN ('queued','retry')");
    await pool.query('UPDATE workflow_jobs SET available_at=DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id=?', [dispatch.job_id]);
    const job = (await jobs.claim('max533-adapter', 30))!;
    const workspace = mkdtempSync(join(tmpdir(), 'max533-adapter-'));
    let calls = 0;
    const provider: LLMProvider = {
      getDefaultModel: () => 'fixture',
      getModelCapabilities: () => ({ model: 'fixture', contextWindowTokens: 32000, preferredOutputTokens: 2048, source: 'configuration', version: 'test' }),
      chat: async (messages, tools) => {
        expect(tools.map(t => t.name)).toEqual(['slide_complete_analysis']);
        expect(JSON.stringify(messages)).toContain('pre_audit_results');
        if (calls++ === 0) return {
          content: null, finishReason: 'tool_calls', shouldExecuteTools: true, hasToolCalls: true,
          toolCalls: [{ id: 'complete', name: 'slide_complete_analysis', arguments: {
            analysisId: submitted.analysisId, envelope: {
              schemaVersion: 1, analysisType: 'sql_audit', subject: { type: 'instance', id: 1 },
              conclusions: ['fixture'], hypotheses: [], evidenceRefs: [], confidence: 0,
              recommendations: [], displayMarkdown: 'fixture adapter SQL audit',
              provenance: { modelVersion: 'fixture', promptVersion: 'fixture', toolVersions: {} },
              createdAt: new Date().toISOString(),
            },
          } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
        return { content: 'done', finishReason: 'stop', shouldExecuteTools: false, hasToolCalls: false, toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
      chatStream: async () => { throw new Error('UNEXPECTED_STREAM'); },
    };
    const adapter = new DirectAdapter({ workspace, tools: new ToolRegistry(), llmProvider: provider });
    try {
      const registry = new JobRegistry();
      registerAnalysisDispatchHandler(registry, {
        store: analysisDispatchStore, authorize: authorizeAnalysisRequest, configurationVersion: analysisConfigurationVersion,
        engine: async () => adapter,
      });
      await registry.execute(job, { workerId: 'max533-adapter', fencingToken: job.fencingToken, signal: new AbortController().signal });
      await jobs.complete(job.id, 'max533-adapter', job.fencingToken);
      expect(calls).toBe(2);
      expect((await rows('SELECT status,analysis_envelope FROM ai_analysis WHERE id=?', [submitted.analysisId]))[0]).toMatchObject({
        status: 'completed', analysis_envelope: { analysisType: 'sql_audit', provenance: { usageStatus: 'available' } },
      });
      expect(await submit('SELECT 537')).toEqual(submitted);
      expect(calls).toBe(2);
    } finally { await adapter.dispose(); rmSync(workspace, { recursive: true, force: true }); }
  });

  it('never replays an unknown result and prevents completion after live revocation', async () => {
    const unknown = await submit('SELECT 534'); await run(unknown.analysisId, 'unknown');
    const before = sends;
    await expect(submit('SELECT 534')).rejects.toThrow('ANALYSIS_PROVIDER_RESULT_UNKNOWN');
    expect(sends).toBe(before);
    const revoked = await submit('SELECT 535'); await run(revoked.analysisId, 'revoke');
    expect((await rows('SELECT status,result FROM ai_analysis WHERE id=?', [revoked.analysisId]))[0]).toMatchObject({ status: 'unknown', result: null });
    await expect(submit()).rejects.toThrow('ANALYSIS_AUTHORITY_REVOKED');
    expect(sends).toBe(before + 1);
    console.log('MAX533 verified: concurrent/TTL/evidence/config/actor/scope identity, rollback, unknown no-replay, live revocation; controlled engine only');
  });
});
