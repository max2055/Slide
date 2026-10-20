import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { ActorContextService, type ActorContext } from '../../auth/actor-context.js';
import { productionAccess } from '../../metrics/config/access.js';
import { createConfigurationRegistry } from '../../metrics/config/registry.js';
import { MetricScheduler, type CollectorAccess } from '../../metrics/scheduler/service.js';
import { MysqlScheduleStore } from '../../metrics/scheduler/store.js';
import { MetricFormalization } from '../../metrics/rollout/formalization.js';
import { policyService } from '../../metrics/policy/service.js';
import { MysqlFormalMetricStore } from '../../metrics/rollout/formal-store.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { workflowExecution } from '../../workflows/execution-context.js';
import type { PackageExecution } from '../../metrics/packages/runner.js';
import type { PackageRegistry } from '../../metrics/packages/model.js';
import { InvestigationResultStore, resultEvidenceIds } from '../../investigations/result-schema.js';
import { InvestigationEvidenceStore } from '../../investigations/evidence-store.js';
import { InvestigationAuthorization } from '../../investigations/authorization.js';
import { InvestigationSessionBridge } from '../../investigations/session-bridge.js';
import { operationsContentHash } from '../contracts.js';
import { assertSourceClock, sourceDefinitions, sourceFailure } from './config.js';
import { SourceControl } from './control.js';
import { rejectSourceHttp } from './http-receipt.js';

/** Guard before production services that enumerate the schema. A dedicated
 * configuration import must contain only these two assets and no unrelated jobs. */
export async function assertSourceInventory(pool: Pool, control: Pick<SourceControl, 'config'>) {
  const c = control.config;
  const [servers] = await pool.query<RowDataPacket[]>('SELECT id,host,port,host_key_fingerprint FROM servers');
  const [instances] = await pool.query<RowDataPacket[]>('SELECT id,host,port,db_type FROM database_instances');
  const [networks] = await pool.query<RowDataPacket[]>('SELECT id FROM network_devices LIMIT 1');
  if (servers.length !== 1 || Number(servers[0].id) !== c.serverId || servers[0].host !== c.target.host
    || Number(servers[0].port) !== 22 || servers[0].host_key_fingerprint !== c.target.hostFingerprint
    || instances.length !== 1 || Number(instances[0].id) !== c.instanceId
    || instances[0].host !== c.instanceHost || Number(instances[0].port) !== 3308 || instances[0].db_type !== 'mysql'
    || networks.length) sourceFailure('INVENTORY_ALLOWLIST');
  const [rules] = await pool.query<RowDataPacket[]>('SELECT * FROM alert_rules WHERE enabled=1');
  if (rules.length !== c.alertRules.length || rules.some(r => {
    const expected = c.alertRules.find(rule => rule.id === Number(r.id));
    return !expected || r.metric_name !== expected.metricName || r.operator !== expected.operator
    || Number(r.threshold) !== expected.threshold || Number(r.duration_seconds) !== expected.durationSeconds
    || r.threshold_template !== null || r.threshold_type === 'dynamic'
    || r.target_type !== 'server' || Number(r.server_id) !== c.serverId
    || JSON.stringify(typeof r.notification_channels === 'string' ? JSON.parse(r.notification_channels) : r.notification_channels) !== '[]';
  }))
    sourceFailure('ALERT_RULE_ALLOWLIST');
}

export async function sourceActor(control: SourceControl): Promise<ActorContext> {
  return new ActorContextService().loadInvestigationActorFrom(control.pool as never,
    control.config.actorId, 'user', control.config.sessionVersion, `v23-source:${control.config.operationId}`);
}

/** Fixed read-only UTC probe through the original credential/host-pin resolver.
 * No shell arguments, arbitrary commands or write operations are accepted. */
export async function sourceHostClock(access: CollectorAccess = productionAccess) {
  const resolved = await access.resolve({ type: 'server', id: 3 });
  const transport = await resolved.resolve(resolved.credential_ref, resolved.resource, 'ssh');
  if (transport.method !== 'ssh') return sourceFailure('CLOCK_TRANSPORT');
  const before = Date.now();
  const output = await transport.pool.execCommands(transport.client, ['date -u +%s%3N'], { timeoutMs: 1000, maxOutputBytes: 64 });
  const after = Date.now();
  const value = output[0];
  // Reject unknown SSH result protocols rather than guessing.
  if (!value || value.exitCode !== 0 || value.stderr.trim() || !/^\d{13}\s*$/.test(value.stdout)) sourceFailure('CLOCK_PROTOCOL');
  assertSourceClock(before, after, Number(value.stdout.trim()));
  await resolved.assertCurrent?.();
}

export async function collectSource(control: SourceControl, options: {
  access?: CollectorAccess; packages?: PackageRegistry; collect?: PackageExecution['collect'];
} = {}) {
  const c = control.config, pool = control.pool, packages = options.packages ?? createConfigurationRegistry();
  const refs = [{ type: 'server' as const, id: c.serverId }, { type: 'instance' as const, id: c.instanceId }];
  const store = new MysqlScheduleStore(pool, packages, 'production');
  const formal = new MetricFormalization(pool, packages);
  const access = options.access ?? productionAccess;
  const actor = await sourceActor(control);
  for (const ref of refs) await policyService.assertAccess(actor, ref, true);
  const all = await store.list();
  if (all.length !== 2 || all.some(p => !refs.some(r => r.type === p.binding.resource.type && r.id === p.binding.resource.id)
    || p.binding.revision !== c.revisions[p.binding.resource.type as 'server' | 'instance'])) sourceFailure('POLICY_ALLOWLIST');
  const bounded: CollectorAccess = { resolve: async ref => {
    await control.assertActive();
    await assertSourceInventory(pool, control);
    if (!refs.some(r => r.type === ref.type && r.id === ref.id)) sourceFailure('TARGET_NOT_ALLOWED');
    await policyService.assertAccess(await sourceActor(control), ref, true);
    const result = await access.resolve(ref);
    return { ...result, assertCurrent: async () => {
      await control.assertActive(); await assertSourceInventory(pool, control);
      await policyService.assertAccess(await sourceActor(control), ref, true);
      await result.assertCurrent?.();
    } };
  } };
  const scheduler = new MetricScheduler(store, packages, bounded, Date.now, options.collect, formal);
  const registry = new JobRegistry(); scheduler.register(registry);
  let executed = 0;
  while (executed < c.maxMetricJobs) {
    await control.assertActive();
    // Recheck the complete set before tick(), which reconciles each publication.
    const current = await store.list();
    if (operationsContentHash(current.map(p => p.binding)) !== operationsContentHash(all.map(p => p.binding))) sourceFailure('POLICY_CHANGED');
    await scheduler.tick();
    const [jobs] = await pool.query<RowDataPacket[]>(`SELECT id,payload FROM workflow_jobs WHERE job_type='metrics.collect' AND state='queued' ORDER BY created_at,id LIMIT 13`);
    if (jobs.length > c.maxMetricJobs - executed) sourceFailure('WORK_LIMIT');
    for (const row of jobs) {
      await control.execute(row.id, 'metrics.collect', registry, job => {
        const payload = job.payload as { resource?: { type: string; id: number }; revision?: number };
        const ref = refs.find(r => r.type === payload.resource?.type && r.id === payload.resource.id);
        if (!ref || payload.revision !== c.revisions[ref.type]) sourceFailure('JOB_IDENTITY');
      });
      executed++;
    }
    if (executed < c.maxMetricJobs) await delay(1000, undefined, { signal: control.signal });
  }
  for (const ref of refs) await formal.reconcile(ref, c.revisions[ref.type]);
  return { executed, server: await sourcePublication(pool, c.serverId),
    instance: await sourcePublication(pool, c.instanceId, 'instance') };
}

export async function sourcePublication(pool: Pool, resourceId: number, type: 'server' | 'instance' = 'server') {
  if (await new MysqlFormalMetricStore(pool).sourceState({ type, id: resourceId }) !== 'semantic')
    return { formalPublicationIds: [] as string[], ready: false };
  const [rows] = await pool.execute<RowDataPacket[]>(`SELECT p.observation_id FROM metric_publications p
    JOIN metric_rollout r ON r.series_hash=p.series_hash
    JOIN metric_observations o ON o.id=p.observation_id AND o.series_hash=p.series_hash
    WHERE r.resource_type=? AND r.resource_id=? AND r.source='semantic' AND r.read_mode='semantic'
    AND r.applied_revision=r.published_revision AND p.generation=r.generation
    AND o.stage='normalized' AND o.payload IS NOT NULL
    AND JSON_EXTRACT(o.payload,'$.versions.config_revision')=r.published_revision
    AND p.observed_at>=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 120 SECOND)
    AND p.observed_at<=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 SECOND) LIMIT 101`, [type, String(resourceId)]);
  if (rows.length > 100) sourceFailure('SERIES_LIMIT');
  return { formalPublicationIds: rows.map(r => String(r.observation_id)), ready: rows.length > 0 };
}

export async function evaluateSource(control: SourceControl) {
  const { serverAlertEvaluator } = await import('../../server-alert-evaluator.js');
  const { DatabaseAlertBridge } = await import('../../investigations/alert-bridge.js');
  await control.assertActive();
  await assertSourceInventory(control.pool, control);
  if (!(await sourcePublication(control.pool, control.config.serverId)).ready) sourceFailure('FORMAL_SOURCE_NOT_READY');
  const actor = await sourceActor(control);
  await policyService.assertAccess(actor, { type: 'server', id: control.config.serverId }, true);
  await workflowExecution.run({ signal: control.signal, workerId: control.workerId, fencingToken: 1 },
    () => serverAlertEvaluator.evaluateServerRules(new Map(control.config.alertRules.map(r => [r.id, r.dimensions]))));
  const [alerts] = await control.pool.execute<RowDataPacket[]>(`SELECT * FROM alerts WHERE server_id=?
    AND status IN ('unread','read','acknowledged') ORDER BY id DESC LIMIT 2`, [control.config.serverId]);
  if (alerts.length !== 1) sourceFailure('EXACT_ALERT_REQUIRED');
  const tags = typeof alerts[0].tags === 'string' ? JSON.parse(alerts[0].tags) : alerts[0].tags;
  const rule = control.config.alertRules.find(r => r.id === Number(tags?.rule_id));
  if (!rule || alerts[0].metric_name !== rule.metricName
    || operationsContentHash(tags?.dimensions) !== operationsContentHash(rule.dimensions)
    || !Number.isFinite(Date.parse(tags?.observed_to)) || Date.parse(tags.observed_to) < Date.now() - 120_000
    || Date.parse(tags.observed_to) > Date.now() + 2000) sourceFailure('ALERT_SOURCE_BINDING');
  await control.assertActive();
  // Explicit one-alert invocation of the production event admission lane. No
  // global automatic loop/flag is enabled. Its original service identity,
  // envelope, budget reservation and idempotency checks remain authoritative.
  const contexts = new ActorContextService(() => control.pool as never);
  const authorization = new InvestigationAuthorization(contexts);
  const bridge = new DatabaseAlertBridge(() => control.pool, contexts, authorization,
    new InvestigationSessionBridge(() => control.pool, authorization),
    () => ({ manual: true, opsAuto: true, legacy: false }),
    () => ({ configured: true, serviceUserId: control.config.serviceActorId, instanceIds: [],
      serverIds: [control.config.serverId], policyId: 'server-alert-pilot', policyVersion: 1 }));
  const result = await bridge.dispatch(alerts[0] as never, 'auto', actor,
    async () => sourceFailure('LEGACY_LANE_FORBIDDEN'));
  if (!result.investigationId || !result.requestId) sourceFailure('INVESTIGATION_NOT_ADMITTED');
  const [events] = await control.pool.execute<RowDataPacket[]>(`SELECT e.id FROM operational_events e
    JOIN investigation_event_links l ON l.event_id=e.id WHERE l.investigation_id=?
    AND e.source='server-alert-engine' AND e.source_event_id=? LIMIT 2`, [result.investigationId, `alert:${alerts[0].id}`]);
  if (events.length !== 1) sourceFailure('EXACT_EVENT_REQUIRED');
  return { alertId: Number(alerts[0].id), eventId: events[0].id, investigationId: result.investigationId, requestId: result.requestId };
}

/** Standalone lane: load the same persisted policy and catalog as the API,
 * without starting an Agent, cron, worker or recovering global connections. */
export async function initializeSourceRuntime() {
  const { agentSecurityPolicyService, DEFAULT_AGENT_ID } = await import('../../security/agent-security-policy-service.js');
  const { loadPlatformTools } = await import('../../adapter/get-agent-engine.js');
  await agentSecurityPolicyService.initialize(); // propagate failure; never use a stale/inherited cache on error
  if (agentSecurityPolicyService.get(DEFAULT_AGENT_ID).version < 1) sourceFailure('AGENT_POLICY_REQUIRED');
  await loadPlatformTools();
}

export async function investigateSource(control: SourceControl) {
  await initializeSourceRuntime();
  const { InvestigationExecutor } = await import('../../investigations/executor.js');
  const { createLLMProvider, createActorBoundToolRegistry } = await import('../../adapter/get-agent-engine.js');
  const { investigationBudgetConfiguration } = await import('../../investigations/session-bridge.js');
  const { bindSourceProvider } = await import('./provider.js');
  const { operationsProductBudget } = await import('../product-budget.js');
  const budget = operationsProductBudget(); budget.read(); // never initialize/reset
  const executor = new InvestigationExecutor({ pool: () => control.pool, budget: investigationBudgetConfiguration(),
    // MAX-207 source-only authorization; actual provider capacity remains authoritative.
    contextInputLimit: 100_000,
    toolsForActor: actor => {
      const registry = createActorBoundToolRegistry(actor);
      for (const name of registry.toolNames) {
        const tool = registry.get(name)!;
        const execute = tool.execute.bind(tool);
        tool.execute = async (args, context) => {
          await control.assertActive();
          await initializeSourceRuntime();
          await control.assertActive();
          // The original tool wrapper checks the refreshed policy, including
          // effect/resource constraints, immediately before its handler.
          return execute(args, context);
        };
      }
      return registry;
    },
    providerForPurpose: async purpose => bindSourceProvider(await createLLMProvider(purpose), budget) });
  const c = control.config;
  const [jobs] = await control.pool.execute<RowDataPacket[]>(`SELECT id FROM workflow_jobs WHERE job_type='investigation.execute'
    AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.investigationId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.requestId'))=?`, [c.investigationId, c.requestId]);
  if (jobs.length !== 1) sourceFailure('EXACT_REQUEST_REQUIRED');
  const registry = new JobRegistry();
  registry.register('investigation.execute', async (payload, job, context) => {
    if (payload.investigationId !== c.investigationId || payload.requestId !== c.requestId) sourceFailure('JOB_IDENTITY');
    const run = await executor.execute({ investigationId: c.investigationId!, requestId: c.requestId!, job, context });
    if (run.state !== 'completed') sourceFailure('INVESTIGATION_NOT_COMPLETED');
    await referenceSourceObservations(control, run.id);
    return run;
  });
  await control.execute(jobs[0].id, 'investigation.execute', registry, () => {});
  return exactSource(control);
}

/** New request through the original authenticated admission lane. This phase
 * sends no model/tool work; its separate parent receipt only acknowledges the
 * exact settled partial. A following investigate needs its own config/lock. */
export async function continueSource(control: SourceControl, token: string) {
  const c = control.config;
  if (c.phase !== 'continue' || !control.audit) sourceFailure('PARTIAL_AUDIT_REQUIRED');
  const { verifySourceAudit } = await import('./audit.js');
  const receipt = verifySourceAudit(control.audit, c);
  if (receipt.decision !== 'known_partial_explicit_continuation') return sourceFailure('PARTIAL_AUDIT_REQUIRED');
  const actor = await sourceActor(control);
  const inv = await new InvestigationSessionBridge(() => control.pool).storeFor(actor)
    .detail({ kind: 'user', id: actor.userId }, c.investigationId!);
  await control.assertActive();
  const response = await fetch(`${c.api}/api/investigations/${c.investigationId}/runs`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([control.signal, AbortSignal.timeout(25000)]),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `v23-continuation:${receipt.reviewId}` },
    body: JSON.stringify({ expectedVersion: inv.version,
      message: '显式后续调查：保留原 partial、证据与计量；重新读取当前合法范围，不重放旧请求或假定已恢复。',
      continuationOf: { requestId: receipt.partial.requestId, runId: receipt.partial.runId, resultVersion: receipt.partial.resultVersion, notAfter: c.deadline } }),
  });
  if (response.status !== 202) await rejectSourceHttp(response, 'CONTINUATION_HTTP_REJECTED');
  const accepted = await response.json() as { investigationId: string; requestId: string; jobId: string; version: number };
  if (accepted.investigationId !== c.investigationId || accepted.requestId === c.requestId) sourceFailure('CONTINUATION_BINDING');
  await control.assertActive();
  return accepted;
}

/** The generic runtime summary deliberately has no evidence references. Compose
 * a new version through the original trusted result port, citing only successful
 * canonical tool receipts of this completed request/Run. Never infer root cause,
 * import model claims, or manufacture evidence/observation values. */
async function referenceSourceObservations(control: SourceControl, runId: string) {
  await control.assertActive();
  const c = control.config, pool = control.pool;
  const [requests] = await pool.execute<RowDataPacket[]>(`SELECT actor_id,actor_kind,request_snapshot FROM investigation_requests
    WHERE id=? AND investigation_id=?`, [c.requestId, c.investigationId]);
  if (requests.length !== 1) sourceFailure('EXACT_REQUEST_REQUIRED');
  const request = requests[0], snapshot = typeof request.request_snapshot === 'string'
    ? JSON.parse(request.request_snapshot) : request.request_snapshot;
  if (!snapshot?.authority || !['user', 'service'].includes(request.actor_kind)
    || Number(request.actor_id) !== (request.actor_kind === 'service' ? c.serviceActorId : c.actorId)) sourceFailure('REQUEST_ACTOR_BINDING');
  const live = await new ActorContextService().loadInvestigationActorFrom(pool as never, Number(request.actor_id),
    request.actor_kind, snapshot.authority.sessionVersion);
  const actor = { ...live, resourceBoundary: snapshot.authority.resourceBoundary };
  const store = new InvestigationResultStore(() => pool);
  const [summary] = (await store.list(actor, c.investigationId!, undefined, 1)).items;
  if (!summary || summary.requestId !== c.requestId || summary.runId !== runId) sourceFailure('LATEST_RESULT_REQUIRED');
  const [rows] = await pool.execute<RowDataPacket[]>(`SELECT id FROM investigation_evidence WHERE investigation_id=?
    AND request_id=? AND run_id=? AND source_key LIKE 'canonical-tool:%' ORDER BY id LIMIT 101`, [c.investigationId, c.requestId, runId]);
  if (!rows.length || rows.length > 100) sourceFailure('RESULT_EVIDENCE_REQUIRED');
  const proofs = [];
  for (const row of rows) {
    const proof = await new InvestigationEvidenceStore(() => pool).get(actor, c.investigationId!, row.id, true);
    if (proof.status !== 'available' || (proof.raw as { success?: boolean })?.success !== true)
      sourceFailure('TOOL_OBSERVATION_UNAVAILABLE');
    proofs.push(proof);
  }
  await control.assertActive();
  const binding = { investigationId: c.investigationId!, requestId: c.requestId!, runId };
  await store.transaction(actor, c.investigationId!, async (connection, investigation, current) => {
    await control.assertCommitFence(connection);
    const bound = await store.assertBinding(connection, current, investigation, binding);
    if (bound.run.state !== 'completed') sourceFailure('INVESTIGATION_NOT_COMPLETED');
    await store.putOnConnection(connection, current, investigation, binding,
      `v23-source-observations:${runId}`, summary.version, { ...summary.result,
        facts: proofs.map(proof => ({ statement: `已读取工具回执：${proof.summary}；缺口与unknown保持原状，不证明健康、根因或恢复`, evidenceIds: [proof.id] })) });
    await control.assertCommitFence(connection);
  });
}

export async function exactSource(control: SourceControl) {
  const c = control.config, actor = await sourceActor(control);
  const [result] = (await new InvestigationResultStore(() => control.pool).list(actor, c.investigationId!, undefined, 1)).items;
  if (!result || result.requestId !== c.requestId) sourceFailure('LATEST_RESULT_REQUIRED');
  const ids = resultEvidenceIds(result.result);
  if (!ids.length || ids.length > 100) sourceFailure('RESULT_EVIDENCE_REQUIRED');
  const evidence = [];
  for (const id of ids) {
    const proof = await new InvestigationEvidenceStore(() => control.pool).get(actor, result.investigationId, id);
    if (proof.status !== 'available' || proof.requestId !== result.requestId || proof.runId !== result.runId
      || Date.parse(proof.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(proof.collectedAt))
      || Date.parse(proof.collectedAt) > Date.now() + 2000 || Date.parse(proof.collectedAt) < Date.now() - 120_000
      || proof.observedTo !== null && (Date.parse(proof.observedTo) > Date.now() + 2000 || Date.parse(proof.observedTo) < Date.now() - 120_000)
      || !proof.resources.some(r => r.type === 'server' && r.id === c.serverId))
      sourceFailure('EVIDENCE_BINDING');
    evidence.push({ id, version: 1, hash: proof.contentHash, validUntil: proof.expiresAt });
  }
  return { investigationId: result.investigationId, requestId: result.requestId, runId: result.runId, resultVersion: result.version, evidence };
}

export async function proposeSource(control: SourceControl, token: string,
  recordPlan: (value: unknown) => Promise<void>) {
  const c = control.config, source = await exactSource(control), definitions = sourceDefinitions();
  const probeBefore = Date.now();
  const probe = await fetch(c.api + '/api/health', { redirect: 'error',
    signal: AbortSignal.any([control.signal, AbortSignal.timeout(1000)]) });
  if (!probe.ok) sourceFailure('API_NOT_READY');
  assertSourceClock(probeBefore, Date.now(), Date.parse(probe.headers.get('date') ?? ''));
  const post = async (path: string, body: unknown) => {
    await control.assertActive();
    const response = await fetch(c.api + path, { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([control.signal, AbortSignal.timeout(25_000)]),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) await rejectSourceHttp(response, 'HTTP_REJECTED');
    return response.json() as Promise<any>;
  };
  const { plan } = await post('/api/operations/actions/plans', { content: { schemaVersion: 1,
    investigationId: source.investigationId, resultVersion: source.resultVersion,
    target: { type: 'server', id: c.serverId }, tool: { name: 'restart_demo_service', version: c.target.toolVersion, hash: c.target.helperHash },
    parameters: { unit: c.target.unit }, evidence: source.evidence, relations: [], baselines: [],
    preconditions: [{ kind: 'target_config_hash', expected: operationsContentHash(c.target) }],
    policyVersion: `${definitions.policy.policyVersion}:${definitions.policyHash}`, verifier: definitions.verifier,
    risk: 'medium', impact: '仅专属 slide-action-demo.service；进程内状态不能回滚，真实业务效果待验证',
    rollback: { capability: 'none', description: '停止后续派发并保留原始证据/未知结果；不自动重启或重放' } }, lifetimeMs: 600_000 });
  if (!plan?.id || plan.version !== 1 || plan.contentHash !== operationsContentHash(plan.content)) sourceFailure('PLAN_RESPONSE');
  // The first response must be durably retained even if submit/its ack is lost.
  await recordPlan({ code: 'V23_SOURCE_PLAN_CREATED', planId: plan.id, version: plan.version, contentHash: plan.contentHash });
  const submitted = await post(`/api/operations/actions/plans/${encodeURIComponent(plan.id)}/submit`, { expectedVersion: plan.version });
  const [unsafe] = await control.pool.query<RowDataPacket[]>(`SELECT id FROM action_executions LIMIT 1`);
  const [used] = await control.pool.execute<RowDataPacket[]>(`SELECT id FROM agent_tool_approvals
    WHERE JSON_UNQUOTE(JSON_EXTRACT(args_redacted,'$.planId'))=? AND (used_count<>0 OR status<>'pending') LIMIT 1`, [plan.id]);
  if (unsafe.length || used.length) sourceFailure('DISPATCH_OR_APPROVAL_CONSUMED');
  return { source, plan, submitted, policyHash: definitions.policyHash, verifierHash: definitions.verifierHash };
}
