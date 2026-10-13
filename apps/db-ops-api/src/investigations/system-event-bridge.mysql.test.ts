import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../migrations/runner.js';
import { ActorContextService, signAccessToken, type ActorContext } from '../auth/actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { InvestigationAuthorization, provisionInvestigationServiceIdentity } from './authorization.js';
import { MysqlInvestigationBudgetLedger, type BudgetPolicy } from './budget-ledger.js';
import { MysqlOperationalEventIngest } from './event-ingest.js';
import { MysqlSystemEventBridge, SYSTEM_EVENT_JOB, type SystemFailure } from './system-event-bridge.js';
import { createSystemTools } from './system-tools.js';
import { SystemFailurePublisher, installSystemFailurePublisher } from '../platform/system-failure-publisher.js';
import { installPlatformObservation } from '../platform/platform-observation-service.js';
import { StructuredLogEvidenceAdapter } from '../platform/structured-log-evidence-adapter.js';
import type { TriggerBinding } from './trigger-policy.js';
import { SourceSnapshotService } from '../platform/source-snapshot-service.js';
import { SourceManagementService } from '../platform/source-management-service.js';
import { createSystemComposition } from './system-composition.js';
import { registerSystemEventRoutes, SystemEventReader } from './system-event-routes.js';
import { InvestigationExecutor } from './executor.js';
import { MysqlWorkflowStore } from '../workflows/worker-runtime.js';
import { ToolRegistry, type LLMProvider } from '@slide/agent-core';

// Always a run-owned mysql:8.4, formal migrations, TCP HTTP/JWT and independent
// process recovery. No skip, external Provider request or production DB access.
describe('T09 System durable facts, real MySQL/JWT/HTTP', () => {
  const database = `t09_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const secret = randomUUID();
  let container: string; let port: number; let admin: Pool; let pool: Pool;
  let contexts: ActorContextService; let authorization: InvestigationAuthorization;
  let actor: ActorContext; let serviceId: number; let roleId: number;
  let ledger: MysqlInvestigationBudgetLedger; let bridge: MysqlSystemEventBridge;
  let app: FastifyInstance; let address: string; let publisher: SystemFailurePublisher; let uninstall: () => void;
  let target: string;
  const from = new Date(Date.now() - 60_000).toISOString(), to = new Date(Date.now() + 60_000).toISOString();
  const quota: BudgetPolicy = { currency: 'USD', maxConcurrent: 20, manualReserved: 1, maxPerResourceConcurrent: 20,
    maxAutomaticRequestsPerHour: 20, maxAutomaticTokensPerDay: 100_000, maxTotalTokensPerDay: 200_000, maxCostMicrosPerDay: 100_000 };
  const binding = (component = 'api'): TriggerBinding => ({ source: `slide.system.${component}`, verified: true,
    allowedOrigins: ['user_operation', 'collector', 'workflow', 'investigation_engine'],
    policy: { id: `system-${component}`, version: 1, domain: 'system-test', actor, profileId: 'system', profileVersion: 1,
      resources: [], component, kinds: ['system.failure'], threshold: 1, windowMs: 300_000, cooldownMs: 600_000,
      criticalSingle: true, reserveTokens: 100, reserveCostMicros: 100,
      prices: { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 } } });
  const build = () => new MysqlSystemEventBridge(() => pool, ['api', 'collector', 'queue', 'agent'].map(binding),
    b => new MysqlOperationalEventIngest(() => pool, b, ledger, authorization), authorization);
  const failure = (extra: Partial<SystemFailure> = {}): SystemFailure => ({ component: 'api', sourceEventId: randomUUID(),
    correlationId: randomUUID(), occurredAt: new Date().toISOString(), stableErrorCode: 'HTTP_500', callsite: 'api:GET:/failure',
    origin: 'user_operation', httpStatus: 500, releaseId: 'fixture-release', commitSha: 'a'.repeat(40), ...extra });
  const count = async (table: string) => Number((await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n);
  const facts = () => bridge.readFacts(actor, target, { from, to, component: 'api' });

  beforeAll(async () => {
    container = `slide-t09-${process.pid}-${randomUUID()}`;
    execFileSync('docker', ['run', '--detach', '--rm', '--name', container, '--env', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes',
      '--publish', '127.0.0.1::3306', 'mysql:8.4'], { stdio: 'pipe' });
    port = Number(execFileSync('docker', ['port', container, '3306/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1));
    const options = { host: '127.0.0.1', port, user: 'root', password: '', timezone: 'Z' };
    admin = mysql.createPool(options);
    const deadline = Date.now() + 45_000;
    for (;;) { try { await admin.query('SELECT 1'); break; } catch (error) {
      if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 500));
    } }
    await admin.query(`CREATE DATABASE ${database}`); pool = mysql.createPool({ ...options, database, connectionLimit: 12 });
    await new MigrationRunner(pool).run(); await new MigrationRunner(pool).run();
    contexts = new ActorContextService(() => pool as never); authorization = new InvestigationAuthorization(contexts);
    serviceId = await provisionInvestigationServiceIdentity(pool as never, 't09');
    const [role] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO roles (name) VALUES ('system-reader')"); roleId = Number(role.insertId);
    await pool.execute(`INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions
      WHERE code IN ('chat:view', 'config:view')`, [roleId]);
    await pool.execute('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [serviceId, roleId]);
    await pool.execute("INSERT INTO users (id, username, password_hash) VALUES (9901, 'system-reviewer', 'disabled-fixture')");
    await pool.execute('INSERT INTO user_roles (user_id, role_id) VALUES (9901, ?)', [roleId]);
    ledger = new MysqlInvestigationBudgetLedger(() => pool, quota);
    app = Fastify();
    await installPlatformObservation(app, createVerifyToken(secret, contexts), new StructuredLogEvidenceAdapter());
    await registerSystemEventRoutes(app, createVerifyToken(secret, contexts), new SystemEventReader(() => pool, authorization));
    app.get('/fixture/failure', async (_r, reply) => reply.code(500).send({ error: 'fixture' }));
    app.get('/fixture/400', async (_r, reply) => reply.code(400).send({}));
    app.get('/fixture/403', async (_r, reply) => reply.code(403).send({}));
    app.get('/fixture/facts', { preHandler: createVerifyToken(secret, contexts) }, async (request: any, reply) => {
      try { return await bridge.readFacts(request.user, target, { from, to, component: 'api' }); }
      catch (error) { return reply.code((error as any).statusCode ?? 503).send({ error: (error as any).code ?? 'UNAVAILABLE' }); }
    });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  }, 120_000);
  beforeEach(async () => {
    if (publisher) { await publisher.drain(); uninstall(); }
    await pool.execute("UPDATE users SET status = 'active', session_version = 1 WHERE id IN (?, 9901)", [serviceId]);
    await pool.execute(`INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions
      WHERE code IN ('chat:view', 'config:view')`, [roleId]);
    for (const table of ['investigation_results', 'investigation_evidence', 'investigation_stream_events', 'investigation_stream_heads',
      'investigation_observed_sources', 'agent_canonical_facts', 'investigation_event_links', 'operational_events', 'investigation_trigger_keys', 'investigation_trigger_cooldowns',
      'investigation_budget_resources', 'investigation_budget_ledger', 'investigation_budget_domains', 'investigation_create_keys',
      'investigation_admission_keys', 'investigation_requests', 'investigation_members', 'investigation_resources', 'investigations',
      'chat_messages', 'agent_runs', 'chat_sessions', 'workflow_jobs', 'outbox_events']) await pool.execute(`DELETE FROM ${table}`);
    actor = { ...await contexts.loadInvestigationActorFrom(pool as never, serviceId, 'service', 1),
      resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } };
    bridge = build(); publisher = new SystemFailurePublisher(f => bridge.record(f)); uninstall = installSystemFailurePublisher(publisher);
  });
  afterAll(async () => {
    try { if (publisher) { await publisher.drain(); uninstall(); } await app?.close(); await pool?.end();
      if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
    } finally { if (container) execFileSync('docker', ['stop', '--time', '10', container], { stdio: 'pipe' }); }
  }, 30_000);

  it.each([
    { age: 2 * 3_600_000, gap: 'SYSTEM_EVENT_WINDOW_TRUNCATED' },
    { age: 7 * 24 * 3_600_000, gap: 'SYSTEM_EVENT_WINDOW_TRUNCATED' },
    { age: -2 * 3_600_000, gap: 'SYSTEM_EVENT_CLOCK_AHEAD' },
  ])('event age $age keeps original evidence after restart with a bounded query and explicit $gap', async ({ age, gap }) => {
    const input = failure({ occurredAt: new Date(Date.now() - age).toISOString() });
    const saved = await bridge.record(input);
    // New bridge instance consumes the persistent backlog, not process memory.
    const accepted = await build().deliver(saved.jobId); target = accepted.investigationId!;
    expect(accepted.disposition).toBe('accepted');
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT request_snapshot FROM investigation_requests WHERE id = ?', [accepted.requestId]);
    const snapshot = typeof rows[0].request_snapshot === 'string' ? JSON.parse(rows[0].request_snapshot) : rows[0].request_snapshot;
    const originalContext = JSON.stringify(snapshot.context);
    expect(snapshot.context.from).toBe(input.occurredAt);
    const composition = await createSystemComposition(() => pool, { configuration: { enabled: false, automatic: false, serviceUserId: 0 }, contexts });
    try {
      const registry = composition.toolsForInvestigation(actor, snapshot);
      expect(registry.getDefinitions()).toHaveLength(5);
      const result = await registry.get('get_platform_observations')!.execute({}) as any;
      expect(result.data).toMatchObject({ eventOccurredAt: input.occurredAt, receivedAt: snapshot.context.to,
        observedFrom: input.occurredAt, gaps: expect.arrayContaining([gap]), quality: 'degraded' });
      expect(Date.parse(result.data.observedTo) - Date.parse(result.data.observedFrom)).toBe(age > 0 ? 3_600_000 : 0);
      expect(result.data.facts).toHaveLength(1);
      expect(result.data.facts[0].event).toMatchObject({ sourceEventId: input.sourceEventId, occurredAt: input.occurredAt,
        correlationId: input.correlationId, commitSha: input.commitSha });
      expect(JSON.stringify(snapshot.context)).toBe(originalContext);
      const child = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'src/investigations/system-event-recovery-child.ts'], {
        cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SYSTEM_RECOVERY_FIXTURE: JSON.stringify({ port, database, serviceId,
          investigationId: target, composed: true }) },
      }));
      expect(child).toMatchObject({ count: 1, sourceEventId: input.sourceEventId, contentHash: result.data.facts[0].contentHash,
        observedFrom: input.occurredAt, observedTo: result.data.observedTo, receivedAt: snapshot.context.to, gaps: expect.arrayContaining([gap]) });
      // Live revocation still erases evidence from the already built registry.
      await pool.execute("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=? AND p.code='config:view'", [roleId]);
      await expect(registry.get('get_platform_observations')!.execute({})).rejects.toMatchObject({ code: 'INVESTIGATION_NOT_FOUND' });
    } finally { await composition.close(); }
  }, 60_000);
  it('seven-day backlog executes real System tools and repairs canonical completion in a new process without another Provider call', async () => {
    const composition = await createSystemComposition(() => pool, { contexts,
      configuration: { enabled: true, automatic: true, serviceUserId: serviceId },
      budget: { domain: 'system-test', policy: quota, reserveCostMicros: 100,
        prices: { input: 100, cachedInput: 50, output: 200 } } });
    let calls = 0;
    const input = failure({ occurredAt: new Date(Date.now() - 7 * 24 * 3_600_000).toISOString() });
    const final = { content: '持久原始事实已读取；日志窗口有缺口，根因待验证。', finishReason: 'stop', toolCalls: [],
      hasToolCalls: false, shouldExecuteTools: false, usage: { prompt_tokens: 20, completion_tokens: 10, cached_tokens: 0 } };
    const provider: LLMProvider = {
      getDefaultModel: () => 'controlled-system-backlog',
      getModelCapabilities: () => ({ model: 'controlled-system-backlog', contextWindowTokens: 32768,
        preferredOutputTokens: 2048, source: 'configuration', version: 'fixture/v1' }),
      chat: async messages => {
        calls++;
        if (calls === 1) return { ...final, content: null, finishReason: 'tool_calls',
          toolCalls: [{ id: 'backlog-facts', name: 'get_platform_observations', arguments: {} }], hasToolCalls: true, shouldExecuteTools: true };
        const evidence = messages.filter(m => m.role === 'tool').map(m => JSON.parse(String(m.content)));
        expect(evidence).toHaveLength(1);
        expect(evidence[0].data.facts[0].event.sourceEventId).toBe(input.sourceEventId);
        expect(evidence[0].data.gaps).toContain('SYSTEM_EVENT_WINDOW_TRUNCATED');
        return final;
      },
      chatStream: async () => { throw new Error('STREAM_NOT_EXPECTED'); },
    };
    try {
      const saved = await composition.bridge.record(input), accepted = await composition.bridge.deliver(saved.jobId);
      const workerId = 't09-backlog-worker';
      const job = await new MysqlWorkflowStore(() => pool as never).claim(workerId, 120, { types: ['investigation.execute'], exclude: false });
      expect(job).not.toBeNull();
      const command = { investigationId: accepted.investigationId!, requestId: accepted.requestId!, job: job!,
        context: { workerId, fencingToken: job!.fencingToken, signal: new AbortController().signal } };
      const executor = new InvestigationExecutor({ pool: () => pool, authorization,
        systemToolsForInvestigation: composition.toolsForInvestigation,
        toolsForActor: () => new ToolRegistry(), providerForPurpose: async () => provider,
        budget: { domain: 'system-test', policy: quota, reserveCostMicros: 100 } });
      await pool.query(`CREATE TRIGGER t09_completion_failure BEFORE UPDATE ON agent_runs FOR EACH ROW
        BEGIN IF NEW.state = 'completed' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'T09_COMPLETION_STORAGE_FAILURE'; END IF; END`);
      try { await expect(executor.execute(command)).rejects.toThrow('T09_COMPLETION_STORAGE_FAILURE'); }
      finally { await pool.query('DROP TRIGGER t09_completion_failure'); }
      expect(calls).toBe(2);
      const [pending] = await pool.query<RowDataPacket[]>('SELECT id, state, result_json FROM agent_runs');
      expect(pending).toHaveLength(1); expect(pending[0].state).toBe('running');
      expect(pending[0].result_json.completionPending).toBe(true);
      // A new process must obtain a new real Workflow fence; the old lease
      // remains protected against duplicate simultaneous execution.
      await pool.query('UPDATE workflow_jobs SET lease_expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE id=?', [job!.id]);
      const next = await new MysqlWorkflowStore(() => pool as never).claim('t09-recovery-worker', 120,
        { types: ['investigation.execute'], exclude: false });
      expect(next!.id).toBe(job!.id); expect(next!.fencingToken).toBeGreaterThan(job!.fencingToken);
      const recoveredCommand = { ...command, job: next!,
        context: { workerId: 't09-recovery-worker', fencingToken: next!.fencingToken } };
      const recover = () => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'src/investigations/system-event-recovery-child.ts'], {
        cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SYSTEM_RECOVERY_FIXTURE: JSON.stringify({ port, database, serviceId,
          investigationId: accepted.investigationId, composed: true, quota, execute: recoveredCommand }) },
      }));
      const first = recover();
      expect(first).toMatchObject({ runId: pending[0].id, state: 'completed', results: 1, evidence: 1, toolMessages: 1,
        count: 1, sourceEventId: input.sourceEventId });
      expect(recover()).toEqual(first); // terminal replay does not duplicate canonical/result/evidence.
      expect(calls).toBe(2);
      expect(await count('agent_runs')).toBe(1);
      const [evidence] = await pool.query<RowDataPacket[]>('SELECT raw_json FROM investigation_evidence');
      expect(JSON.stringify(evidence)).toContain(input.sourceEventId);
      expect(JSON.stringify(evidence)).toContain('SYSTEM_EVENT_WINDOW_TRUNCATED');
    } finally { await composition.close(); }
  }, 60_000);

  it('configured output cap admits real System facts and governs provider dispatch within the unchanged context ceiling', async () => {
    const composition = await createSystemComposition(() => pool, { contexts,
      configuration: { enabled: true, automatic: true, serviceUserId: serviceId },
      budget: { domain: 'system-test', policy: quota, reserveCostMicros: 100,
        prices: { input: 100, cachedInput: 50, output: 200 } } });
    let calls = 0;
    const provider: LLMProvider = {
      getDefaultModel: () => 'controlled-small-output',
      getModelCapabilities: () => ({ model: 'controlled-small-output', contextWindowTokens: 8192,
        maxOutputTokens: 1024, preferredOutputTokens: 512, source: 'configuration', version: 'fixture/v1' }),
      chat: async (messages, _tools, options) => {
        calls++;
        expect(options?.maxTokens).toBe(512);
        const final = { content: '原始持久错误已读取；根因待验证。', finishReason: 'stop', toolCalls: [],
          hasToolCalls: false, shouldExecuteTools: false, usage: { prompt_tokens: 20, completion_tokens: 10 } };
        if (calls === 1) return { ...final, content: null, finishReason: 'tool_calls',
          toolCalls: [{ id: 'configured-output-facts', name: 'get_platform_observations', arguments: {} }],
          hasToolCalls: true, shouldExecuteTools: true };
        expect(JSON.stringify(messages.filter(m => m.role === 'tool'))).toContain('HTTP_500');
        return final;
      },
      chatStream: async () => { throw new Error('STREAM_NOT_EXPECTED'); },
    };
    try {
      const saved = await composition.bridge.record(failure()), accepted = await composition.bridge.deliver(saved.jobId);
      const workerId = 'configured-output-worker';
      const job = await new MysqlWorkflowStore(() => pool as never).claim(workerId, 120, { types: ['investigation.execute'], exclude: false });
      const executor = new InvestigationExecutor({ pool: () => pool, authorization,
        systemToolsForInvestigation: composition.toolsForInvestigation, toolsForActor: () => new ToolRegistry(),
        providerForPurpose: async () => provider, budget: { domain: 'system-test', policy: quota, reserveCostMicros: 100 } });
      const run = await executor.execute({ investigationId: accepted.investigationId!, requestId: accepted.requestId!, job: job!,
        context: { workerId, fencingToken: job!.fencingToken, signal: new AbortController().signal } });
      expect(run.state).toBe('completed'); expect(calls).toBe(2);
      expect(await count('agent_runs')).toBe(1); expect(await count('investigation_results')).toBe(1);
      expect(await count('investigation_evidence')).toBe(1);
    } finally { await composition.close(); }
  }, 60_000);
  it('five live System tools preserve complete JSON evidence within 16k, including provider reasoning and fenced completion recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 't09-context-source-'));
    let composition: Awaited<ReturnType<typeof createSystemComposition>> | undefined;
    try {
      const commitSha = 'a'.repeat(40), signingKey = randomUUID().repeat(2);
      const repository = { origin: 'https://github.com', provider: 'github' as const, ref: commitSha, allowedPaths: ['src/'] };
      const source = 'export function qualifyFailure() {\n  // Synthetic intent only: a slow fixture operation maps to HTTP 500.\n  return { status: 500, code: "SYNTHETIC_TIMEOUT", timeoutMs: 1000 };\n}\n';
      const manifest = await new SourceSnapshotService(root, signingKey).publish({ releaseId: 'signed-fixture', commitSha,
        projectId: 'fixture/repo', repository }, [{ path: 'src/system-fixture.ts', content: source }]);
      const key = 'source.snapshot.' + createHash('sha256').update(JSON.stringify({ ...repository, projectId: 'fixture/repo' })).digest('hex');
      await pool.execute('REPLACE INTO system_config(config_key,config_value) VALUES (?,?),(?,?)', ['source.gitlab',
        JSON.stringify({ baseUrl: repository.origin, provider: repository.provider, ref: commitSha, allowedPaths: ['src/'],
          repositoryPath: 'fixture/repo', allowModelContent: true }), key,
        JSON.stringify({ releaseId: manifest.releaseId, commitSha, treeDigest: manifest.treeDigest })]);
      vi.stubEnv('SLIDE_SOURCE_ROOT', root); vi.stubEnv('SLIDE_SOURCE_SIGNING_KEY', signingKey);
      vi.stubEnv('SLIDE_RELEASE_MANIFEST', ''); vi.stubEnv('SLIDE_RELEASE_ID', 'fixture-release');
      vi.stubEnv('SLIDE_COMMIT_SHA', commitSha); vi.stubEnv('SLIDE_SOURCE_DIGEST', manifest.treeDigest);
      composition = await createSystemComposition(() => pool, { contexts, source: new SourceManagementService(() => pool as never),
        configuration: { enabled: true, automatic: true, serviceUserId: serviceId },
        budget: { domain: 'system-test', policy: quota, reserveCostMicros: 100 } });
      const input = failure({ occurredAt: new Date(Date.now() - 2 * 3600000).toISOString(),
        stableErrorCode: 'SYNTHETIC_TIMEOUT', callsite: 'src/system-fixture.ts:qualifyFailure' });
      const saved = await composition.bridge.record(input), accepted = await composition.bridge.deliver(saved.jobId);
      let calls = 0;
      const provider: LLMProvider = { getDefaultModel: () => 'controlled-five-tool-context',
        getModelCapabilities: () => ({ model: 'controlled-five-tool-context', contextWindowTokens: 16000,
          maxOutputTokens: 2048, preferredOutputTokens: 2048, source: 'configuration', version: 'fixture/v1' }),
        chat: async (messages, _tools, options) => {
          calls++; expect(options?.maxTokens).toBe(2048);
          const toolCalls = calls === 1 ? ['get_platform_observations', 'get_deployment_manifest'].map(name => ({ id: name, name, arguments: {} }))
            : calls === 2 ? [{ id: 'symbol', name: 'get_symbol_definition', arguments: { name: 'qualifyFailure' } },
              { id: 'search', name: 'search_source', arguments: { query: 'SYNTHETIC_TIMEOUT' } },
              { id: 'source', name: 'read_source_region', arguments: { path: 'src/system-fixture.ts', startLine: 1, endLine: 200 } }] : [];
          if (calls === 3) {
            const received = messages.filter(m => m.role === 'tool').map(m => JSON.parse(String(m.content)));
            expect(received).toHaveLength(5); expect(received.every(r => r.success)).toBe(true);
            expect(JSON.stringify(received)).toContain(input.sourceEventId);
            expect(received.find(r => r.data.content)?.data.content).toBe(source);
            expect(JSON.stringify(received)).toContain('SYSTEM_EVENT_WINDOW_TRUNCATED');
          }
          return { content: calls === 3 ? 'SYNTHETIC_TIMEOUT：源码已读取，根因未验证。' : null,
            finishReason: calls < 3 ? 'tool_calls' : 'stop', toolCalls, hasToolCalls: calls < 3, shouldExecuteTools: calls < 3,
            _extra: { reasoning_content: 'diagnostic reasoning '.repeat(33) }, usage: { prompt_tokens: 20, completion_tokens: 10 } };
        }, chatStream: async () => { throw Error('STREAM_NOT_EXPECTED'); } };
      const workerId = 'five-tool-context', store = new MysqlWorkflowStore(() => pool as never);
      const job = await store.claim(workerId, 120, { types: ['investigation.execute'], exclude: false }); expect(job).toBeTruthy();
      const executor = new InvestigationExecutor({ pool: () => pool, authorization,
        systemToolsForInvestigation: composition.toolsForInvestigation, toolsForActor: () => new ToolRegistry(),
        providerForPurpose: async () => provider, budget: { domain: 'system-test', policy: quota, reserveCostMicros: 100 } });
      const command = { investigationId: accepted.investigationId!, requestId: accepted.requestId!, job: job!,
        context: { workerId, fencingToken: job!.fencingToken, signal: new AbortController().signal } };
      await pool.query(`CREATE TRIGGER t09_context_completion_failure BEFORE UPDATE ON agent_runs FOR EACH ROW
        BEGIN IF NEW.state='completed' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='T09_CONTEXT_COMPLETION_FAILURE'; END IF; END`);
      try { await expect(executor.execute(command)).rejects.toThrow('T09_CONTEXT_COMPLETION_FAILURE'); }
      finally { await pool.query('DROP TRIGGER t09_context_completion_failure'); }
      expect(calls).toBe(3);
      const [pending] = await pool.query<RowDataPacket[]>('SELECT id,state,result_json FROM agent_runs');
      expect(pending).toHaveLength(1); expect(pending[0].state).toBe('running');
      expect(pending[0].result_json.completionPending).toBe(true);
      await pool.execute('UPDATE workflow_jobs SET lease_expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE id=?', [job!.id]);
      const next = await store.claim('five-tool-recovery', 120, { types: ['investigation.execute'], exclude: false });
      expect(next!.fencingToken).toBeGreaterThan(job!.fencingToken);
      const recoveredCommand = { investigationId: accepted.investigationId, requestId: accepted.requestId, job: next,
        context: { workerId: 'five-tool-recovery', fencingToken: next!.fencingToken } };
      const recover = () => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'src/investigations/system-event-recovery-child.ts'], {
        cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SYSTEM_RECOVERY_FIXTURE: JSON.stringify({ port, database, serviceId,
          investigationId: accepted.investigationId, composed: true, quota, execute: recoveredCommand }) },
      }));
      const first = recover(); expect(first).toMatchObject({ runId: pending[0].id, state: 'completed', results: 1, evidence: 5, toolMessages: 5 });
      expect(recover()).toEqual(first); expect(calls).toBe(3);
      expect(await count('investigation_results')).toBe(1); expect(await count('agent_runs')).toBe(1);
    } finally { await composition?.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  }, 60000);
  it('durable original precedes admission; 100 retries and immutable conflicts survive recreation', async () => {
    const input = failure();
    const writes = await Promise.all(Array.from({ length: 100 }, () => bridge.record(input)));
    expect(new Set(writes.map(w => w.jobId)).size).toBe(1); expect(writes.filter(w => !w.duplicate)).toHaveLength(1);
    expect(await count('operational_events')).toBe(0); expect(await count('investigations')).toBe(0); expect(await count('agent_runs')).toBe(0);
    await expect(bridge.record({ ...input, stableErrorCode: 'DIFFERENT' })).rejects.toMatchObject({ code: 'EVENT_DELIVERY_CONFLICT' });
    const originalId = writes[0].jobId;
    const accepted = await build().deliver(originalId); target = accepted.investigationId!;
    expect(accepted.disposition).toBe('accepted');
    expect((await build().deliver(originalId)).duplicate).toBe(true);
    expect(await count('investigations')).toBe(1); expect(await count('agent_runs')).toBe(0);
    const original = await facts(); expect(original).toHaveLength(1); expect(original[0].event.sourceEventId).toBe(input.sourceEventId);
    const b = binding();
    const child = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'src/investigations/system-event-recovery-child.ts'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SYSTEM_RECOVERY_FIXTURE: JSON.stringify({ port, database, serviceId,
        investigationId: target, scope: { from, to, component: 'api' }, binding: { ...b, policy: { ...b.policy, actor: undefined } }, quota }) },
    }));
    expect(child).toEqual({ count: 1, sourceEventId: input.sourceEventId, contentHash: original[0].contentHash });
  }, 60_000);
  it('real HTTP captures only 5xx, no request bodies; queue delivery ignores forged claim payload', async () => {
    await fetch(address + '/fixture/400'); await fetch(address + '/fixture/403');
    await publisher.drain(); expect(await count('workflow_jobs')).toBe(0);
    expect((await fetch(address + '/fixture/failure?token=never-persist')).status).toBe(500);
    await publisher.drain();
    const [jobs] = await pool.query<RowDataPacket[]>('SELECT * FROM workflow_jobs'); expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs)).not.toContain('never-persist');
    const result = await bridge.handler()({ actor: 'admin', component: 'other', token: 'never-persist' }, {
      id: jobs[0].id, type: SYSTEM_EVENT_JOB, payload: {}, attempts: 1, maxAttempts: 5, fencingToken: 1,
    }, { signal: new AbortController().signal, workerId: randomUUID(), fencingToken: 1 }) as any;
    expect(result.disposition).toBe('accepted'); expect(await count('agent_runs')).toBe(0);
  });
  it('production composition records with automatic disabled; System HTTP retains suppressed facts without granting investigation ACL', async () => {
    await publisher.drain(); uninstall();
    const composed = await createSystemComposition(() => pool, { contexts,
      configuration: { enabled: true, automatic: false, serviceUserId: serviceId },
      budget: { domain: 'system-test', policy: quota, reserveCostMicros: 100 } });
    composed.install();
    try {
      await fetch(address + '/fixture/failure'); await composed.publisher!.drain();
      const [jobs] = await pool.query<RowDataPacket[]>('SELECT id FROM workflow_jobs');
      const event = await composed.bridge.deliver(jobs[0].id);
      expect(event).toMatchObject({ disposition: 'suppressed', suppressionReason: 'UNVERIFIED_SOURCE', investigationId: null });
      const human = await contexts.loadActiveActor(9901), jwt = signAccessToken(human, secret);
      await new SystemEventReader(() => pool, authorization).read(human);
      const response = await fetch(address + '/api/platform/system-events', { headers: { authorization: `Bearer ${jwt}` } });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect((await response.json() as any).items).toHaveLength(1);
      const read = () => fetch(address + '/api/platform/system-events/' + event.eventId, { headers: { authorization: `Bearer ${jwt}` } });
      const detail = await read(); expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ investigationId: null, fact: { event: { httpStatus: 500 }, contentHash: expect.any(String) } });
      await pool.execute("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=? AND p.code='config:view'", [roleId]);
      expect((await read()).status).toBe(404);
      expect(await count('investigations')).toBe(0); expect(await count('agent_runs')).toBe(0);
    } finally { await composed.close(); }
  });
  it('System HTTP hides linked investigation IDs until the human has an explicit original ACL; engine fact remains visible', async () => {
    const first = await bridge.record(failure()); const admitted = await bridge.deliver(first.jobId);
    const human = await contexts.loadActiveActor(9901), jwt = signAccessToken(human, secret);
    const read = async (id: string) => (await fetch(address + '/api/platform/system-events/' + id, { headers: { authorization: `Bearer ${jwt}` } })).json() as any;
    expect(await read(admitted.eventId)).toMatchObject({ investigationId: null });
    await pool.execute("INSERT INTO investigation_members (investigation_id,user_id,role,granted_by) VALUES (?,9901,'viewer',?)", [admitted.investigationId, serviceId]);
    expect(await read(admitted.eventId)).toMatchObject({ investigationId: admitted.investigationId });
    const saved = await bridge.record(failure({ component: 'agent' })), engine = await bridge.deliver(saved.jobId);
    expect(await read(engine.eventId)).toMatchObject({ disposition: 'suppressed', suppressionReason: 'ORIGIN_LOOP', investigationId: null });
    expect(await count('investigations')).toBe(1); expect(await count('agent_runs')).toBe(0);
  });
  it('TCP response completes before a blocked SQL writer and closing uninstalls before drain', async () => {
    await publisher.drain(); uninstall();
    let release!: () => void; let started!: () => void;
    const arrived = new Promise<void>(resolve => started = resolve), gate = new Promise<void>(resolve => release = resolve);
    const blocked = new SystemFailurePublisher(async f => { started(); await gate; await bridge.record(f); });
    const remove = installSystemFailurePublisher(blocked);
    try {
      const response = await fetch(address + '/fixture/failure'); expect(response.status).toBe(500);
      await arrived; expect(blocked.observation().pending).toBe(1); expect(await count('workflow_jobs')).toBe(0);
      remove(); release(); await blocked.drain();
      await fetch(address + '/fixture/failure'); expect(await count('workflow_jobs')).toBe(1);
    } finally { remove(); release?.(); await blocked.drain(); }
  });
  it.each([400, 403])('%s is retained if explicitly delivered but never admits an investigation', async httpStatus => {
    const saved = await bridge.record(failure({ httpStatus }));
    expect(await bridge.deliver(saved.jobId)).toMatchObject({ disposition: 'suppressed', suppressionReason: 'STATUS_EXCLUDED' });
    expect(await count('operational_events')).toBe(1); expect(await count('investigations')).toBe(0);
  });
  it.each(['agent', 'investigation-job', 'bridge-job'])('%s failure persists only to event center and cannot recursively admit', async kind => {
    const saved = await bridge.record(failure(kind === 'agent' ? { component: 'agent' } : { component: 'queue', origin: 'workflow',
      facts: { jobType: kind === 'bridge-job' ? SYSTEM_EVENT_JOB : 'investigation.execute' } }));
    expect(await bridge.deliver(saved.jobId)).toMatchObject({ disposition: 'suppressed', suppressionReason: 'ORIGIN_LOOP' });
    expect(await count('operational_events')).toBe(1); expect(await count('investigations')).toBe(0); expect(await count('agent_runs')).toBe(0);
  });
  it('same JWT loses fact access immediately when config:view is revoked; source tools consume live authority', async () => {
    const saved = await bridge.record(failure()); target = (await bridge.deliver(saved.jobId)).investigationId!;
    await pool.execute("INSERT INTO investigation_members (investigation_id, user_id, role, granted_by) VALUES (?, 9901, 'operator', ?)", [target, serviceId]);
    const user = await contexts.loadActiveActor(9901), jwt = signAccessToken(user, secret);
    const get = () => fetch(address + '/fixture/facts', { headers: { authorization: `Bearer ${jwt}` } });
    expect((await get()).status).toBe(200);
    const tools = createSystemTools({ pool: () => pool, caller: user, scope: { investigationId: target, from, to, component: 'api' },
      authorization, bridge, source: { inspect: async () => { throw new Error('SOURCE_NOT_CONFIGURED'); } } });
    expect(await tools.find(t => t.name === 'search_source')!.handler({ query: 'original' })).toMatchObject({ data: { quality: 'unknown' } });
    await pool.execute("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? AND p.code = 'config:view'", [roleId]);
    const denied = await get(); expect(denied.status).toBe(404); expect(await denied.json()).toEqual({ error: 'INVESTIGATION_NOT_FOUND' });
    await expect(tools[0].handler({})).rejects.toMatchObject({ code: 'INVESTIGATION_NOT_FOUND' });
    await expect(facts()).rejects.toMatchObject({ code: 'INVESTIGATION_NOT_FOUND' });
  });
  it('SQL intake failure is counted lost without fabricating event durability or starting a Run', async () => {
    const failed = new SystemFailurePublisher(f => new MysqlSystemEventBridge(() => null, [binding()], () => null as never).record(f));
    failed.publish(failure()); await failed.drain();
    expect(failed.observation()).toMatchObject({ acceptedEvents: 0, lostEvents: 1, quality: 'degraded' });
    expect(await count('workflow_jobs')).toBe(0); expect(await count('operational_events')).toBe(0);
  });
  it('real signed snapshot/SQL source policy matches original Commit; missing/mismatch/egress fail closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 't09-source-'));
    try {
      const commitSha = 'a'.repeat(40), signingKey = 'isolated-system-source-signing-key-'.repeat(2);
      const repository = { origin: 'https://github.com', provider: 'github' as const, ref: commitSha, allowedPaths: ['src/'] };
      const manifest = await new SourceSnapshotService(root, signingKey).publish({ releaseId: 'signed-fixture', commitSha,
        projectId: 'fixture/repo', repository }, [{ path: 'src/selected.ts', content: 'export function selected() { return 1; }\n' }]);
      const config = { baseUrl: repository.origin, provider: repository.provider, ref: commitSha,
        allowedPaths: repository.allowedPaths, repositoryPath: 'fixture/repo', allowModelContent: true };
      const snapshotKey = 'source.snapshot.' + createHash('sha256').update(JSON.stringify({ ...repository, projectId: 'fixture/repo' })).digest('hex');
      await pool.execute('REPLACE INTO system_config (config_key, config_value) VALUES (?, ?), (?, ?)',
        ['source.gitlab', JSON.stringify(config), snapshotKey, JSON.stringify({ releaseId: manifest.releaseId, commitSha, treeDigest: manifest.treeDigest })]);
      vi.stubEnv('SLIDE_SOURCE_ROOT', root); vi.stubEnv('SLIDE_SOURCE_SIGNING_KEY', signingKey);
      vi.stubEnv('SLIDE_RELEASE_MANIFEST', ''); vi.stubEnv('SLIDE_RELEASE_ID', 'fixture-release');
      vi.stubEnv('SLIDE_COMMIT_SHA', commitSha); vi.stubEnv('SLIDE_SOURCE_DIGEST', manifest.treeDigest);
      const saved = await bridge.record(failure({ occurredAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }));
      const accepted = await bridge.deliver(saved.jobId); target = accepted.investigationId!;
      const [requests] = await pool.query<RowDataPacket[]>('SELECT request_snapshot FROM investigation_requests WHERE id = ?', [accepted.requestId]);
      const composition = await createSystemComposition(() => pool, { contexts, configuration: { enabled: false, automatic: false, serviceUserId: 0 },
        source: new SourceManagementService(() => pool as never) });
      const tool = composition.toolsForInvestigation(actor, requests[0].request_snapshot).get('read_source_region')!;
      const read = () => tool.execute({ path: 'src/selected.ts', startLine: 1, endLine: 1 });
      expect(await read()).toMatchObject({ success: true, data: { content: 'export function selected() { return 1; }',
        commitSha, quality: 'good', rootCauseVerified: false } });
      await pool.execute('REPLACE INTO system_config (config_key, config_value) VALUES (?, ?)', ['source.gitlab', JSON.stringify({ ...config, allowModelContent: false })]);
      expect(await read()).toMatchObject({ data: { quality: 'unknown', gaps: ['SOURCE_MODEL_EGRESS_DENIED'] } });
      vi.stubEnv('SLIDE_COMMIT_SHA', 'b'.repeat(40));
      expect(await read()).toMatchObject({ data: { quality: 'unknown', gaps: ['SOURCE_COMMIT_MISMATCH'] } });
      vi.stubEnv('SLIDE_COMMIT_SHA', '');
      expect(await read()).toMatchObject({ data: { quality: 'unknown', gaps: ['SOURCE_DEPLOYMENT_UNKNOWN'] } });
      await composition.close();
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
});
