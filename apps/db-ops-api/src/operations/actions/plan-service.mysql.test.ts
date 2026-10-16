/** Real SQL + JWT/HTTP domain composition. No product model or target writes. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql, { type Pool } from 'mysql2/promise';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ActorContextService, type ActorContext } from '../../auth/actor-context.js';
import { OperationsAuthorization, OPERATIONS_PERMISSIONS } from '../authorization.js';
import { OperationsError } from '../contracts.js';
import { ActionPlanService } from './plan-service.js';
import { PlanSources, PlanStore, planRows, type PlanConnection } from './plan-store.js';
import { registerActionPlanRoutes } from './routes.js';
import { AgentToolApprovalService } from '../../security/agent-tool-approval-service.js';

const port = Number(process.env.OPERATIONS_TEST_MYSQL_PORT ?? process.env.AGENT_RUN_TEST_MYSQL_PORT);
describe.skipIf(!port)('P06 SQL + JWT domain composition', () => {
  let pool: Pool,
    app: FastifyInstance,
    service: ActionPlanService,
    author: ActorContext,
    reviewer: ActorContext;
  const database = `operations_p06_${randomUUID().replaceAll('-', '')}`;
  const options = {
    host: '127.0.0.1',
    port,
    user: 'root',
    password: process.env.OPERATIONS_TEST_MYSQL_PASSWORD ?? '',
    timezone: 'Z',
    connectionLimit: 12,
  };
  const contexts = new ActorContextService();
  const key = `p06-isolated-jwt-${randomUUID()}`;
  let store: PlanStore, legacy: AgentToolApprovalService, sources: PlanSources;
  const ids = { investigation: randomUUID(), request: randomUUID(), evidence: randomUUID() };
  const sql = (query: string, values: unknown[] = []) => pool.execute(query, values as any[]);
  const loadActor = (id: number, session = 1) =>
    contexts.loadInvestigationActorFrom({ execute: sql }, id, 'user', session, 'p06');
  const file = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const apply = async (text: string) => {
    for (const stmt of text
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await pool.query(stmt);
  };
  const proposal = () => ({
    schemaVersion: 1,
    investigationId: ids.investigation,
    resultVersion: 1,
    target: { type: 'server', id: 1 },
    tool: { name: 'restart_demo_service', version: '1', hash: 'a'.repeat(64) },
    parameters: { unit: 'slide-action-demo.service' },
    evidence: [
      {
        id: ids.evidence,
        version: 1,
        hash: 'b'.repeat(64),
        validUntil: new Date(Date.now() + 3600_000).toISOString(),
      },
    ],
    relations: [],
    baselines: [],
    preconditions: [{ kind: 'target_config_hash', expected: 'c'.repeat(64) }],
    risk: 'medium',
    impact: 'Restart isolated demo only',
    policyVersion: '1',
    verifier: {
      id: 'demo-service',
      version: '1',
      definitionHash: 'd'.repeat(64),
      beforeSeconds: 120,
      readinessSeconds: 60,
      observationSeconds: 300,
      intervalSeconds: 10,
      maxExtraRestarts: 0,
      requireAllHealthy: true,
    },
    rollback: { capability: 'none', description: 'Process memory cannot be restored' },
  });
  const ref = (plan: { id: string; version: number }) => ({ planId: plan.id, expectedVersion: plan.version });
  const pending = async () => {
    const p = await service.create(author, proposal());
    return service.submit(author, ref(p));
  };
  const approved = async () => {
    const p = await pending();
    await service.review(reviewer, { ...ref(p.plan), approvalId: p.approvalId, action: 'approve' });
    return p;
  };
  const enqueue = async (c: PlanConnection, p: any, approvalId: string) => {
    const executionId = randomUUID();
    await c.execute(
      `INSERT INTO action_executions(id,plan_id,plan_version,approval_id,operation_id,actor_id,request_key,payload_hash)
      VALUES(?,?,?,?,?,2,?,?)`,
      [executionId, p.id, p.version, approvalId, `op-${executionId}`, randomUUID(), 'e'.repeat(64)],
    );
    // P07 owns the production intent/outbox composition; this exercises an
    // actual second SQL write in the same consumption transaction.
    await c.execute('INSERT INTO p06_intents VALUES(?,?)', [executionId, approvalId]);
    return executionId;
  };
  const execute = (p: Awaited<ReturnType<typeof pending>>, caller = reviewer) =>
    service.enqueueApproved(caller, { ...ref(p.plan), approvalId: p.approvalId }, enqueue);
  const state = async (id: string) =>
    (
      await planRows(
        { execute: sql },
        'SELECT status,scope,used_count FROM agent_tool_approvals WHERE id=?',
        [id],
      )
    )[0];
  beforeAll(async () => {
    const admin = await mysql.createConnection(options);
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.end();
    pool = mysql.createPool({ ...options, database });
    await apply(`CREATE TABLE users(id INT UNSIGNED PRIMARY KEY,username VARCHAR(64),password_hash VARCHAR(128),status VARCHAR(16),session_version BIGINT DEFAULT 1);
      CREATE TABLE roles(id INT PRIMARY KEY,name VARCHAR(64));CREATE TABLE permissions(id INT PRIMARY KEY,code VARCHAR(128));
      CREATE TABLE user_roles(user_id INT,role_id INT,grant_expiry DATETIME NULL);CREATE TABLE role_permissions(role_id INT,permission_id INT);
      CREATE TABLE instance_permissions(user_id INT,instance_id INT,access_level VARCHAR(32),grant_expiry DATETIME NULL);
      CREATE TABLE servers(id INT PRIMARY KEY);CREATE TABLE network_devices(id INT PRIMARY KEY);
      CREATE TABLE database_instances(id INT PRIMARY KEY,lifecycle_state VARCHAR(32));
      CREATE TABLE chat_sessions(session_id VARCHAR(100) PRIMARY KEY);
      INSERT INTO users VALUES(1,'admin','disabled','active',1),(2,'reviewer','disabled','active',1),(3,'outsider','disabled','active',1);
      INSERT INTO roles VALUES(1,'admin'),(2,'reviewer'),(3,'outsider');INSERT INTO user_roles VALUES(1,1,NULL),(2,2,NULL),(3,3,NULL);
      INSERT INTO servers VALUES(1),(2);INSERT INTO chat_sessions VALUES('p06-session');`);
    for (const [i, code] of [
      'chat:view',
      'servers:view',
      'servers:manage',
      ...Object.values(OPERATIONS_PERMISSIONS),
    ].entries()) {
      await sql('INSERT INTO permissions VALUES(?,?)', [i + 1, code]);
      for (const role of [1, 2, 3]) await sql('INSERT INTO role_permissions VALUES(?,?)', [role, i + 1]);
    }
    for (const name of [
      '054_agent_tool_approvals',
      '068_agent_tool_approval_scopes',
      '112_investigations',
      '117_investigation_observation',
    ])
      await apply(file(`../../../sql/migrations/${name}.sql`));
    await apply(file('../schema/operations-v1.sql'));
    await pool.query(
      'CREATE TABLE p06_intents(id VARCHAR(128) PRIMARY KEY,approval_id BIGINT UNSIGNED UNIQUE NOT NULL)',
    );
    await sql(
      `INSERT INTO investigations(id,title,goal,profile_id,profile_version,session_id,owner_kind,owner_id,scope_version)
      VALUES(?,'p06','p06','ops',1,'p06-session','user',1,?)`,
      [ids.investigation, 'f'.repeat(64)],
    );
    await sql("INSERT INTO investigation_resources VALUES(?,'server',1,'primary')", [ids.investigation]);
    await sql("INSERT INTO investigation_members VALUES(?,2,'viewer',1,NULL)", [ids.investigation]);
    await sql(
      `INSERT INTO investigation_requests(id,investigation_id,actor_kind,actor_id,idempotency_key,request_hash,request_snapshot,job_id,accepted_version)
      VALUES(?,?,'user',1,'p06',?,'{}',?,1)`,
      [ids.request, ids.investigation, 'f'.repeat(64), randomUUID()],
    );
    await sql(
      `INSERT INTO investigation_results(id,investigation_id,request_id,run_id,version,source_key,payload_hash,result_json)
      VALUES(?,?,?,'run',1,'initial',?,'{}')`,
      [randomUUID(), ids.investigation, ids.request, 'f'.repeat(64)],
    );
    await sql(
      `INSERT INTO investigation_evidence(id,investigation_id,request_id,run_id,source_key,payload_hash,content_hash,metadata_json,raw_json,expires_at)
      VALUES(?,?,?,'run','evidence',?,?,?,'{}',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 HOUR))`,
      [
        ids.evidence,
        ids.investigation,
        ids.request,
        'b'.repeat(64),
        'b'.repeat(64),
        JSON.stringify({ resources: [{ type: 'server', id: 1 }] }),
      ],
    );
    await pool.query(
      `CREATE TABLE p06_environment(id INT PRIMARY KEY,tool_hash CHAR(64),policy_version VARCHAR(128),config_hash CHAR(64),eligible BOOLEAN)`,
    );
    await sql('INSERT INTO p06_environment VALUES(1,?,?,?,true)', ['a'.repeat(64), '1', 'c'.repeat(64)]);
    store = new PlanStore(pool as any);
    sources = new PlanSources({
      validate: async (c, content) => {
        const [env] = await planRows(c, 'SELECT * FROM p06_environment WHERE id=? FOR SHARE', [
          content.target.id,
        ]);
        if (
          !env?.eligible ||
          env.tool_hash !== content.tool.hash ||
          env.policy_version !== content.policyVersion ||
          content.preconditions.length !== 1 ||
          content.preconditions[0].kind !== 'target_config_hash' ||
          content.preconditions[0].expected !== env.config_hash ||
          content.tool.version !== '1' ||
          content.verifier.version !== '1' ||
          content.verifier.definitionHash !== 'd'.repeat(64)
        )
          throw new OperationsError('OPERATIONS_PRECONDITION_FAILED');
        return;
      },
    });
    service = new ActionPlanService(store, sources, new OperationsAuthorization(), () => ({
      context: false,
      cases: false,
      baselines: false,
      attention: false,
      plans: true,
      dispatch: true,
    }));
    legacy = new AgentToolApprovalService(() => ({ execute: sql }), key);
    app = Fastify();
    await registerActionPlanRoutes(
      app,
      async (request, reply) => {
        try {
          const claims = jwt.verify(
            String(request.headers.authorization ?? '').replace(/^Bearer /, ''),
            key,
          ) as { userId: number; sessionVersion: number };
          request.user = await loadActor(claims.userId, claims.sessionVersion);
        } catch {
          return reply.code(401).send({ reasonCode: 'UNAUTHENTICATED' });
        }
      },
      service,
    );
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    if (pool) {
      await pool.query(`DROP DATABASE ${database}`);
      await pool.end();
    }
  }, 60_000);
  beforeEach(async () => {
    await sql("UPDATE users SET session_version=1,status='active'");
    await sql('DELETE FROM role_permissions');
    for (const role of [1, 2, 3])
      await sql('INSERT INTO role_permissions SELECT ?,id FROM permissions', [role]);
    await sql('DELETE FROM investigation_results WHERE version>1');
    await sql(
      'UPDATE investigation_evidence SET content_hash=?,expired_at=NULL,expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 HOUR),metadata_json=?',
      ['b'.repeat(64), JSON.stringify({ resources: [{ type: 'server', id: 1 }] })],
    );
    await sql('UPDATE p06_environment SET tool_hash=?,policy_version=?,config_hash=?,eligible=true', [
      'a'.repeat(64),
      '1',
      'c'.repeat(64),
    ]);
    author = await loadActor(1);
    reviewer = await loadActor(2);
  });
  it('rejects admin self-review, a service reviewer and nonmember; independent human approval succeeds', async () => {
    const p = await pending();
    await expect(
      service.review(author, { ...ref(p.plan), approvalId: p.approvalId, action: 'approve' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.review(
        { ...reviewer, principalKind: 'service' },
        { ...ref(p.plan), approvalId: p.approvalId, action: 'approve' },
      ),
    ).rejects.toBeTruthy();
    await expect(service.get(await loadActor(3), p.plan.id)).rejects.toMatchObject({ statusCode: 404 });
    await service.review(reviewer, { ...ref(p.plan), approvalId: p.approvalId, action: 'approve' });
    expect(await state(p.approvalId)).toEqual({ status: 'approved', scope: 'once', used_count: 0 });
  });
  it('blocks legacy single/batch review and consumption for action approvals; preserves ordinary approvals', async () => {
    const p = await pending();
    expect(await legacy.review(p.approvalId, 1, 'approve', undefined, 'session')).toBe(false);
    expect(await legacy.reviewPendingByTool('operations_action_plan', 2, 'approve')).toEqual([]);
    expect(await legacy.review(p.approvalId, 2, 'reject')).toBe(false);
    await service.review(reviewer, { ...ref(p.plan), approvalId: p.approvalId, action: 'approve' });
    const [row] = await planRows(
      { execute: sql },
      'SELECT binding_hash FROM agent_tool_approvals WHERE id=?',
      [p.approvalId],
    );
    expect(
      await legacy.consumeApproved(p.approvalId, row.binding_hash, 1, {
        sessionKey: 'inherited',
        riskLevel: 'medium',
      }),
    ).toBe(false);
    const old = await legacy.submit(
      author,
      {
        name: 'slide_update_db_config',
        description: 'legacy',
        parameters: { type: 'object', properties: {} },
        handler: async () => ({ success: true }),
      },
      { instance_id: 1 },
      { type: 'instance', instanceId: 1 },
    );
    expect(await legacy.review(old.id, 1, 'approve')).toBe(true);
    const [oldRow] = await planRows(
      { execute: sql },
      'SELECT binding_hash FROM agent_tool_approvals WHERE id=?',
      [old.id],
    );
    expect(await legacy.consumeApproved(old.id, oldRow.binding_hash, 1)).toBe(true);
  });
  it('defaults 15m, bounds 30m, stores immutable versions and invalidates old approved and pending grants', async () => {
    const p = await approved(),
      before = await service.get(author, p.plan.id);
    expect(Date.parse(before.content.validUntil) - Date.parse(before.content.validFrom)).toBe(900_000);
    const next = await service.revise(author, ref(p.plan), { ...proposal(), impact: 'New impact' });
    expect(next.version).toBe(2);
    expect(await state(p.approvalId)).toMatchObject({ status: 'expired' });
    await expect(execute(p)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.revise(author, ref(p.plan), proposal())).rejects.toMatchObject({ statusCode: 409 });
    const versions = await planRows(
      { execute: sql },
      'SELECT version,state,content_hash FROM action_plan_versions WHERE plan_id=? ORDER BY version',
      [p.plan.id],
    );
    expect(versions[0]).toEqual({ version: 1, state: 'superseded', content_hash: before.contentHash });
    const p2 = await pending();
    await service.revise(author, ref(p2.plan), proposal());
    expect(await state(p2.approvalId)).toMatchObject({ status: 'expired' });
    await expect(service.create(author, proposal(), 1_800_001)).rejects.toMatchObject({ statusCode: 422 });
  });
  it('consumes once under concurrent execution and writes exactly one execution/intent', async () => {
    const p = await approved();
    const results = await Promise.allSettled([execute(p), execute(p)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await state(p.approvalId)).toEqual({ status: 'consumed', scope: 'once', used_count: 1 });
    const [counts] = await planRows(
      { execute: sql },
      'SELECT COUNT(*) n FROM p06_intents WHERE approval_id=?',
      [p.approvalId],
    );
    expect(counts.n).toBe(1);
    await expect(execute(p)).rejects.toMatchObject({ statusCode: 409 });
  });
  it('rolls consumption and intent back together on enqueue failure', async () => {
    const p = await approved();
    await expect(
      service.enqueueApproved(reviewer, { ...ref(p.plan), approvalId: p.approvalId }, async (c, plan, id) => {
        await enqueue(c, plan, id);
        throw new Error('intent failure');
      }),
    ).rejects.toThrow('intent failure');
    expect(await state(p.approvalId)).toMatchObject({ status: 'approved', used_count: 0 });
    expect(
      await planRows({ execute: sql }, 'SELECT * FROM p06_intents WHERE approval_id=?', [p.approvalId]),
    ).toHaveLength(0);
    await execute(p);
  });
  it.each([
    'proposer-permission',
    'reviewer-permission',
    'session',
    'result',
    'evidence-hash',
    'evidence-expiry',
    'evidence-scope',
    'tool',
    'policy',
    'precondition',
    'target',
    'expiry',
    'scope',
  ])('invalidates approved grant after %s change', async (change) => {
    const p = await approved();
    if (change === 'proposer-permission' || change === 'reviewer-permission')
      await sql(
        'DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=? AND p.code=?',
        [
          change === 'proposer-permission' ? 1 : 2,
          change === 'proposer-permission' ? 'operations:actions:propose' : 'operations:actions:approve',
        ],
      );
    if (change === 'session') await sql('UPDATE users SET session_version=2 WHERE id=1');
    if (change === 'result')
      await sql(
        `INSERT INTO investigation_results(id,investigation_id,request_id,run_id,version,source_key,payload_hash,result_json) VALUES(?,?,?,'run',2,'changed',?,'{}')`,
        [randomUUID(), ids.investigation, ids.request, 'e'.repeat(64)],
      );
    if (change === 'evidence-hash')
      await sql('UPDATE investigation_evidence SET content_hash=?', ['e'.repeat(64)]);
    if (change === 'evidence-expiry')
      await sql('UPDATE investigation_evidence SET expired_at=UTC_TIMESTAMP(3)');
    if (change === 'evidence-scope')
      await sql('UPDATE investigation_evidence SET metadata_json=?', [
        JSON.stringify({ resources: [{ type: 'server', id: 2 }] }),
      ]);
    if (change === 'tool') await sql('UPDATE p06_environment SET tool_hash=?', ['e'.repeat(64)]);
    if (change === 'policy') await sql("UPDATE p06_environment SET policy_version='2'");
    if (change === 'precondition') await sql('UPDATE p06_environment SET config_hash=?', ['e'.repeat(64)]);
    if (change === 'target') await sql('UPDATE p06_environment SET eligible=false');
    if (change === 'expiry')
      await sql(
        'UPDATE agent_tool_approvals SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',
        [p.approvalId],
      );
    if (change === 'scope')
      await sql("UPDATE agent_tool_approvals SET scope='session',session_key='s' WHERE id=?", [p.approvalId]);
    if (change === 'evidence-scope')
      reviewer = { ...reviewer, resourceBoundary: { serverIds: [1], instanceIds: [], networkDeviceIds: [] } };
    await expect(execute(p)).rejects.toBeTruthy();
    expect(await state(p.approvalId)).not.toMatchObject({ status: 'consumed' });
  });
  it.each(['relation', 'baseline'])(
    'invalidates approval on a new %s revision and keeps historical scope readable',
    async (kind) => {
      const input = proposal();
      const until = new Date(Date.now() + 3600_000).toISOString();
      if (kind === 'relation') {
        await sql(
          `INSERT INTO resource_relation_revisions(relation_id,version,source_type,source_id,target_type,target_id,relation_type,state,content_hash,provenance,observed_at,confirmed_by,confirmed_at,valid_from,valid_until)
        VALUES(1,1,'server',1,'server',2,'depends_on','confirmed',?,'{}',UTC_TIMESTAMP(3),2,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 HOUR))`,
          ['c'.repeat(64)],
        );
        input.relations = [{ id: '1', version: 1, hash: 'c'.repeat(64), validUntil: until }] as never;
      } else {
        await sql(
          `INSERT INTO behavior_baseline_versions(id,version,resource_type,resource_id,series_hash,series_identity,method_version,content_hash,state,training_from,training_until,validation_from,validation_until,quality,reference_bands)
        VALUES('baseline',1,'server',1,?,'{}','1',?,'qualified','2026-01-01','2026-01-15','2026-01-15','2026-01-22','{}','{}')`,
          ['c'.repeat(64), 'c'.repeat(64)],
        );
        input.baselines = [{ id: 'baseline', version: 1, hash: 'c'.repeat(64), validUntil: until }] as never;
      }
      const plan = await service.create(author, input),
        p = await service.submit(author, ref(plan));
      await service.review(reviewer, { ...ref(plan), approvalId: p.approvalId, action: 'approve' });
      if (kind === 'relation')
        await sql("UPDATE resource_relation_revisions SET state='withdrawn' WHERE relation_id=1");
      else await sql("UPDATE behavior_baseline_versions SET state='invalidated' WHERE id='baseline'");
      await expect(execute(p)).rejects.toMatchObject({ statusCode: 422 });
      expect((await service.get(author, plan.id)).contentHash).toBe(plan.contentHash);
    },
  );
  it('fails closed when plans/dispatch disabled while retaining authorized reads', async () => {
    const p = await approved();
    const disabled = new ActionPlanService(store, sources, new OperationsAuthorization(), () => ({
      context: false,
      cases: false,
      baselines: false,
      attention: false,
      plans: false,
      dispatch: false,
    }));
    await expect(disabled.create(author, proposal())).rejects.toMatchObject({
      code: 'OPERATIONS_FEATURE_DISABLED',
    });
    await expect(
      disabled.enqueueApproved(reviewer, { ...ref(p.plan), approvalId: p.approvalId }, enqueue),
    ).rejects.toMatchObject({ code: 'OPERATIONS_FEATURE_DISABLED' });
    expect((await disabled.get(author, p.plan.id)).id).toBe(p.plan.id);
    expect(await state(p.approvalId)).toMatchObject({ status: 'approved' });
  });
  it('keeps rejected approval unusable and prevents stale-content/hash edits', async () => {
    const p = await pending();
    await service.review(reviewer, {
      ...ref(p.plan),
      approvalId: p.approvalId,
      action: 'reject',
      note: 'Unsafe',
    });
    await expect(execute(p)).rejects.toMatchObject({ statusCode: 409 });
    const p2 = await approved();
    const content = { ...p2.plan.content, impact: 'tampered' };
    await sql('UPDATE action_plan_versions SET content=? WHERE plan_id=? AND version=1', [
      JSON.stringify(content),
      p2.plan.id,
    ]);
    await expect(execute(p2)).rejects.toMatchObject({ statusCode: 422 });
  });
  it('serves a real loopback HTTP request with signed JWT and SQL persistence', async () => {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${base}/api/operations/actions/plans`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jwt.sign({ userId: 1, sessionVersion: 1 }, key, { expiresIn: '5m' })}`,
      },
      body: JSON.stringify({ content: proposal() }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    expect((await service.get(author, body.plan.id)).contentHash).toBe(body.plan.contentHash);
  });
  it('uses JWT and real live SQL ACLs over HTTP; denies supplied identity, scope and unknown fields', async () => {
    const token = (id: number) =>
      `Bearer ${jwt.sign({ userId: id, sessionVersion: 1 }, key, { expiresIn: '5m' })}`;
    const post = (path: string, payload: any, id = 1) =>
      app.inject({ method: 'POST', url: path, headers: { authorization: token(id) }, payload });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/operations/actions/plans',
          payload: { content: proposal() },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await post('/api/operations/actions/plans', { content: proposal(), actorId: 2 })).statusCode,
    ).toBe(422);
    expect(
      (
        await post('/api/operations/actions/plans', {
          content: { ...proposal(), author: { kind: 'user', id: 2 } },
        })
      ).statusCode,
    ).toBe(422);
    const created = await post('/api/operations/actions/plans', { content: proposal() });
    expect(created.statusCode).toBe(201);
    const plan = created.json().plan;
    const url = `/api/operations/actions/plans/${plan.id}`;
    const submitted = await post(`${url}/submit`, { expectedVersion: 1 });
    expect(submitted.statusCode).toBe(201);
    const command = { expectedVersion: 1, approvalId: submitted.json().approvalId, action: 'approve' };
    expect((await post(`${url}/review`, command)).statusCode).toBe(403);
    expect((await post(`${url}/review`, { ...command, scope: 'session' }, 2)).statusCode).toBe(422);
    expect((await post(`${url}/review`, command, 3)).statusCode).toBe(404);
    expect((await post(`${url}/review`, command, 2)).statusCode).toBe(200);
    await sql('UPDATE users SET session_version=2 WHERE id=2');
    expect((await app.inject({ method: 'GET', url, headers: { authorization: token(2) } })).statusCode).toBe(
      401,
    );
  });
});
