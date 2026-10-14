/** Explicit T09 real-provider qualification. Never imported by server/tests.
 * Shared configuration SELECT only; all business writes use run-owned mysql. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import Fastify from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { ToolRegistry, type LLMProvider } from '@slide/agent-core';
import { DirectAdapter } from '../adapter/direct-adapter.js';
import { createConfiguredAgentProvider } from '../adapter/llm-provider-factory.js';
import { ActorContextService, signAccessToken } from '../auth/actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { decryptData } from '../db-connection.js';
import { llmDatabaseService } from '../llm-database-service.js';
import { MigrationRunner } from '../migrations/runner.js';
import { SourceSnapshotService } from '../platform/source-snapshot-service.js';
import { SourceManagementService } from '../platform/source-management-service.js';
import { JobRegistry } from '../workflows/job-registry.js';
import { MysqlWorkflowStore } from '../workflows/worker-runtime.js';
import { InvestigationAuthorization, provisionInvestigationServiceIdentity } from './authorization.js';
import { InvestigationExecutor } from './executor.js';
import { createSystemComposition, type SystemComposition } from './system-composition.js';
import { registerSystemEventRoutes, SystemEventReader } from './system-event-routes.js';
import { createInvestigationWorkflowHandler } from './workflow-handler.js';
import { readSystemJournal, receiveSystemUsage, reserveSystemSend, stopSystemSends,
  SYSTEM_STANDING_AUTHORIZATION } from './system-real-provider-budget.js';

const journal = process.env.T09_REAL_JOURNAL!, evidence = process.env.T09_REAL_EVIDENCE!;
if (process.env.T09_REAL_AUTHORIZATION !== SYSTEM_STANDING_AUTHORIZATION || !journal || !evidence
  || !process.env.T09_PROVIDER_ENV || !process.env.T09_REAL_ARTIFACTS) throw Error('T09_EXPLICIT_AUTHORIZATION_REQUIRED');
const initial = readSystemJournal(journal);
if (initial.entries[0].authorization !== SYSTEM_STANDING_AUTHORIZATION || initial.requests || initial.stopped) throw Error('T09_EXISTING_SCENARIO_REQUIRES_REVIEW');
config({ path: process.env.T09_PROVIDER_ENV, quiet: true });
const artifacts = resolve(process.env.T09_REAL_ARTIFACTS);
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const record = (value: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...value });
  appendFileSync(evidence, `${line}\n`, { mode: 0o600 }); console.log(line);
};
const safeCode = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)
  ? error.message : 'QUALIFICATION_ASSERTION_OR_ENVIRONMENT';
const sentToolContents: string[] = [];

async function configuredProvider() {
  const shared = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME ?? 'db_ops_ai' });
  let provider: LLMProvider, prices: { input: number; cachedInput: number; output: number };
  try {
    // Service delegates SELECTs to this checked executor. No legacy credential migration.
    const select = { execute: async (sql: string, values?: any[]) => {
      assert(/^SELECT\s/i.test(sql), 'T09_SHARED_WRITE_FORBIDDEN'); return shared.execute(sql, values);
    } };
    const stored = (await llmDatabaseService.getAllProviders(select as never)).find(p => p.enabled && p.is_default);
    assert(stored?.name === 'deepseek' && stored.default_model === 'deepseek-flash'
      && stored.api_base_url === 'https://api.deepseek.com/v1' && stored.api_format === 'openai-completions'
      && stored.supports_function_call && stored.api_key_encrypted, 'T09_PROVIDER_CONFIGURATION_CHANGED');
    const bindings = await llmDatabaseService.getSceneBindings(select as never);
    assert.equal(bindings.length, 0, 'T09_SCENE_CONFIGURATION_CHANGED');
    const p = stored;
    assert(Number.isSafeInteger(p.max_tokens) && p.max_tokens! > 0, 'T09_PROVIDER_OUTPUT_INVALID');
    const key = decryptData(p.api_key_encrypted!); // memory only; never print/persist.
    prices = { input: Math.ceil(p.input_cost_per_1k * 1_000_000_000),
      cachedInput: Math.ceil(p.input_cost_per_1k * 1_000_000_000), output: Math.ceil(p.output_cost_per_1k * 1_000_000_000) };
    assert(prices.input > 0 && prices.output > 0);
    provider = await createConfiguredAgentProvider({ getAllProviders: async () => [p],
      getSceneBindings: async () => bindings, getProviderApiKey: async name => { assert.equal(name, p.name); return key; } },
      'fault_diagnosis', true, false);
    assert.equal(provider.getDefaultModel(), 'deepseek-flash');
    record({ configuration: { provider: p.name, model: provider.getDefaultModel(), outputCeiling: p.max_tokens,
      sharedOutputCeiling: stored.max_tokens, scene: 'fault_diagnosis via existing default route', sharedWrites: 0, prices,
      authorization: SYSTEM_STANDING_AUTHORIZATION, baseline: initial.entries[0], historicalRequests: initial.cumulativeRequests, historicalStopped: true } });
    const client = (provider as any).client as { fetch: typeof fetch; maxRetries: number };
    assert.equal(client.maxRetries, 0);
    const originalFetch = client.fetch;
    client.fetch = async (input, init) => {
      const request = new Request(input, init), bodyText = await request.clone().text();
      const body = JSON.parse(bodyText);
      assert.equal(request.url, 'https://api.deepseek.com/v1/chat/completions');
      assert.equal(request.method, 'POST'); assert.equal(body.model, 'deepseek-flash'); assert(!body.stream);
      assert(!bodyText.includes(key), 'T09_SECRET_IN_BODY');
      assert(Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 && body.max_tokens <= p.max_tokens!);
      // Byte-level upper bound on this small UTF-8/BPE request plus conservative
      // 1024-token chat-template margin. Also count schemas and all tool history.
      const upper = Buffer.byteLength(bodyText) + 1024;
      const send = reserveSystemSend(journal, upper, body.max_tokens);
      sentToolContents.push(...body.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content)));
      record({ send, requestHash: createHash('sha256').update(bodyText).digest('hex'),
        requestBytes: Buffer.byteLength(bodyText),
        toolResultsSent: body.messages.filter((m: any) => m.role === 'tool').map((m: any) => ({
          toolCallId: m.tool_call_id, contentHash: createHash('sha256').update(String(m.content)).digest('hex'),
          signedSourceIncluded: String(m.content).includes('export function qualifyFailure'),
        })), state: readSystemJournal(journal) });
      try {
        const response = await originalFetch(input, { ...init, redirect: 'error' });
        if (!response.ok) {
          record({ sequence: send.sequence, providerStatus: response.status });
          throw Error(`PROVIDER_HTTP_${response.status}`);
        }
        const raw = await response.clone().json() as any;
        const state = receiveSystemUsage(journal, send.sequence!, { inputTokens: raw.usage?.prompt_tokens,
          outputTokens: raw.usage?.completion_tokens,
          cachedInputTokens: raw.usage?.prompt_cache_hit_tokens ?? raw.usage?.prompt_tokens_details?.cached_tokens ?? 0 });
        assert(raw.choices?.length === 1 && ['stop', 'tool_calls'].includes(raw.choices[0].finish_reason), 'T09_PROVIDER_PROTOCOL');
        record({ sequence: send.sequence, providerStatus: response.status, usage: raw.usage,
          finishReason: raw.choices[0].finish_reason, toolCalls: raw.choices[0].message.tool_calls ?? [],
          content: raw.choices[0].message.content, state });
        return response;
      } catch (error) {
        stopSystemSends(journal, safeCode(error)); throw Error(safeCode(error));
      }
    };
  } finally { await shared.end(); }
  const chat = provider!.chat.bind(provider!);
  const bounded: LLMProvider = { getDefaultModel: provider!.getDefaultModel.bind(provider!),
    getModelCapabilities: provider!.getModelCapabilities?.bind(provider!), projectMessages: provider!.projectMessages?.bind(provider!),
    chat: async (messages, tools, options) => {
      // Preserve the executor's configured model/runtime output and run budget.
      const result = await chat(messages, tools, options);
      if (result.finishReason === 'error') { stopSystemSends(journal, 'PROVIDER_RUNTIME_ERROR'); throw Error('T09_PROVIDER_RUNTIME_ERROR'); }
      return result;
    }, chatStream: async () => { throw Error('T09_REAL_STREAM_NOT_AUTHORIZED'); } };
  return { provider: bounded, prices: prices! };
}

async function main() {
  const { provider, prices } = await configuredProvider(); // no ping/model call
  const container = `slide-t09-real-${process.pid}-${randomUUID()}`;
  const database = `t09_real_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool | undefined, pool: Pool | undefined, composition: SystemComposition | undefined, adapter: DirectAdapter | undefined;
  let started = false; const app = Fastify();
  const policy = { currency: 'USD', maxConcurrent: 4, manualReserved: 1, maxPerResourceConcurrent: 4,
    maxAutomaticRequestsPerHour: 20, maxAutomaticTokensPerDay: 128000, maxTotalTokensPerDay: 256000, maxCostMicrosPerDay: 10000000 };
  try {
    execFileSync('docker', ['run', '--detach', '--rm', '--name', container, '--env', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes',
      '--publish', '127.0.0.1::3306', 'mysql:8.4'], { stdio: 'pipe' }); started = true;
    const port = Number(execFileSync('docker', ['port', container, '3306/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1));
    const testConfig = { host: '127.0.0.1', port, user: 'root', password: '', timezone: 'Z' };
    admin = mysql.createPool(testConfig);
    const deadline = Date.now() + 45000;
    for (;;) { try { await admin.query('SELECT 1'); break; } catch { if (Date.now() > deadline) throw Error('T09_ISOLATED_MYSQL_UNAVAILABLE');
      await new Promise(resolve => setTimeout(resolve, 500)); } }
    await admin.query(`CREATE DATABASE ${database}`); pool = mysql.createPool({ ...testConfig, database, connectionLimit: 12 });
    await new MigrationRunner(pool).run(); await new MigrationRunner(pool).run();
    const contexts = new ActorContextService(() => pool as never), authorization = new InvestigationAuthorization(contexts);
    const serviceId = await provisionInvestigationServiceIdentity(pool as never, 't09-real');
    const [role] = await pool.query<mysql.ResultSetHeader>("INSERT INTO roles (name) VALUES ('synthetic-system-reader')");
    await pool.execute("INSERT INTO role_permissions (role_id,permission_id) SELECT ?,id FROM permissions WHERE code IN ('chat:view','config:view')", [role.insertId]);
    await pool.execute('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)', [serviceId, role.insertId]);
    await pool.execute("INSERT INTO users (id,username,password_hash) VALUES (9901,'synthetic-system-reviewer','disabled')");
    await pool.execute('INSERT INTO user_roles (user_id,role_id) VALUES (9901,?)', [role.insertId]);
    const commitSha = 'a'.repeat(40), signingKey = randomUUID().repeat(2);
    const repository = { origin: 'https://github.com', provider: 'github' as const, ref: commitSha, allowedPaths: ['src/'] };
    const source = 'export function qualifyFailure() {\n  // Synthetic intent only: a slow fixture operation maps to HTTP 500.\n  return { status: 500, code: "SYNTHETIC_TIMEOUT", timeoutMs: 1000 };\n}\n';
    const manifest = await new SourceSnapshotService(resolve(artifacts, 'source'), signingKey).publish({
      releaseId: 'signed-fixture', commitSha, projectId: 'fixture/repo', repository }, [{ path: 'src/system-fixture.ts', content: source }]);
    const snapshotKey = 'source.snapshot.' + createHash('sha256').update(JSON.stringify({ ...repository, projectId: 'fixture/repo' })).digest('hex');
    await pool.execute('REPLACE INTO system_config(config_key,config_value) VALUES (?,?),(?,?)', [
      'source.gitlab', JSON.stringify({ baseUrl: repository.origin, provider: repository.provider, ref: commitSha,
        allowedPaths: repository.allowedPaths, repositoryPath: 'fixture/repo', allowModelContent: true }),
      snapshotKey, JSON.stringify({ releaseId: manifest.releaseId, commitSha, treeDigest: manifest.treeDigest })]);
    Object.assign(process.env, { SLIDE_SOURCE_ROOT: resolve(artifacts, 'source'), SLIDE_SOURCE_SIGNING_KEY: signingKey,
      SLIDE_RELEASE_MANIFEST: '', SLIDE_RELEASE_ID: 'fixture-release', SLIDE_COMMIT_SHA: commitSha, SLIDE_SOURCE_DIGEST: manifest.treeDigest });
    composition = await createSystemComposition(() => pool!, { contexts, source: new SourceManagementService(() => pool as never),
      configuration: { enabled: true, automatic: true, serviceUserId: serviceId },
      budget: { domain: 'system-test', policy, reserveCostMicros: 1000000, prices } });
    const input = { component: 'api' as const, sourceEventId: randomUUID(), correlationId: randomUUID(),
      occurredAt: new Date(Date.now() - 2 * 3600000).toISOString(), stableErrorCode: 'SYNTHETIC_TIMEOUT',
      callsite: 'src/system-fixture.ts:qualifyFailure', origin: 'user_operation' as const, httpStatus: 500,
      releaseId: 'fixture-release', commitSha };
    const saved = await composition.bridge.record(input), accepted = await composition.bridge.deliver(saved.jobId);
    assert.equal(accepted.disposition, 'accepted');
    record({ fixture: { input, accepted, container, port, database, manifest: { ...manifest, signature: '[omitted]' },
      syntheticSourceHash: createHash('sha256').update(source).digest('hex'), migrations: 'formal twice', productionOperations: 0 } });
    if (process.env.T09_REAL_PREPARE_ONLY === 'true') {
      const [snapshots] = await pool.query<RowDataPacket[]>('SELECT request_snapshot FROM investigation_requests WHERE id=?', [accepted.requestId]);
      const snapshot = typeof snapshots[0].request_snapshot === 'string' ? JSON.parse(snapshots[0].request_snapshot) : snapshots[0].request_snapshot;
      const actor = { ...await contexts.loadInvestigationActorFrom(pool as never, serviceId, 'service', 1),
        resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } };
      const registry = composition.toolsForInvestigation(actor, snapshot);
      for (const name of ['get_platform_observations', 'get_deployment_manifest', 'read_source_region']) {
        const value = await registry.get(name)!.execute(name === 'read_source_region'
          ? { path: 'src/system-fixture.ts', startLine: 1, endLine: 4 } : {}) as any;
        assert(value.success && value.data.quality !== 'unknown', 'T09_PREPARE_SOURCE_UNAVAILABLE');
      }
      record({ preparedOnly: true, requests: 0, qualificationPassed: false,
        note: 'operator preflight only, not model consumption or qualification evidence' }); return;
    }
    const workerId = 't09-real-worker', store = new MysqlWorkflowStore(() => pool as never);
    const job = await store.claim(workerId, 180, { types: ['investigation.execute'], exclude: false }); assert(job);
    const tools = new ToolRegistry();
    adapter = new DirectAdapter({ tools, toolsForActor: () => tools, llmProvider: provider, providerForPurpose: async purpose => {
      assert.equal(purpose, 'fault_diagnosis'); return provider;
    }, workspace: resolve(artifacts, 'runtime') });
    adapter.configureInvestigationExecutor(new InvestigationExecutor({ pool: () => pool!, authorization,
      systemToolsForInvestigation: composition.toolsForInvestigation, toolsForActor: () => tools,
      providerForPurpose: async () => provider, budget: { domain: 'system-test', policy, reserveCostMicros: 1000000, prices } }));
    const registry = new JobRegistry(); registry.register('investigation.execute', createInvestigationWorkflowHandler(async () => adapter!));
    // A real SQL completion fault AFTER the provider response forces durable repair,
    // never a repeated model request. This is an expected storage failure only.
    await pool.query(`CREATE TRIGGER t09_real_completion_failure BEFORE UPDATE ON agent_runs FOR EACH ROW
      BEGIN IF NEW.state='completed' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='T09_REAL_COMPLETION_FAILURE'; END IF; END`);
    let storageFailure = false;
    try { const result = await registry.executeWithResult(job, { workerId, fencingToken: job.fencingToken, signal: new AbortController().signal });
      record({ initialResult: result });
    } catch (error) { storageFailure = error instanceof Error && error.message.includes('T09_REAL_COMPLETION_FAILURE');
      if (!storageFailure) throw error;
      record({ expectedStorageFailure: 'T09_REAL_COMPLETION_FAILURE' });
    } finally { await pool.query('DROP TRIGGER t09_real_completion_failure'); }
    const query = async (sql: string, values: any[] = []) => (await pool!.query<RowDataPacket[]>(sql, values))[0];
    const pending = await query('SELECT id,state,session_id,result_json FROM agent_runs');
    const canonical = await query('SELECT entry_json FROM agent_canonical_facts ORDER BY turn_sequence,ordinal');
    record({ pendingRun: pending, canonicalBeforeRecovery: canonical });
    assert.equal(pending.length, 1, 'T09_REAL_RUN_MISSING');
    await adapter.dispose(); adapter = undefined;
    await pool.execute('UPDATE workflow_jobs SET lease_expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE id=?', [job.id]);
    const next = await store.claim('t09-real-recovery', 180, { types: ['investigation.execute'], exclude: false });
    assert(next?.id === job.id && next.fencingToken > job.fencingToken);
    const command = { investigationId: accepted.investigationId, requestId: accepted.requestId, job: next,
      context: { workerId: 't09-real-recovery', fencingToken: next.fencingToken } };
    const recover = () => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'src/investigations/system-event-recovery-child.ts'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SYSTEM_RECOVERY_FIXTURE: JSON.stringify({ port, database, serviceId,
        investigationId: accepted.investigationId, composed: true, quota: policy, execute: command }) } }));
    const before = readSystemJournal(journal).requests, first = recover(), replay = recover();
    assert.deepEqual(replay, first); assert.equal(first.runId, pending[0].id);
    assert.equal(readSystemJournal(journal).requests, before);
    await store.complete(next.id, command.context.workerId, next.fencingToken);
    const results = await query('SELECT result_json FROM investigation_results');
    const chatMessages = await query('SELECT role,content,message_id FROM chat_messages ORDER BY id');
    const toolEvidence = await query('SELECT raw_json FROM investigation_evidence');
    const ledger = await query('SELECT state,charged_tokens,usage_snapshot,cost_status,charged_cost_micros FROM investigation_budget_ledger');
    record({ recovery: first, replay, providerReplayDelta: readSystemJournal(journal).requests - before, results, toolEvidence, ledger, chatMessages });
    const entries = (await query('SELECT entry_json FROM agent_canonical_facts ORDER BY turn_sequence,ordinal'))
      .map(r => typeof r.entry_json === 'string' ? JSON.parse(r.entry_json) : r.entry_json);
    const consumed = entries.filter(e => e.role === 'tool').map(e => ({ name: e.name, content: e.content }));
    const names = consumed.map(e => e.name);
    const rendered = JSON.stringify(consumed), answer = chatMessages.filter(e => e.role === 'assistant').map(e => e.content).join('\n');
    await pool.execute("INSERT INTO investigation_members(investigation_id,user_id,role,granted_by) VALUES (?,9901,'viewer',?)", [accepted.investigationId, serviceId]);
    const secret = randomUUID();
    await registerSystemEventRoutes(app, createVerifyToken(secret, contexts), new SystemEventReader(() => pool!, authorization));
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const http = await fetch(`${address}/api/platform/system-events/${accepted.eventId}`, {
      headers: { authorization: `Bearer ${signAccessToken(await contexts.loadActiveActor(9901), secret)}` } });
    assert.equal(http.status, 200); const eventDetail = await http.json() as any;
    record({ httpStatus: http.status, eventDetail, consumedTools: names, answer });
    assert(storageFailure && first.state === 'completed' && first.results === 1, 'T09_REAL_RUN_NOT_COMPLETED');
    assert(names.includes('get_platform_observations'), 'T09_FACTS_NOT_CONSUMED');
    assert(names.includes('get_deployment_manifest'), 'T09_MANIFEST_NOT_CONSUMED');
    assert(names.some(n => ['read_source_region', 'get_symbol_definition'].includes(n)), 'T09_SOURCE_NOT_CONSUMED');
    const outbound = sentToolContents.join('\n');
    assert(outbound.includes(input.sourceEventId) && outbound.includes(commitSha)
      && outbound.includes(JSON.stringify(source.trimEnd()).slice(1, -1)), 'T09_SOURCE_NOT_SENT_TO_MODEL');
    assert.equal(toolEvidence.length, 5, 'T09_FIVE_EVIDENCE_REQUIRED');
    assert(rendered.includes(input.sourceEventId) && rendered.includes(commitSha) && rendered.includes('SYSTEM_EVENT_WINDOW_TRUNCATED')
      && rendered.includes('qualifyFailure'), 'T09_EVIDENCE_BINDING_MISSING');
    assert(answer.includes('SYNTHETIC_TIMEOUT') && answer.includes('system-fixture.ts') && /未验证|待验证|不能确认|无法确认/.test(answer), 'T09_RESULT_EVIDENCE_INCOMPLETE');
    assert.equal(eventDetail.investigationId, accepted.investigationId);
    const usage = readSystemJournal(journal);
    assert.equal(ledger[0].state, 'settled'); assert.equal(Number(ledger[0].charged_tokens), usage.totalTokens);
    stopSystemSends(journal, 'QUALIFICATION_COMPLETED');
    record({ completed: true, requests: usage.requests, cumulativeRequests: usage.cumulativeRequests, cumulativeTokens: usage.cumulativeTokens, usage: usage.usage,
      consumedTools: names, syntheticTargetAndSource: true, realProvider: 'deepseek/deepseek-flash',
      actualProviderCharge: 'unavailable; ledger cost uses configured estimate', familyAgentTokenTelemetry: 'unavailable' });
  } finally {
    await adapter?.dispose(); await composition?.close(); await app.close(); await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
    if (started) execFileSync('docker', ['stop', '--time', '10', container], { stdio: 'pipe' });
  }
}
try { await main(); }
catch (error) {
  if (readSystemJournal(journal).requests) stopSystemSends(journal, safeCode(error));
  record({ completed: false, code: safeCode(error), errorType: error instanceof Error ? error.name : 'unknown',
    // Locations only, never raw DB/HTTP error messages which may include secrets.
    location: error instanceof Error ? error.stack?.split('\n').filter(l => l.trim().startsWith('at ')).slice(0, 5) : [],
    state: readSystemJournal(journal), reason: 'scene stopped; diagnose before a new linked scene; no transport retry or fallback' });
  process.exitCode = 1;
}
