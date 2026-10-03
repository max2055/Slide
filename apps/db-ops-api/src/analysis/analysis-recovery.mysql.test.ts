import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, type LLMProvider as AgentProvider } from '@slide/agent-core';
import { DirectAdapter } from '../adapter/direct-adapter.js';
import { freezeEvidence } from './analysis-evidence.js';
import { setAnalysisProviderIdentity } from './analysis-execution.js';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import mysql, { type Pool } from 'mysql2/promise';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner, splitSqlStatements } from '../migrations/runner.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../workflows/worker-runtime.js';
import { AnalysisDispatchStore, type AnalysisRequest } from './analysis-dispatch-store.js';
import { registerAnalysisDispatchHandler } from './analysis-dispatch-handler.js';
import { JobRegistry } from '../workflows/job-registry.js';
import { dbConnection } from '../db-connection.js';
import { aiAnalysisDatabaseService } from '../ai-analysis-database-service.js';
import { analysisRecoveryInventory } from './analysis-recovery-inventory.js';
import { actorContextService } from '../auth/actor-context.js';
import { authorizeAnalysisRequest, analysisAuthorizationVersion } from './analysis-identity.js';

const port = Number(process.env.ANALYSIS_TEST_MYSQL_PORT);
describe.skipIf(!port)('analysis durable recovery in isolated MySQL', () => {
  let pool: Pool, admin: Pool, store: AnalysisDispatchStore, jobs: MysqlWorkflowStore;
  const database = `analysis_recovery_${process.pid}`;
  const request: AnalysisRequest = {
    purpose: 'fault_diagnosis', subject: { type: 'instance', id: 42 },
    actor: { userId: 7, username: 'operator', roles: [], permissions: ['ai:manage', 'instance:view'], sessionVersion: 1, instanceScopes: { 42: 'read-only' }, requestId: 'test' },
    message: 'analysisId = __ANALYSIS_ID__', systemPrompt: 'test prompt', evidenceVersion: 'e1', configVersion: 'c1', authorizationVersion: 'a1',
  };
  const envelope = { schemaVersion: 1, analysisType: 'fault_diagnosis', subject: request.subject, conclusions: ['finding'], hypotheses: [], evidenceRefs: [], confidence: 0.5, recommendations: [], displayMarkdown: 'finding', provenance: { modelVersion: 'test-model', promptVersion: 'test-prompt', toolVersions: {} }, createdAt: '2026-10-03T00:00:00Z' };
  beforeAll(async () => {
    const options = { host: '127.0.0.1', port, user: 'root', password: process.env.ANALYSIS_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    admin = mysql.createPool(options); await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database }); store = new AnalysisDispatchStore(() => pool); jobs = new MysqlWorkflowStore(() => pool as any);
    await pool.query(`CREATE TABLE ai_analysis (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, analysis_type VARCHAR(32), target_type VARCHAR(32), instance_id INT, server_id INT, network_device_id INT, related_id INT, status ENUM('pending','running','completed','failed') DEFAULT 'pending', trigger_type VARCHAR(16), cache_key VARCHAR(255), session_key VARCHAR(255), result JSON, analysis_envelope JSON, envelope_backfill_status VARCHAR(32), execution_trace JSON, \`usage\` JSON, error_message TEXT, duration_ms INT, ttl_minutes INT DEFAULT 1440, cache_ttl_minutes INT, started_at DATETIME, completed_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    for (const file of ['032_workflow_outbox_jobs.sql', '109_analysis_dispatch_recovery.sql']) {
      for (const sql of splitSqlStatements(readFileSync(new URL(`../../sql/migrations/${file}`, import.meta.url), 'utf8'))) await pool.query(sql);
    }
    for (const sql of [
      'CREATE TABLE users (id INT PRIMARY KEY, username VARCHAR(64), status VARCHAR(32), session_version INT)',
      'CREATE TABLE roles (id INT PRIMARY KEY, name VARCHAR(64))',
      'CREATE TABLE permissions (id INT PRIMARY KEY, code VARCHAR(64))',
      'CREATE TABLE user_roles (user_id INT, role_id INT, grant_expiry DATETIME)',
      'CREATE TABLE role_permissions (role_id INT, permission_id INT)',
      'CREATE TABLE instance_permissions (user_id INT, instance_id INT, access_level VARCHAR(32), grant_expiry DATETIME)',
      'CREATE TABLE database_instances (id INT PRIMARY KEY)',
    ]) await pool.query(sql);
    await pool.query("INSERT INTO users VALUES (7,'operator','active',1)");
    await pool.query("INSERT INTO roles VALUES (1,'operator')");
    await pool.query("INSERT INTO permissions VALUES (1,'ai:manage'),(2,'instance:view')");
    await pool.query('INSERT INTO database_instances VALUES (42)');
  });
  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS fail_analysis_intent');
    await pool.query('DROP TRIGGER IF EXISTS delay_completion');
    for (const table of ['analysis_dispatch_keys', 'analysis_dispatch_attempts', 'analysis_dispatches', 'ai_analysis', 'outbox_events', 'workflow_jobs']) await pool.query(`DELETE FROM ${table}`);
    await pool.query('UPDATE users SET session_version = 1');
    for (const table of ['user_roles', 'role_permissions', 'instance_permissions']) await pool.query(`DELETE FROM ${table}`);
    await pool.query('INSERT INTO user_roles VALUES (7,1,NULL)');
    await pool.query('INSERT INTO role_permissions VALUES (1,1),(1,2)');
    await pool.query("INSERT INTO instance_permissions VALUES (7,42,'read-only',NULL)");
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP DATABASE ${database}`); await admin.end(); } });
  const enqueue = (options = {}) => store.enqueue({ analysisType: 'fault_diagnosis', cacheKey: 'fault:42:test:manual:user:7:session:1', triggerType: 'manual', request, ...options });
  const rows = async (sql: string) => (await pool.query<any[]>(sql))[0];
  async function claim(id: number, owner = 'a') {
    await pool.query('UPDATE workflow_jobs SET available_at = DATE_SUB(NOW(), INTERVAL 1 SECOND)');
    // The real worker acknowledges terminal/unknown intents before taking the
    // next job. Do not assume a nondeterministic tied SQL ordering selects id.
    for (let remaining = 10; remaining > 0; remaining--) {
      const job = (await jobs.claim(owner, 30))!; expect(job).not.toBeNull();
      const context = { workerId: owner, fencingToken: job.fencingToken, signal: new AbortController().signal };
      const actualId = Number((job.payload as { analysisId: number }).analysisId);
      const owned = await store.claim(actualId, job, context);
      if (actualId === id) { expect(owned).not.toBeNull(); return owned!; }
      expect(owned).toBeNull();
      expect(await jobs.complete(job.id, owner, job.fencingToken)).toBe(true);
    }
    throw new Error('EXPECTED_ANALYSIS_JOB_NOT_CLAIMED');
  }
  const expire = () => pool.query('UPDATE workflow_jobs SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND)');
  it('commits analysis, request, outbox and runnable job together; concurrent acceptance reuses it', async () => {
    const [a, b] = await Promise.all([enqueue(), enqueue()]); expect(a.analysisId).toBe(b.analysisId);
    for (const table of ['ai_analysis', 'analysis_dispatches', 'outbox_events', 'workflow_jobs']) expect(await rows(`SELECT * FROM ${table}`)).toHaveLength(1);
    expect((await rows('SELECT * FROM outbox_events'))[0].published_at).not.toBeNull();
  });
  it('rolls back analysis when durable intent fails', async () => {
    await pool.query("CREATE TRIGGER fail_analysis_intent BEFORE INSERT ON outbox_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INJECTED_INTENT_FAILURE'");
    await expect(enqueue()).rejects.toThrow('INJECTED_INTENT_FAILURE');
    expect(await rows('SELECT * FROM ai_analysis')).toHaveLength(0);
    expect(await rows('SELECT * FROM workflow_jobs')).toHaveLength(0);
  });
  it('recovers a safe unsent lease and rejects the old owner', async () => {
    const queued = await enqueue(); const old = await claim(queued.analysisId); await expire();
    const fresh = await claim(queued.analysisId, 'b'); expect(fresh.job.fencingToken).toBeGreaterThan(old.job.fencingToken);
    await expect(store.beforeSend(old)).rejects.toThrow('ANALYSIS_LEASE_LOST');
    await expect(store.completeEnvelope(old, envelope)).rejects.toThrow('ANALYSIS_LEASE_LOST');
    await store.beforeSend(fresh); await store.completeEnvelope(fresh, envelope);
    expect((await rows('SELECT * FROM ai_analysis'))[0].status).toBe('completed');
  });
  it.each(['sending', 'responded'])('%s abandoned request becomes unknown and never automatically replays', async window => {
    const queued = await enqueue(); const owned = await claim(queued.analysisId); await store.beforeSend(owned);
    if (window === 'responded') await store.responded(owned);
    await expire(); await store.recover();
    expect((await rows('SELECT * FROM ai_analysis'))[0].status).toBe('unknown');
    expect((await enqueue()).status).toBe('unknown');
    expect(await rows('SELECT * FROM ai_analysis')).toHaveLength(1);
    expect(await store.claim(queued.analysisId, { ...owned.job, fencingToken: 999 }, { ...owned.context, workerId: 'b', fencingToken: 999 })).toBeNull();
  });
  it('explicit retry keeps unknown history and fences late completion', async () => {
    const queued = await enqueue(); const old = await claim(queued.analysisId); await store.beforeSend(old); await expire(); await store.recover();
    const retry = await enqueue({ retryOf: queued.analysisId }); expect(retry.analysisId).not.toBe(queued.analysisId);
    const current = await claim(retry.analysisId, 'b'); await store.beforeSend(current); await store.completeEnvelope(current, envelope);
    await expect(store.completeEnvelope(old, envelope)).rejects.toThrow('ANALYSIS_LEASE_LOST');
    expect((await rows(`SELECT * FROM ai_analysis WHERE id = ${queued.analysisId}`))[0].status).toBe('unknown');
  });
  it.each(['evidenceVersion', 'configVersion', 'authorizationVersion'])('completed result is reused only with identical %s and freshness', async version => {
    const queued = await enqueue(); const owned = await claim(queued.analysisId); await store.beforeSend(owned); await store.completeEnvelope(owned, envelope);
    expect((await enqueue()).cached).toBe(true);
    const different = await enqueue({ request: { ...request, [version]: 'changed' } }); expect(different.analysisId).not.toBe(queued.analysisId);
  });
  it('completion survives crash before workflow acknowledgement and cannot be overwritten without identity', async () => {
    const queued = await enqueue(); const owned = await claim(queued.analysisId); await store.beforeSend(owned); await store.completeEnvelope(owned, envelope); await expire();
    expect(await store.claim(queued.analysisId, owned.job, owned.context)).toBeNull();
    expect((await rows('SELECT * FROM ai_analysis'))[0].result).toContain('finding');
  });
  it.each(['committed', 'claimed', 'before-send', 'sending', 'responded', 'before-completion', 'completed'])('recovers a real SIGKILL at %s without duplicating a possibly paid call', async window => {
    const queued = await enqueue(); let calls = 0; let stderr = ''; let reached = false;
    let kill!: () => void;
    const supplier = createServer((req, res) => {
      req.resume(); req.on('end', () => {
        calls++;
        if (window === 'sending') { reached = true; kill(); return; }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(envelope));
      });
    });
    await new Promise<void>(resolve => supplier.listen(0, '127.0.0.1', resolve));
    const address = supplier.address() as { port: number };
    const child = fork(fileURLToPath(new URL('./analysis-recovery-child.ts', import.meta.url)), [window], {
      execArgv: ['--import', 'tsx'], silent: true,
      env: { ...process.env, ANALYSIS_TEST_DATABASE: database, ANALYSIS_TEST_ID: String(queued.analysisId), ANALYSIS_TEST_SUPPLIER: `http://127.0.0.1:${address.port}` },
    });
    kill = () => { child.kill('SIGKILL'); };
    child.stderr?.on('data', data => { stderr += data; });
    child.on('message', message => { if ((message as { at?: string }).at === window) { reached = true; kill(); } });
    const timeout = setTimeout(kill, 10_000);
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
      expect(reached, stderr).toBe(true); expect(result.signal, stderr).toBe('SIGKILL');
    } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) kill(); supplier.closeAllConnections(); await new Promise<void>(resolve => supplier.close(() => resolve())); }
    await expire(); await store.recover();
    const analysis = (await rows(`SELECT * FROM ai_analysis WHERE id = ${queued.analysisId}`))[0];
    const unsafe = ['sending', 'responded', 'before-completion'].includes(window);
    if (unsafe) {
      expect(analysis.status).toBe('unknown'); expect(calls).toBe(1); expect((await enqueue()).status).toBe('unknown');
    } else if (window === 'completed') {
      expect(analysis.status).toBe('completed'); expect(calls).toBe(1); expect((await enqueue()).cached).toBe(true);
    } else {
      const fresh = await claim(queued.analysisId, 'restart'); await store.beforeSend(fresh); calls++; await store.completeEnvelope(fresh, envelope);
      expect(calls).toBe(1);
    }
    expect(await rows('SELECT * FROM ai_analysis')).toHaveLength(1);
  }, 15_000);
  it('binds actual fake-model execution, persists final usage after completion and retains the input snapshot', async () => {
    const frozen = freezeEvidence(request.subject, request.authorizationVersion, { metrics: { qps: 7 }, gaps: [] });
    const accepted = await enqueue({ request: { ...request, evidence: frozen, evidenceVersion: frozen.hash } });
    const owned = await claim(accepted.analysisId);
    const workspace = mkdtempSync(join(tmpdir(), 'max116-model-'));
    let calls = 0;
    const model: AgentProvider = {
      getDefaultModel: () => 'actual-fake-model',
      getModelCapabilities: () => ({ model: 'actual-fake-model', contextWindowTokens: 32000, preferredOutputTokens: 2048, source: 'configuration', version: 'test' }),
      chat: async (_messages, tools) => {
        expect(tools.map(t => t.name)).toEqual(['slide_complete_analysis']);
        if (calls++ === 0) return { content: null, finishReason: 'tool_calls', toolCalls: [{ id: 'completion', name: 'slide_complete_analysis', arguments: { analysisId: owned.analysisId, envelope: { ...envelope, evidenceRefs: [{ ref: '/metrics/qps', summary: 'qps 7' }], provenance: { modelVersion: 'FORGED', promptVersion: 'FORGED', toolVersions: { database: 'FORGED' } } } } }], usage: { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 4 }, shouldExecuteTools: true, hasToolCalls: true };
        const stored = (await rows(`SELECT * FROM ai_analysis WHERE id = ${owned.analysisId}`))[0];
        expect(stored.status).toBe('completed'); // Completion precedes final usage.
        return { content: 'done', finishReason: 'stop', toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 1 }, shouldExecuteTools: false, hasToolCalls: false };
      },
      chatStream: async () => { throw new Error('UNEXPECTED_STREAM'); },
    };
    setAnalysisProviderIdentity(model, { provider: 'fake-supplier', providerId: 99, routeVersion: 'actual-route-version' });
    const adapter = new DirectAdapter({ workspace, tools: new ToolRegistry(), llmProvider: model });
    try {
      const result = await adapter.invoke('w08-fake-' + owned.analysisId, owned.request.message, owned.request.systemPrompt, {
        analysisId: owned.analysisId, runtimeRunId: owned.runtimeRunId,
        beforeProviderRequest: () => store.beforeSend(owned), completeAnalysis: output => store.completeEnvelope(owned, output),
        recordAnalysisExecution: event => store.recordExecution(owned, event),
      });
      expect(result.stopReason).toBe('completed'); expect(calls).toBe(2);
      const record = (await rows(`SELECT * FROM ai_analysis WHERE id = ${owned.analysisId}`))[0];
      expect(record.analysis_envelope).toMatchObject({ verification: 'bound', evidenceSnapshot: { id: frozen.id, hash: frozen.hash }, provenance: { provider: 'fake-supplier', modelVersion: 'actual-fake-model', routeVersion: 'actual-route-version', runtimeRunId: owned.runtimeRunId, attemptNumber: owned.job.attempts, usageStatus: 'available' } });
      expect(record.analysis_envelope.provenance.promptVersion).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(record.analysis_envelope.provenance)).not.toContain('FORGED');
      expect(record.usage).toEqual({ prompt_tokens: 15, completion_tokens: 3, cached_tokens: 4 });
      expect(record.execution_trace).toMatchObject({ runtimeRunId: owned.runtimeRunId, finalized: true, requests: [{ requestNumber: 1 }, { requestNumber: 2 }] });
      const savedConclusion = record.analysis_envelope.conclusions;
      expect(await store.completeEnvelope(owned, { ...envelope, conclusions: ['overwrite'] })).toMatchObject({ success: false, error: 'ANALYSIS_ALREADY_TERMINAL' });
      await expect(store.recordExecution({ ...owned, runtimeRunId: 'other-run' }, { kind: 'finalized' })).rejects.toThrow('ANALYSIS_LEASE_LOST');
      expect((await rows(`SELECT * FROM ai_analysis WHERE id = ${owned.analysisId}`))[0].analysis_envelope.conclusions).toEqual(savedConclusion);
      const savedRequest = (await rows(`SELECT request_snapshot FROM analysis_dispatches WHERE analysis_id = ${owned.analysisId}`))[0].request_snapshot;
      expect(savedRequest.evidence.data.metrics.qps).toBe(7);
      frozen.data = { metrics: { qps: 999 } };
      expect((await rows(`SELECT request_snapshot FROM analysis_dispatches WHERE analysis_id = ${owned.analysisId}`))[0].request_snapshot.evidence.data.metrics.qps).toBe(7);
    } finally { await adapter.dispose(); rmSync(workspace, { recursive: true, force: true }); }
  });
  it('never upgrades partial supplier usage when completion precedes finalization', async () => {
    const accepted = await enqueue(); const owned = await claim(accepted.analysisId); await store.beforeSend(owned);
    const metadata = { provider: 'fake', routeVersion: 'r1', model: 'm1', promptHash: 'p1', inputHash: 'i1', toolVersions: {}, startedAt: new Date().toISOString() };
    await store.recordExecution(owned, { kind: 'request', request: { ...metadata, requestNumber: 1 } });
    await store.recordExecution(owned, { kind: 'response', requestNumber: 1, usage: null });
    await store.recordExecution(owned, { kind: 'request', request: { ...metadata, requestNumber: 2 } });
    await store.recordExecution(owned, { kind: 'response', requestNumber: 2, usage: { prompt_tokens: 7 } });
    await store.completeEnvelope(owned, envelope);
    expect((await rows('SELECT * FROM ai_analysis'))[0].analysis_envelope.provenance.usageStatus).toBe('partial');
    await store.recordExecution(owned, { kind: 'finalized' });
    expect((await rows('SELECT * FROM ai_analysis'))[0].usage).toEqual({ prompt_tokens: 7 });
  });
  it('rejects wrong type, imaginary references and foreign authorized snapshots; accepts genuine references', async () => {
    const evidence = freezeEvidence(request.subject, 'a1', { qps: 7, observations: [{ resource: request.subject, metricId: 'cpu', value: 90 }], gaps: [] });
    const accepted = await enqueue({ request: { ...request, evidence, evidenceVersion: evidence.hash } });
    const owned = await claim(accepted.analysisId); await store.beforeSend(owned);
    const otherEvidence = freezeEvidence({ type: 'instance', id: 99 }, 'other-scope', { qps: 99 });
    await enqueue({ relatedId: 99, request: { ...request, subject: { type: 'instance', id: 99 }, evidence: otherEvidence, evidenceVersion: otherEvidence.hash, authorizationVersion: 'other-scope' } });
    for (const output of [
      { ...envelope, analysisType: 'topsql_analysis' }, { ...envelope, subject: { type: 'server', id: 42 } },
      { ...envelope, evidenceRefs: [{ ref: '/imaginary', summary: 'fabricated' }] },
      { ...envelope, evidenceRefs: [{ ref: `snapshot:${otherEvidence.id}#/qps`, summary: 'foreign' }] },
      { ...envelope, evidenceRefs: [{ ref: 'observation:cpu:99', summary: 'outside scope' }] },
    ]) expect((await store.completeEnvelope(owned, output)).success).toBe(false);
    expect((await rows('SELECT * FROM ai_analysis'))[0].result).toBeNull();
    expect(await store.completeEnvelope(owned, { ...envelope, evidenceRefs: [{ ref: '/qps', summary: 'qps' }] })).toEqual({ success: true });
    expect((await rows('SELECT * FROM ai_analysis'))[0].analysis_envelope.verification).toBe('unknown'); // No actual execution telemetry, never claim verification.
  });
  it('permission revocation before recovery and before a late completion prevents execution or result writes', async () => {
    const queued = await enqueue();
    const job = (await jobs.claim('revoked', 30))!;
    const context = { workerId: 'revoked', fencingToken: job.fencingToken, signal: new AbortController().signal };
    const registry = new JobRegistry(); const send = vi.fn();
    registerAnalysisDispatchHandler(registry, { store, authorize: async () => { throw new Error('ANALYSIS_AUTHORITY_REVOKED'); }, configurationVersion: async () => 'c1', engine: async () => ({ invoke: send } as any) });
    await expect(registry.execute(job, context)).rejects.toThrow('ANALYSIS_AUTHORITY_REVOKED'); expect(send).not.toHaveBeenCalled();
    await jobs.complete(job.id, context.workerId, job.fencingToken);
    await expire();
    const replacement = await enqueue();
    expect(replacement.analysisId).not.toBe(queued.analysisId);
    const next = (await jobs.claim('current', 30))!;
    let authorized = true;
    const current = new JobRegistry();
    registerAnalysisDispatchHandler(current, { store, authorize: async () => { if (!authorized) throw new Error('ANALYSIS_AUTHORITY_REVOKED'); }, configurationVersion: async () => 'c1',
      engine: async () => ({ invoke: async (_s: string, _m: string, _p: string, options: any) => { await options.beforeProviderRequest(); authorized = false; await options.completeAnalysis(envelope); return { content: null, stopReason: 'completed' }; } } as any) });
    await expect(current.execute(next, { ...context, workerId: 'current', fencingToken: next.fencingToken })).rejects.toThrow('ANALYSIS_AUTHORITY_REVOKED');
    expect((await rows(`SELECT * FROM ai_analysis WHERE id = ${replacement.analysisId}`))[0]).toMatchObject({ status: 'unknown', result: null });
  });
  it('legacy recovery preserves status history, existing results and blocks an implicit paid retry', async () => {
    await pool.query("INSERT INTO ai_analysis (analysis_type,target_type,instance_id,trigger_type,cache_key,status,result) VALUES ('fault_diagnosis','instance',42,'manual','fault:42:old:manual:user:7:session:1','running','\"legacy result\"')");
    await store.recoverLegacy(); const legacy = (await rows('SELECT * FROM ai_analysis'))[0];
    expect(legacy).toMatchObject({ status: 'unknown', legacy_status: 'running', recovery_reason: 'LEGACY_RESULT_PRESENT', result: 'legacy result' });
    expect((await enqueue()).status).toBe('unknown'); expect(await rows('SELECT * FROM workflow_jobs')).toHaveLength(0);
    const retry = await enqueue({ retryOf: legacy.id }); expect(retry.analysisId).not.toBe(legacy.id);
  });
  it('full migration ledger bootstraps and reruns with the analysis dispatch schema', async () => {
    const schema = `${database}_bootstrap`;
    await admin.query(`CREATE DATABASE ${schema}`);
    const fresh = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: process.env.ANALYSIS_TEST_MYSQL_PASSWORD ?? '', database: schema });
    try {
      const runner = new MigrationRunner(fresh as any);
      await runner.run(); await runner.run();
      await new AnalysisDispatchStore(() => fresh).assertSchema();
      expect((await runner.inspect()).find(row => row.migration_id === '109_analysis_dispatch_recovery.sql')?.status).toBe('completed');
    } finally { await fresh.end(); await admin.query(`DROP DATABASE ${schema}`); }
  }, 30_000);
  it('legacy TopSQL keys cannot bypass unknown admission and explicit automatic retry creates a linked manual request', async () => {
    await pool.query("INSERT INTO ai_analysis (analysis_type,target_type,instance_id,related_id,trigger_type,cache_key,status) VALUES ('topsql_analysis','instance',42,99,'manual','old-sql-hash:42','running')");
    await store.recoverLegacy();
    const legacy = (await rows('SELECT * FROM ai_analysis'))[0];
    const options = { analysisType: 'topsql_analysis', cacheKey: 'topsql:new-hash:42', relatedId: 99, request: { ...request, purpose: 'topsql_analysis' } };
    expect((await enqueue(options)).status).toBe('unknown');
    expect(await rows('SELECT * FROM workflow_jobs')).toHaveLength(0);
    expect((await enqueue({ ...options, retryOf: legacy.id })).analysisId).not.toBe(legacy.id);
    await pool.query("UPDATE workflow_jobs SET state = 'completed'");
    const automatic = await enqueue({ triggerType: 'auto', request: { ...request, actor: undefined } });
    const owned = await claim(automatic.analysisId); await store.beforeSend(owned); await store.fail(owned, 'ANALYSIS_PROVIDER_RESULT_UNKNOWN');
    const manual = await enqueue({ retryOf: automatic.analysisId });
    expect(manual.analysisId).not.toBe(automatic.analysisId);
    expect((await rows(`SELECT retry_of FROM analysis_dispatches WHERE analysis_id = ${manual.analysisId}`))[0].retry_of).toBe(automatic.analysisId);
  });
  it('explicit retry cannot adopt another actor manual unknown or another subject', async () => {
    const queued = await enqueue(); const owned = await claim(queued.analysisId);
    await store.beforeSend(owned); await store.fail(owned, 'ANALYSIS_PROVIDER_RESULT_UNKNOWN');
    await expect(enqueue({ retryOf: queued.analysisId, request: { ...request, actor: { ...request.actor!, userId: 8 } } })).rejects.toThrow('ANALYSIS_RETRY_SUPERSEDED');
    await expect(enqueue({ retryOf: queued.analysisId, request: { ...request, subject: { type: 'instance', id: 43 } } })).rejects.toThrow('ANALYSIS_RETRY_SUPERSEDED');
    expect(await rows('SELECT * FROM ai_analysis')).toHaveLength(1);
  });
  it('ordinary completion/failure/status writers cannot bypass durable execution identity', async () => {
    const queued = await enqueue(); const owned = await claim(queued.analysisId); await store.beforeSend(owned);
    const spy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    try {
      expect((await aiAnalysisDatabaseService.completeAnalysisEnvelope(queued.analysisId, envelope)).success).toBe(false);
      expect((await aiAnalysisDatabaseService.completeAnalysis(queued.analysisId, { result: 'unbound' })).success).toBe(false);
      expect((await aiAnalysisDatabaseService.failAnalysis(queued.analysisId, 'unbound')).success).toBe(false);
      expect((await aiAnalysisDatabaseService.updateStatus(queued.analysisId, 'failed')).success).toBe(false);
    } finally { spy.mockRestore(); }
    expect((await rows('SELECT * FROM ai_analysis'))[0]).toMatchObject({ status: 'running', result: null });
  });
  it('lease expiry during completion rolls back both the result and the request terminal state', async () => {
    const queued = await enqueue(); const owned = await claim(queued.analysisId); await store.beforeSend(owned);
    await pool.query('UPDATE workflow_jobs SET lease_expires_at = DATE_ADD(NOW(), INTERVAL 1 SECOND)');
    await pool.query("CREATE TRIGGER delay_completion BEFORE UPDATE ON ai_analysis FOR EACH ROW BEGIN IF NEW.status = 'completed' THEN DO SLEEP(2); END IF; END");
    await expect(store.completeEnvelope(owned, envelope)).rejects.toThrow('ANALYSIS_LEASE_LOST');
    expect((await rows('SELECT * FROM ai_analysis'))[0]).toMatchObject({ status: 'running', result: null });
    expect((await rows('SELECT * FROM analysis_dispatches'))[0].request_state).toBe('sending');
  });
  it('dry-run inventory separates provable unsent work, existing result and uncertainty without mutation', async () => {
    await enqueue();
    await pool.query("INSERT INTO ai_analysis (analysis_type,target_type,instance_id,status,result) VALUES ('fault_diagnosis','instance',42,'running','\"legacy\"'), ('fault_diagnosis','instance',42,'pending',NULL)");
    const before = await rows('SELECT * FROM ai_analysis');
    const inventory = await analysisRecoveryInventory(pool);
    expect(inventory.map(row => row.resolution)).toEqual(['provably_unsent_durable_intent', 'existing_result_preserved', 'unknown_requires_explicit_retry']);
    expect(await rows('SELECT * FROM ai_analysis')).toEqual(before);
  });
  it.each(['session', 'permission', 'resource-scope'])('live %s revocation in MySQL prevents recovery from sending', async kind => {
    const spy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    try {
      const actor = await actorContextService.loadActiveActor(7, 1);
      await enqueue({ request: { ...request, actor, authorizationVersion: analysisAuthorizationVersion(actor) } });
      const job = (await jobs.claim('live-revocation', 30))!;
      if (kind === 'session') await pool.query('UPDATE users SET session_version = 2 WHERE id = 7');
      if (kind === 'permission') await pool.query('DELETE FROM role_permissions WHERE permission_id = 1');
      if (kind === 'resource-scope') await pool.query('DELETE FROM instance_permissions WHERE user_id = 7');
      const send = vi.fn(); const registry = new JobRegistry();
      registerAnalysisDispatchHandler(registry, { store, authorize: authorizeAnalysisRequest, configurationVersion: async () => 'c1', engine: async () => ({ invoke: send } as any) });
      await expect(registry.execute(job, { workerId: 'live-revocation', fencingToken: job.fencingToken, signal: new AbortController().signal })).rejects.toThrow('ANALYSIS_AUTHORITY_REVOKED');
      expect(send).not.toHaveBeenCalled(); expect((await rows('SELECT * FROM analysis_dispatches'))[0].request_state).toBe('failed');
    } finally { spy.mockRestore(); }
  });
  it('a pre-send engine error returned as a result safely retries instead of acknowledging away the intent', async () => {
    const queued = await enqueue(); let attempts = 0; let paid = 0;
    const registry = new JobRegistry();
    registerAnalysisDispatchHandler(registry, { store, authorize: async () => {}, configurationVersion: async () => 'c1', engine: async () => ({ invoke: async (_s: string, _m: string, _p: string, options: any) => {
      if (++attempts === 1) return { content: null, stopReason: 'error', error: 'local preflight unavailable' };
      await options.beforeProviderRequest(); paid++; await options.completeAnalysis(envelope); return { content: null, stopReason: 'completed' };
    } } as any) });
    const worker = new WorkerRuntime(jobs, 'retry-test');
    try {
      expect(await worker.runOnce((job, context) => registry.execute(job, context))).toBe('retry');
      expect((await rows('SELECT * FROM analysis_dispatches'))[0].request_state).toBe('unsent');
      await pool.query('UPDATE workflow_jobs SET available_at = DATE_SUB(NOW(), INTERVAL 1 SECOND)');
      expect(await worker.runOnce((job, context) => registry.execute(job, context))).toBe('completed');
      expect(paid).toBe(1); expect((await rows(`SELECT * FROM ai_analysis WHERE id = ${queued.analysisId}`))[0].status).toBe('completed');
    } finally { await worker.shutdown(); }
  });
  it('active cache requires a live matching lease, while an expired unsent intent returns pending and can recover', async () => {
    const queued = await enqueue(); await claim(queued.analysisId);
    const spy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    try {
      const lookup = { instanceId: 42, triggerType: 'manual' as const, userId: 7, sessionVersion: 1 };
      expect((await aiAnalysisDatabaseService.findActiveFaultDiagnosis(lookup))?.id).toBe(queued.analysisId);
      await expire(); expect(await aiAnalysisDatabaseService.findActiveFaultDiagnosis(lookup)).toBeNull();
      const reused = await enqueue(); expect(reused).toMatchObject({ analysisId: queued.analysisId, status: 'pending', cached: false });
      const fresh = await claim(queued.analysisId, 'fresh'); await store.beforeSend(fresh); await store.completeEnvelope(fresh, envelope);
    } finally { spy.mockRestore(); }
  });
  it('dispatch disable preserves a queryable pending job, and re-enable resumes the same ID', async () => {
    const queued = await enqueue(); vi.stubEnv('ANALYSIS_DISPATCH_ENABLED', 'false');
    try { expect(await jobs.claim('disabled', 30)).toBeNull(); expect((await rows('SELECT * FROM ai_analysis'))[0]).toMatchObject({ id: queued.analysisId, status: 'pending' }); }
    finally { vi.unstubAllEnvs(); }
    expect((await jobs.claim('enabled', 30))?.payload.analysisId).toBe(queued.analysisId);
  });
  it('does not attach and replay a pre-existing legacy analysis without proof of sending status', async () => {
    await expect(enqueue({ existingAnalysisId: 999 })).rejects.toThrow('ANALYSIS_LEGACY_BINDING_REQUIRES_CONFIRMATION');
    expect(await rows('SELECT * FROM workflow_jobs')).toHaveLength(0);
  });
});
