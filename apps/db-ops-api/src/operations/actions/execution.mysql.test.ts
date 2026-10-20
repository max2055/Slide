/** Production schema + actual MySQL transactions. No VM/model calls. */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client, Server, utils } from 'ssh2';
import mysql, { type Pool } from 'mysql2/promise';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ActorContextService, type ActorContext } from '../../auth/actor-context.js';
import { OperationsAuthorization, OPERATIONS_PERMISSIONS } from '../authorization.js';
import { operationsContentHash } from '../contracts.js';
import type { OperationsFlags } from '../feature-flags.js';
import { PlanStore, PlanSources, planRows, type PlanConnection } from './plan-store.js';
import { ActionPlanService } from './plan-service.js';
import { ActionExecutionStore, type ExecutionRecord } from './execution-store.js';
import {
  ActionExecutor,
  consumeActionInvocation,
  type ActionAdapter,
  type ActionInvocation,
} from './executor.js';
import { AgentToolApprovalExecution } from '../../security/agent-tool-approval-execution.js';
import { actionWorkflowHandler, registerActionExecutionRoutes } from './workflow-handler.js';
import { RestartDemoServiceAdapter } from './adapters/restart-demo-service.js';

const port = Number(
  process.env.OPERATIONS_TEST_MYSQL_PORT ?? process.env.AGENT_RUN_TEST_MYSQL_PORT,
);
describe.skipIf(!port)('P07 production SQL execution boundary', () => {
  let pool: Pool,
    plans: PlanStore,
    sources: PlanSources,
    approvals: ActionPlanService,
    store: ActionExecutionStore;
  let author: ActorContext, reviewer: ActorContext, worker: ActionExecutor;
  let flags: OperationsFlags, sends: number, remoteReceipt: unknown;
  let receiptReads = 0;
  let preflight: (() => Promise<void>) | undefined,
    send: ((invocation: ActionInvocation) => Promise<unknown>) | undefined;
  let validateEnvironment: ((c: PlanConnection) => Promise<void>) | undefined;
  let targetConfigHash: string, toolHash: string;
  const database = `operations_p07_${randomUUID().replaceAll('-', '')}`;
  const options = {
    host: '127.0.0.1',
    port,
    user: 'root',
    password: process.env.OPERATIONS_TEST_MYSQL_PASSWORD ?? '',
    timezone: 'Z',
    connectionLimit: 12,
  };
  const ids = { investigation: randomUUID(), request: randomUUID(), evidence: randomUUID() };
  const sql = (q: string, v: unknown[] = []) => pool.execute(q, v as any[]);
  const rows = (q: string, v: unknown[] = []) => planRows({ execute: sql }, q, v);
  const actor = (id: number) =>
    new ActorContextService().loadInvestigationActorFrom({ execute: sql }, id, 'user', 1, 'p07');
  const apply = async (text: string) => {
    for (const s of text
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((v) => v.trim())
      .filter(Boolean))
      await pool.query(s);
  };
  const file = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const proposal = () => ({
    schemaVersion: 1,
    investigationId: ids.investigation,
    resultVersion: 1,
    target: { type: 'server', id: 1 },
    tool: { name: 'restart_demo_service', version: '1', hash: toolHash },
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
    preconditions: [{ kind: 'target_config_hash', expected: targetConfigHash }],
    risk: 'medium',
    impact: 'isolated demo',
    policyVersion: '1',
    verifier: {
      id: 'demo',
      version: '1',
      definitionHash: 'd'.repeat(64),
      beforeSeconds: 120,
      readinessSeconds: 60,
      observationSeconds: 300,
      intervalSeconds: 10,
      maxExtraRestarts: 0,
      requireAllHealthy: true,
    },
    rollback: { capability: 'none', description: 'no memory rollback' },
  });
  const approved = async () => {
    const p = await approvals.create(author, proposal());
    const ref = { planId: p.id, expectedVersion: p.version };
    const a = await approvals.submit(author, ref);
    await approvals.review(reviewer, { ...ref, approvalId: a.approvalId, action: 'approve' });
    return { ...ref, approvalId: a.approvalId, requestKey: randomUUID() };
  };
  const queued = async () => store.enqueue(reviewer, await approved());
  const receipt = (i: ActionInvocation, outcome = 'succeeded') => ({
    protocol: 1,
    operationId: i.operationId,
    planHash: i.planHash,
    unit: 'slide-action-demo.service',
    configHash: i.configHash,
    helperHash: i.toolHash,
    outcome,
    before: '1'.repeat(32),
    after: '2'.repeat(32),
  });
  const adapter: ActionAdapter = {
    preflight: async () => {
      await preflight?.();
    },
    execute: async (i) => {
      consumeActionInvocation(i);
      sends++;
      remoteReceipt = receipt(i);
      return send ? send(i) : remoteReceipt;
    },
    receipt: async () => {
      receiptReads++;
      return remoteReceipt;
    },
  };
  const state = (e: ExecutionRecord) => store.get(reviewer, e.id);
  const expireLease = (e: ExecutionRecord) =>
    sql(
      'UPDATE action_executions SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',
      [e.id],
    );
  beforeAll(async () => {
    const admin = await mysql.createConnection(options);
    await admin.query(
      `CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await admin.end();
    pool = mysql.createPool({ ...options, database });
    await apply(`CREATE TABLE users(id INT UNSIGNED PRIMARY KEY,username VARCHAR(64),password_hash VARCHAR(128),status VARCHAR(16),session_version BIGINT DEFAULT 1);
      CREATE TABLE roles(id INT PRIMARY KEY,name VARCHAR(64));CREATE TABLE permissions(id INT PRIMARY KEY,code VARCHAR(128));
      CREATE TABLE user_roles(user_id INT,role_id INT,grant_expiry DATETIME NULL);CREATE TABLE role_permissions(role_id INT,permission_id INT);
      CREATE TABLE instance_permissions(user_id INT,instance_id INT,access_level VARCHAR(32),grant_expiry DATETIME NULL);
      CREATE TABLE servers(id INT PRIMARY KEY);CREATE TABLE network_devices(id INT PRIMARY KEY);CREATE TABLE database_instances(id INT PRIMARY KEY,lifecycle_state VARCHAR(32));
      CREATE TABLE chat_sessions(session_id VARCHAR(100) PRIMARY KEY);
      INSERT INTO users VALUES(1,'author','disabled','active',1),(2,'reviewer','disabled','active',1);
      INSERT INTO roles VALUES(1,'author'),(2,'reviewer');INSERT INTO user_roles VALUES(1,1,NULL),(2,2,NULL);
      INSERT INTO servers VALUES(1);INSERT INTO chat_sessions VALUES('p07');`);
    for (const [i, code] of [
      'chat:view',
      'servers:view',
      'servers:manage',
      ...Object.values(OPERATIONS_PERMISSIONS),
    ].entries()) {
      await sql('INSERT INTO permissions VALUES(?,?)', [i + 1, code]);
      for (const role of [1, 2])
        await sql('INSERT INTO role_permissions VALUES(?,?)', [role, i + 1]);
    }
    for (const name of [
      '029_resource_observations',
      '032_workflow_outbox_jobs',
      '054_agent_tool_approvals',
      '068_agent_tool_approval_scopes',
      '094_agent_tool_execution_intents',
      '112_investigations',
      '117_investigation_observation',
    ])
      await apply(file(`../../../sql/migrations/${name}.sql`));
    await apply(file('../schema/operations-v1.sql'));
    await sql(
      `INSERT INTO investigations(id,title,goal,profile_id,profile_version,session_id,owner_kind,owner_id,scope_version) VALUES(?,'p07','p07','ops',1,'p07','user',1,?)`,
      [ids.investigation, 'f'.repeat(64)],
    );
    await sql("INSERT INTO investigation_resources VALUES(?,'server',1,'primary')", [
      ids.investigation,
    ]);
    await sql("INSERT INTO investigation_members VALUES(?,2,'viewer',1,NULL)", [ids.investigation]);
    await sql(
      `INSERT INTO investigation_requests(id,investigation_id,actor_kind,actor_id,idempotency_key,request_hash,request_snapshot,job_id,accepted_version) VALUES(?,?,'user',1,'p07',?,'{}',?,1)`,
      [ids.request, ids.investigation, 'f'.repeat(64), randomUUID()],
    );
    await sql(
      `INSERT INTO investigation_results(id,investigation_id,request_id,run_id,version,source_key,payload_hash,result_json) VALUES(?,?,?,'run',1,'initial',?,'{}')`,
      [randomUUID(), ids.investigation, ids.request, 'f'.repeat(64)],
    );
    await sql(
      `INSERT INTO investigation_evidence(id,investigation_id,request_id,run_id,source_key,payload_hash,content_hash,metadata_json,raw_json,expires_at) VALUES(?,?,?,'run','evidence',?,?,?,'{}',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 HOUR))`,
      [
        ids.evidence,
        ids.investigation,
        ids.request,
        'b'.repeat(64),
        'b'.repeat(64),
        JSON.stringify({ resources: [{ type: 'server', id: 1 }] }),
      ],
    );
    plans = new PlanStore(pool as any);
    sources = new PlanSources({
      validate: async (_c: PlanConnection, p) => {
        if (p.tool.hash !== toolHash) throw new Error('hash');
        await validateEnvironment?.(_c);
      },
    });
    approvals = new ActionPlanService(plans, sources, new OperationsAuthorization(), () => flags);
    store = new ActionExecutionStore(plans, sources, approvals);
    worker = new ActionExecutor(
      store,
      sources,
      adapter,
      new OperationsAuthorization(),
      () => flags,
    );
  }, 60_000);
  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP DATABASE ${database}`);
      await pool.end();
    }
  }, 60_000);
  beforeEach(async () => {
    flags = {
      context: false,
      cases: false,
      baselines: false,
      attention: false,
      plans: true,
      dispatch: true,
    };
    sends = 0;
    receiptReads = 0;
    remoteReceipt = null;
    preflight = undefined;
    send = undefined;
    validateEnvironment = undefined;
    targetConfigHash = 'c'.repeat(64);
    toolHash = 'a'.repeat(64);
    await sql("UPDATE users SET session_version=1,status='active'");
    await sql('DELETE FROM role_permissions');
    for (const role of [1, 2])
      await sql('INSERT INTO role_permissions SELECT ?,id FROM permissions', [role]);
    await sql(
      'UPDATE investigation_evidence SET expired_at=NULL,expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 HOUR)',
    );
    await sql('DELETE FROM action_dispatch_locks');
    await sql('DELETE FROM action_executions');
    await sql('DELETE FROM agent_tool_execution_intents');
    await sql('DELETE FROM workflow_jobs');
    await sql('DELETE FROM outbox_events');
    author = await actor(1);
    reviewer = await actor(2);
  });
  afterEach(() => vi.restoreAllMocks());
  it('consumes once + unique execution + intent/outbox/job atomically under duplicate requests', async () => {
    const command = await approved();
    const [a, b] = await Promise.all([
      store.enqueue(reviewer, command),
      store.enqueue(reviewer, command),
    ]);
    expect(a.id).toBe(b.id);
    expect(await rows('SELECT * FROM action_executions')).toHaveLength(1);
    expect(await rows('SELECT * FROM agent_tool_execution_intents')).toHaveLength(1);
    expect(await rows('SELECT * FROM outbox_events')).toHaveLength(1);
    expect(await rows('SELECT * FROM workflow_jobs')).toHaveLength(1);
    expect(
      (
        await rows('SELECT status,used_count FROM agent_tool_approvals WHERE id=?', [
          command.approvalId,
        ])
      )[0],
    ).toMatchObject({ status: 'consumed', used_count: 1 });
    expect(await store.enqueue(reviewer, command)).toMatchObject({ id: a.id });
    await expect(store.enqueue(reviewer, { ...command, approvalId: '999' })).rejects.toMatchObject({
      code: 'OPERATIONS_IDEMPOTENCY_CONFLICT',
    });
  });
  it('rolls approval + intent + locks back if the durable queue insert fails', async () => {
    const command = await approved();
    await sql('RENAME TABLE workflow_jobs TO p07_hidden_jobs');
    try {
      await expect(store.enqueue(reviewer, command)).rejects.toThrow();
    } finally {
      await sql('RENAME TABLE p07_hidden_jobs TO workflow_jobs');
    }
    expect(await rows('SELECT * FROM action_executions')).toHaveLength(0);
    expect(await rows('SELECT * FROM agent_tool_execution_intents')).toHaveLength(0);
    expect(await rows('SELECT * FROM outbox_events')).toHaveLength(0);
    expect(
      (
        await rows('SELECT status,used_count FROM agent_tool_approvals WHERE id=?', [
          command.approvalId,
        ])
      )[0],
    ).toMatchObject({ status: 'approved', used_count: 0 });
  });
  it('one global/resource lock; blocked second approval remains unused; releases after success', async () => {
    const e = await queued(),
      next = await approved();
    await expect(store.enqueue(reviewer, next)).rejects.toMatchObject({
      code: 'OPERATIONS_VERSION_CONFLICT',
    });
    expect(
      (await rows('SELECT status FROM agent_tool_approvals WHERE id=?', [next.approvalId]))[0]
        .status,
    ).toBe('approved');
    await Promise.all([worker.run(e.id, 'worker-a'), worker.run(e.id, 'worker-b')]);
    expect(sends).toBe(1);
    expect((await state(e)).state).toBe('succeeded');
    expect(
      await rows('SELECT * FROM action_dispatch_locks WHERE execution_id IS NOT NULL'),
    ).toHaveLength(0);
    expect((await store.enqueue(reviewer, next)).state).toBe('queued');
  });
  it('unknown global lock blocks an independently approved different server without consuming it', async () => {
    await sql('INSERT INTO servers VALUES(2)');
    await sql("INSERT INTO investigation_resources VALUES(?,'server',2,'related')", [ids.investigation]);
    try {
      const e = await queued();
      const p = await approvals.create(author, { ...proposal(), target: { type: 'server', id: 2 } });
      const ref = { planId: p.id, expectedVersion: p.version };
      const a = await approvals.submit(author, ref);
      await approvals.review(reviewer, { ...ref, approvalId: a.approvalId, action: 'approve' });
      send = async () => { throw new Error('lost reply'); };
      await worker.run(e.id, 'first-target');
      await expect(store.enqueue(reviewer, { ...ref, approvalId: a.approvalId, requestKey: randomUUID() }))
        .rejects.toMatchObject({ code: 'OPERATIONS_VERSION_CONFLICT' });
      expect((await rows('SELECT status,used_count FROM agent_tool_approvals WHERE id=?', [a.approvalId]))[0])
        .toMatchObject({ status: 'approved', used_count: 0 });
      expect((await rows('SELECT lock_key FROM action_dispatch_locks WHERE execution_id=? ORDER BY lock_key', [e.id]))
        .map((row) => row.lock_key.toString())).toEqual(['global', 'server:1']);
      expect((await state(e)).state).toBe('outcome_unknown');
      expect(sends).toBe(1);
    } finally {
      await sql("DELETE FROM investigation_resources WHERE investigation_id=? AND resource_id=2", [ids.investigation]);
      await sql('DELETE FROM servers WHERE id=2');
    }
  });
  it('expired prechecking fence cannot send after a replacement worker claims', async () => {
    const e = await queued(),
      a = await store.claim(e.id, 'worker-a');
    expect(a).not.toBeNull();
    await expireLease(e);
    const b = await store.claim(e.id, 'worker-b');
    expect(b!.fence).toBeGreaterThan(a!.fence);
    expect(await store.transaction((c) => store.leased(c, a!))).toBeNull();
    await expireLease(e);
    await worker.run(e.id, 'worker-c');
    expect(sends).toBe(1);
  });
  it.each(['slow validation', 'SQL lock wait'])(
    'R1 rejects expired lease after final %s before any send',
    async (window) => {
      const e = await queued();
      const claim = store.claim.bind(store);
      vi.spyOn(store, 'claim').mockImplementation((id, owner) => claim(id, owner, 1));
      let validations = 0;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocker = window === 'SQL lock wait' ? await pool.getConnection() : null;
      try {
        if (blocker) {
          await blocker.beginTransaction();
          await blocker.execute('SELECT id FROM workflow_jobs FOR UPDATE');
        }
        validateEnvironment = async (c) => {
          if (++validations !== 2) return;
          if (blocker) {
            entered();
            await c.execute('SELECT id FROM workflow_jobs FOR UPDATE');
          } else await c.execute('SELECT SLEEP(1.2)');
        };
        const running = worker.run(e.id, 'expired-final-check');
        if (blocker) {
          await waiting;
          await blocker.execute('SELECT SLEEP(1.2)');
          await blocker.commit();
        }
        await running;
      } finally {
        if (blocker) {
          await blocker.rollback();
          blocker.release();
        }
      }
      expect(validations).toBe(2);
      expect(sends).toBe(0);
      expect(await state(e)).toMatchObject({ state: 'failed', sentAt: null });
      await worker.run(e.id, 'redelivery');
      expect(sends).toBe(0);
      expect(
        (
          await rows('SELECT status,used_count FROM agent_tool_approvals WHERE id=?', [
            e.approvalId,
          ])
        )[0],
      ).toMatchObject({ status: 'consumed', used_count: 1 });
      expect(
        await rows(
          "SELECT * FROM outbox_events WHERE aggregate_id=? AND event_type='operations.action.state' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.state'))='dispatching'",
          [e.id],
        ),
      ).toHaveLength(0);
    },
  );
  it.each([
    "state='cancelled'",
    'cancel_requested_at=UTC_TIMESTAMP(3)',
    "lease_owner='replacement'",
    'fence=fence+1',
    'lease_expires_at=UTC_TIMESTAMP(3)',
    'version=version+1',
  ])('R1 atomic admission rejects changed durable authority: %s', async (mutation) => {
    const e = await queued();
    const lease = (await store.claim(e.id, 'old-worker'))!;
    await store.transaction(async (c) => {
      const checked = (await store.leased(c, lease))!;
      await c.execute(`UPDATE action_executions SET ${mutation} WHERE id=?`, [e.id]);
      expect(await store.admitDispatch(c, checked, lease)).toBe(false);
    });
    expect((await state(e)).sentAt).toBeNull();
    expect(sends).toBe(0);
    expect(
      await rows(
        "SELECT * FROM outbox_events WHERE aggregate_id=? AND event_type='operations.action.state'",
        [e.id],
      ),
    ).toHaveLength(0);
  });
  it('R1 lost dispatch commit acknowledgement keeps unknown without send or refund', async () => {
    const e = await queued();
    const transaction = plans.transaction.bind(plans);
    let lost = false;
    vi.spyOn(plans, 'transaction').mockImplementation(async (work) => {
      const value = await transaction(work);
      if (value && typeof value === 'object' && 'executionId' in value && !lost) {
        lost = true;
        throw new Error('commit succeeded but acknowledgement lost');
      }
      return value;
    });
    await worker.run(e.id, 'lost-ack');
    expect(lost).toBe(true);
    expect(await state(e)).toMatchObject({ state: 'outcome_unknown', sentAt: expect.any(String) });
    await worker.run(e.id, 'redelivery');
    expect(sends).toBe(0);
    expect(
      await rows('SELECT * FROM action_dispatch_locks WHERE execution_id=?', [e.id]),
    ).toHaveLength(2);
    expect(
      (
        await rows('SELECT status,used_count FROM agent_tool_approvals WHERE id=?', [e.approvalId])
      )[0],
    ).toMatchObject({ status: 'consumed', used_count: 1 });
  });
  it('R1 failed dispatch transaction rolls back admission and its outbox without sending', async () => {
    const e = await queued();
    const admit = store.admitDispatch.bind(store);
    vi.spyOn(store, 'admitDispatch').mockImplementation(async (...args) => {
      expect(await admit(...args)).toBe(true);
      throw new Error('transaction fails after admission');
    });
    await worker.run(e.id, 'rollback');
    expect(await state(e)).toMatchObject({ state: 'failed', sentAt: null });
    expect(sends).toBe(0);
    expect(
      await rows(
        "SELECT * FROM outbox_events WHERE aggregate_id=? AND event_type='operations.action.state' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.state'))='dispatching'",
        [e.id],
      ),
    ).toHaveLength(0);
  });
  it('recovers crashed dispatch boundary as unknown and never resends/refunds', async () => {
    const e = await queued(),
      lease = await store.claim(e.id, 'crashed');
    await store.transaction(async (c) => store.transition(c, lease!.execution, 'dispatching'));
    await expireLease(e);
    await worker.run(e.id, 'recovery');
    await worker.run(e.id, 'again');
    expect(sends).toBe(0);
    expect((await state(e)).state).toBe('outcome_unknown');
    expect(
      (
        await rows('SELECT status,used_count FROM agent_tool_approvals WHERE id=?', [e.approvalId])
      )[0],
    ).toMatchObject({ status: 'consumed', used_count: 1 });
    expect(
      await rows('SELECT * FROM action_dispatch_locks WHERE execution_id=?', [e.id]),
    ).toHaveLength(2);
  });
  it('lost remote reply is unknown; only pinned original receipt can release it', async () => {
    const e = await queued();
    send = async () => {
      throw new Error('reply lost');
    };
    await worker.run(e.id, 'worker');
    expect((await state(e)).state).toBe('outcome_unknown');
    expect(sends).toBe(1);
    await worker.run(e.id, 'redelivery');
    expect(sends).toBe(1);
    const good = remoteReceipt;
    remoteReceipt = null;
    await expect(worker.reconcile(reviewer, e.id)).rejects.toMatchObject({
      code: 'OPERATIONS_PRECONDITION_FAILED',
    });
    expect((await state(e)).state).toBe('outcome_unknown');
    remoteReceipt = { ...(good as any), operationId: randomUUID() };
    await expect(worker.reconcile(reviewer, e.id)).rejects.toMatchObject({
      code: 'OPERATIONS_PRECONDITION_FAILED',
    });
    expect((await state(e)).state).toBe('outcome_unknown');
    remoteReceipt = good;
    flags.dispatch = false;
    expect((await worker.reconcile(reviewer, e.id)).state).toBe('succeeded');
    expect(sends).toBe(1);
  });
  it.each(['after_intent', 'before_receipt'])(
    'Q09/Q10 actual helper child crash at %s retains SQL approval and locks',
    async (point) => {
      const e = await queued();
      send = async (invocation) => {
        const result = spawnSync('/usr/bin/python3', [
          '-I', new URL('../../../../../scripts/qualification/action-demo-helper-fixture.py', import.meta.url).pathname,
          'scenario', point, invocation.operationId, invocation.planHash,
          invocation.configHash, invocation.toolHash,
        ], { encoding: 'utf8', timeout: 20_000 });
        expect(result.status, result.stderr).toBe(0);
        const actual = JSON.parse(result.stdout);
        expect(actual.restartCount).toBe(point === 'after_intent' ? 0 : 1);
        expect(actual.killed).toBe(true);
        remoteReceipt = actual.receipt;
        throw new Error('actual child terminated at durable barrier');
      };
      await worker.run(e.id, 'barrier-worker');
      expect((await state(e)).state).toBe('outcome_unknown');
      expect(sends).toBe(1);
      await worker.run(e.id, 'fresh-worker');
      expect(sends).toBe(1);
      expect((await worker.reconcile(reviewer, e.id)).state).toBe('outcome_unknown');
      expect(sends).toBe(1);
      expect((await rows('SELECT status,used_count FROM agent_tool_approvals WHERE id=?', [e.approvalId]))[0])
        .toMatchObject({ status: 'consumed', used_count: 1 });
      expect(await rows('SELECT * FROM action_dispatch_locks WHERE execution_id=?', [e.id])).toHaveLength(2);
    },
  );
  it('lost completion persistence stays unknown; fresh worker reads receipt without send', async () => {
    const e = await queued();
    const original = store.transition.bind(store);
    let broken = false;
    store.transition = async (...args) => {
      if (args[2] === 'succeeded' && !broken) {
        broken = true;
        throw new Error('lost commit');
      }
      return original(...args);
    };
    try {
      await worker.run(e.id, 'worker');
    } finally {
      store.transition = original;
    }
    expect((await state(e)).state).toBe('outcome_unknown');
    expect(sends).toBe(1);
    const resumed = new ActionExecutor(
      new ActionExecutionStore(plans, sources, approvals),
      sources,
      adapter,
      new OperationsAuthorization(),
      () => flags,
    );
    expect((await resumed.reconcile(reviewer, e.id)).state).toBe('succeeded');
    expect(sends).toBe(1);
  });
  it.each(['queued', 'preflight'])('cancel %s before send prevents any write', async (window) => {
    const e = await queued();
    if (window === 'queued') await store.cancel(reviewer, e.id);
    else
      preflight = async () => {
        await store.cancel(reviewer, e.id);
      };
    await worker.run(e.id, 'worker');
    expect(sends).toBe(0);
    expect((await state(e)).state).toBe('cancelled');
  });
  it('cancellation after boundary records request and preserves actual success', async () => {
    const e = await queued();
    send = async (i) => {
      const c = await store.cancel(reviewer, e.id);
      expect(c.state).toBe('dispatching');
      return receipt(i);
    };
    await worker.run(e.id, 'worker');
    expect(sends).toBe(1);
    expect(await state(e)).toMatchObject({
      state: 'succeeded',
      cancelRequestedAt: expect.any(String),
    });
  });
  it.each(['author', 'reviewer', 'executor', 'source', 'flag'])(
    'rechecks %s after preflight before dispatch',
    async (kind) => {
      const e = await queued();
      preflight = async () => {
        if (kind === 'author') await sql('UPDATE users SET session_version=2 WHERE id=1');
        if (kind === 'reviewer') await sql('UPDATE users SET session_version=2 WHERE id=2');
        if (kind === 'executor')
          await sql(
            "DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=2 AND p.code='operations:actions:execute'",
          );
        if (kind === 'source')
          await sql('UPDATE investigation_evidence SET expired_at=UTC_TIMESTAMP(3)');
        if (kind === 'flag') flags.dispatch = false;
      };
      await worker.run(e.id, 'worker');
      expect(sends).toBe(0);
      // Reads remain governed by current session; inspect persisted state directly.
      expect((await rows('SELECT state FROM action_executions WHERE id=?', [e.id]))[0].state).toBe(
        'failed',
      );
    },
  );
  it('revocation after send cannot claim cancellation or hide actual completion', async () => {
    const e = await queued();
    send = async (i) => {
      await sql('UPDATE users SET session_version=2 WHERE id=2');
      return receipt(i);
    };
    await worker.run(e.id, 'worker');
    expect(sends).toBe(1);
    expect((await rows('SELECT state FROM action_executions WHERE id=?', [e.id]))[0].state).toBe(
      'succeeded',
    );
    await expect(state(e)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('generic authorization cannot consume an operations approval', async () => {
    const command = await approved();
    const [a] = await rows('SELECT binding_hash FROM agent_tool_approvals WHERE id=?', [
      command.approvalId,
    ]);
    const generic = new AgentToolApprovalExecution(pool as any);
    expect(
      await generic.authorize(
        command.approvalId,
        a.binding_hash,
        1,
        'chat',
        undefined,
        async () => {},
      ),
    ).toMatchObject({ approved: false });
    expect(
      (await rows('SELECT status FROM agent_tool_approvals WHERE id=?', [command.approvalId]))[0]
        .status,
    ).toBe('approved');
  });
  it('queue payload cannot supply actor/token, and repeated workflow delivery sends once', async () => {
    const e = await queued(),
      handle = actionWorkflowHandler(worker, 'workflow');
    const job = {
      id: randomUUID(),
      type: 'operations.action.execute',
      payload: { executionId: e.id },
      attempts: 1,
      maxAttempts: 1,
      fencingToken: 1,
    };
    await expect(
      handle({ ...job, payload: { ...job.payload, actor: reviewer } }),
    ).rejects.toMatchObject({ code: 'OPERATIONS_INPUT_INVALID' });
    await handle(job);
    await handle({ ...job, fencingToken: 2 });
    expect(sends).toBe(1);
    expect((await state(e)).receiptHash).toBe(operationsContentHash(remoteReceipt));
  });
  it('sweeps expired dispatches to unknown with disabled dispatch and retains locks', async () => {
    const e = await queued(),
      lease = await store.claim(e.id, 'crashed');
    await store.transaction((c) => store.transition(c, lease!.execution, 'dispatching'));
    await expireLease(e);
    flags.dispatch = false;
    expect(await store.recoverExpiredDispatches()).toBe(1);
    expect(await store.recoverExpiredDispatches()).toBe(0);
    expect((await state(e)).state).toBe('outcome_unknown');
    expect(sends).toBe(0);
    expect(
      await rows('SELECT * FROM action_dispatch_locks WHERE execution_id=?', [e.id]),
    ).toHaveLength(2);
  });
  it('late worker receipt after lease expiry is unknown until original read-only reconciliation', async () => {
    const e = await queued();
    send = async (i) => {
      await expireLease(e);
      return receipt(i);
    };
    await worker.run(e.id, 'expired');
    expect((await state(e)).state).toBe('outcome_unknown');
    await worker.run(e.id, 'recovery');
    expect(sends).toBe(1);
    expect((await worker.reconcile(reviewer, e.id)).state).toBe('succeeded');
  });
  it('real JWT/HTTP explicit POST queues once; GET, duplicate POST and rejected fields never send', async () => {
    const app = Fastify(),
      key = 'p07-isolated-' + randomUUID();
    await registerActionExecutionRoutes(
      app,
      async (req, reply) => {
        try {
          const claim = jwt.verify(
            String(req.headers.authorization ?? '').replace(/^Bearer /, ''),
            key,
          ) as any;
          req.user = await new ActorContextService().loadInvestigationActorFrom(
            { execute: sql },
            claim.userId,
            'user',
            claim.sessionVersion,
            'p07-http',
          );
        } catch {
          return reply.code(401).send({ reasonCode: 'UNAUTHENTICATED' });
        }
      },
      store,
      worker,
    );
    try {
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const command = await approved();
      const path = '/api/operations/action-plans/' + command.planId + '/versions/1/execute';
      const token = jwt.sign({ userId: 2, sessionVersion: 1 }, key, { expiresIn: '5m' });
      const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + token };
      const body = { approvalId: command.approvalId, requestKey: command.requestKey };
      expect(
        (
          await fetch(base + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(base + path, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...body, actorId: 1 }),
          })
        ).status,
      ).toBe(422);
      const response = await fetch(base + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(202);
      const e = ((await response.json()) as any).execution;
      for (let i = 0; i < 2; i++)
        expect(
          (await fetch(base + '/api/operations/action-executions/' + e.id, { headers })).status,
        ).toBe(200);
      const duplicate = await fetch(base + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      expect(duplicate.status).toBe(202);
      expect(((await duplicate.json()) as any).execution.id).toBe(e.id);
      expect(sends).toBe(0);
      expect(await rows('SELECT * FROM action_executions')).toHaveLength(1);
      expect(
        (
          await fetch(base + '/api/operations/action-executions/' + e.id + '/reconcile', {
            method: 'POST',
            headers,
            body: JSON.stringify({ receipt: { outcome: 'succeeded' } }),
          })
        ).status,
      ).toBe(422);
      await sql('UPDATE users SET session_version=2 WHERE id=2');
      expect(
        (await fetch(base + '/api/operations/action-executions/' + e.id, { headers })).status,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('paused stale worker cannot send after a replacement has completed', async () => {
    const e = await queued();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
        enter = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    let first = true;
    preflight = async () => {
      if (first) {
        first = false;
        enter();
        await gate;
      }
    };
    const old = worker.run(e.id, 'old');
    await entered;
    try {
      await expireLease(e);
      await worker.run(e.id, 'replacement');
    } finally {
      release();
      await old;
    }
    expect(sends).toBe(1);
    expect((await state(e)).state).toBe('succeeded');
  });
  it('requires current execute permission before any remote reconciliation read', async () => {
    const e = await queued();
    send = async () => {
      throw new Error('reply lost');
    };
    await worker.run(e.id, 'worker');
    await sql(
      "DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=2 AND p.code='operations:actions:execute'",
    );
    await expect(worker.reconcile(reviewer, e.id)).rejects.toMatchObject({
      code: 'OPERATIONS_FORBIDDEN',
    });
    expect(receiptReads).toBe(0);
    expect((await state(e)).state).toBe('outcome_unknown');
  });

  // Synthetic principals/data, isolated MySQL, real HTTP + pinned loopback SSH,
  // production adapter and helper disk protocol. Only root/path/config/systemctl
  // are replaced by the existing unprivileged fixture; no VM or systemd action.
  it.each([
    'success', 'lost SSH reply', 'lost SQL completion', 'after_intent', 'before_receipt',
    'cancel before', 'cancel after', 'revoke before', 'revoke after',
  ])('controlled HTTP/SQL/SSH/helper chain: %s', async (fault) => {
    const directory = mkdtempSync(join(tmpdir(), 'max200-chain-'));
    const fixture = new URL('../../../../../scripts/qualification/action-demo-helper-fixture.py', import.meta.url).pathname;
    const helper = new URL('../../../../../scripts/qualification/action-demo-helper.sh', import.meta.url);
    toolHash = createHash('sha256').update(readFileSync(helper)).digest('hex');
    // ssh2 1.17's Ed25519 generator strips leading zero public-key bytes,
    // producing a malformed OpenSSH key for ~1/256 random keys. RSA avoids
    // that generator bug; retain real host pinning and public-key auth below.
    const host = utils.generateKeyPairSync('rsa', { bits: 2048 }), login = utils.generateKeyPairSync('rsa', { bits: 2048 });
    const hostKey = utils.parseKey(host.private), loginKey = utils.parseKey(login.private);
    if (hostKey instanceof Error || loginKey instanceof Error) throw new Error(
      `SSH fixture key parse failed (${process.platform}/${process.version}, ssh2 1.17): ` +
      (hostKey instanceof Error ? hostKey.message : loginKey instanceof Error ? loginKey.message : ''),
    );
    const registration = {
      protocol: 1, serverId: 1, host: '192.168.49.130', port: 22, username: 'slide-action',
      unit: 'slide-action-demo.service', helper: '/usr/local/libexec/slide-action-demo-helper',
      helperHash: toolHash, unitHash: 'e'.repeat(64), toolVersion: '1', eligible: true,
      hostFingerprint: 'SHA256:' + createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, ''),
    };
    targetConfigHash = operationsContentHash(registration);
    const signing = generateKeyPairSync('ed25519'), commands: string[] = [];
    let atInspect: (() => Promise<void>) | undefined, atExecute: (() => Promise<void>) | undefined;
    const server = new Server({ hostKeys: [host.private] }, (client) => {
      client.on('error', () => {});
      client.on('authentication', (ctx) => {
        if (ctx.method === 'publickey' && ctx.username === 'slide-action' &&
            ctx.key.data.equals(loginKey.getPublicSSH()) &&
            (!ctx.signature || loginKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)) ctx.accept();
        else ctx.reject();
      });
      client.on('ready', () => client.on('session', (accept) => {
        accept().on('exec', (accept, reject, info) => {
          const prefix = 'sudo -n -- /usr/local/libexec/slide-action-demo-helper ';
          if (!info.command.startsWith(prefix)) { reject(); return; }
          const channel = accept(), args = info.command.slice(prefix.length).split(' ');
          commands.push(args[0]);
          void (async () => {
            if (args[0] === 'inspect') await atInspect?.();
            if (args[0] === 'execute') await atExecute?.();
            const crash = args[0] === 'execute' && ['after_intent', 'before_receipt'].includes(fault);
            const result = spawnSync('/usr/bin/python3', ['-I', fixture, ...(crash
              ? ['retained-scenario', fault, directory, ...args.slice(1)]
              : ['child', directory, args[0], ... (args.length === 1
                ? [randomUUID(), 'b'.repeat(64), targetConfigHash, toolHash] : args.slice(1))])],
              { encoding: 'utf8', timeout: 20_000 });
            if (result.status !== 0) throw new Error(result.stderr);
            // The helper has already persisted its result when this transport fails.
            if (args[0] === 'execute' && (fault === 'lost SSH reply' || crash)) channel.exit(1);
            else { channel.write(result.stdout); channel.exit(0); }
            channel.end();
          })().catch(() => { channel.exit(1); channel.end(); });
        });
      }));
    });
    const app = Fastify(), jwtKey = 'synthetic-p07-' + randomUUID();
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('fixture address');
      const adapter = new RestartDemoServiceAdapter(registration,
        sign(null, Buffer.from(targetConfigHash), signing.privateKey), signing.publicKey,
        async () => ({ privateKey: login.private }), () => {
          const client = new Client(), connect = client.connect.bind(client);
          // Socket routing only: retain the production host verifier/account/command.
          client.connect = (config) => connect({ ...config, host: '127.0.0.1', port: address.port });
          return client;
        });
      const isolated = new ActionExecutor(store, sources, adapter, new OperationsAuthorization(), () => flags);
      await registerActionExecutionRoutes(app, async (req, reply) => {
        try {
          const claims = jwt.verify(String(req.headers.authorization ?? '').replace(/^Bearer /, ''), jwtKey) as any;
          req.user = await new ActorContextService().loadInvestigationActorFrom(
            { execute: sql }, claims.userId, 'user', claims.sessionVersion, 'synthetic-p07-chain');
        } catch { return reply.code(401).send({ reasonCode: 'UNAUTHENTICATED' }); }
      }, store, isolated);
      const base = await app.listen({ host: '127.0.0.1', port: 0 }), command = await approved();
      const headers = { 'content-type': 'application/json', authorization: 'Bearer ' +
        jwt.sign({ userId: 2, sessionVersion: 1 }, jwtKey, { expiresIn: '5m' }) };
      const url = base + `/api/operations/action-plans/${command.planId}/versions/1/execute`;
      const post = () => fetch(url, { method: 'POST', headers,
        body: JSON.stringify({ approvalId: command.approvalId, requestKey: command.requestKey }) });
      const response = await post();
      expect(response.status).toBe(202);
      const e = ((await response.json()) as any).execution as ExecutionRecord;
      const executionUrl = base + '/api/operations/action-executions/' + e.id;
      const cancel = async () => {
        expect((await fetch(executionUrl + '/cancel', { method: 'POST', headers, body: '{}' })).status).toBe(200);
      };
      const revoke = async () => { await sql('UPDATE users SET session_version=2 WHERE id=2'); };
      if (fault === 'cancel before') atInspect = cancel;
      if (fault === 'cancel after') atExecute = cancel;
      if (fault === 'revoke before') atInspect = revoke;
      if (fault === 'revoke after') atExecute = revoke;
      if (fault === 'lost SQL completion') {
        const transition = store.transition.bind(store);
        vi.spyOn(store, 'transition').mockImplementation(async (...args) => {
          if (args[2] === 'succeeded') throw new Error('isolated completion persistence failure');
          return transition(...args);
        });
      }
      const handle = actionWorkflowHandler(isolated, 'synthetic-chain-worker');
      const job = { id: randomUUID(), type: 'operations.action.execute', payload: { executionId: e.id },
        attempts: 1, maxAttempts: 1, fencingToken: 1 };
      await Promise.all([handle(job), handle(job)]);
      vi.restoreAllMocks();
      const expectedCount = ['cancel before', 'revoke before', 'after_intent'].includes(fault) ? 0 : 1;
      const count = () => existsSync(join(directory, 'actual-restarts')) ? Number(readFileSync(join(directory, 'actual-restarts'), 'utf8')) : 0;
      expect(count()).toBe(expectedCount);
      const unknown = ['lost SSH reply', 'lost SQL completion', 'after_intent', 'before_receipt'].includes(fault);
      const expectedState = unknown ? 'outcome_unknown' : fault === 'cancel before' ? 'cancelled' : fault === 'revoke before' ? 'failed' : 'succeeded';
      const persisted = (await rows('SELECT * FROM action_executions WHERE id=?', [e.id]))[0];
      expect(persisted.state).toBe(expectedState);
      if (fault.startsWith('cancel')) expect(persisted.cancel_requested_at).not.toBeNull();
      expect((await rows('SELECT status,used_count FROM agent_tool_approvals WHERE id=?', [e.approvalId]))[0])
        .toMatchObject({ status: 'consumed', used_count: 1 });
      expect(await rows('SELECT * FROM agent_tool_execution_intents WHERE id=?', [e.id])).toHaveLength(1);
      expect(await rows('SELECT * FROM workflow_jobs')).toHaveLength(1);
      if (unknown) {
        expect(await rows('SELECT * FROM action_dispatch_locks WHERE execution_id=?', [e.id])).toHaveLength(2);
        flags.dispatch = false;
        // A fresh executor restores only by reading the original helper receipt.
        const fresh = new ActionExecutor(new ActionExecutionStore(plans, sources, approvals), sources,
          adapter, new OperationsAuthorization(), () => flags);
        expect((await fresh.reconcile(reviewer, e.id)).state).toBe(
          ['after_intent', 'before_receipt'].includes(fault) ? 'outcome_unknown' : 'succeeded');
      }
      if (fault === 'revoke after') expect((await fetch(executionUrl, { headers })).status).toBe(401);
      if (!fault.startsWith('revoke')) {
        expect((await post()).status).toBe(202);
        expect((await fetch(executionUrl, { headers })).status).toBe(200);
      }
      const sent = commands.filter((c) => c === 'execute').length;
      await handle(job);
      expect(commands.filter((c) => c === 'execute')).toHaveLength(sent);
      expect(sent).toBe(fault.endsWith('before') ? 0 : 1);
      expect(count()).toBe(expectedCount);
    } finally {
      vi.restoreAllMocks();
      await app.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
