import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { FaultDiagnosisService, type FaultDiagnosisDependencies } from './fault-diagnosis-service.js';
import { MysqlWorkflowStore } from './workflows/worker-runtime.js';
import mysql from 'mysql2/promise';
import { splitSqlStatements } from './migrations/runner.js';
import { AnalysisDispatchStore } from './analysis/analysis-dispatch-store.js';
import { parseFaultDiagnosisInstanceId } from './fault-diagnosis-route-input.js';
import type { AnalysisAcceptance } from './analysis/analysis-dispatch-store.js';

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const submit = source.slice(source.indexOf("  fastify.post('/api/ai/analysis',"), source.indexOf('  // 轮询分析状态'));
const retry = source.slice(source.indexOf("  fastify.post('/api/ai/analysis/:id/reanalyze',"), source.indexOf('  // 获取自动分析配置'));
const actor = { userId: 7, username: 'operator', roles: [], permissions: ['ai:manage', 'instance:view'], sessionVersion: 1, instanceScopes: { 42: 'read-only' as const }, requestId: 'http-test' };

describe('MAX-438 production HTTP registration and fault service', () => {
  for (const path of ['/api/ai/analysis', '/api/ai/analysis/73/reanalyze']) {
    it.each(['pending', 'running', 'completed', 'unknown'] as const)(`${path} preserves %s, cache flag and ID`, async status => {
      const dispatch = vi.fn(async (): Promise<AnalysisAcceptance> => ({ analysisId: 73, status, success: status !== 'unknown', cached: status === 'completed' }));
      const service = new FaultDiagnosisService({
        dispatch, contextCollector: { collect: async () => ({ subject: { type: 'instance', id: 42 }, database: { instance: { name: 'test' } } }) },
      } as unknown as FaultDiagnosisDependencies);
      const app = Fastify();
      const deps = {
        fastify: app, verifyToken: async (request: any) => { request.user = actor; },
        requirePermission: () => async () => {}, hasInstanceAccess: () => true,
        parseFaultDiagnosisInstanceId, faultDiagnosisService: service,
        aiAnalysisDatabaseService: { getAnalysisById: async () => ({ id: 73, analysis_type: 'fault_diagnosis', instance_id: 42, status: 'completed' }) },
      };
      new Function(...Object.keys(deps), transpileModule(submit + retry, {}).outputText)(...Object.values(deps));
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const response = await fetch(address + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ analysis_type: 'fault_diagnosis', instance_id: 42 }) });
        const result = await response.json() as any;
        expect(response.status).toBe(status === 'unknown' ? 409 : 200);
        expect(result.status).toBe(status);
        expect(result.id ?? result.analysisId).toBe(73);
        expect(result.cached).toBe(status === 'completed');
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally { await app.close(); }
    });
  }
});


it.skipIf(!process.env.FAULT_DIAGNOSIS_TEST_MYSQL_PORT)('MAX-438 real MySQL admissions are reused through production HTTP and service without another intent', async () => {
  const options = { host: process.env.FAULT_DIAGNOSIS_TEST_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.FAULT_DIAGNOSIS_TEST_MYSQL_PORT), user: process.env.FAULT_DIAGNOSIS_TEST_MYSQL_USER ?? 'root',
    password: process.env.FAULT_DIAGNOSIS_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
  const admin = mysql.createPool(options);
  const database = `max432_http_${process.pid}`;
  let pool: ReturnType<typeof mysql.createPool> | undefined;
  const app = Fastify();
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database });
    await pool.query(`CREATE TABLE ai_analysis (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, analysis_type VARCHAR(32), target_type VARCHAR(32), instance_id INT, server_id INT, network_device_id INT, related_id INT, status ENUM('pending','running','completed','failed') DEFAULT 'pending', trigger_type VARCHAR(16), cache_key VARCHAR(255), session_key VARCHAR(255), result JSON, analysis_envelope JSON, envelope_backfill_status VARCHAR(32), execution_trace JSON, \`usage\` JSON, error_message TEXT, duration_ms INT, ttl_minutes INT DEFAULT 1440, cache_ttl_minutes INT, started_at DATETIME, completed_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    await pool.query('CREATE TABLE report_configs (id INT PRIMARY KEY, format VARCHAR(32))');
    for (const file of ['032_workflow_outbox_jobs.sql', '036_notification_delivery_audit.sql', '041_report_notification_delivery.sql', '093_delivery_recovery.sql', '109_analysis_dispatch_recovery.sql', '157_analysis_dispatch_id_range.sql']) {
      for (const sql of splitSqlStatements(readFileSync(new URL(`../sql/migrations/${file}`, import.meta.url), 'utf8'))) await pool.query(sql);
    }
    const store = new AnalysisDispatchStore(() => pool!);
    const dispatch = vi.fn(async () => store.enqueue({ analysisType: 'fault_diagnosis',
      cacheKey: 'fault:42:http:manual:user:7:session:1', triggerType: 'manual',
      request: { purpose: 'fault_diagnosis', subject: { type: 'instance', id: 42 }, actor,
        message: 'isolated acceptance fixture', systemPrompt: 'fixture', evidenceVersion: 'e1', configVersion: 'c1', authorizationVersion: 'a1' } }));
    const service = new FaultDiagnosisService({ dispatch,
      contextCollector: { collect: async () => ({ subject: { type: 'instance', id: 42 }, database: { instance: { name: 'test' } } }) },
    } as unknown as FaultDiagnosisDependencies);
    const deps = { fastify: app, verifyToken: async (request: any) => { request.user = actor; },
      requirePermission: () => async () => {}, hasInstanceAccess: () => true,
      parseFaultDiagnosisInstanceId, faultDiagnosisService: service };
    new Function(...Object.keys(deps), transpileModule(submit, {}).outputText)(...Object.values(deps));
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const post = async () => {
      const response = await fetch(address + '/api/ai/analysis', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ analysis_type: 'fault_diagnosis', instance_id: 42 }) });
      return { code: response.status, body: await response.json() as any };
    };
    const first = await post();
    const id = first.body.id;
    expect(first.body).toMatchObject({ status: 'pending', cached: false });
    expect((await post()).body).toMatchObject({ id, status: 'pending', cached: false });
    const jobsStore = new MysqlWorkflowStore(() => pool as any);
    const job = (await jobsStore.claim('max432-http', 30))!;
    expect(job).not.toBeNull();
    await store.claim(id, job, { workerId: 'max432-http', fencingToken: job.fencingToken, signal: new AbortController().signal });
    expect((await post()).body).toMatchObject({ id, status: 'running', cached: false });
    await pool.query("UPDATE ai_analysis SET status = 'completed', completed_at = NOW() WHERE id = ?", [id]);
    expect((await post()).body).toMatchObject({ id, status: 'completed', cached: true });
    await pool.query("UPDATE ai_analysis SET status = 'unknown' WHERE id = ?", [id]);
    const unknown = await post();
    expect(unknown.code).toBe(409);
    expect(unknown.body).toMatchObject({ analysisId: id, status: 'unknown', cached: false });
    const [rows] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM ai_analysis');
    expect(rows[0].n).toBe(1);
    const [jobs] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM workflow_jobs');
    expect(jobs[0].n).toBe(1);
    console.info('MAX-432 isolated HTTP/MySQL: pending/running/completed/unknown, one analysis/intent; no worker/provider invoked');
  } finally {
    await app.close(); await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    const [remaining] = await admin.query<any[]>('SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ?', [database]);
    expect(remaining[0].n).toBe(0);
    console.info('MAX-432 isolated HTTP/MySQL schema cleanup verified');
    await admin.end();
  }
});
