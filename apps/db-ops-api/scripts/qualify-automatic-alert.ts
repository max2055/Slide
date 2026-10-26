/** Explicit MAX-225 qualification. Shared configuration is SELECT-only; all
 * alert/policy/admission writes use a disposable formal MySQL schema. The
 * real-provider segment only runs with MAX225_REAL_MODEL=authorized and a
 * parent ledger it can reserve into before every send. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { parse } from 'dotenv';
import { ToolRegistry, type LLMProvider } from '@slide/agent-core';
import { DirectAdapter } from '../src/adapter/direct-adapter.js';
import { createConfiguredAgentProvider } from '../src/adapter/llm-provider-factory.js';
import { bridgeTestFixture } from '../src/investigations/bridge-test-fixture.js';
import { investigationBudgetConfiguration } from '../src/investigations/session-bridge.js';
import { investigationRuntimeConfiguration } from '../src/investigations/runtime-configuration.js';
import { InvestigationExecutor } from '../src/investigations/executor.js';
import { createInvestigationWorkflowHandler } from '../src/investigations/workflow-handler.js';
import { dbConnection, decryptData } from '../src/db-connection.js';
import { llmDatabaseService } from '../src/llm-database-service.js';
import { createAssetCollectorAccess } from '../src/metrics/config/access.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { runPackage } from '../src/metrics/packages/runner.js';
import { policyService } from '../src/metrics/policy/service.js';
import { MysqlPolicyStore } from '../src/metrics/policy/store.js';
import { admin } from '../src/metrics/policy/test-support.js';
import { RolloutControl } from '../src/metrics/rollout/control.js';
import { serverAlertEvaluator } from '../src/server-alert-evaluator.js';
import { getResourceObservationsTool } from '../src/tools/generated/slide-self-mgmt/resource_tools.js';
import { getServerAlertsTool } from '../src/tools/generated/slide-self-mgmt/server_tools.js';
import { JobRegistry } from '../src/workflows/job-registry.js';
import { MysqlWorkflowStore } from '../src/workflows/worker-runtime.js';
import sshSessionPool from '../src/ssh-session-pool.js';

assert(process.env.MAX225_CONFIG_ENV && process.env.MAX225_EVIDENCE, 'EXPLICIT_QUALIFICATION_PATHS_REQUIRED');
const env = parse(readFileSync(process.env.MAX225_CONFIG_ENV));
process.env.ENCRYPTION_KEY = env.ENCRYPTION_KEY;
const shared = mysql.createPool({host:env.DB_HOST,port:Number(env.DB_PORT??3306),user:env.DB_USER,password:env.DB_PASSWORD,database:env.DB_NAME});
const evidence: any = {schemaVersion:1, qualification:'MAX-225', startedAt:new Date().toISOString(), sharedWrites:0, modelRequests:0, samples:[]};
const originalPool = dbConnection.getPool, originalIsConnected = dbConnection.isConnected;
let f: Awaited<ReturnType<typeof bridgeTestFixture>> | undefined;

// ── Optional real-provider segment ─────────────────────────────────────────
// The parent ledger is the single accounting source. A send is only allowed
// after its reservation is written and read back; provider usage settles it.
const MODEL_LEDGER_KEY = 'model_test_budget_ledger';
const modelAuthorized = process.env.MAX225_REAL_MODEL === 'authorized';
let modelDiagnostics: unknown;
type Fixture = Awaited<ReturnType<typeof bridgeTestFixture>>;
function ledger(...args: string[]): string {
  return execFileSync(process.env.MAX225_MULTICA_BIN ?? 'multica', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function readBudget(): any {
  const parent = process.env.MAX225_PARENT_ISSUE!;
  const stored = JSON.parse(ledger('issue', 'metadata', 'get', parent, '--key', MODEL_LEDGER_KEY, '--output', 'json'));
  const value = typeof stored === 'string' ? JSON.parse(stored) : stored;
  assert.equal(value.parent_issue_id, parent, 'LEDGER_PARENT_MISMATCH');
  return value;
}
function writeBudget(value: any): any {
  const parent = process.env.MAX225_PARENT_ISSUE!;
  ledger('issue', 'metadata', 'set', parent, '--key', MODEL_LEDGER_KEY, '--value', JSON.stringify(value), '--type', 'string', '--output', 'json');
  return readBudget();
}
// Cache tokens are a subset of input; they are reported, never added again.
const ledgerTotal = (value: any) => value.settled.total_tokens
  + value.reservations.reduce((sum: number, r: any) => sum + r.reserved_tokens, 0)
  + value.unknown_requests.reduce((sum: number, r: any) => sum + r.reserved_tokens, 0);
function reserveBeforeSend(input: { scenario: string; inputBound: number; outputCeiling: number }): any {
  const value = readBudget();
  const reserved = input.inputBound + input.outputCeiling;
  assert(ledgerTotal(value) + reserved <= value.limit_tokens, 'MODEL_BUDGET_EXHAUSTED');
  // The parent map shares an 8KB ceiling; keep records to fields that are
  // needed to audit or settle this exact send.
  const reservation = { id: randomUUID(), issue: 'MAX-225', scenario: input.scenario,
    input_bound_tokens: input.inputBound, output_ceiling_tokens: input.outputCeiling,
    reserved_tokens: reserved, at: new Date().toISOString() };
  value.reservations.push(reservation);
  value.revision += 1;
  const persisted = writeBudget(value);
  assert(persisted.reservations.some((r: any) => r.id === reservation.id), 'MODEL_RESERVATION_NOT_DURABLE');
  assert(ledgerTotal(persisted) <= persisted.limit_tokens, 'MODEL_BUDGET_EXHAUSTED');
  return reservation;
}
function settleReservation(reservation: any, usage: any, reason?: string): any {
  const value = readBudget();
  const index = value.reservations.findIndex((r: any) => r.id === reservation.id);
  assert(index >= 0, 'MODEL_RESERVATION_LOST');
  value.reservations.splice(index, 1);
  if (usage) {
    value.settled.input_tokens += usage.inputTokens;
    value.settled.cached_input_tokens += usage.cachedInputTokens;
    value.settled.output_tokens += usage.outputTokens;
    value.settled.total_tokens = value.settled.input_tokens + value.settled.output_tokens;
    value.events.push({ k: 's', id: reservation.id, sc: reservation.scenario,
      in: usage.inputTokens, c: usage.cachedInputTokens, o: usage.outputTokens, q: usage.requestId });
  } else {
    // Unknown transport/usage keeps the full reservation and is never replayed.
    value.unknown_requests.push({ id: reservation.id, reserved_tokens: reservation.reserved_tokens,
      reason: reason ?? 'MODEL_USAGE_UNKNOWN', at: new Date().toISOString() });
    value.events.push({ k: 'u', id: reservation.id, sc: reservation.scenario, reason: reason ?? 'MODEL_USAGE_UNKNOWN' });
  }
  value.revision += 1;
  const persisted = writeBudget(value);
  assert(!persisted.reservations.some((r: any) => r.id === reservation.id), 'MODEL_SETTLEMENT_NOT_DURABLE');
  return persisted;
}

/** Executes the already-admitted alert investigation through the real executor
 * and the configured DeepSeek route. Every send is reserved in the parent
 * ledger first; nothing here changes shared configuration. */
async function runRealModelSegment(fixture: Fixture, alertId: number, alertRequestId: string) {
  assert(process.env.MAX225_PARENT_ISSUE && process.env.MAX225_REAL_MODEL === 'authorized', 'MODEL_SEGMENT_UNAUTHORIZED');
  const select = { execute: async (sql: string, values?: any[]) => {
    assert(/^SELECT\s/i.test(sql), 'SHARED_WRITE_FORBIDDEN');
    return shared.execute(sql, values);
  } };
  const stored = (await llmDatabaseService.getAllProviders(select as never)).find(p => p.enabled && p.is_default);
  assert(stored?.name === 'deepseek' && stored.default_model === 'deepseek-flash'
    && stored.api_base_url === 'https://api.deepseek.com/v1' && stored.api_format === 'openai-completions'
    && stored.supports_function_call && stored.api_key_encrypted, 'MODEL_PROVIDER_CONFIGURATION_CHANGED');
  const bindings = await llmDatabaseService.getSceneBindings(select as never);
  assert.equal(bindings.length, 0, 'MODEL_SCENE_CONFIGURATION_CHANGED');
  const key = decryptData(stored.api_key_encrypted!); // memory only, never recorded
  const ceiling = Math.min(stored.max_tokens!, 4096);
  assert(Number.isSafeInteger(ceiling) && ceiling > 0, 'MODEL_OUTPUT_CEILING_INVALID');
  const prices = { input: Math.ceil(stored.input_cost_per_1k * 1_000_000_000),
    cachedInput: Math.ceil(stored.input_cost_per_1k * 1_000_000_000),
    output: Math.ceil(stored.output_cost_per_1k * 1_000_000_000) };
  assert(prices.input > 0 && prices.output > 0, 'MODEL_PRICES_INVALID');
  const raw = await createConfiguredAgentProvider({ getAllProviders: async () => [stored],
    getSceneBindings: async () => bindings, getProviderApiKey: async name => { assert.equal(name, stored.name); return key; } },
    'fault_diagnosis', true, false);
  assert.equal(raw.getDefaultModel(), 'deepseek-flash');
  const sends: any[] = [];
  let stop = false;
  const client = (raw as unknown as { client: { fetch: typeof fetch; maxRetries: number } }).client;
  assert.equal(client.maxRetries, 0);
  const originalFetch = client.fetch;
  client.fetch = async (input, init) => {
    assert(!stop, 'MODEL_SEGMENT_STOPPED');
    const request = new Request(input, init);
    const bodyText = await request.clone().text();
    const body = JSON.parse(bodyText) as { model: string; max_tokens: number; stream?: boolean };
    assert.equal(request.url, 'https://api.deepseek.com/v1/chat/completions', 'MODEL_ENDPOINT_CHANGED');
    assert.equal(request.method, 'POST', 'MODEL_METHOD_CHANGED');
    assert.equal(body.model, 'deepseek-flash', 'MODEL_NAME_CHANGED');
    assert(!body.stream, 'MODEL_STREAM_NOT_AUTHORIZED');
    assert(!bodyText.includes(key), 'MODEL_SECRET_IN_BODY');
    assert(Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 && body.max_tokens <= ceiling, 'MODEL_OUTPUT_CEILING');
    // UTF-8 bytes are never fewer than BPE tokens; 1024 covers the chat
    // template and role framing, so this bound is an upper bound.
    const inputBound = Buffer.byteLength(bodyText) + 1024;
    let reservation: any;
    try {
      reservation = reserveBeforeSend({ scenario: `investigation-send-${sends.length + 1}`, inputBound, outputCeiling: body.max_tokens });
    } catch (error) {
      // No send without a durable reservation; surface it without masking the
      // cause behind the SDK's generic transport error.
      stop = true;
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message) ? error.message : 'LEDGER_WRITE_FAILED';
      throw Error(`MODEL_LEDGER_RESERVE_FAILED_${code}`);
    }
    const record: any = { sequence: sends.length + 1, requestHash: createHash('sha256').update(bodyText).digest('hex'),
      requestBytes: Buffer.byteLength(bodyText), inputBoundTokens: inputBound, outputCeilingTokens: body.max_tokens,
      reservedTokens: reservation.reserved_tokens, tools: (body as any).tools?.map((t: any) => t.function?.name) ?? [] };
    sends.push(record);
    let response: Response;
    try {
      response = await originalFetch(input, { ...init, redirect: 'error' });
    } catch (error) {
      stop = true;
      record.transport = 'error';
      settleReservation(reservation, null, 'MODEL_TRANSPORT_UNKNOWN');
      throw error;
    }
    if (!response.ok) {
      stop = true;
      record.providerStatus = response.status;
      settleReservation(reservation, null, `PROVIDER_HTTP_${response.status}`);
      throw Error(`PROVIDER_HTTP_${response.status}`);
    }
    const payload = (await response.clone().json()) as any;
    const usage = payload?.usage && Number.isSafeInteger(payload.usage.prompt_tokens) && Number.isSafeInteger(payload.usage.completion_tokens)
      ? { inputTokens: payload.usage.prompt_tokens,
        cachedInputTokens: payload.usage.prompt_cache_hit_tokens ?? payload.usage.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: payload.usage.completion_tokens,
        requestId: response.headers.get('x-request-id') ?? (typeof payload.id === 'string' ? payload.id : null) } : null;
    record.providerStatus = response.status;
    record.usage = payload?.usage ?? null;
    record.finishReason = payload?.choices?.[0]?.finish_reason ?? null;
    if (!usage) {
      stop = true;
      settleReservation(reservation, null, 'MODEL_USAGE_UNREPORTED');
      throw Error('MODEL_USAGE_UNREPORTED');
    }
    record.settled = settleReservation(reservation, usage);
    record.requestId = usage.requestId;
    if (!['stop', 'tool_calls'].includes(record.finishReason)) {
      stop = true;
      throw Error('MODEL_PROTOCOL_UNEXPECTED');
    }
    return response;
  };
  const chat = raw.chat.bind(raw);
  const provider: LLMProvider = {
    getDefaultModel: () => raw.getDefaultModel(),
    getModelCapabilities: raw.getModelCapabilities?.bind(raw),
    countPromptTokens: raw.countPromptTokens?.bind(raw),
    projectMessages: raw.projectMessages?.bind(raw),
    chat: (messages, tools, options) => chat(messages, tools, { ...options, maxTokens: Math.min(options?.maxTokens ?? ceiling, ceiling) }),
    chatStream: async () => { throw Error('MODEL_STREAM_NOT_AUTHORIZED'); },
  };

  // The executor hands us the frozen service actor; tool handlers need it as
  // their execution context, which the runtime does not pass through itself.
  const toolsFrom = (toolActor: { userId: number } & Record<string, unknown>) => {
    const registry = new ToolRegistry();
    for (const tool of [getResourceObservationsTool, getServerAlertsTool])
      registry.register({ name: tool.name, description: tool.description, parameters: tool.parameters as any,
        readOnly: true, concurrencySafe: true, exclusive: false,
        execute: async (args: Record<string, unknown>) => tool.handler(args, { actor: toolActor } as never) });
    return registry;
  };
  const probeActor = await fixture.contexts.loadInvestigationActorFrom(fixture.pool as never, fixture.serviceId, 'service', 1);
  const registry = toolsFrom(probeActor as never);

  // Fail before any model send if the read-only evidence path cannot see the
  // real admitted alert and its observation.
  const [alertRow] = (await fixture.pool.query<any[]>('SELECT id,server_id,metric_value,tags FROM alerts WHERE id=?', [alertId]))[0];
  assert(alertRow?.server_id, 'MODEL_ALERT_MISSING');
  const preflight: any = {};
  for (const [name, args] of [['get_resource_observations', { resourceType: 'server', resourceId: alertRow.server_id, limit: 4 }],
    ['get_server_alerts', { serverId: alertRow.server_id, activeOnly: false }]] as const) {
    preflight[name] = await registry.get(name)!.execute(args as any, {} as never);
    assert((preflight[name] as any)?.success !== false, `MODEL_TOOL_PREFLIGHT_FAILED_${name}`);
  }
  const alertValue = Number(alertRow.metric_value);
  const preflightSummary = { observations: (preflight.get_resource_observations as any)?.data?.observations?.map((o: any) => ({
    metricId: o.metricId, value: o.value, observedAt: o.observedAt, quality: o.quality, reason: o.reason })),
    alerts: ((preflight.get_server_alerts as any)?.data?.alerts ?? (preflight.get_server_alerts as any)?.data ?? []).slice?.(0, 3) };
  modelDiagnostics = { stage: 'tool_preflight', preflight: preflightSummary, alertId, alertRequestId };
  // The cited evidence must be this run's real reading, not any stale or
  // synthetic value: compare against the alert's own recorded metric value.
  assert(Number.isFinite(alertValue) && preflightSummary.observations?.some(
    (o: any) => Number(o.value) === alertValue && o.quality === 'good'), 'MODEL_TOOL_PREFLIGHT_NO_REAL_OBSERVATION');

  const store = new MysqlWorkflowStore(() => fixture.pool as never);
  const job = await store.claim('max225-real-worker', 180, { types: ['investigation.execute'], exclude: false });
  assert(job, 'MODEL_INVESTIGATION_JOB_MISSING');
  assert.equal(job.payload.requestId, alertRequestId, 'MODEL_JOB_REQUEST_MISMATCH');
  const budget = investigationBudgetConfiguration();
  const adapter = new DirectAdapter({ tools: registry, toolsForActor: toolsFrom as never, llmProvider: provider,
    providerForPurpose: async purpose => { assert.equal(purpose, 'fault_diagnosis'); return provider; },
    workspace: process.env.MAX225_RUNTIME_WORKSPACE ?? '.qualification/max225-real' });
  adapter.configureInvestigationExecutor(new InvestigationExecutor({ pool: () => fixture.pool,
    authorization: fixture.authorization, providerForPurpose: async () => provider, toolsForActor: toolsFrom as never,
    runtimeContext: investigationRuntimeConfiguration(), budget: { ...budget, prices } }));
  const jobs = new JobRegistry();
  jobs.register('investigation.execute', createInvestigationWorkflowHandler(async () => adapter));
  let state: string | null = null, error: string | null = null;
  try {
    const result = (await jobs.executeWithResult(job, { workerId: 'max225-real-worker',
      fencingToken: job.fencingToken, signal: new AbortController().signal })) as { state?: string; error?: string | null };
    state = result?.state ?? null;
    error = result?.error ?? null;
  } finally {
    await adapter.dispose();
  }
  await store.complete(job.id, 'max225-real-worker', job.fencingToken).catch(() => undefined);

  const query = async (sql: string, values: any[] = []) => (await fixture.pool.query<any[]>(sql, values))[0];
  const runs = await query('SELECT id,state,result_json FROM agent_runs');
  const results = await query('SELECT result_json FROM investigation_results');
  const toolEvidence = await query('SELECT id,metadata_json FROM investigation_evidence');
  const allocation = await query('SELECT state,charged_tokens,charged_cost_micros,usage_snapshot,cost_status FROM investigation_budget_ledger WHERE request_id=?', [alertRequestId]);
  const messages = await query("SELECT role,content FROM chat_messages WHERE role='assistant' ORDER BY id");
  // Record the durable execution state before asserting, so a partial run
  // still leaves an auditable reason instead of only an assertion message.
  modelDiagnostics = { runs: runs.map((r: any) => ({ id: r.id, state: r.state, result: typeof r.result_json === 'string' ? JSON.parse(r.result_json) : r.result_json })),
    allocation, resultCount: results.length, evidenceRows: toolEvidence.length, sends: sends.length,
    runtimeContext: (typeof runs[0].result_json === 'string' ? JSON.parse(runs[0].result_json) : runs[0].result_json)
      ?.investigationExecution?.runtimeContext ?? null,
    assistantMessages: messages.map((m: any) => String(m.content ?? '').slice(0, 600)) };
  assert(runs.length === 1, 'MODEL_RUN_MISSING');
  assert.equal(runs[0].state, 'completed', 'MODEL_RUN_NOT_COMPLETED');
  assert(results.length === 1, 'MODEL_RESULT_MISSING');
  const published = typeof results[0].result_json === 'string' ? JSON.parse(results[0].result_json) : results[0].result_json;
  const factEvidenceIds = new Set(toolEvidence.map((row: any) => row.id));
  const claimEvidenceIds = (published.claims ?? []).flatMap((claim: any) => claim.supportingEvidenceIds ?? []);
  assert(claimEvidenceIds.length > 0, 'MODEL_CITED_CLAIM_REQUIRED');
  assert(claimEvidenceIds.every((id: string) => factEvidenceIds.has(id)), 'MODEL_CITATION_NOT_BOUND');
  assert(!/未通过格式或证据引用校验/.test(String(published.summary ?? '')), 'MODEL_ANALYSIS_REJECTED');
  const finalAnswer = messages.map((m: any) => String(m.content ?? '')).join('\n');
  const usage = sends.flatMap(s => s.usage ? [s.usage] : []);
  const measured = usage.reduce((sum, u) => ({ inputTokens: sum.inputTokens + u.prompt_tokens,
    outputTokens: sum.outputTokens + u.completion_tokens,
    cachedInputTokens: sum.cachedInputTokens + (u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0) }),
    { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  assert.equal(allocation.length, 1, 'MODEL_ALLOCATION_MISSING');
  assert.equal(allocation[0].state, 'settled', 'MODEL_ALLOCATION_NOT_SETTLED');
  assert.deepEqual(typeof allocation[0].usage_snapshot === 'string' ? JSON.parse(allocation[0].usage_snapshot) : allocation[0].usage_snapshot, measured);
  return { provider: 'deepseek', model: 'deepseek-flash', outputCeiling: ceiling,
    jobRequestId: alertRequestId, runState: runs[0].state, executorState: state, executorError: error,
    preflight: preflightSummary,
    sends: sends.map(({ settled: _settled, ...send }) => send), measuredUsage: measured,
    productLedger: allocation[0], summary: published.summary, claims: published.claims,
    evidenceRows: toolEvidence.length, evidenceIds: [...factEvidenceIds], finalAnswerHash: createHash('sha256').update(finalAnswer).digest('hex'),
    finalAnswer, sharedWrites: 0 };
}

try {
  evidence.stage='read_bound_resource';
  const [servers] = await shared.query<any[]>('SELECT id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint,status,collection_enabled FROM servers WHERE id=?',[Number(process.env.MAX225_SERVER_ID ?? 3)]);
  assert(servers.length===1 && servers[0].credential_encrypted, 'BOUND_VM_CREDENTIAL_REQUIRED');
  const server = servers[0];
  // Host-network workaround only: when this machine's scoped route to the VM
  // is broken for Node sockets, a loopback TCP relay still terminates in the
  // real VM's sshd. The recorded value makes the deviation auditable.
  const relay = process.env.MAX225_SSH_RELAY;
  if (relay) {
    const [host, port] = relay.split(':');
    evidence.sshRelay = { listen: relay, target: `${server.host}:${server.port}` };
    server.host = host; server.port = Number(port);
  }
  evidence.stage='isolated_schema';
  f = await bridgeTestFixture(); dbConnection.getPool = () => f!.pool;
  // The evaluator's health gate reads its own flag; point it at the same real
  // isolated pool the rest of this qualification writes through.
  dbConnection.isConnected = () => true;
  const columns = Object.keys(server);
  await f.pool.query(`INSERT INTO servers (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`,columns.map(key=>server[key]));
  await f.pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 201,id FROM permissions WHERE code='servers:view'");
  process.env.INVESTIGATION_OPS_AUTO_ENABLED='true';
  process.env.INVESTIGATION_OPS_SERVICE_USER_ID=String(f.serviceId);
  process.env.INVESTIGATION_OPS_SERVER_IDS=String(server.id);
  const registry = createConfigurationRegistry();
  const pin = registry.list().find(r=>r.package.id==='linux-host')!.package;
  const definition = registry.catalog(pin).find(d=>d.id==='linux.cpu.user_system_percent')!;
  const collector = pin.collectors.find(c=>c.mappings.some(m=>m.metric.id===definition.id))!;
  const ref = {type:'server' as const,id:server.id};
  await policyService.changeBinding(admin,ref,{expected_revision:0,package:{id:pin.id,version:pin.version,digest:pin.digest}},true);
  await f.pool.query('UPDATE alert_rules SET enabled=0');
  evidence.stage='resolve_bound_collector';
  const access = await createAssetCollectorAccess().resolve(ref);
  const control = new RolloutControl(f.pool);
  let initialized = false, alertId: number | undefined, modelDone = false;
  evidence.resource={type:'server',id:server.id};
  for (let index=0;index<30;index++) {
    evidence.stage='collect_vm';
    const result = await runPackage(registry,{package:{id:pin.id,version:pin.version,digest:pin.digest},credential_ref:access.credential_ref,overrides:{}},
      {...access,binding_id:`server:${server.id}`,attempt_id:`MAX225:${randomUUID()}`,config_revision:1,observed_at:new Date().toISOString(),
        signal:AbortSignal.timeout(30_000),collector_ids:[collector.id],metric_keys:[`${definition.id}@${definition.semantic_version}`]});
    const observation = result.observations.find(o=>o.observation.metric.id===definition.id)?.observation;
    evidence.samples.push({attempts:result.attempts.map(a=>({status:a.status,error:a.error})),observation});
    assert(observation?.quality.status==='good' && observation.value?.encoding==='float64','REAL_CPU_OBSERVATION_REQUIRED');
    if (!initialized) {
      // An idle VM legitimately reports 0%; a real threshold needs a real
      // nonzero sample, so keep observing instead of fabricating one.
      if (!(observation.value.value>0)) continue;
      evidence.threshold=observation.value.value*0.95;
      await f.pool.query(`INSERT INTO alert_rules (id,name,target_type,server_id,metric_name,operator,threshold,duration_seconds,severity,enabled)
        VALUES (9001,'MAX225 real VM CPU','server',?,'cpu_usage','>',?,0,'critical',1)`,[server.id,evidence.threshold]);
      await control.initialize(observation,{source:'semantic',read:'semantic',revision:1,package:{id:pin.id,version:pin.version,digest:pin.digest}});
      await control.applied(observation,{source:'semantic',generation:1,revision:1});
      // The evaluator refuses to read a metric whose collection method has no
      // capability evidence. This attempt is that evidence: the real SSH
      // collection below returned a good value for exactly this metric.
      await new MysqlPolicyStore(()=>f.pool).reportCapabilities(ref,1,[{resource_id:String(server.id),
        metric:{id:definition.id,semantic_version:definition.semantic_version},status:'supported',method:collector.method,
        basis:[{kind:'method',evidence:`attempt:${result.attempts[0]!.id}`}],
        evaluated_at:new Date().toISOString(),valid_until:new Date(Date.now()+3600_000).toISOString()}],null);
      initialized=true;
    }
    // Preserve actual collection timestamps/values; no fabricated observations.
    await control.publish(observation,definition,{source:'semantic',generation:1,revision:1});
    evidence.stage='evaluate_and_admit';
    await serverAlertEvaluator.evaluateServerRules();
    const [alerts] = await f.pool.query<any[]>('SELECT id,status,metric_value,tags,resolved_at FROM alerts WHERE server_id=? ORDER BY id',[server.id]);
    evidence.alerts=alerts;
    alertId ??= alerts[0]?.id;
    // The admitted investigation runs while its alert is still active, so the
    // cited evidence is the real observation that triggered this alert.
    if (modelAuthorized && !modelDone && alertId) {
      const [ownersNow] = await f.pool.query<any[]>('SELECT alert_id,investigation_id FROM investigation_alert_owners WHERE alert_id=?',[alertId]);
      const auto = (alerts.find(a=>a.id===alertId)?.tags as any)?.auto_analysis;
      if (ownersNow.length===1 && auto?.requestId) {
        modelDone = true;
        evidence.stage='real_model_investigation';
        evidence.model = await runRealModelSegment(f, alertId, auto.requestId);
        evidence.modelRequests = evidence.model.sends.length;
        evidence.stage='evaluate_and_admit';
      }
    }
    if (alertId && alerts.find(a=>a.id===alertId)?.status==='resolved') { evidence.recovered=true; break; }
  }
  assert(initialized,'REAL_NONZERO_CPU_SAMPLE_NOT_OBSERVED');
  assert(alertId,'REAL_ALERT_REQUIRED');
  const [owners] = await f.pool.query<any[]>('SELECT alert_id,lane,investigation_id,analysis_id FROM investigation_alert_owners WHERE alert_id=?',[alertId]);
  evidence.owners=owners;
  assert(owners.length===1 && owners[0].investigation_id && owners[0].lane==='investigation','AUTOMATIC_ADMISSION_REQUIRED');
  evidence.admissionVerified=true;
  assert(evidence.recovered,'NATURAL_CPU_RECOVERY_NOT_OBSERVED');
} catch (error) {
  evidence.failure = error instanceof assert.AssertionError ? error.message : (error as {code?:string}).code ?? 'QUALIFICATION_FAILED';
  evidence.failureDetail = error instanceof Error ? error.message : String(error);
  // Frame locations only; never raw provider/SQL text or secrets.
  evidence.failureFrames = error instanceof Error ? (error.stack ?? '').split('\n')
    .filter(line => line.trim().startsWith('at ')).slice(0, 8) : [];
  process.exitCode=1;
} finally {
  evidence.finishedAt=new Date().toISOString();
  if (modelDiagnostics) evidence.modelDiagnostics = modelDiagnostics;
  writeFileSync(process.env.MAX225_EVIDENCE!,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({admissionVerified:evidence.admissionVerified??false,recovered:evidence.recovered??false,failure:evidence.failure??null,samples:evidence.samples.length,modelRequests:evidence.modelRequests??0}));
  dbConnection.getPool=originalPool;
  dbConnection.isConnected=originalIsConnected;
  sshSessionPool.closeAll();
  await f?.close(); await shared.end();
}
