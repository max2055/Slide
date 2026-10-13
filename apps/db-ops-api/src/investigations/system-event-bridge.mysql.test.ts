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
    for (const table of ['investigation_event_links', 'operational_events', 'investigation_trigger_keys', 'investigation_trigger_cooldowns',
      'investigation_budget_resources', 'investigation_budget_ledger', 'investigation_budget_domains', 'investigation_create_keys',
      'investigation_admission_keys', 'investigation_requests', 'investigation_members', 'investigation_resources', 'investigations',
      'chat_messages', 'chat_sessions', 'workflow_jobs', 'outbox_events']) await pool.execute(`DELETE FROM ${table}`);
    actor = { ...await contexts.loadInvestigationActorFrom(pool as never, serviceId, 'service', 1),
      resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } };
    bridge = build(); publisher = new SystemFailurePublisher(f => bridge.record(f)); uninstall = installSystemFailurePublisher(publisher);
  });
  afterAll(async () => {
    try { if (publisher) { await publisher.drain(); uninstall(); } await app?.close(); await pool?.end();
      if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
    } finally { if (container) execFileSync('docker', ['stop', '--time', '10', container], { stdio: 'pipe' }); }
  }, 30_000);

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
      const saved = await bridge.record(failure()); target = (await bridge.deliver(saved.jobId)).investigationId!;
      const tools = createSystemTools({ pool: () => pool, caller: actor, scope: { investigationId: target, from, to, component: 'api' },
        authorization, bridge, source: new SourceManagementService(() => pool as never) });
      const tool = tools.find(t => t.name === 'read_source_region')!;
      const read = () => tool.handler({ path: 'src/selected.ts', startLine: 1, endLine: 1 });
      expect(await read()).toMatchObject({ success: true, data: { content: 'export function selected() { return 1; }',
        commitSha, quality: 'good', rootCauseVerified: false } });
      await pool.execute('REPLACE INTO system_config (config_key, config_value) VALUES (?, ?)', ['source.gitlab', JSON.stringify({ ...config, allowModelContent: false })]);
      expect(await read()).toMatchObject({ data: { quality: 'unknown', gaps: ['SOURCE_MODEL_EGRESS_DENIED'] } });
      vi.stubEnv('SLIDE_COMMIT_SHA', 'b'.repeat(40));
      expect(await read()).toMatchObject({ data: { quality: 'unknown', gaps: ['SOURCE_COMMIT_MISMATCH'] } });
      vi.stubEnv('SLIDE_COMMIT_SHA', '');
      expect(await read()).toMatchObject({ data: { quality: 'unknown', gaps: ['SOURCE_DEPLOYMENT_UNKNOWN'] } });
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
});
