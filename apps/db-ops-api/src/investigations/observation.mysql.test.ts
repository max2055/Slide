import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import Fastify from 'fastify';
import { WebSocket } from 'ws';
import { ToolRegistry, type LLMProvider } from '@slide/agent-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../migrations/runner.js';
import { ActorContextService, signAccessToken, type ActorContext } from '../auth/actor-context.js';
import { InvestigationAuthorization } from './authorization.js';
import { InvestigationSessionBridge, investigationBudgetConfiguration } from './session-bridge.js';
import { InvestigationExecutor } from './executor.js';
import { InvestigationStreamStore, InvestigationWatchService, reduceInvestigationEvents, emptyInvestigationProjection } from './stream.js';
import { InvestigationEvidenceStore } from './evidence-store.js';
import { InvestigationResultStore } from './result-schema.js';
import { registerInvestigationRoutes } from './routes.js';
import { CanonicalStore, type InvestigationExecutionBinding, type InvestigationConnection } from '../adapter/canonical-store.js';
import { AgentRunService } from '../adapter/agent-run-service.js';
import { MysqlWorkflowStore } from '../workflows/worker-runtime.js';
import { DirectAdapter } from '../adapter/direct-adapter.js';

const port = Number(process.env.AGENT_RUN_TEST_MYSQL_PORT);
describe.skipIf(!port)('T05 observation / real MySQL, JWT, HTTP and WebSocket', () => {
  const database = `inv_observation_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool, pool: Pool, contexts: ActorContextService, authorization: InvestigationAuthorization;
  let bridge: InvestigationSessionBridge, stream: InvestigationStreamStore, evidence: InvestigationEvidenceStore, results: InvestigationResultStore;
  let owner: ActorContext, viewer: ActorContext, ordinary: ActorContext;
  let inv: any, binding: InvestigationExecutionBinding, canonical: CanonicalStore;
  const rows = async (sql: string, values: any[] = []) => (await pool.query<RowDataPacket[]>(sql, values))[0];
  const input = () => ({ source: 'tool:metrics', summary: 'Metric observation', resources: [{ type: 'instance' as const, id: 101 }],
    observedFrom: new Date(Date.now() - 60_000).toISOString(), observedTo: new Date(Date.now() - 1000).toISOString(), collectedAt: new Date().toISOString(),
    raw: { value: null, password: 'fake-secret', sql: "SELECT * FROM t WHERE email='private-value'" } });
  const result = (ids: string[] = []) => ({ schemaVersion: 2, subject: inv.context.subject, summary: 'Execution summary',
    facts: [], hypotheses: [{ statement: 'No verified recovery', status: 'unknown', supportingEvidenceIds: [], contradictingEvidenceIds: ids }],
    claims: [], rootCauseVerification: { status: 'unverified' }, unresolvedQuestions: ['Requires verification'], recommendations: [], problemStatus: 'unconfirmed',
    provenance: { modelVersion: 'fixture', promptVersion: 'fixture-v1', toolVersions: {}, runtimeRunId: binding.runId, usageStatus: 'unavailable' }, createdAt: new Date().toISOString() });
  const tx = async <T>(fn: (c: InvestigationConnection) => Promise<T>) => {
    const c = await pool.getConnection();
    try { await c.beginTransaction(); const value = await fn(c as never); await c.commit(); return value; }
    catch (e) { await c.rollback(); throw e; } finally { c.release(); }
  };
  beforeAll(async () => {
    const config = { host: '127.0.0.1', port, user: 'root', password: process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    admin = mysql.createPool(config); await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...config, database, connectionLimit: 12 });
    await new MigrationRunner(pool).run();
    contexts = new ActorContextService(() => pool as never);
    authorization = new InvestigationAuthorization(contexts);
    bridge = new InvestigationSessionBridge(() => pool, authorization);
    stream = new InvestigationStreamStore(() => pool, authorization);
    evidence = new InvestigationEvidenceStore(() => pool, authorization);
    results = new InvestigationResultStore(() => pool, authorization);
    canonical = new CanonicalStore(() => pool as never, authorization);
    await pool.query("INSERT INTO users (id, username, password_hash) VALUES (101, 't05-owner', 'no-login'), (102, 't05-viewer', 'no-login'), (103, 't05-share', 'no-login')");
    await pool.query("INSERT INTO roles (id, name) VALUES (101, 't05-readonly')");
    await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT 101, id FROM permissions WHERE code IN ('chat:view','instance:view','metric:view','alert:view')");
    await pool.query("INSERT INTO database_instances (id, name, host, port, username, password_encrypted) VALUES (101, 'one', 'fixture.invalid', 3306, 'fixture', 'unused'), (102, 'two', 'fixture.invalid', 3306, 'fixture', 'unused')");
  }, 60_000);
  beforeEach(async () => {
    for (const table of ['investigation_results','investigation_evidence','investigation_stream_events','investigation_stream_heads','investigation_observed_sources',
      'investigation_budget_resources','investigation_budget_ledger','investigation_budget_domains',
      'investigation_admission_keys','investigation_create_keys','investigation_members','investigation_resources','investigation_requests','investigations',
      'agent_canonical_facts','agent_runs','chat_session_shares','chat_messages','chat_sessions','workflow_jobs','outbox_events']) await pool.query(`DELETE FROM ${table}`);
    await pool.query('DELETE FROM user_roles'); await pool.query('DELETE FROM instance_permissions');
    await pool.query("UPDATE users SET status='active' WHERE id IN (101,102,103)");
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES (101,101),(102,101),(103,101)');
    await pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (101,101,'read-only'),(101,102,'read-only'),(102,101,'read-only'),(102,102,'read-only'),(103,101,'read-only'),(103,102,'read-only')");
    owner = await contexts.loadActiveActor(101); viewer = await contexts.loadActiveActor(102); ordinary = await contexts.loadActiveActor(103);
    const created = await bridge.create(owner, { idempotencyKey: randomUUID(), title: 'T05', goal: 'Inspect', profileId: 'ops', profileVersion: 1,
      resources: [{ type: 'instance', id: 101, role: 'primary' }, { type: 'instance', id: 102, role: 'related' }],
      context: { subject: { kind: 'resource', resource: { type: 'instance', id: 101 } } } }, { message: 'Inspect', idempotencyKey: randomUUID() });
    inv = { ...created.investigation, context: { subject: { kind: 'resource', resource: { type: 'instance', id: 101 } } } };
    await pool.query("INSERT INTO investigation_members (investigation_id,user_id,role,granted_by) VALUES (?,102,'viewer',101)", [inv.id]);
    await pool.query("INSERT INTO chat_session_shares (session_id,granted_by,recipient_user_id,permission) VALUES (?,101,103,'read')", [inv.sessionId]);
    const accepted = created.acceptance!;
    const job = await new MysqlWorkflowStore(() => pool as never).claim('t05-worker', 60, { types: ['investigation.execute'], exclude: false });
    const [request] = await rows('SELECT message_id FROM investigation_requests WHERE id = ?', [accepted.requestId]);
    const { run } = await new AgentRunService(() => pool as never).claim(owner.userId, inv.sessionId, request.message_id, `investigation:${accepted.requestId}`);
    binding = { investigationId: inv.id, requestId: accepted.requestId, runId: run.id, jobId: job!.id, workerId: 't05-worker', fencingToken: job!.fencingToken };
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { if (!/^inv_observation_\d+_[a-f0-9]+$/.test(database)) throw new Error('UNSAFE_TEST_SCHEMA'); await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });
  const facts = () => [
    { id: 'call-m', role: 'assistant', content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'get_instance_summary', arguments: '{"instance_id":101}' } }],
      source: 'fact', runId: binding.runId, turnId: (inv as any).turnId },
    { id: 'tool-m', role: 'tool', content: '{"qps":7,"password":"fake-secret"}', tool_call_id: 'tool-1', source: 'fact', runId: binding.runId, turnId: (inv as any).turnId },
  ] as any;
  async function appendFacts() {
    inv.turnId = (await rows('SELECT message_id FROM investigation_requests WHERE id=?',[binding.requestId]))[0].message_id;
    await tx(c => canonical.appendInvestigationToolFacts(c, owner, binding, facts(), 0));
  }

  it('captures every Parts commit, exact duplicate checkpoints do not increment the durable cursor', async () => {
    const start = await stream.snapshot(owner, inv.id);
    await appendFacts();
    const middle = await stream.snapshot(owner, inv.id);
    expect(middle.documents.some(d => d.id === 'tool-m')).toBe(true);
    expect(JSON.stringify(middle)).not.toContain('fake-secret');
    await appendFacts();
    const repeated = await stream.snapshot(owner, inv.id);
    expect(repeated.watermark).toBe(middle.watermark);
    const replay = await stream.replay(owner, inv.id, start.watermark);
    expect(replay.events.filter(e => e.type === 'parts.operation')).toHaveLength(2);
    const reconstructed = new InvestigationStreamStore(() => pool, authorization);
    expect((await reconstructed.snapshot(owner, inv.id)).projectionHash).toBe(repeated.projectionHash);
  });
  it('partial->completed Parts revisions replay without adding a duplicate tool call', async () => {
    inv.turnId=(await rows('SELECT message_id FROM investigation_requests WHERE id=?',[binding.requestId]))[0].message_id;
    await tx(c=>canonical.appendInvestigationToolFacts(c,owner,binding,facts().slice(0,1),0));
    await appendFacts();const replay=await stream.replay(owner,inv.id,0);
    const state=reduceInvestigationEvents(emptyInvestigationProjection(inv.id),replay.events);
    expect(state.runs[binding.runId].parts.filter(p=>p.part.type==='tool_call')).toHaveLength(1);
    expect(state.documents.find(d=>d.id==='call-m')?.status).toBe('completed');
    expect(replay.events.filter(e=>e.type==='parts.operation'&&e.payload.operations.some(op=>op.type==='parts.persisted'&&op.documents.some(d=>d.id==='call-m')))).toHaveLength(2);
    expect((await bridge.facts(viewer,inv.id)).documents.map(d=>d.id)).toEqual([inv.turnId,'call-m','tool-m']);
  });
  it('rolls back fact conflicts and never advances checkpoint or cursor', async () => {
    await appendFacts(); const before = await stream.snapshot(owner, inv.id);
    const changed = facts(); changed[1].content = 'different';
    await expect(tx(c => canonical.appendInvestigationToolFacts(c,owner,binding,changed,0,{ marker:'must-not-commit' }))).rejects.toThrow('CANONICAL_ID_CONFLICT');
    expect((await stream.snapshot(owner,inv.id)).watermark).toBe(before.watermark);
    expect((await rows('SELECT metadata FROM chat_sessions WHERE session_id=?',[inv.sessionId]))[0].metadata).toBeNull();
  });
  it('orders/deduplicates replay and rebuilds identical Parts after process recreation', async () => {
    await appendFacts();
    const all = await stream.replay(owner,inv.id,0);
    const state = reduceInvestigationEvents(emptyInvestigationProjection(inv.id), [...all.events].reverse().concat(all.events));
    expect(state.sequence).toBe(all.watermark);
    const first = await stream.snapshot(owner,inv.id), second = await new InvestigationStreamStore(() => pool,authorization).snapshot(owner,inv.id);
    expect(first.projectionHash).toBe(second.projectionHash);
    expect(Object.values(state.runs).flatMap(r=>r.parts).map(p=>p.part.id).sort())
      .toEqual(Object.values(first.projection.runs).flatMap(r=>r.parts).map(p=>p.part.id).sort());
  });
  it('records source tombstones beyond event retention and returns replay_required for expired/future cursors', async () => {
    const snap = await stream.snapshot(owner,inv.id);
    // Explicitly simulate a 91-day-old retained prefix in this isolated schema.
    await pool.query('UPDATE investigation_stream_events SET occurred_at = DATE_SUB(NOW(), INTERVAL 91 DAY) WHERE investigation_id=?',[inv.id]);
    await stream.prune(owner,inv.id,new Date(Date.now()-90*86_400_000).toISOString());
    expect(await stream.replay(owner,inv.id,0)).toMatchObject({ replayRequired:true, events:[] });
    expect((await stream.snapshot(owner,inv.id)).watermark).toBe(snap.watermark);
    expect(await stream.replay(owner,inv.id,snap.watermark+1)).toMatchObject({ replayRequired:true });
  });
  it('evidence is redacted in actual SQL, concurrent same key is idempotent, changed payload conflicts', async () => {
    const value=input(); const saved=await Promise.all(Array.from({length:12},()=>evidence.put(owner,binding,'capture',value)));
    expect(new Set(saved.map(e=>e.id)).size).toBe(1);
    const [row]=await rows('SELECT * FROM investigation_evidence'); expect(JSON.stringify(row)).not.toMatch(/fake-secret|private-value/);
    expect((await evidence.get(owner,inv.id,saved[0].id,true)).raw).toMatchObject({ value:null });
    await expect(evidence.put(owner,binding,'capture',{...value,summary:'changed'})).rejects.toMatchObject({code:'IDEMPOTENCY_PAYLOAD_MISMATCH'});
  });
  it('raw expiry returns a tombstone, purges SQL, preserves result references and refuses new proof', async () => {
    const saved=await evidence.put(owner,binding,'expired',input());
    const r=await results.put(owner,binding,'first',0,result([saved.id]));
    await pool.query('UPDATE investigation_evidence SET expires_at=DATE_SUB(NOW(),INTERVAL 1 DAY) WHERE id=?',[saved.id]);
    expect(await evidence.get(owner,inv.id,saved.id,true)).toMatchObject({status:'expired',expiryReason:'RETENTION_EXPIRED',contentHash:saved.contentHash});
    expect((await rows('SELECT raw_json FROM investigation_evidence'))[0].raw_json).toBeNull();
    expect((await results.list(owner,inv.id)).items[0].id).toBe(r.id);
    await expect(results.put(owner,binding,'second',1,result([saved.id]))).rejects.toMatchObject({code:'EVIDENCE_EXPIRED'});
  });
  it('concurrent result versions/idempotency remain atomic with an event in the same transaction', async () => {
    const saved=await evidence.put(owner,binding,'capture',input()), candidate=result([saved.id]);
    const versions=await Promise.all(Array.from({length:12},()=>results.put(owner,binding,'same',0,candidate)));
    expect(new Set(versions.map(r=>r.id)).size).toBe(1); expect(versions[0].version).toBe(1);
    const competing=await Promise.allSettled(['a','b'].map(k=>results.put(owner,binding,k,1,candidate)));
    expect(competing.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await results.list(owner,inv.id)).items.map(r=>r.version)).toEqual([2,1]);
    expect((await stream.replay(owner,inv.id,0)).events.filter(e=>e.type==='result.persisted')).toHaveLength(2);
  });
  it('foreign investigation/evidence/original request/Run/subject/version are rejected', async () => {
    const saved=await evidence.put(owner,binding,'capture',input());
    await expect(evidence.get(owner,randomUUID(),saved.id)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    await expect(results.put(owner,{...binding,requestId:randomUUID()},'bad',0,result([saved.id]))).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    await expect(results.put(owner,binding,'bad',0,result([randomUUID()]))).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    await expect(results.put(owner,binding,'bad',1,result())).rejects.toMatchObject({code:'VERSION_CONFLICT'});
    await expect(results.put(owner,binding,'bad',0,{...result(),provenance:{...result().provenance,runtimeRunId:'foreign'}})).rejects.toMatchObject({code:'INVESTIGATION_INPUT_INVALID'});
    await expect(results.put(owner,binding,'bad',0,{...result(),subject:{kind:'resource',resource:{type:'instance',id:102}}})).rejects.toMatchObject({code:'INVESTIGATION_INPUT_INVALID'});
  });
  it('rejects an existing foreign evidence ID and an existing Run of another investigation', async () => {
    const other = await bridge.create(owner, { idempotencyKey:randomUUID(),title:'Other',goal:'Inspect',profileId:'ops',profileVersion:1,
      resources:[{type:'instance',id:101,role:'primary'}],context:{subject:{kind:'resource',resource:{type:'instance',id:101}}} },{message:'Other',idempotencyKey:randomUUID()});
    const request=other.acceptance!.requestId, [stored]=await rows('SELECT message_id FROM investigation_requests WHERE id=?',[request]);
    const {run}=await new AgentRunService(()=>pool as never).claim(101,other.investigation.sessionId,stored.message_id,`investigation:${request}`);
    const foreign=await evidence.put(owner,{investigationId:other.investigation.id,requestId:request,runId:run.id},'foreign',input());
    await expect(evidence.get(owner,inv.id,foreign.id,true)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    await expect(results.put(owner,binding,'cross',0,result([foreign.id]))).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    await expect(evidence.put(owner,{...binding,runId:run.id},'cross',input())).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    expect(await rows('SELECT * FROM investigation_results')).toEqual([]);
  });
  it('an invisible resource reference suppresses the entire derived result page', async () => {
    const saved=await evidence.put(owner,binding,'capture',input());await results.put(owner,binding,'r',0,result([saved.id]));
    // Simulate an imported historical reference carrying additional scope;
    // normal T05 writes reject this out-of-bound resource at creation.
    const [row]=await rows('SELECT metadata_json FROM investigation_evidence WHERE id=?',[saved.id]);
    await pool.query('UPDATE investigation_evidence SET metadata_json=? WHERE id=?',[JSON.stringify({...row.metadata_json,resources:[{type:'instance',id:999}]}),saved.id]);
    await expect(results.list(owner,inv.id)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    await expect(stream.snapshot(owner,inv.id)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
  });
  it('read shares cannot observe or append; viewers read but cannot append; multi-resource ACL withdraws all content', async () => {
    const saved=await evidence.put(owner,binding,'capture',input());
    expect(await evidence.get(viewer,inv.id,saved.id)).toMatchObject({id:saved.id});
    await expect(stream.snapshot(ordinary,inv.id)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    await expect(evidence.put(viewer,binding,'viewer',input())).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    await pool.query('DELETE FROM instance_permissions WHERE user_id=102 AND instance_id=102');
    await expect(stream.snapshot(viewer,inv.id)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    await expect(evidence.get(viewer,inv.id,saved.id)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    await expect(results.list(viewer,inv.id)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
  });
  it('HTTP JWT content routes enforce no-store, bounds and raw-expired 410 after authorization', async () => {
    const app=Fastify();
    const verify=async(req:any)=>{req.user=await contexts.authenticateAccessToken(req.headers.authorization?.slice(7),process.env.JWT_SECRET_KEY!,'t05-http');};
    await registerInvestigationRoutes(app,verify,bridge,{stream,evidence,results});
    try {
      const auth={authorization:`Bearer ${signAccessToken(owner,process.env.JWT_SECRET_KEY!)}`};
      const saved=await evidence.put(owner,binding,'capture',input());
      const page=await app.inject({url:`/api/investigations/${inv.id}/events?after=0`,headers:auth});
      expect(page.statusCode).toBe(200); expect(page.headers['cache-control']).toBe('private, no-store');
      expect((await app.inject({url:`/api/investigations/${inv.id}/events?limit=201`,headers:auth})).statusCode).toBe(400);
      await pool.query('UPDATE investigation_evidence SET expires_at=DATE_SUB(NOW(),INTERVAL 1 DAY) WHERE id=?',[saved.id]);
      expect((await app.inject({url:`/api/investigations/${inv.id}/evidence/${saved.id}?raw=true`,headers:auth})).statusCode).toBe(410);
      await pool.query('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=102');
      expect((await app.inject({url:`/api/investigations/${inv.id}/evidence/${saved.id}?raw=true`,headers:auth})).statusCode).toBe(404);
    } finally {await app.close();}
  });
  it('atomic result/event rollback preserves version and committed evidence on a real SQL failure', async () => {
    const candidate=result();
    await pool.query("CREATE TRIGGER t05_fail_result_event BEFORE INSERT ON investigation_stream_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'T05_INJECTED_FAILURE'");
    try { await expect(results.put(owner,binding,'failure',0,candidate)).rejects.toThrow('T05_INJECTED_FAILURE'); }
    finally { await pool.query('DROP TRIGGER t05_fail_result_event'); }
    expect(await rows('SELECT * FROM investigation_results')).toEqual([]);
    expect(await rows('SELECT * FROM investigation_stream_heads')).toEqual([]);
    expect((await results.put(owner,binding,'failure',0,candidate)).version).toBe(1);
  });
  it('periodic ACL catches membership/disablement with no new events and suppresses a snapshot withdrawn before send', async () => {
    const watch=new InvestigationWatchService(stream,60_000), sent:any[]=[];let closed=false;
    const peer={send:(e:any)=>{sent.push(e);return true;},close:()=>{closed=true;}};
    try {await watch.watch(peer,viewer,inv.id);await pool.query('DELETE FROM investigation_members WHERE investigation_id=? AND user_id=102',[inv.id]);
      await watch.tick();expect(closed).toBe(true);expect(sent).toHaveLength(1);}
    finally {watch.dispose();}
    const original=stream.snapshot.bind(stream);
    stream.snapshot=async(...args)=>{const snapshot=await original(...args);await pool.query('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=102');return snapshot;};
    const late=new InvestigationWatchService(stream,60_000), events:any[]=[];
    try {await expect(late.watch({send:(e:any)=>{events.push(e);return true;},close:()=>{}},owner,inv.id)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});expect(events).toEqual([]);}
    finally {stream.snapshot=original;late.dispose();}
  });
  it('unknown is a partial resolution, never completion or a rewrite of a cancelled Run', async () => {
    await pool.query("UPDATE agent_runs SET state='partial',result_json=?,finished_at=NOW() WHERE id=?",[JSON.stringify({resolution:{kind:'partial',reasonCode:'INVESTIGATION_PROVIDER_UNKNOWN'}}),binding.runId]);
    const unknown=await stream.snapshot(owner,inv.id);expect(unknown.runs[0]).toMatchObject({state:'partial',resolution:'outcome_unknown'});
    expect((await results.list(owner,inv.id)).items[0].result).toMatchObject({schemaVersion:2,rootCauseVerification:{status:'unverified'},problemStatus:'unconfirmed'});
    expect((await rows('SELECT state FROM agent_runs'))[0].state).toBe('partial');
  });
  it('original Run consumes a controlled Provider/tool through the real executor and persists evidence and V2 summary', async () => {
    let providerCalls=0,toolCalls=0;
    const provider:LLMProvider={getDefaultModel:()=> 'fixture',getModelCapabilities:()=>({model:'fixture',contextWindowTokens:32768,preferredOutputTokens:4096,source:'configuration',version:'fixture/v1'}),
      chat:async()=>{providerCalls++;return {content:providerCalls===1?null:'根因待核验',finishReason:providerCalls===1?'tool_calls':'stop',
        toolCalls:providerCalls===1?[{id:'metrics-call',name:'get_instance_summary',arguments:{instance_id:101}}]:[],hasToolCalls:providerCalls===1,shouldExecuteTools:providerCalls===1,
        usage:{prompt_tokens:20,completion_tokens:10,cached_tokens:5}};},chatStream:async()=>{throw new Error('NO_EXTERNAL_MODEL');}};
    const tools=new ToolRegistry();tools.register({name:'get_instance_summary',description:'Readonly fixture',parameters:{type:'object',properties:{instance_id:{type:'number'}}},readOnly:true,concurrencySafe:true,exclusive:false,
      execute:async()=>{toolCalls++;return {success:true,qps:null,password:'fake-secret',sql:"SELECT * FROM t WHERE email='private-value'"};}});
    const executor=new InvestigationExecutor({pool:()=>pool,authorization,providerForPurpose:async()=>provider,toolsForActor:()=>tools,
      budget:{domain:'t05-controlled-fixture',policy:investigationBudgetConfiguration().policy,reserveCostMicros:1000000,prices:{input:100,cachedInput:50,output:200}}});
    const terminal=await executor.execute({investigationId:inv.id,requestId:binding.requestId,
      job:{id:binding.jobId,type:'investigation.execute',payload:{investigationId:inv.id,requestId:binding.requestId},attempts:1,maxAttempts:5,fencingToken:binding.fencingToken},
      context:{workerId:binding.workerId,fencingToken:binding.fencingToken,signal:new AbortController().signal}});
    expect(terminal.state).toBe('completed');expect(providerCalls).toBe(2);expect(toolCalls).toBe(1);
    const snapshot=await stream.snapshot(owner,inv.id);expect(snapshot.evidenceIds).toHaveLength(1);expect(snapshot.results).toHaveLength(1);
    expect(JSON.stringify(await evidence.get(owner,inv.id,snapshot.evidenceIds[0],true))).not.toMatch(/fake-secret|private-value/);
    const summary=(await results.list(owner,inv.id)).items[0];expect(summary.result.rootCauseVerification).toEqual({status:'unverified'});
    expect(summary.result.provenance).toMatchObject({runtimeRunId:terminal.id,usageStatus:'available',modelVersion:'unavailable'});
    const restart=await new InvestigationStreamStore(()=>pool,authorization).snapshot(owner,inv.id);
    expect(restart.projectionHash).toBe(snapshot.projectionHash);expect(restart.results).toEqual(snapshot.results);
  });
  it('snapshot->subscription gap catches commits; unwatch supersedes a pending snapshot; periodic ACL closes without cancelling Run', async () => {
    const watch=new InvestigationWatchService(stream,60_000), sent:any[]=[]; let closed=false;
    const peer={send:(e:any)=>{sent.push(e);return true;},close:()=>{closed=true;}};
    const original=stream.snapshot.bind(stream);
    stream.snapshot=async(...args)=>{const snap=await original(...args); await evidence.put(owner,binding,'gap',input());return snap;};
    try {
      await watch.watch(peer,viewer,inv.id); const snap=sent[0]; expect(snap.type).toBe('investigation.snapshot');
      await watch.tick(); expect(sent.some(e=>e.type==='investigation.event'&&e.event.type==='evidence.added'&&e.event.sequence>snap.watermark)).toBe(true);
      await pool.query('DELETE FROM instance_permissions WHERE user_id=102 AND instance_id=102');
      await watch.tick(); expect(closed).toBe(true);
      expect((await rows('SELECT state FROM agent_runs WHERE id=?',[binding.runId]))[0].state).toBe('running');
    } finally {stream.snapshot=original;watch.dispose();}
    let release!:()=>void; const barrier=new Promise<void>(r=>{release=r;});
    stream.snapshot=async(...args)=>{const snap=await original(...args);await barrier;return snap;};
    const pending=new InvestigationWatchService(stream,60_000), events:any[]=[];
    const other={send:(e:any)=>{events.push(e);return true;},close:()=>{}};
    try {const promise=pending.watch(other,owner,inv.id); pending.unwatch(other,inv.id);release();await promise;expect(events).toEqual([]);}
    finally {stream.snapshot=original;pending.dispose();}
  });
  it('actual DirectAdapter WS authenticates JWT, watches, reconnects hash, unwatch and live revocation preserve Run', async () => {
    const workspace=await mkdtemp(join(tmpdir(),'slide-t05-ws-'));
    const savedPort=process.env.AGENT_WS_PORT; process.env.AGENT_WS_PORT='0';
    const watch=new InvestigationWatchService(stream,25);
    const adapter=new DirectAdapter({tools:new ToolRegistry(),llmProvider:{} as LLMProvider,actorContextService:contexts,
      investigationWatchService:watch,workspace,heartbeatIntervalMs:60_000});
    const sockets:WebSocket[]=[];
    const connect=async()=>{const ws=new WebSocket(`ws://127.0.0.1:${(adapter as any).wsServer.address().port}/ws`);sockets.push(ws);
      await once(ws,'open');const events:any[]=[];ws.on('message',v=>events.push(JSON.parse(v.toString())));
      ws.send(JSON.stringify({type:'auth',token:signAccessToken(owner,process.env.JWT_SECRET_KEY!)}));
      await eventually(()=>events.some(e=>e.type==='auth_ok'));return {ws,events};};
    try {
      await adapter.start(); if (!(adapter as any).wsServer.address()) await once((adapter as any).wsServer,'listening');
      const one=await connect();one.ws.send(JSON.stringify({type:'investigation.watch',id:inv.id}));
      await eventually(()=>one.events.some(e=>e.type==='investigation.snapshot'));
      const hash=one.events.find(e=>e.type==='investigation.snapshot').projectionHash;
      one.ws.close();await once(one.ws,'close'); expect((await rows('SELECT state FROM agent_runs'))[0].state).toBe('running');
      const two=await connect();two.ws.send(JSON.stringify({type:'investigation.watch',id:inv.id,afterSequence:0}));
      await eventually(()=>two.events.some(e=>e.type==='investigation.snapshot'));
      expect(two.events.find(e=>e.type==='investigation.snapshot').projectionHash).toBe(hash);
      two.ws.send(JSON.stringify({type:'investigation.unwatch',id:inv.id})); await eventually(()=>!(watch as any).peers.size);
      const count=two.events.length;await evidence.put(owner,binding,'after-unwatch',input());await watch.tick();expect(two.events).toHaveLength(count);
      two.ws.send(JSON.stringify({type:'investigation.watch',id:inv.id}));await eventually(()=>two.events.filter(e=>e.type==='investigation.snapshot').length===2);
      const closing=once(two.ws,'close');await pool.query('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=102');await watch.tick();
      expect((await closing)[0]).toBe(4001); expect((await rows('SELECT state FROM agent_runs'))[0].state).toBe('running');
    } finally {for(const ws of sockets)ws.terminate();await adapter.dispose(); if(savedPort===undefined)delete process.env.AGENT_WS_PORT;else process.env.AGENT_WS_PORT=savedPort;await rm(workspace,{recursive:true,force:true});}
  },20_000);
});
async function eventually(check:()=>boolean):Promise<void>{
  const deadline=Date.now()+5000;
  while(!check()){if(Date.now()>deadline)throw new Error('OBSERVATION_TIMEOUT');await new Promise(r=>setTimeout(r,10));}
}
