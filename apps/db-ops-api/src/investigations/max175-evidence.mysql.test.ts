import { randomUUID } from 'node:crypto';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { ToolRegistry, type LLMProvider } from '@slide/agent-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../migrations/runner.js';
import { ActorContextService } from '../auth/actor-context.js';
import { InvestigationAuthorization } from './authorization.js';
import { InvestigationSessionBridge, investigationBudgetConfiguration } from './session-bridge.js';
import { InvestigationExecutor } from './executor.js';
import { MysqlWorkflowStore } from '../workflows/worker-runtime.js';

const port = Number(process.env.AGENT_RUN_TEST_MYSQL_PORT);
describe.skipIf(!port)('MAX-175 bounded executor evidence / isolated MySQL, controlled provider', () => {
  const database = `max175_evidence_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool, pool: Pool, authorization: InvestigationAuthorization, bridge: InvestigationSessionBridge;
  let contexts: ActorContextService;
  const rows = async (sql: string, values: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, values))[0];
  beforeAll(async () => {
    const config = { host: '127.0.0.1', port, user: 'root', password: process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    admin = mysql.createPool(config); await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...config, database, connectionLimit: 12 });
    await new MigrationRunner(pool).run();
    contexts = new ActorContextService(() => pool as never); authorization = new InvestigationAuthorization(contexts);
    bridge = new InvestigationSessionBridge(() => pool, authorization);
    await pool.query("INSERT INTO users(id,username,password_hash) VALUES(101,'max175-evidence','no-login')");
    await pool.query("INSERT INTO roles(id,name) VALUES(101,'max175-readonly')");
    await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 101,id FROM permissions WHERE code IN ('chat:view','instance:view','metric:view','alert:view')");
    await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(101,101)');
    await pool.query("INSERT INTO database_instances(id,name,host,port,username,password_encrypted) VALUES(101,'MAX175','fixture.invalid',3306,'fixture','unused')");
    await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(101,101,'read-only')");
  }, 60000);
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); } });
  async function persisted(value: unknown, expectReference = false) {
    const actor = await contexts.loadActiveActor(101);
    const created = await bridge.create(actor, { idempotencyKey: randomUUID(), title: 'MAX175 evidence', goal: 'Read', profileId: 'ops', profileVersion: 1,
      resources: [{ type: 'instance', id: 101, role: 'primary' }] }, { message: 'Read', idempotencyKey: randomUUID() });
    const requestId = created.acceptance!.requestId;
    const job = (await new MysqlWorkflowStore(() => pool as never).claim('max175-evidence', 60, { types: ['investigation.execute'], exclude: false }))!;
    let calls = 0;
    let modelToolContent: string | undefined;
    let checkpointDuringRequest: unknown;
    const provider: LLMProvider = { getDefaultModel: () => 'fixture',
      getModelCapabilities: () => ({ model: 'fixture', contextWindowTokens: 32768, preferredOutputTokens: 4096, source: 'configuration', version: 'fixture/v1' }),
      chat: async (messages) => { calls++; modelToolContent = messages.find(m => m.role === 'tool')?.content as string | undefined;
        if (expectReference && calls > 1) checkpointDuringRequest = await rows('SELECT metadata FROM chat_sessions WHERE session_id=?', [created.investigation.sessionId]);
        return { content: calls === 1 ? null : '根因待核验', finishReason: calls === 1 ? 'tool_calls' : 'stop',
        toolCalls: calls === 1 ? [{ id: 'max175-call', name: 'get_instance_summary', arguments: { instance_id: 101 } }] : [],
        hasToolCalls: calls === 1, shouldExecuteTools: calls === 1, usage: { prompt_tokens: 20, completion_tokens: 10, cached_tokens: 5 } }; },
      chatStream: async () => { throw Error('NO_EXTERNAL_MODEL'); } };
    const tools = new ToolRegistry(); tools.register({ name: 'get_instance_summary', description: 'Readonly fixture',
      parameters: { type: 'object', properties: { instance_id: { type: 'number' } } }, readOnly: true, concurrencySafe: true, exclusive: false, execute: async () => value });
    const executor = new InvestigationExecutor({ pool: () => pool, authorization, providerForPurpose: async () => provider, toolsForActor: () => tools,
      budget: { domain: 'max175-evidence', policy: investigationBudgetConfiguration().policy, reserveCostMicros: 1000000 } });
    const terminal = await executor.execute({ investigationId: created.investigation.id, requestId, job,
      context: { workerId: 'max175-evidence', fencingToken: job.fencingToken, signal: new AbortController().signal } });
    expect(terminal, JSON.stringify(terminal)).toMatchObject({ state: 'completed' });
    await pool.query("UPDATE workflow_jobs SET state='completed' WHERE id=?", [job.id]);
    const evidence = await rows('SELECT raw_json FROM investigation_evidence WHERE investigation_id=?', [created.investigation.id]);
    expect(evidence).toHaveLength(1);
    if (expectReference) {
      expect(JSON.parse(modelToolContent!)).toMatchObject({data:{evidenceOmitted:true,requiresNarrowerRead:true,
        contextReference:{toolCallId:'max175-call'}}});
      expect(modelToolContent).not.toContain('bounded-row');
      expect(JSON.stringify(checkpointDuringRequest)).toContain('bounded-row');
    }
    return JSON.stringify(evidence[0].raw_json);
  }
  it('persists nested ISO dates, null invalid dates and redaction after bounded copying', async () => {
    const json = await persisted({ success: true, nested: [{ observedAt: new Date('2026-10-16T01:00:00Z'), validUntil: new Date('2026-10-16T01:05:00Z'),
      invalid: new Date(NaN), password: 'max175-secret', detail: 'token=max175-secret' }] });
    expect(json).toContain('2026-10-16T01:00:00.000Z'); expect(json).toContain('2026-10-16T01:05:00.000Z');
    expect(json).toContain('"invalid":null'); expect(json).toContain('[REDACTED]'); expect(json).not.toContain('max175-secret');
  });
  it('preserves row and depth bounds when dates are present', async () => {
    let deep: unknown = { beyond: 'must-be-cut', date: new Date() };
    for (let i = 0; i < 25; i++) deep = { child: deep };
    const json = await persisted({ success: true, deep, observedAt: new Date(), rows: Array(201).fill('bounded-row') }, true);
    expect(json.match(/bounded-row/g)).toHaveLength(200); expect(json).toContain('[depth limit]'); expect(json).not.toContain('must-be-cut');
  });
  it('rejects results over the byte ceiling after Date serialization', async () => {
    const json = await persisted({ success: true, observedAt: new Date(), text: 'x'.repeat(128001) });
    expect(json).toContain('INVESTIGATION_TOOL_OUTPUT_LIMIT'); expect(json.length).toBeLessThan(1000);
  });
});
