import { createRequire } from 'node:module';
import Fastify from 'fastify';
import { vi } from 'vitest';
import { registerInvestigationRoutes } from './routes.js';
import { createVerifyToken } from '../auth-middleware.js';
import { dbConnection } from '../db-connection.js';
import { chatDatabaseService } from '../chat-database-service.js';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { InvestigationExecutor } from './executor.js';
import { MysqlInvestigationBudgetLedger } from './budget-ledger.js';
import { MysqlOperationalEventIngest } from './event-ingest.js';
import { INVESTIGATION_PROFILES } from './profiles.js';
import type { TriggerBinding } from './trigger-policy.js';
import { ToolRegistry, type LLMProvider } from '@slide/agent-core';
import { JobRegistry } from '../workflows/job-registry.js';
import { createInvestigationWorkflowHandler } from './workflow-handler.js';
import { DirectAdapter } from '../adapter/direct-adapter.js';
import { randomUUID } from 'node:crypto';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../migrations/runner.js';
import { ActorContextService, signAccessToken, type ActorContext } from '../auth/actor-context.js';
import { InvestigationAuthorization, provisionInvestigationServiceIdentity } from './authorization.js';
import { InvestigationSessionBridge } from './session-bridge.js';
import { MysqlWorkflowStore } from '../workflows/worker-runtime.js';
import { AgentRunService, type AgentRun } from '../adapter/agent-run-service.js';
import {
  CanonicalStore,
  type InvestigationConnection,
  type InvestigationExecutionBinding,
} from '../adapter/canonical-store.js';

const port = Number(process.env.AGENT_RUN_TEST_MYSQL_PORT);
describe.skipIf(!port)('T04 investigation workflow execution / real MySQL', () => {
  const database = `inv_execution_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool, pool: Pool, canonical: CanonicalStore, contexts: ActorContextService;
  let bridge: InvestigationSessionBridge,
    owner: ActorContext,
    operator: ActorContext,
    viewer: ActorContext,
    service: ActorContext;
  let serviceId: number, roleId: number, binding: InvestigationExecutionBinding, sessionId: string, turnId: string;
  const rows = async (sql: string, values: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, values))[0];
  const tx = async <T>(work: (c: InvestigationConnection) => Promise<T>, lostAck = false): Promise<T> => {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const value = await work(c as unknown as InvestigationConnection);
      await c.commit();
      if (lostAck) throw new Error('LOST_ACK');
      return value;
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  };
  const create = {
    title: 'Investigation facts',
    goal: 'Read current facts',
    profileId: 'ops' as const,
    profileVersion: 1,
    resources: [
      { type: 'instance' as const, id: 101, role: 'primary' as const },
      { type: 'instance' as const, id: 103, role: 'related' as const },
    ],
  };
  async function admit(actor: ActorContext, original: ActorContext = actor) {
    const inv = (await bridge.create(original, create)).investigation;
    if (original.userId !== actor.userId)
      await pool.query(
        "INSERT INTO investigation_members (investigation_id,user_id,role,granted_by,expires_at) VALUES (?, ?, 'operator', ?, NULL)",
        [inv.id, actor.userId, original.userId],
      );
    await pool.query(
      "INSERT INTO investigation_members (investigation_id,user_id,role,granted_by,expires_at) VALUES (?, ?, 'viewer', ?, NULL)",
      [inv.id, viewer.userId, original.userId],
    );
    const accepted = await bridge.admit(actor, {
      investigationId: inv.id,
      expectedVersion: inv.version,
      idempotencyKey: randomUUID(),
      message: 'Inspect',
    });
    const job = await new MysqlWorkflowStore(() => pool as never).claim('canonical-worker', 60, {
      types: ['investigation.execute'],
      exclude: false,
    });
    turnId = (await rows('SELECT message_id FROM investigation_requests WHERE id = ?', [accepted.requestId]))[0]
      .message_id;
    const { run } = await new AgentRunService(() => pool as never).claim(
      actor.userId,
      inv.sessionId,
      turnId,
      `investigation:${accepted.requestId}`,
    );
    sessionId = inv.sessionId;
    binding = {
      investigationId: inv.id,
      requestId: accepted.requestId,
      jobId: job!.id,
      runId: run.id,
      workerId: 'canonical-worker',
      fencingToken: job!.fencingToken,
    };
    return binding;
  }
  beforeAll(async () => {
    const config = {
      host: '127.0.0.1',
      port,
      user: 'root',
      password: process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? '',
      timezone: 'Z',
    };
    admin = mysql.createPool(config);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...config, database, connectionLimit: 12 });
    await new MigrationRunner(pool).run();
    await pool.query(
      "INSERT INTO users (id, username, password_hash) VALUES (101, 'inv-owner', 'no-login'), (102, 'inv-operator', 'no-login'), (104, 'inv-viewer', 'no-login')",
    );
    contexts = new ActorContextService(() => pool as never);
    serviceId = await tx((c) => provisionInvestigationServiceIdentity(c, 'canonical-test'));
    const [role] = await pool.query<mysql.ResultSetHeader>("INSERT INTO roles (name) VALUES ('inv-readonly')");
    roleId = role.insertId;
    await pool.query(
      "INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code IN ('chat:view','instance:view','metric:view','alert:view')",
      [roleId],
    );
    await pool.query(
      "INSERT INTO database_instances (id, name, host, port, username, password_encrypted) VALUES (101, 'one', 'fixture.invalid', 3306, 'fixture', 'unused'), (103, 'two', 'fixture.invalid', 3306, 'fixture', 'unused')",
    );
    canonical = new CanonicalStore(() => pool as never, new InvestigationAuthorization(contexts));
    bridge = new InvestigationSessionBridge(() => pool, new InvestigationAuthorization(contexts));
  }, 60_000);
  beforeEach(async () => {
    await pool.query("UPDATE users SET status='active' WHERE id IN (101,102,104)");
    for (const table of [
      'investigation_event_links',
      'operational_events',
      'investigation_trigger_keys',
      'investigation_trigger_cooldowns',
      'investigation_budget_resources',
      'investigation_budget_ledger',
      'investigation_budget_domains',
      'investigation_admission_keys',
      'investigation_create_keys',
      'investigation_requests',
      'investigation_members',
      'investigation_resources',
      'investigations',
      'agent_canonical_facts',
      'chat_session_shares',
      'chat_messages',
      'agent_runs',
      'chat_sessions',
      'workflow_jobs',
      'outbox_events',
      'instance_permissions',
      'user_roles',
    ])
      await pool.query(`DELETE FROM ${table}`);
    for (const id of [101, 102, 104, serviceId]) {
      await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [id, roleId]);
      for (const instance of [101, 103])
        await pool.query(
          "INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (?, ?, 'read-only')",
          [id, instance],
        );
    }
    const secret = randomUUID();
    owner = await contexts.authenticateAccessToken(
      signAccessToken(await contexts.loadActiveActor(101), secret),
      secret,
    );
    operator = await contexts.loadActiveActor(102);
    viewer = await contexts.loadActiveActor(104);
    service = {
      ...(await tx((c) => contexts.loadInvestigationActorFrom(c, serviceId, 'service', 1))),
      resourceBoundary: { instanceIds: [101, 103], serverIds: [], networkDeviceIds: [] },
    };
    await admit(owner);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  });
  let providerCalls = 0,
    toolCalls = 0;
  const policy = {
    currency: 'USD',
    maxConcurrent: 4,
    manualReserved: 1,
    maxPerResourceConcurrent: 4,
    maxAutomaticRequestsPerHour: 20,
    maxAutomaticTokensPerDay: 256000,
    maxTotalTokensPerDay: 1000000,
    maxCostMicrosPerDay: 10000000,
  };
  function fixture(
    options: {
      beforeProvider?: () => Promise<void>;
      beforeTool?: () => Promise<void>;
      toolCalls?: boolean;
      missingUsage?: boolean;
    } = {},
  ) {
    providerCalls = 0;
    toolCalls = 0;
    const provider: LLMProvider = {
      getDefaultModel: () => 'readonly-fixture',
      getModelCapabilities: () => ({
        model: 'readonly-fixture',
        contextWindowTokens: 32768,
        preferredOutputTokens: 4096,
        source: 'configuration',
        version: 'fixture/v1',
      }),
      chat: async () => {
        providerCalls++;
        await options.beforeProvider?.();
        return {
          content: providerCalls === 1 && options.toolCalls !== false ? null : '事实不足，根因待验证',
          finishReason: providerCalls === 1 && options.toolCalls !== false ? 'tool_calls' : 'stop',
          toolCalls:
            providerCalls === 1 && options.toolCalls !== false
              ? [{ id: 'summary-call', name: 'get_instance_summary', arguments: { instance_id: 101 } }]
              : [],
          hasToolCalls: providerCalls === 1 && options.toolCalls !== false,
          shouldExecuteTools: providerCalls === 1 && options.toolCalls !== false,
          usage: options.missingUsage ? {} : { prompt_tokens: 20, completion_tokens: 10, cached_tokens: 5 },
        };
      },
      chatStream: async () => {
        throw new Error('STREAM_NOT_EXPECTED');
      },
    };
    const tools = new ToolRegistry();
    tools.register({
      name: 'get_instance_summary',
      description: 'Readonly summary',
      parameters: { type: 'object', properties: { instance_id: { type: 'number' } } },
      readOnly: true,
      concurrencySafe: true,
      exclusive: false,
      execute: async () => {
        toolCalls++;
        await options.beforeTool?.();
        return { success: true, rows: [{ health: 'unknown' }], password: 'must-redact' };
      },
    });
    return new InvestigationExecutor({
      pool: () => pool,
      authorization: new InvestigationAuthorization(contexts),
      providerForPurpose: async () => provider,
      toolsForActor: () => tools,
      budget: {
        domain: 'test-investigation',
        policy,
        reserveCostMicros: 1000000,
        prices: { input: 100, cachedInput: 50, output: 200 },
      },
    });
  }
  const execute = (executor: InvestigationExecutor) =>
    executor.execute({
      investigationId: binding.investigationId,
      requestId: binding.requestId,
      job: {
        id: binding.jobId,
        type: 'investigation.execute',
        payload: { investigationId: binding.investigationId, requestId: binding.requestId },
        attempts: 1,
        maxAttempts: 5,
        fencingToken: binding.fencingToken,
      },
      context: { workerId: binding.workerId, fencingToken: binding.fencingToken, signal: new AbortController().signal },
    });
  beforeEach(async () => {
    for (const table of [
      'investigation_budget_resources',
      'investigation_budget_ledger',
      'investigation_budget_domains',
    ])
      await pool.query(`DELETE FROM ${table}`);
  });
  const ledger = () => new MysqlInvestigationBudgetLedger(() => pool, policy);
  async function automatic(reserveTokens = 32000, claim = true) {
    await pool.query("UPDATE workflow_jobs SET state='completed'");
    const trusted: TriggerBinding = {
      source: 't04-receipt-fixture',
      verified: true,
      allowedOrigins: ['collector'],
      policy: {
        id: 'readonly-event',
        version: 1,
        domain: 'test-investigation',
        actor: service,
        profileId: 'ops',
        profileVersion: 1,
        kinds: ['resource.alert'],
        resources: create.resources,
        threshold: 1,
        windowMs: 60000,
        cooldownMs: 60000,
        criticalSingle: true,
        reserveTokens,
        reserveCostMicros: 1000000,
        prices: { input: 100, cachedInput: 50, output: 200 },
      },
    };
    const ingest = new MysqlOperationalEventIngest(
      () => pool,
      trusted,
      ledger(),
      new InvestigationAuthorization(contexts),
    );
    const receipt = await ingest.ingest({
      schemaVersion: 1,
      sourceEventId: randomUUID(),
      kind: 'resource.alert',
      subject: { kind: 'resource', resource: { type: 'instance', id: 101 } },
      occurredAt: new Date().toISOString(),
      severity: 'critical',
      summary: '只读测试事件',
      origin: 'collector',
      stableErrorCode: 'TEST_ALERT',
      callsite: 't04:receipt',
    });
    expect(receipt.disposition).toBe('accepted');
    if (!claim) return (await rows('SELECT * FROM investigation_budget_ledger WHERE request_id=?', [receipt.requestId]))[0];
    const job = await new MysqlWorkflowStore(() => pool as never).claim('canonical-worker', 60, {
      types: ['investigation.execute'],
      exclude: false,
    });
    const request = (await rows('SELECT * FROM investigation_requests WHERE id=?', [receipt.requestId]))[0];
    const inv = (await rows('SELECT * FROM investigations WHERE id=?', [receipt.investigationId]))[0];
    turnId = request.message_id;
    sessionId = inv.session_id;
    const { run } = await new AgentRunService(() => pool as never).claim(
      service.userId,
      sessionId,
      turnId,
      `investigation:${receipt.requestId}`,
    );
    binding = {
      investigationId: inv.id,
      requestId: receipt.requestId!,
      jobId: job!.id,
      runId: run.id,
      workerId: 'canonical-worker',
      fencingToken: job!.fencingToken,
    };
    return (await rows('SELECT * FROM investigation_budget_ledger WHERE request_id=?', [binding.requestId]))[0];
  }
  it('queued cancellation must cancel the unsent admitted receipt through JWT HTTP', async () => {
    const admitted = await automatic(32000, false);
    const request = (await rows('SELECT * FROM investigation_requests WHERE id=?', [admitted.request_id]))[0];
    await pool.query("INSERT INTO investigation_members (investigation_id,user_id,role,granted_by) VALUES (?,?,'operator',?)", [request.investigation_id,owner.userId,serviceId]);
    const secret = randomUUID();
    const app = Fastify();
    await registerInvestigationRoutes(app, createVerifyToken(secret, contexts), bridge);
    try {
      const response = await app.inject({method:'POST',url:`/api/investigations/${request.investigation_id}/requests/${request.id}/cancel`,headers:{authorization:`Bearer ${signAccessToken(owner,secret)}`}});
      expect(response.statusCode, response.body).toBe(202);
      expect((await rows('SELECT state FROM workflow_jobs WHERE id=?', [request.job_id]))[0].state).toBe('cancelled');
      expect(await new MysqlWorkflowStore(() => pool as never).claim('after-cancel',60,{types:['investigation.execute'],exclude:false})).toBeNull();
      expect(await rows('SELECT * FROM agent_runs WHERE idempotency_key=?',[`investigation:${request.id}`])).toEqual([]);
      expect(await ledger().read(admitted.id)).toMatchObject({state:'cancelled',chargedTokens:0,chargedCostMicros:0});
    } finally { await app.close(); }
  });
  it('event admission receipt is reused by actual workflow/executor/Runtime without duplicate allocation or changed prices', async () => {
    const admitted = await automatic();
    const executor = fixture();
    const adapter = new DirectAdapter({
      tools: new ToolRegistry(),
      llmProvider: await (executor as any).options.providerForPurpose('fault_diagnosis'),
    });
    (adapter as any).toolsForActor = (executor as any).options.toolsForActor;
    adapter.configureInvestigationExecutor(executor);
    const registry = new JobRegistry();
    registry.register(
      'investigation.execute',
      createInvestigationWorkflowHandler(async () => adapter),
    );
    const command = childCommand();
    const result = (await registry.executeWithResult(command.job, {
      ...command.context,
      signal: new AbortController().signal,
    })) as AgentRun;
    expect(result.state, JSON.stringify(result.error)).toBe('completed');
    const allocations = await rows(
      'SELECT *, CAST(operation_id AS CHAR) AS operation_id FROM investigation_budget_ledger',
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      id: admitted.id,
      operation_id: `request:${binding.requestId}`,
      state: 'settled',
      charged_tokens: 60,
      charged_cost_micros: 1,
      cost_status: 'known',
    });
    expect(providerCalls).toBe(2);
    expect(toolCalls).toBe(1);
    await execute(executor);
    expect(providerCalls).toBe(2);
    expect(await rows('SELECT *, CAST(operation_id AS CHAR) AS operation_id FROM investigation_budget_ledger')).toEqual(
      allocations,
    );
  });
  it('Runtime refuses provider dispatch when the original receipt cannot fit the prompt', async () => {
    const admitted = await automatic(1);
    const result = await execute(fixture());
    expect(result.state).toBe('partial');
    expect(providerCalls).toBe(0);
    expect(toolCalls).toBe(0);
    const allocations = await rows(
      'SELECT *, CAST(operation_id AS CHAR) AS operation_id FROM investigation_budget_ledger',
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      id: admitted.id,
      reserved_tokens: 1,
      state: 'cancelled',
      charged_tokens: 0,
    });
  });
  it.each(['missing', 'reservation', 'hash', 'domain', 'lane', 'profile', 'resources'])(
    'automatic receipt %s fails closed without replacement allocation',
    async (kind) => {
      const admitted = await automatic();
      const request = (
        await rows('SELECT request_snapshot FROM investigation_requests WHERE id=?', [binding.requestId])
      )[0];
      const snapshot = request.request_snapshot;
      if (kind === 'missing') delete snapshot.budgetReceipt;
      if (kind === 'reservation') snapshot.budgetReceipt.reservationId = randomUUID();
      if (kind === 'hash') snapshot.budgetReceipt.commandHash = 'forged';
      if (kind === 'domain') snapshot.budgetReceipt.domain = 'another-domain';
      if (kind === 'lane') snapshot.budgetReceipt.mode = 'manual';
      if (kind === 'profile') {
        const stored = admitted.reservation_snapshot;
        stored.profile.budget.maxTokens--;
        await pool.query('UPDATE investigation_budget_ledger SET reservation_snapshot=? WHERE id=?', [
          JSON.stringify(stored),
          admitted.id,
        ]);
      }
      if (kind === 'resources')
        await pool.query(
          'UPDATE investigation_resources SET role=role, resource_id=102 WHERE investigation_id=? AND resource_id=103',
          [binding.investigationId],
        );
      await pool.query('UPDATE investigation_requests SET request_snapshot=? WHERE id=?', [
        JSON.stringify(snapshot),
        binding.requestId,
      ]);
      if (kind === 'missing') expect((await execute(fixture())).state).toBe('failed');
      else await expect(execute(fixture())).rejects.toThrow(/^BUDGET_/);
      expect((await rows('SELECT state FROM agent_runs WHERE id=?', [binding.runId]))[0].state).toBe('failed');
      expect(providerCalls).toBe(0);
      expect(toolCalls).toBe(0);
      expect(await rows('SELECT id FROM investigation_budget_ledger')).toEqual([{ id: admitted.id }]);
    },
  );
  it('an already sent receipt without execution checkpoint cannot restart Runtime or refund unknown budget', async () => {
    const admitted = await automatic();
    const first = await ledger().markSent(admitted.id);
    expect(first.dispatchAllowed).toBe(true);
    expect((await ledger().markSent(admitted.id)).dispatchAllowed).toBe(false);
    const executor = fixture();
    expect((await execute(executor)).state).toBe('partial');
    expect(providerCalls).toBe(0);
    expect(toolCalls).toBe(0);
    expect(await ledger().read(admitted.id)).toMatchObject({
      state: 'unknown',
      chargedTokens: 32000,
      chargedCostMicros: 1000000,
    });
    await execute(executor);
    expect(providerCalls).toBe(0);
  });
  it('service request without an admitted receipt never invents an automatic allocation', async () => {
    await pool.query("UPDATE workflow_jobs SET state='completed'");
    await admit(service);
    expect((await execute(fixture())).state).toBe('failed');
    expect(providerCalls).toBe(0);
    expect(toolCalls).toBe(0);
    expect(await rows('SELECT id FROM investigation_budget_ledger')).toEqual([]);
  });
  it.each(['stale', 'expired'])(
    'automatic receipt %s fence prevents any model call or new allocation',
    async (kind) => {
      const admitted = await automatic();
      await pool.query(
        kind === 'stale'
          ? 'UPDATE workflow_jobs SET fencing_token=fencing_token+1 WHERE id=?'
          : 'UPDATE workflow_jobs SET lease_expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE id=?',
        [binding.jobId],
      );
      await expect(execute(fixture())).rejects.toThrow('INVESTIGATION_FENCE_LOST');
      expect(providerCalls).toBe(0);
      expect((await ledger().read(admitted.id)).state).toBe('reserved');
      expect(await rows('SELECT id FROM investigation_budget_ledger')).toEqual([{ id: admitted.id }]);
    },
  );
  it('related scope withdrawal from the original service actor stops admitted Runtime before dispatch', async () => {
    const admitted = await automatic();
    await pool.query('DELETE FROM instance_permissions WHERE user_id=? AND instance_id=103', [serviceId]);
    expect((await execute(fixture())).state).toBe('failed');
    expect(providerCalls).toBe(0);
    expect(toolCalls).toBe(0);
    expect(await rows('SELECT id FROM investigation_budget_ledger')).toEqual([{ id: admitted.id }]);
    expect(await ledger().read(admitted.id)).toMatchObject({
      state: 'cancelled',
      chargedTokens: 0,
      chargedCostMicros: 0,
    });
  });
  it('receipt mutated during tool I/O is revalidated before the next provider intent', async () => {
    await automatic();
    const executor = fixture({
      beforeTool: async () => {
        await pool.query(
          "UPDATE investigation_requests SET request_snapshot=JSON_SET(request_snapshot,'$.budgetReceipt.domain','wrong-domain') WHERE id=?",
          [binding.requestId],
        );
      },
    });
    const result = await execute(executor);
    expect(result.state).toBe('partial');
    expect(providerCalls).toBe(1);
    expect(toolCalls).toBe(1);
    expect(await rows('SELECT id FROM investigation_budget_ledger')).toHaveLength(1);
  });
  it('executor reserve and checkpoint roll back together on a real SQL write failure', async () => {
    await pool.query(
      "CREATE TRIGGER t04_checkpoint_failure BEFORE UPDATE ON agent_runs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='CHECKPOINT_WRITE_FAILURE'",
    );
    try {
      await expect(execute(fixture())).rejects.toThrow();
    } finally {
      await pool.query('DROP TRIGGER t04_checkpoint_failure');
    }
    expect(providerCalls).toBe(0);
    expect(await rows('SELECT id FROM investigation_budget_ledger')).toEqual([]);
    expect(
      (await rows('SELECT request_snapshot FROM investigation_requests WHERE id=?', [binding.requestId]))[0]
        .request_snapshot.budgetReceipt,
    ).toBeUndefined();
    expect((await execute(fixture())).state).toBe('completed');
  });
  it.each(['global', 'resource'])('automatic admission and manual executor share the %s quota', async (kind) => {
    const manual = { ...binding };
    const saved = { ...policy };
    try {
      policy.maxConcurrent = kind === 'global' ? 1 : 4;
      policy.manualReserved = 0;
      policy.maxPerResourceConcurrent = kind === 'resource' ? 1 : 4;
      const admitted = await automatic();
      const auto = { ...binding };
      await pool.query(
        "UPDATE workflow_jobs SET state='running',lease_owner='canonical-worker',lease_expires_at=DATE_ADD(NOW(),INTERVAL 1 MINUTE) WHERE id=?",
        [manual.jobId],
      );
      binding = manual;
      const result = await execute(fixture());
      expect(result.error).toMatchObject({
        reasonCode:
          kind === 'global' ? 'INVESTIGATION_BUDGET_GLOBAL_CONCURRENCY' : 'INVESTIGATION_BUDGET_RESOURCE_CONCURRENCY',
      });
      expect(providerCalls).toBe(0);
      expect(await rows('SELECT id FROM investigation_budget_ledger')).toEqual([{ id: admitted.id }]);
      binding = auto;
      expect((await execute(fixture())).state).toBe('completed');
    } finally {
      Object.assign(policy, saved);
    }
  });
  it('trusted manual request with receipt reuses original token/cost allocation and its request operation', async () => {
    const receipt = await tx((c) =>
      ledger().reserveExecutionInTransaction(c, {
        requestId: binding.requestId,
        domain: 'test-investigation',
        mode: 'manual',
        profile: INVESTIGATION_PROFILES.ops,
        reserveTokens: 32000,
        reserveCostMicros: 1000000,
        prices: { input: 100, cachedInput: 50, output: 200 },
      }),
    );
    expect(receipt.accepted).toBe(true);
    expect((await execute(fixture())).state).toBe('completed');
    expect(
      await rows('SELECT CAST(operation_id AS CHAR) AS operation_id,state FROM investigation_budget_ledger'),
    ).toEqual([{ operation_id: `request:${binding.requestId}`, state: 'settled' }]);
  });
  it('actual Workflow -> adapter -> executor -> Runtime -> durable terminal, original IDs and whole-execution aggregate usage', async () => {
    const executor = fixture();
    const adapter = new DirectAdapter({
      tools: new ToolRegistry(),
      toolsForActor: () => new ToolRegistry(),
      llmProvider: {
        getDefaultModel: () => '',
        chat: async () => {
          throw Error('unused');
        },
        chatStream: async () => {
          throw Error('unused');
        },
      },
    });
    // Use the production adapter entry and its injected, actor-bound runtime ports.
    const runtime = (executor as any).options;
    (adapter as any).provider = await runtime.providerForPurpose('fault_diagnosis');
    (adapter as any).toolsForActor = runtime.toolsForActor;
    adapter.configureInvestigationExecutor(executor);
    const registry = new JobRegistry();
    registry.register(
      'investigation.execute',
      createInvestigationWorkflowHandler(async () => adapter),
    );
    const result = (await registry.executeWithResult(
      {
        id: binding.jobId,
        type: 'investigation.execute',
        payload: { investigationId: binding.investigationId, requestId: binding.requestId },
        attempts: 1,
        maxAttempts: 5,
        fencingToken: binding.fencingToken,
      },
      { workerId: binding.workerId, fencingToken: binding.fencingToken, signal: new AbortController().signal },
    )) as AgentRun;
    expect(result.error).toBeNull();
    expect(result.state).toBe('completed');
    expect(providerCalls).toBe(2);
    expect(toolCalls).toBe(1);
    expect((await rows('SELECT * FROM agent_runs WHERE id=?', [binding.runId]))[0]).toMatchObject({
      state: 'completed',
      actor_id: owner.userId,
      message_id: turnId,
    });
    const history = await rows('SELECT * FROM chat_messages WHERE session_id=? ORDER BY id', [sessionId]);
    expect(history).toHaveLength(2);
    expect(history[1].parent_id).toBe(turnId);
    const facts = await rows('SELECT entry_json FROM agent_canonical_facts');
    expect(facts).toHaveLength(2);
    expect(JSON.stringify(facts)).not.toContain('must-redact');
    const inv = (await rows('SELECT * FROM investigations WHERE id=?', [binding.investigationId]))[0];
    expect(inv).toMatchObject({ active_request_id: null, lifecycle: 'waiting', problem_status: 'unconfirmed' });
    const ledger = (
      await rows('SELECT *, CAST(operation_id AS CHAR) AS operation_id FROM investigation_budget_ledger')
    )[0];
    expect(ledger).toMatchObject({ state: 'settled', charged_tokens: 60, cost_status: 'known' });
    expect(ledger.usage_snapshot).toEqual({ inputTokens: 40, cachedInputTokens: 10, outputTokens: 20 });
    const before = await rows('SELECT * FROM agent_canonical_facts');
    expect((await execute(executor)).state).toBe('completed');
    expect(providerCalls).toBe(2);
    expect(await rows('SELECT * FROM agent_canonical_facts')).toEqual(before);
  });
  it('missing provider usage keeps full allocation unknown, even after durable response completion', async () => {
    const terminal = await execute(fixture({ toolCalls: false, missingUsage: true }));
    expect(terminal.error).toBeNull();
    expect(terminal.state).toBe('completed');
    expect(
      (await rows('SELECT state, charged_tokens, charged_cost_micros FROM investigation_budget_ledger'))[0],
    ).toMatchObject({ state: 'unknown', charged_tokens: 32000, charged_cost_micros: 1000000 });
  });
  it('provider exception after intent never retries and remains partial/unknown without refund', async () => {
    const executor = fixture({
      beforeProvider: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const terminal = await execute(executor);
    expect(terminal.state).toBe('partial');
    expect(providerCalls).toBe(1);
    expect(toolCalls).toBe(0);
    expect((await rows('SELECT state, charged_tokens FROM investigation_budget_ledger'))[0]).toMatchObject({
      state: 'unknown',
      charged_tokens: 32000,
    });
    await execute(executor);
    expect(providerCalls).toBe(1);
  });
  it('withdrawal during provider receipt prevents tools/facts/completion and preserves unknown usage', async () => {
    const executor = fixture({
      beforeProvider: async () => {
        await pool.query('DELETE FROM instance_permissions WHERE user_id=? AND instance_id=103', [owner.userId]);
      },
    });
    expect((await execute(executor)).state).toBe('failed');
    expect(toolCalls).toBe(0);
    expect(await rows('SELECT * FROM agent_canonical_facts')).toHaveLength(0);
    expect((await rows('SELECT state FROM investigation_budget_ledger'))[0].state).toBe('unknown');
  });
  it('cancel during tool I/O produces one cancelled terminal without final assistant or duplicated tool', async () => {
    const executor = fixture({
      beforeTool: async () => {
        await bridge
          .storeFor(owner)
          .cancel({ kind: 'user', id: owner.userId }, binding.investigationId, binding.requestId);
      },
    });
    expect((await execute(executor)).state).toBe('cancelled');
    expect(toolCalls).toBe(1);
    expect(await rows("SELECT * FROM chat_messages WHERE role='assistant'")).toHaveLength(0);
    expect(
      (await rows('SELECT active_request_id FROM investigations WHERE id=?', [binding.investigationId]))[0]
        .active_request_id,
    ).toBeNull();
  });
  it('a stale fence after provider I/O cannot settle usage, append facts or commit terminal', async () => {
    const executor = fixture({
      beforeProvider: async () => {
        await pool.query('UPDATE workflow_jobs SET fencing_token=fencing_token+1,lease_owner=? WHERE id=?', [
          'new-owner',
          binding.jobId,
        ]);
      },
    });
    await expect(execute(executor)).rejects.toThrow('INVESTIGATION_FENCE_LOST');
    expect((await rows('SELECT state FROM agent_runs WHERE id=?', [binding.runId]))[0].state).toBe('running');
    expect(await rows('SELECT * FROM agent_canonical_facts')).toHaveLength(0);
    expect((await rows('SELECT state FROM investigation_budget_ledger'))[0].state).toBe('sent');
  });
  it.each(['operator', 'service'])('%s executes the service Session under original request identity', async (kind) => {
    await pool.query("UPDATE workflow_jobs SET state='completed'");
    const actor = kind === 'operator' ? operator : service;
    await admit(actor, service);
    if (kind === 'service')
      await tx((c) =>
        ledger().reserveExecutionInTransaction(c, {
          requestId: binding.requestId,
          domain: 'test-investigation',
          mode: 'automatic',
          profile: INVESTIGATION_PROFILES.ops,
          reserveTokens: 32000,
          reserveCostMicros: 1000000,
          prices: { input: 100, cachedInput: 50, output: 200 },
        }),
      );
    expect((await execute(fixture())).state).toBe('completed');
    expect((await rows('SELECT user_id FROM chat_sessions WHERE session_id=?', [sessionId]))[0].user_id).toBe(
      serviceId,
    );
    expect((await rows('SELECT actor_id,message_id FROM agent_runs WHERE id=?', [binding.runId]))[0]).toMatchObject({
      actor_id: actor.userId,
      message_id: turnId,
    });
  });
  it('viewer downgrade of the retained operator request denies model and budget dispatch', async () => {
    await pool.query("UPDATE workflow_jobs SET state='completed'");
    await admit(operator, service);
    await pool.query("UPDATE investigation_members SET role='viewer' WHERE investigation_id=? AND user_id=?", [
      binding.investigationId,
      operator.userId,
    ]);
    expect((await execute(fixture())).state).toBe('failed');
    expect(providerCalls).toBe(0);
    expect(toolCalls).toBe(0);
    expect(
      await rows('SELECT *, CAST(operation_id AS CHAR) AS operation_id FROM investigation_budget_ledger'),
    ).toHaveLength(0);
  });
  it.each(['keep', 'revoke'])('global instance grant provenance is restored and remains live: %s', async (mode) => {
    await pool.query("UPDATE workflow_jobs SET state='completed'");
    const [globalRole] = await rows("SELECT id FROM roles WHERE name='admin'");
    await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES (?,?)', [owner.userId, globalRole.id]);
    await pool.query('DELETE FROM instance_permissions WHERE user_id=?', [owner.userId]);
    await admit(await contexts.loadActiveActor(owner.userId));
    if (mode === 'revoke')
      await pool.query('DELETE FROM user_roles WHERE user_id=? AND role_id=?', [owner.userId, globalRole.id]);
    expect((await execute(fixture())).state).toBe(mode === 'keep' ? 'completed' : 'failed');
    expect(providerCalls).toBe(mode === 'keep' ? 2 : 0);
    expect(toolCalls).toBe(mode === 'keep' ? 1 : 0);
  });
  it('budget rejection prevents any model/tool call and releases active request', async () => {
    policy.maxCostMicrosPerDay = 1;
    const executor = fixture();
    policy.maxCostMicrosPerDay = 10000000;
    {
      expect((await execute(executor)).state).toBe('failed');
      expect(providerCalls).toBe(0);
      expect(toolCalls).toBe(0);
      expect(
        await rows('SELECT *, CAST(operation_id AS CHAR) AS operation_id FROM investigation_budget_ledger'),
      ).toHaveLength(0);
      expect(
        (await rows('SELECT active_request_id FROM investigations WHERE id=?', [binding.investigationId]))[0]
          .active_request_id,
      ).toBeNull();
    }
  });
  it.each(['cancel', 'revoke', 'session-version', 'disabled'])(
    '%s before Run creation clears active admission without model/budget dispatch',
    async (mode) => {
      await pool.query('DELETE FROM agent_runs WHERE id=?', [binding.runId]);
      if (mode === 'cancel')
        await bridge
          .storeFor(owner)
          .cancel({ kind: 'user', id: owner.userId }, binding.investigationId, binding.requestId);
      else if (mode === 'session-version')
        await pool.query('UPDATE users SET session_version=session_version+1 WHERE id=?', [owner.userId]);
      else if (mode === 'disabled') await pool.query("UPDATE users SET status='inactive' WHERE id=?", [owner.userId]);
      else await pool.query('DELETE FROM instance_permissions WHERE user_id=? AND instance_id=103', [owner.userId]);
      const terminal = await execute(fixture());
      expect(terminal.state).toBe(mode === 'cancel' ? 'cancelled' : 'failed');
      expect(providerCalls).toBe(0);
      expect(toolCalls).toBe(0);
      expect(
        await rows('SELECT *, CAST(operation_id AS CHAR) AS operation_id FROM investigation_budget_ledger'),
      ).toHaveLength(0);
      expect(
        (await rows('SELECT active_request_id FROM investigations WHERE id=?', [binding.investigationId]))[0]
          .active_request_id,
      ).toBeNull();
    },
  );
  it('same owner/fence coalesces concurrent invocations and never resets provider intent', async () => {
    const executor = fixture();
    const results = await Promise.all([execute(executor), execute(executor), execute(executor)]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.every((r) => r.state === 'completed')).toBe(true);
    expect(providerCalls).toBe(2);
    expect(toolCalls).toBe(1);
  });
  it('another executor with the same fence cannot reset or terminate an active invocation', async () => {
    let release!: () => void, enter!: () => void;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
    const executor = fixture({
      beforeProvider: async () => {
        enter();
        await blocked;
      },
    });
    const first = execute(executor);
    await entered;
    try {
      const other = new InvestigationExecutor((executor as any).options);
      await expect(execute(other)).rejects.toThrow('INVESTIGATION_EXECUTION_ALREADY_RUNNING');
      expect((await rows('SELECT state FROM agent_runs WHERE id=?', [binding.runId]))[0].state).toBe('running');
    } finally {
      release();
      await first;
    }
    expect(providerCalls).toBe(2);
    expect(toolCalls).toBe(1);
  });
  it('ordinary owner completion/cancel race has one terminal and at most one final message', async () => {
    const runs = new AgentRunService(() => pool as never);
    await tx((c) =>
      runs.stageInvestigationCompletion(c, canonical, owner, binding, {
        type: 'complete',
        stopReason: 'completed',
        finalContent: 'staged answer',
      }),
    );
    const results = await Promise.allSettled([
      tx((c) => runs.recoverInvestigationCompletion(c, canonical, owner, binding)),
      bridge.storeFor(owner).cancel({ kind: 'user', id: owner.userId }, binding.investigationId, binding.requestId),
    ]);
    let final = (await rows('SELECT state FROM agent_runs WHERE id=?', [binding.runId]))[0].state;
    if (final === 'running')
      final = (await tx((c) => runs.terminateInvestigation(c, owner, binding, 'cancelled', 'INVESTIGATION_CANCELLED')))
        .state;
    expect(['completed', 'cancelled']).toContain(final);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await rows("SELECT * FROM chat_messages WHERE role='assistant'")).toHaveLength(
      final === 'completed' ? 1 : 0,
    );
    expect(
      (await rows('SELECT active_request_id FROM investigations WHERE id=?', [binding.investigationId]))[0]
        .active_request_id,
    ).toBeNull();
  });
  it('ordinary Chat recovery and cancellation cannot mutate a staged investigation Run', async () => {
    const runs = new AgentRunService(() => pool as never);
    await tx((c) =>
      runs.stageInvestigationCompletion(c, canonical, owner, binding, {
        type: 'complete',
        stopReason: 'completed',
        finalContent: 'staged investigation',
      }),
    );
    const pending = await runs.getForActor(binding.runId, owner.userId, sessionId);
    expect(await runs.pendingCompletions(owner.userId, sessionId)).toEqual([]);
    await expect(runs.recoverCompletion(pending!)).rejects.toThrow('INVESTIGATION_EXECUTION_REQUIRED');
    await expect(runs.recoverCompletion({ ...pending!, idempotencyKey: 'forged-chat-key' })).rejects.toThrow(
      'INVESTIGATION_EXECUTION_REQUIRED',
    );
    await expect(runs.complete(pending!, { type: 'complete', finalContent: 'ordinary answer' })).rejects.toThrow(
      'INVESTIGATION_EXECUTION_REQUIRED',
    );
    expect(await runs.cancelForActor(binding.runId, owner.userId, sessionId)).toBe(false);
    expect(await runs.finish(binding.runId, 'failed')).toBe(false);
    await runs.failUnstagedCompletion(binding.runId);
    expect((await runs.getForActor(binding.runId, owner.userId, sessionId))!.state).toBe('running');
    expect(await rows("SELECT * FROM chat_messages WHERE role='assistant'")).toHaveLength(0);
    await bridge.storeFor(owner).cancel({ kind: 'user', id: owner.userId }, binding.investigationId, binding.requestId);
    expect((await execute(fixture())).state).toBe('cancelled');
    expect(await rows("SELECT * FROM chat_messages WHERE role='assistant'")).toHaveLength(0);
  });
  it('an unbound ordinary Chat key with the investigation prefix retains completion compatibility', async () => {
    const runs = new AgentRunService(() => pool as never),
      chatId = randomUUID();
    await pool.query('INSERT INTO chat_sessions(session_id,user_id,title) VALUES (?,?,?)', [
      chatId,
      owner.userId,
      'Ordinary Chat',
    ]);
    const { run } = await runs.claim(owner.userId, chatId, 'ordinary-turn', `investigation:${randomUUID()}`);
    expect(
      (await runs.complete(run, { type: 'complete', stopReason: 'completed', finalContent: 'ordinary response' }))
        .state,
    ).toBe('completed');
  });
  it.skipIf(process.env.T04_BROWSER_TEST !== '1')(
    'real Chromium closes authenticated HTTP/WS while Workflow keeps executing',
    async () => {
      const require = createRequire(new URL('../../../../frontend/package.json', import.meta.url));
      const { chromium } = require('@playwright/test');
      const browser = await chromium.launch({ headless: true });
      const app = Fastify();
      const secret = randomUUID();
      vi.stubEnv('JWT_SECRET_KEY', secret);
      vi.stubEnv('AGENT_WS_HOST', '127.0.0.1');
      vi.stubEnv('AGENT_WS_PORT', '0');
      vi.stubEnv('SLIDE_MEMORY_PIPELINE_ENABLED', 'false');
      const oldPool = (chatDatabaseService as any).pool;
      vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
      (chatDatabaseService as any).pool = pool;
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const entered = new Promise<void>((r) => {
        started = r;
      });
      const executor = fixture({
        beforeProvider: async () => {
          if (providerCalls === 1) {
            started();
            await gate;
          }
        },
      });
      const runtime = (executor as any).options;
      const adapter = new DirectAdapter({
        tools: runtime.toolsForActor(owner),
        toolsForActor: runtime.toolsForActor,
        llmProvider: await runtime.providerForPurpose('fault_diagnosis'),
        actorContextService: contexts,
        workspace: '.qualification/t04-browser',
      });
      let execution: Promise<unknown> | undefined;
      try {
        await adapter.start();
        const server = (adapter as any).wsServer;
        if (!server.address()) await new Promise<void>((r) => server.once('listening', r));
        const wsPort = server.address().port;
        await registerInvestigationRoutes(app, createVerifyToken(secret, contexts), bridge);
        app.get('/fixture', async (_request, reply) =>
          reply.type('text/html').send('<html><body>调查后台执行测试</body></html>'),
        );
        const url = await app.listen({ host: '127.0.0.1', port: 0 });
        const page = await browser.newPage();
        await page.goto(url + '/fixture');
        const token = signAccessToken(owner, secret);
        await page.evaluate(
          async ({ token, wsPort }) => {
            const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`);
            await new Promise<void>((resolve, reject) => {
              socket.onerror = () => reject(Error('WS_CONNECT'));
              socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token }));
              socket.onmessage = (e) => {
                if (JSON.parse(e.data).type === 'auth_ok') resolve();
              };
            });
            (globalThis as any).socket = socket;
          },
          { token, wsPort },
        );
        await pool.query("UPDATE workflow_jobs SET state='completed'");
        const acceptance = await page.evaluate(
          async ({ token }) => {
            const response = await fetch('/api/investigations', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': 'real-browser',
              },
              body: JSON.stringify({
                title: '浏览器断开调查',
                goal: '只读获取事实，根因待验证',
                profileId: 'ops',
                subject: { kind: 'resource', resource: { type: 'instance', id: 101 } },
                resourceRefs: [{ type: 'instance', id: 101, role: 'primary' }],
              }),
            });
            if (response.status !== 202) throw Error(`HTTP_${response.status}`);
            return response.json();
          },
          { token },
        );
        const job = await new MysqlWorkflowStore(() => pool as never).claim('browser-worker', 60, {
          types: ['investigation.execute'],
          exclude: false,
        });
        adapter.configureInvestigationExecutor(executor);
        const registry = new JobRegistry();
        registry.register(
          'investigation.execute',
          createInvestigationWorkflowHandler(async () => adapter),
        );
        execution = registry.executeWithResult(job!, {
          workerId: 'browser-worker',
          fencingToken: job!.fencingToken,
          signal: new AbortController().signal,
        });
        await entered;
        await browser.close();
        release();
        expect(((await execution) as AgentRun).state).toBe('completed');
        expect(
          (
            await rows('SELECT state FROM agent_runs WHERE idempotency_key=?', [
              `investigation:${acceptance.requestId}`,
            ])
          )[0].state,
        ).toBe('completed');
        expect(toolCalls).toBe(1);
      } finally {
        release();
        await execution?.catch(() => {});
        await browser.close();
        await adapter.dispose();
        await app.close();
        (chatDatabaseService as any).pool = oldPool;
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    },
    30000,
  );
  const childCommand = () => ({
    investigationId: binding.investigationId,
    requestId: binding.requestId,
    job: {
      id: binding.jobId,
      type: 'investigation.execute',
      payload: { investigationId: binding.investigationId, requestId: binding.requestId },
      attempts: 1,
      maxAttempts: 5,
      fencingToken: binding.fencingToken,
    },
    context: { workerId: binding.workerId, fencingToken: binding.fencingToken },
  });
  async function child(crash?: string) {
    const worker = fork(fileURLToPath(new URL('./execution-recovery-child.ts', import.meta.url)), [], {
      execArgv: ['--import', import.meta.resolve('tsx')],
      silent: true,
      env: {
        ...process.env,
        T04_CHILD_DATABASE: database,
        T04_CHILD_COMMAND: JSON.stringify(childCommand()),
        ...(crash ? { T04_CHILD_CRASH: crash } : { T04_CHILD_CRASH: '' }),
      },
    });
    const messages: any[] = [];
    let diagnostic = '';
    worker.stdout?.on('data', (data) => {
      diagnostic += data;
    });
    worker.stderr?.on('data', (data) => {
      diagnostic += data;
    });
    const result = await new Promise<{ messages: any[]; exitCode: number | null; signal: string | null }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          worker.kill('SIGKILL');
          reject(Error(`CHILD_TIMEOUT ${diagnostic}`));
        }, 15000);
        worker.on('message', (message: any) => {
          messages.push(message);
          if (crash && message.point === crash) worker.kill('SIGKILL');
        });
        worker.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        worker.once('exit', (exitCode, signal) => {
          clearTimeout(timeout);
          if (!crash && exitCode !== 0) reject(Error(`CHILD_FAILED ${JSON.stringify(messages)} ${diagnostic}`));
          else resolve({ messages, exitCode, signal });
        });
      },
    );
    return result;
  }
  it.each(
    [
      'provider-before',
      'provider-intent',
      'provider-after',
      'provider-received',
      'tool-before',
      'tool-after',
      'final-candidate',
      'response-ready',
      'staging-after',
    ].flatMap(
      (point) =>
        [
          ['manual', point],
          ['automatic', point],
        ] as const,
    ),
  )(
    'real OS SIGKILL %s %s and new worker recovery do not replay sent unknown or durable tool/message',
    async (lane, point) => {
      const admitted = lane === 'automatic' ? await automatic() : undefined;
      const first = await child(point);
      expect(first.signal).toBe('SIGKILL');
      expect(first.messages.some((m) => m.point === point)).toBe(true);
      await pool.query('UPDATE workflow_jobs SET lease_expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE id=?', [
        binding.jobId,
      ]);
      const next = await new MysqlWorkflowStore(() => pool as never).claim('recovery-worker', 60, {
        types: ['investigation.execute'],
        exclude: false,
      });
      expect(next!.id).toBe(binding.jobId);
      expect(next!.fencingToken).toBeGreaterThan(binding.fencingToken);
      binding = { ...binding, workerId: 'recovery-worker', fencingToken: next!.fencingToken };
      const second = await child();
      const expected = [
        'provider-intent',
        'provider-after',
        'provider-received',
        'tool-before',
        'final-candidate',
      ].includes(point)
        ? 'partial'
        : 'completed';
      expect(second.messages.find((m) => m.terminal)?.terminal, JSON.stringify(second.messages)).toBe(expected);
      const calls = [...first.messages, ...second.messages];
      expect(calls.filter((m) => m.toolCall)).toHaveLength(
        ['provider-intent', 'provider-after', 'provider-received'].includes(point) ? 0 : 1,
      );
      expect(calls.filter((m) => m.providerCall)).toHaveLength(
        point === 'provider-intent'
          ? 0
          : ['provider-after', 'provider-received', 'tool-before'].includes(point)
            ? 1
            : 2,
      );
      const stored = (await rows('SELECT * FROM agent_runs WHERE id=?', [binding.runId]))[0];
      expect(stored.state).toBe(expected);
      const facts = await rows('SELECT * FROM agent_canonical_facts');
      expect(new Set(facts.map((f) => f.message_id)).size).toBe(facts.length);
      expect(await rows("SELECT * FROM chat_messages WHERE role='assistant'")).toHaveLength(
        expected === 'completed' ? 1 : 0,
      );
      const ledger = (
        await rows('SELECT *, CAST(operation_id AS CHAR) AS operation_id FROM investigation_budget_ledger')
      )[0];
      expect(ledger.state).toBe(expected === 'completed' ? 'settled' : 'unknown');
      expect(await rows('SELECT id FROM investigation_budget_ledger')).toHaveLength(1);
      if (admitted) expect(ledger.id).toBe(admitted.id);
      if (expected === 'partial') expect(Number(ledger.charged_tokens)).toBe(32000);
      const replay = await child();
      expect(replay.messages.some((m) => m.providerCall || m.toolCall)).toBe(false);
    },
    30000,
  );
});
