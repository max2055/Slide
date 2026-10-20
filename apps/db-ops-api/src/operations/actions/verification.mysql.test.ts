/** Synthetic identities/health, real isolated MySQL migrations, JWT, HTTP, approval/once and feedback. No model/VM/production calls. */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { startFeedbackFixture } from '../../investigations/feedback-test-fixture.js';
import { AgentRunService } from '../../adapter/agent-run-service.js';
import { createVerifyToken } from '../../auth-middleware.js';
import { MysqlInvestigationStore } from '../../investigations/store.js';
import { OperationsAuthorization } from '../authorization.js';
import { operationsContentHash, type ActionPlanVersion } from '../contracts.js';
import { PlanStore, PlanSources } from './plan-store.js';
import { ActionPlanService } from './plan-service.js';
import { ActionExecutionStore } from './execution-store.js';
import { ActionExecutor, consumeActionInvocation } from './executor.js';
import {
  ActionEvidenceAdapter,
  type HealthSample,
  type VerificationDefinition,
} from './evidence-adapter.js';
import { ActionVerificationStore } from './verification-store.js';
import { ActionVerificationService } from './verification-service.js';
import {
  registerActionVerificationRoutes,
  verificationWorkflowHandler,
  verifiedActionWorkflowHandler,
} from './verification-handler.js';

const port = Number(process.env.OPERATIONS_TEST_MYSQL_PORT);
describe.skipIf(!port)('P08 B13 isolated functional SQL/JWT/HTTP', () => {
  let f: Awaited<ReturnType<typeof startFeedbackFixture>>, http: Server, healthUrl: string;
  let now: number, mode: string, sends: number, probeCount: number;
  let plans: PlanStore,
    sources: PlanSources,
    approvals: ActionPlanService,
    executions: ActionExecutionStore;
  let executor: ActionExecutor,
    reports: ActionVerificationStore,
    service: ActionVerificationService;
  let owner: typeof f.owner, reviewer: typeof f.owner;
  let onSample: (() => Promise<void>) | undefined;
  const definition: VerificationDefinition = {
    id: 'demo-health',
    version: '1',
    serverId: 101,
    configHash: 'c'.repeat(64),
    helperHash: 'a'.repeat(64),
    unitHash: 'e'.repeat(64),
    hostFingerprint: 'synthetic-pinned-host',
    beforeSeconds: 120,
    readinessSeconds: 60,
    observationSeconds: 300,
    intervalSeconds: 10,
    maxExtraRestarts: 0,
    requireAllHealthy: true,
  };
  const health = (at: number, before = false): HealthSample => ({
    at: new Date(at).toISOString(),
    serverId: 101,
    configHash: definition.configHash,
    helperHash: definition.helperHash,
    unitHash: definition.unitHash,
    hostFingerprint: definition.hostFingerprint,
    invocationId: (before ? '1' : '2').repeat(32),
    active: true,
    running: true,
    mainPid: 123,
    httpStatus: before ? 503 : 200,
    restarts: 0,
  });
  const flags = () => ({
    context: false,
    cases: false,
    baselines: false,
    attention: false,
    plans: true,
    dispatch: true,
  });
  const seed = async () => {
    now = new Date().getTime();
    // Only this synthetic schema: release fixtures left queued by API-negative tests.
    await f.rows('DELETE FROM action_dispatch_locks');
    const created = await f.bridge.create(
      owner,
      {
        idempotencyKey: randomUUID(),
        title: 'P08 synthetic service',
        goal: 'B13 controlled recovery',
        profileId: 'ops',
        profileVersion: 1,
        resources: [{ type: 'server', id: 101, role: 'primary' }],
        context: { subject: { kind: 'resource', resource: { type: 'server', id: 101 } } },
      },
      { message: 'Synthetic read-only investigation', idempotencyKey: randomUUID() },
    );
    const inv = created.investigation,
      requestId = created.acceptance!.requestId;
    await f.rows(
      "INSERT INTO investigation_members (investigation_id,user_id,role,granted_by) VALUES (?,103,'operator',101)",
      [inv.id],
    );
    const [req] = await f.rows('SELECT message_id FROM investigation_requests WHERE id=?', [
      requestId,
    ]);
    const { run } = await new AgentRunService(() => f.pool as never).claim(
      owner.userId,
      inv.sessionId,
      req.message_id,
      `investigation:${requestId}`,
    );
    const binding = { investigationId: inv.id, requestId, runId: run.id };
    const proof = await f.evidence.put(owner, binding, randomUUID(), {
      source: 'synthetic-baseline',
      summary: 'Controlled service failure',
      resources: [{ type: 'server', id: 101 }],
      observedFrom: new Date(now - 120_000).toISOString(),
      observedTo: new Date(now).toISOString(),
      collectedAt: new Date(now).toISOString(),
      raw: { httpStatus: 503 },
    });
    const value = {
      schemaVersion: 2 as const,
      subject: { kind: 'resource' as const, resource: { type: 'server' as const, id: 101 } },
      summary: 'Synthetic source; no product model call',
      facts: [{ statement: 'Controlled unhealthy service', evidenceIds: [proof.id] }],
      hypotheses: [],
      claims: [],
      rootCauseVerification: { status: 'unverified' as const },
      unresolvedQuestions: [],
      recommendations: [],
      problemStatus: 'unconfirmed' as const,
      provenance: {
        modelVersion: 'not-called',
        promptVersion: 'synthetic',
        toolVersions: {},
        runtimeRunId: run.id,
        usageStatus: 'unavailable' as const,
      },
      createdAt: new Date(now).toISOString(),
    };
    const result = await f.results.put(owner, binding, randomUUID(), 0, value);
    await f.rows("UPDATE agent_runs SET state='completed',finished_at=NOW() WHERE id=?", [run.id]);
    await f.rows('UPDATE investigations SET active_request_id=NULL WHERE id=?', [inv.id]);
    const proposal = {
      schemaVersion: 1,
      investigationId: inv.id,
      resultVersion: result.version,
      target: { type: 'server', id: 101 },
      tool: { name: 'restart_demo_service', version: '1', hash: definition.helperHash },
      parameters: { unit: 'slide-action-demo.service' },
      evidence: [
        { id: proof.id, version: 1, hash: proof.contentHash, validUntil: proof.expiresAt },
      ],
      relations: [],
      baselines: [],
      preconditions: [{ kind: 'target_config_hash', expected: definition.configHash }],
      risk: 'medium',
      impact: 'Synthetic isolated service',
      policyVersion: '1',
      verifier: {
        id: definition.id,
        version: definition.version,
        definitionHash: operationsContentHash(definition),
        beforeSeconds: 120,
        readinessSeconds: 60,
        observationSeconds: 300,
        intervalSeconds: 10,
        maxExtraRestarts: 0,
        requireAllHealthy: true,
      },
      rollback: { capability: 'none', description: 'No in-memory rollback' },
    };
    const plan = await approvals.create(owner, proposal),
      ref = { planId: plan.id, expectedVersion: plan.version };
    const approval = await approvals.submit(owner, ref);
    await approvals.review(reviewer, {
      ...ref,
      approvalId: approval.approvalId,
      action: 'approve',
    });
    const execution = await executions.enqueue(reviewer, {
      ...ref,
      approvalId: approval.approvalId,
      requestKey: randomUUID(),
    });
    return { inv, result, proof, binding, value, plan, execution };
  };
  const observe = async (s: Awaited<ReturnType<typeof seed>>) => {
    const first = await service.prepare(reviewer, s.execution.id);
    await executor.run(s.execution.id, 'p08-synthetic');
    const execution = await executions.get(reviewer, s.execution.id);
    // Explicit controllable UTC clock begins from the actual persisted dispatch time.
    now = Date.parse(execution.sentAt!);
    const final = await service.run(reviewer, s.execution.id);
    return { first, final };
  };
  const closeCommand = (
    s: Awaited<ReturnType<typeof seed>>,
    r: Awaited<ReturnType<typeof reports.get>>,
  ) => ({
    resultId: s.result.id,
    resultVersion: s.result.version,
    expectedVersion: r.investigationVersion,
    note: 'Synthetic human fixture decision (not a real operator approval)',
    kind: 'close',
    lifecycle: 'closed',
    problemStatus: 'resolved',
    verification: {
      method: 'Controlled action health window; correlation only',
      from: r.observedFrom!,
      to: r.observedUntil!,
      evidenceIds: [],
      actionReport: { id: r.id, version: r.version, hash: r.contentHash },
    },
  });
  const postClose = (
    s: Awaited<ReturnType<typeof seed>>,
    body: Record<string, unknown>,
    key = randomUUID(),
  ) =>
    f.app.inject({
      method: 'POST',
      url: `/api/investigations/${s.inv.id}/feedback`,
      headers: { authorization: `Bearer ${f.tokens.owner}`, 'idempotency-key': key },
      payload: body,
    });
  beforeAll(async () => {
    f = await startFeedbackFixture(port);
    await f.rows(
      "INSERT INTO servers(id,host,label,os_type,credential_type,credential_encrypted,collection_enabled) VALUES(101,'synthetic.invalid','P08 isolated','Other','key','unused',0)",
    );
    await f.rows(
      "INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT 101,id FROM permissions WHERE code LIKE 'operations:%' OR code IN ('servers:view','servers:manage')",
    );
    http = createServer((_req, res) => {
      probeCount++;
      const sample = health(now);
      if (mode === 'unimproved') sample.httpStatus = 503;
      if (mode === 'deteriorated' && probeCount > 15) sample.restarts = 1;
      if (mode === 'missing' && probeCount === 12) {
        res.writeHead(503).end();
        return;
      }
      if (mode === 'late-ready' && probeCount < 6) sample.httpStatus = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(sample));
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    healthUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    plans = new PlanStore(f.pool as never);
    sources = new PlanSources({
      validate: async (_c, p) => {
        if (p.target.id !== definition.serverId || p.tool.hash !== definition.helperHash)
          throw Error('synthetic environment mismatch');
      },
    });
    approvals = new ActionPlanService(plans, sources, new OperationsAuthorization(), flags);
    executions = new ActionExecutionStore(plans, sources, approvals);
    executor = new ActionExecutor(
      executions,
      sources,
      {
        preflight: async () => {},
        execute: async (i) => {
          consumeActionInvocation(i);
          sends++;
          return {
            protocol: 1,
            operationId: i.operationId,
            planHash: i.planHash,
            configHash: i.configHash,
            helperHash: i.toolHash,
            unit: 'slide-action-demo.service',
            outcome: 'succeeded',
            before: '1'.repeat(32),
            after: '2'.repeat(32),
          };
        },
        receipt: async () => {
          throw Error('No receipt replay');
        },
      },
      new OperationsAuthorization(),
      flags,
    );
    reports = new ActionVerificationStore(plans, sources);
    const adapter = new ActionEvidenceAdapter(definition, {
      history: async (from, _until) =>
        Array.from({ length: 13 }, (_, i) => health(Date.parse(from) + i * 10_000, true)).filter(
          (_s, i) => mode !== 'before-missing' || i !== 3,
        ),
      sample: async () => {
        await onSample?.();
        const response = await fetch(healthUrl);
        return response.json();
      },
    });
    service = new ActionVerificationService(reports, adapter, {
      now: () => now,
      until: async (at) => {
        now = Math.max(now, at);
      },
    });
    await registerActionVerificationRoutes(f.app, createVerifyToken(f.secret, f.contexts), service);
  }, 120_000);
  afterAll(async () => {
    http?.closeAllConnections();
    await new Promise<void>((done) => (http ? http.close(() => done()) : done()));
    await f?.close();
  });
  beforeEach(async () => {
    now = Date.now();
    mode = 'healthy';
    sends = 0;
    probeCount = 0;
    onSample = undefined;
    owner = await f.contexts.loadActiveActor(101);
    reviewer = await f.contexts.loadActiveActor(103);
    vi.spyOn(plans, 'now').mockImplementation(async () => new Date(now));
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await f.rows(
      "INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT 101,id FROM permissions WHERE code LIKE 'operations:%' OR code IN ('servers:view','servers:manage')",
    );
  });
  it('complete immutable report chain, exact 120/60/300/10 windows, independent evidence and human closure/reopen', async () => {
    const s = await seed();
    mode = 'late-ready';
    const { first, final } = await observe(s);
    expect(first.before).toHaveLength(13);
    expect(final.readiness).toHaveLength(6);
    expect(final.observation).toHaveLength(30);
    expect(Date.parse(final.observedFrom!) - Date.parse(final.executionSentAt!)).toBe(60_000);
    expect(Date.parse(final.observedUntil!) - Date.parse(final.observedFrom!)).toBe(300_000);
    expect(final).toMatchObject({
      state: 'passed',
      missingSamples: 0,
      correlationOnly: true,
      planId: s.plan.id,
      planVersion: 1,
      resultVersion: 1,
    });
    expect(sends).toBe(1);
    expect(await reports.get(owner, s.execution.id, 1)).toEqual(first);
    expect((await executions.get(reviewer, s.execution.id)).state).toBe('succeeded');
    expect(
      (await f.rows('SELECT problem_status FROM investigations WHERE id=?', [s.inv.id]))[0]
        .problem_status,
    ).toBe('unconfirmed');
    const key = randomUUID(),
      command = closeCommand(s, final);
    const closed = await postClose(s, command, key);
    expect(closed.statusCode, closed.body).toBe(200);
    expect((await postClose(s, command, key)).json()).toEqual(closed.json());
    const store = new MysqlInvestigationStore(() => f.pool, f.authorization.forActor(owner));
    const reopened = await store.patch({ kind: 'user', id: 101 }, s.inv.id, {
      expectedVersion: closed.json().version,
      lifecycle: 'open',
    });
    expect(reopened.problemStatus).toBe('unconfirmed');
    expect((await postClose(s, { ...command, expectedVersion: reopened.version })).statusCode).toBe(
      400,
    );
    expect((await f.feedback.list(owner, s.inv.id)).items[0].staleVerification).toBe(true);
    expect(sends).toBe(1);
  });
  it.each([
    ['unimproved', 'failed'],
    ['deteriorated', 'failed'],
    ['missing', 'inconclusive'],
    ['before-missing', 'inconclusive'],
  ])('%s never resolves even though execution succeeded', async (scenario, expected) => {
    mode = scenario;
    const s = await seed();
    const { final } = await observe(s);
    expect(final.state).toBe(expected);
    expect(sends).toBe(1);
    // Non-ready reports have no observation window; use a syntactically valid historical window for rejection.
    const command = closeCommand(s, final);
    command.verification.from ??= new Date(now - 60_000).toISOString();
    command.verification.to ??= new Date(now).toISOString();
    expect((await postClose(s, command)).statusCode).toBe(400);
    expect(
      (await f.rows('SELECT problem_status FROM investigations WHERE id=?', [s.inv.id]))[0]
        .problem_status,
    ).toBe('unconfirmed');
  });
  it('rejects registration after dispatch and never fabricates historical observations', async () => {
    const s = await seed();
    await executor.run(s.execution.id, 'p08');
    await expect(service.prepare(reviewer, s.execution.id)).rejects.toThrow(
      'OPERATIONS_PRECONDITION_FAILED',
    );
    expect(sends).toBe(1);
  });
  it('GET has no effects; JWT and server-owned input boundary reject forged samples/verifier', async () => {
    const s = await seed(),
      url = `/api/operations/action-executions/${s.execution.id}/verification`;
    expect((await f.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const headers = { authorization: `Bearer ${f.tokens.owner}` };
    expect((await f.app.inject({ method: 'GET', url, headers })).statusCode).toBe(404);
    expect(
      (await f.app.inject({ method: 'POST', url, headers, payload: { samples: [], verifier: {} } }))
        .statusCode,
    ).toBe(422);
    expect((await f.app.inject({ method: 'POST', url, headers, payload: {} })).statusCode).toBe(
      201,
    );
    expect((await f.app.inject({ method: 'GET', url, headers })).json().verification.version).toBe(
      1,
    );
    expect(sends).toBe(0);
    const p = structuredClone(s.plan);
    (p.content.verifier as any).intervalSeconds = 5;
    const adapter = new ActionEvidenceAdapter(definition, {
      history: async () => [],
      sample: async () => null,
    });
    expect(() => adapter.assertPlan(p as ActionPlanVersion)).toThrow(
      'OPERATIONS_PRECONDITION_FAILED',
    );
  });
  it('rejects cross-investigation, incorrect report hash, old report version and new result references', async () => {
    const s = await seed();
    const { final } = await observe(s);
    now = Date.now();
    const other = await seed();
    now = Date.parse(final.observedUntil!) + 1;
    const command = closeCommand(s, final);
    expect((await postClose(other, { ...command, resultId: other.result.id })).statusCode).toBe(
      404,
    );
    expect(
      (
        await postClose(s, {
          ...command,
          verification: {
            ...command.verification,
            actionReport: { ...command.verification.actionReport, hash: '0'.repeat(64) },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await postClose(s, {
          ...command,
          verification: {
            ...command.verification,
            actionReport: { ...command.verification.actionReport, version: 1 },
          },
        })
      ).statusCode,
    ).toBe(400);
    await f.results.put(owner, s.binding, randomUUID(), 1, {
      ...s.value,
      summary: 'Synthetic follow-up result',
    });
    const [state] = await f.rows('SELECT version FROM investigations WHERE id=?', [s.inv.id]);
    expect(
      (await postClose(s, { ...command, expectedVersion: Number(state.version) })).statusCode,
    ).toBe(409);
  });
  it('rechecks live authority after sampling, blocks revoked reads and makes no additional action sends', async () => {
    const s = await seed();
    await service.prepare(reviewer, s.execution.id);
    await executor.run(s.execution.id, 'p08');
    now = Date.parse((await executions.get(reviewer, s.execution.id)).sentAt!);
    onSample = async () => {
      await f.rows(
        "DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='operations:actions:view'",
      );
    };
    await expect(service.run(reviewer, s.execution.id)).rejects.toThrow('OPERATIONS_NOT_FOUND');
    await expect(reports.get(reviewer, s.execution.id)).rejects.toThrow('OPERATIONS_NOT_FOUND');
    expect(sends).toBe(1);
    expect(
      (
        await f.rows(
          'SELECT MAX(version) AS v FROM action_verification_reports WHERE execution_id=?',
          [s.execution.id],
        )
      )[0].v,
    ).toBe(1);
  });
  it('allows human recovery feedback before closure, retains original report and once consumption', async () => {
    const s = await seed();
    const { final } = await observe(s),
      command = closeCommand(s, final);
    const { lifecycle: _l, problemStatus: _p, ...feedback } = command;
    const recovery = await f.feedback.add(owner, s.inv.id, randomUUID(), {
      ...feedback,
      kind: 'recovery',
    });
    expect(recovery.verification?.actionReport?.hash).toBe(final.contentHash);
    const closed = await postClose(s, { ...command, expectedVersion: recovery.version });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(sends).toBe(1);
  });
  it('checks permission again after waiting and before the target read', async () => {
    const s = await seed();
    await service.prepare(reviewer, s.execution.id);
    await executor.run(s.execution.id, 'p08');
    now = Date.parse((await executions.get(reviewer, s.execution.id)).sentAt!);
    const adapter = new ActionEvidenceAdapter(definition, {
      history: async () => [],
      sample: async () => {
        probeCount++;
        return health(now);
      },
    });
    const revoked = new ActionVerificationService(reports, adapter, {
      now: () => now,
      until: async (at) => {
        now = at;
        await f.rows(
          "DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='operations:actions:view'",
        );
      },
    });
    await expect(revoked.run(reviewer, s.execution.id)).rejects.toThrow('OPERATIONS_NOT_FOUND');
    expect(probeCount).toBe(0);
  });
  it('pre-registration baseline and verifier cannot be amended in a later report version', async () => {
    const s = await seed();
    const first = await service.prepare(reviewer, s.execution.id);
    const { contentHash: _hash, ...changed } = structuredClone(first);
    changed.version++;
    changed.before[0].sample!.httpStatus = 200;
    await expect(plans.transaction((c) => reports.append(c, changed))).rejects.toThrow(
      'OPERATIONS_PRECONDITION_FAILED',
    );
    changed.before = first.before;
    changed.definitionHash = '0'.repeat(64);
    await expect(plans.transaction((c) => reports.append(c, changed))).rejects.toThrow(
      'OPERATIONS_PRECONDITION_FAILED',
    );
    expect(await reports.get(owner, s.execution.id)).toEqual(first);
  });
  it('preserves approved definition bytes and fails closed on report/plan tampering or evidence expiry', async () => {
    const s = await seed();
    const { final } = await observe(s);
    await f.rows('UPDATE investigation_evidence SET expired_at=UTC_TIMESTAMP(3) WHERE id=?', [
      s.proof.id,
    ]);
    expect((await postClose(s, closeCommand(s, final))).statusCode).toBe(400);
    await f.rows(
      "UPDATE action_verification_reports SET conclusion=JSON_SET(conclusion,'$.missingSamples',1) WHERE id=? AND version=?",
      [final.id, final.version],
    );
    await expect(reports.get(owner, final.id)).rejects.toThrow('OPERATIONS_PRECONDITION_FAILED');
  });
  it('wrapper prepares before dispatch, cancellation is inconclusive and duplicate delivery never sends again', async () => {
    const s = await seed();
    const wrapped = verifiedActionWorkflowHandler(service, executor, 'p08', async () => reviewer);
    // Controlled clock follows actual sentAt when observation begins.
    const originalRun = service.run.bind(service);
    vi.spyOn(service, 'run').mockImplementation(async (actor, id) => {
      now = Date.parse((await executions.get(actor, id)).sentAt!);
      return originalRun(actor, id);
    });
    await wrapped({
      type: 'operations.action.execute',
      payload: { executionId: s.execution.id },
    } as any);
    expect((await reports.get(owner, s.execution.id)).state).toBe('passed');
    await wrapped({
      type: 'operations.action.execute',
      payload: { executionId: s.execution.id },
    } as any);
    expect(sends).toBe(1);
    const cancelled = await seed();
    await service.prepare(reviewer, cancelled.execution.id);
    await executions.cancel(reviewer, cancelled.execution.id);
    expect((await originalRun(reviewer, cancelled.execution.id)).state).toBe('inconclusive');
    expect(sends).toBe(1);
  });
  it('missed slots after recovery stay missing; unknown/cancelled executions are never replayed', async () => {
    const s = await seed();
    await service.prepare(reviewer, s.execution.id);
    await executor.run(s.execution.id, 'p08');
    now = Date.parse((await executions.get(reviewer, s.execution.id)).sentAt!) + 25_000;
    const report = await service.run(reviewer, s.execution.id);
    expect(report.state).toBe('inconclusive');
    expect(report.readiness.slice(0, 2).every((s) => s.sample === null)).toBe(true);
    expect(await service.run(reviewer, s.execution.id)).toEqual(report);
    expect(sends).toBe(1);
    const unknown = await seed();
    await service.prepare(reviewer, unknown.execution.id);
    await f.rows("UPDATE action_executions SET state='outcome_unknown' WHERE id=?", [
      unknown.execution.id,
    ]);
    expect((await service.run(reviewer, unknown.execution.id)).state).toBe('inconclusive');
    expect(sends).toBe(1);
    const handler = verificationWorkflowHandler(service, async () => reviewer);
    await expect(
      handler({
        type: 'investigation.execute',
        payload: { executionId: unknown.execution.id },
      } as any),
    ).rejects.toThrow('OPERATIONS_INPUT_INVALID');
  });
});
