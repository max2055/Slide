/** Isolated real MySQL + JSONL qualification; controlled provider, no paid calls. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import { chatDatabaseService } from '../../apps/db-ops-api/src/chat-database-service.js';
import { CanonicalStore, canonicalStore } from '../../apps/db-ops-api/src/adapter/canonical-store.js';
import { AgentRunService } from '../../apps/db-ops-api/src/adapter/agent-run-service.js';
import { DirectAdapter } from '../../apps/db-ops-api/src/adapter/direct-adapter.js';
import { ToolRegistry, Session, SessionManager, checkpointFacts } from '../../packages/agent-core/src/index.js';
import type { ActorContext } from '../../apps/db-ops-api/src/auth/actor-context.js';
const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const database = `slide_canonical_${randomUUID().replaceAll('-', '')}`;
const workspace = await mkdtemp(join(tmpdir(), 'slide-canonical-'));
const connection = await mysql.createConnection({ host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD });
let adapter: DirectAdapter | undefined;
try {
  await connection.query(`CREATE DATABASE \`${database}\``);
  process.env.DB_NAME = database;
  process.env.JWT_SECRET_KEY = randomUUID() + randomUUID(); process.env.ENCRYPTION_KEY = randomUUID();
  const init = spawnSync('pnpm', ['--filter', 'slide-api', 'exec', 'tsx', 'init-db.ts'], { cwd: new URL('../..', import.meta.url), env: process.env, encoding: 'utf8', timeout: 120_000 });
  if (init.status !== 0) process.stderr.write(init.stdout + init.stderr);
  assert.equal(init.status, 0, 'isolated schema initialization failed');
  assert(await dbConnection.initialize()); const pool = dbConnection.getPool()!;
  const [created] = await pool.execute("INSERT INTO users (username, password_hash, status) VALUES (?, 'not-a-login', 'active')", [`canonical-${randomUUID()}`]) as any;
  const actor: ActorContext = { userId: Number(created.insertId), username: 'canonical-qualification', roles: ['viewer'], permissions: [], sessionVersion: 1, instanceScopes: {}, requestId: randomUUID() };
  const [secondActor] = await pool.execute("INSERT INTO users (username, password_hash, status) VALUES (?, 'not-a-login', 'active')", [`other-${randomUUID()}`]) as any;
  const other = { ...actor, userId: Number(secondActor.insertId) };
  const otherSession = await chatDatabaseService.createSession(other, { title: 'other actor' });
  await chatDatabaseService.addMessage(other, otherSession.session_id, { messageId: 'other-actor-fact', role: 'user', content: 'isolated fact' });
  const session = await chatDatabaseService.createSession(actor, { title: 'canonical qualification' });
  const service = new AgentRunService();
  const expected: string[] = [];
  for (let i = 0; i < 101; i++) {
    const userId = `legacy-user-${i}`;
    await chatDatabaseService.addMessage(actor, session.session_id, { messageId: userId, role: 'user', content: `turn ${i}` });
    const facts = checkpointFacts({ canonical_run_id: `run-${i}`, canonical_turn_id: userId, iteration: 1,
      assistantMessage: { role: 'assistant', content: null, tool_calls: ['a', 'b'].map(n => ({ id: `${i}-${n}`, type: 'function', function: { name: 'read', arguments: '{}' } })) },
      completedToolResults: ['a', 'b'].map(n => ({ role: 'tool', content: `result-${n}`, tool_call_id: `${i}-${n}`, name: 'read' })) }, userId);
    await canonicalStore.appendToolFacts(actor, session.session_id, userId, facts, 1);
    await canonicalStore.appendToolFacts(actor, session.session_id, userId, facts, 1);
    await chatDatabaseService.addMessage(actor, session.session_id, { messageId: `legacy-answer-${i}`, role: 'assistant', content: 'done', parentId: userId });
    expected.push(userId, ...facts.map(f => f.id!), `legacy-answer-${i}`);
  }
  async function allFacts() {
    let before: string | undefined; let facts: any[] = [];
    do { const page = await canonicalStore.getPage(actor, session.session_id, 37, before); facts = [...page.messages, ...facts]; before = page.nextBefore ?? undefined; } while (before);
    return facts;
  }
  const facts = await allFacts(); assert.equal(facts.length, 505); assert.deepEqual(facts.map(f => f.id), expected);
  const hash = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  assert.equal(createHash('sha256').update(JSON.stringify(await allFacts())).digest('hex'), hash);
  const fileManager = new SessionManager(workspace); const file = fileManager.getOrCreate(session.session_id); file.appendFacts(facts);
  await fileManager.save(file, { fsync: true });
  assert.deepEqual(new SessionManager(workspace).getOrCreate(session.session_id).messages, file.messages);
  const projected = new Session(session.session_id); projected.appendFacts(facts); assert.equal(projected.getHistory(7).length, 5);
  await assert.rejects(canonicalStore.getPage(other, session.session_id), /Chat session not found/);
  await assert.rejects(canonicalStore.getPage(actor, 'unowned-session'), /Chat session not found/);
  await assert.rejects(canonicalStore.getPage(actor, otherSession.session_id), /Chat session not found/);
  assert.deepEqual((await canonicalStore.getPage(other, otherSession.session_id)).messages.map(m => m.id), ['other-actor-fact']);
  await assert.rejects(canonicalStore.appendToolFacts(other, session.session_id, 'legacy-user-0', [facts[1]], 1), /Chat session not found/);
  await chatDatabaseService.grantSessionShare(actor, session.session_id, other.userId, 'read');
  assert.equal((await canonicalStore.getPage(other, session.session_id, 1000)).messages.length, 505);
  await assert.rejects(canonicalStore.appendToolFacts(other, session.session_id, 'legacy-user-0', [facts[1]], 1), /Chat session not found/);
  console.log(JSON.stringify({ scenario: '505-real-facts-legacy-ID-pagination-JSONL-roundtrip-actor-isolation', passed: true, hash }));

  // Real COMMIT succeeds, then its acknowledgement is lost. Replay must find one answer.
  const run = (await service.claim(actor.userId, session.session_id, randomUUID(), randomUUID())).run;
  await chatDatabaseService.addMessage(actor, session.session_id, { messageId: `run_${run.id}_user`, role: 'user', content: 'ack loss' });
  const lostAckPool = { query: pool.query.bind(pool), getConnection: async () => {
    const real = await pool.getConnection();
    return { query: real.query.bind(real), beginTransaction: real.beginTransaction.bind(real), rollback: real.rollback.bind(real), release: real.release.bind(real),
      commit: async () => { await real.commit(); throw new Error('INJECTED_COMMIT_ACK_LOST'); } };
  } };
  await assert.rejects(new AgentRunService(() => lostAckPool as any).complete(run, { type: 'complete', finalContent: 'unique answer', resolution: { kind: 'response_ready', reasonCode: 'RESPONSE_READY', retryable: false } }), /ACK_LOST/);
  const durable = await service.getForActor(run.id, actor.userId, session.session_id); assert.equal(durable?.state, 'completed');
  await service.recoverCompletion(durable!);
  const [answers] = await pool.query<any[]>('SELECT * FROM chat_messages WHERE message_id = ?', [`run_${run.id}_assistant`]); assert.equal(answers.length, 1);
  console.log(JSON.stringify({ scenario: 'real-COMMIT-ack-loss-unique-durable-final', passed: true }));

  const toolUser = `run_${randomUUID()}_user`;
  await chatDatabaseService.addMessage(actor, session.session_id, { messageId: toolUser, role: 'user', content: 'tool ack loss' });
  const toolCheckpoint = { canonical_run_id: toolUser, canonical_turn_id: toolUser, iteration: 1,
    assistantMessage: { role: 'assistant', content: null, tool_calls: [{ id: 'ack-tool', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    completedToolResults: [{ role: 'tool', tool_call_id: 'ack-tool', content: 'settled' }], pendingToolCalls: [] };
  const toolFacts = checkpointFacts(toolCheckpoint, toolUser);
  await assert.rejects(new CanonicalStore(() => lostAckPool as any).appendToolFacts(actor, session.session_id, toolUser, toolFacts, 1, toolCheckpoint), /ACK_LOST/);
  await canonicalStore.appendToolFacts(actor, session.session_id, toolUser, toolFacts, 1, toolCheckpoint);
  const [toolRows] = await pool.query<any[]>('SELECT message_id FROM agent_canonical_facts WHERE session_id = ? AND message_id IN (?, ?)', [session.session_id, ...toolFacts.map(m => m.id)]);
  assert.equal(toolRows.length, 2);
  const savedCheckpoint = (await chatDatabaseService.getSessionMetadata(actor, session.session_id))?.canonicalRuntimeCheckpoint as any;
  assert.deepEqual(savedCheckpoint.pendingToolCalls, []);
  console.log(JSON.stringify({ scenario: 'tool-facts-checkpoint-atomic-COMMIT-ack-loss-idempotent-replay', passed: true }));

  const pendingRun = (await service.claim(actor.userId, session.session_id, randomUUID(), randomUUID())).run;
  const failing = new AgentRunService(() => ({ query: pool.query.bind(pool), getConnection: async () => { throw new Error('INJECTED_MYSQL_STORAGE_FAILURE'); } }) as any);
  await assert.rejects(failing.complete(pendingRun, { type: 'complete', finalContent: 'recover pending' }), /STORAGE_FAILURE/);
  const pending = await service.getForActor(pendingRun.id, actor.userId, session.session_id);
  assert.equal(pending?.state, 'running'); assert((pending?.result as any).completionPending);
  await Promise.all([new AgentRunService().recoverCompletion(pending!), new AgentRunService().recoverCompletion(pending!)]);
  const [recovered] = await pool.query<any[]>('SELECT id FROM chat_messages WHERE message_id = ?', [`run_${pendingRun.id}_assistant`]); assert.equal(recovered.length, 1);
  console.log(JSON.stringify({ scenario: 'real-MySQL-pending-failure-service-restart-concurrent-recovery', passed: true }));

  // Adapter uses DB history despite a missing/broken JSONL cache. No real LLM calls.
  let observed: any[] = [];
  const provider: any = { getDefaultModel: () => 'controlled', chatStream: async (messages: any[], _tools: any[], callbacks: any) => {
    observed = messages; await callbacks.onContentDelta('cache independent');
    return { content: 'cache independent', finishReason: 'stop', toolCalls: [], usage: {}, shouldExecuteTools: false, hasToolCalls: false };
  }, chat: async () => { throw new Error('unexpected nonstream request'); } };
  adapter = new DirectAdapter({ workspace, tools: new ToolRegistry(), llmProvider: provider });
  (adapter as any).sessionManager.save = async () => { throw new Error('INJECTED_JSONL_WRITE_FAILURE'); };
  const current = (await service.claim(actor.userId, session.session_id, randomUUID(), randomUUID())).run;
  const currentUser = `run_${current.id}_user`;
  await chatDatabaseService.addMessage(actor, session.session_id, { messageId: currentUser, role: 'user', content: 'new request' });
  let candidate: any;
  const result = await adapter.chat(session.session_id, 'new request', event => { if (event.type === 'complete') candidate = event; }, actor, undefined, current.idempotencyKey, current.id, currentUser);
  assert.equal(result.stopReason, 'completed'); assert(observed.some(m => m.content === 'unique answer'));
  const beforeCommit = await canonicalStore.getPage(actor, session.session_id);
  assert(!beforeCommit.messages.some(m => m.content === 'cache independent'), 'response_ready leaked into canonical facts');
  const committed = await service.complete(current, candidate); assert.equal(committed.state, 'completed');
  const cold = new CanonicalStore(); const coldPage = await cold.getPage(actor, session.session_id);
  assert.equal(coldPage.messages.filter(m => m.content === 'cache independent').length, 1);
  console.log(JSON.stringify({ scenario: 'JSONL-write-failure-DB-rebuild-response-ready-excluded', passed: true }));

  // Explicit retention keeps complete turns and records the deletion boundary.
  await canonicalStore.saveCheckpoint(actor, session.session_id, { pendingToolCalls: [{ id: 'unsettled' }] });
  await assert.rejects(chatDatabaseService.enforceMessageCap(actor, session.session_id, 4), /UNSETTLED/);
  await canonicalStore.saveCheckpoint(actor, session.session_id, null);
  await chatDatabaseService.enforceMessageCap(actor, session.session_id, 4);
  const retained = await canonicalStore.getPage(actor, session.session_id);
  assert(retained.messages[0]?.role === 'user');
  const metadata = await chatDatabaseService.getSessionMetadata(actor, session.session_id); assert((metadata?.canonicalRetentionBoundaries as any[])?.length === 1);
  console.log(JSON.stringify({ scenario: 'explicit-retention-whole-turns-audit-unsettled-denied', passed: true }));
} finally {
  await adapter?.dispose(); await dbConnection.close();
  await connection.query(`DROP DATABASE \`${database}\``); await connection.end(); await rm(workspace, { recursive: true, force: true });
}
