/** Opt-in isolated MySQL + real WS test:
 * DB_HOST=127.0.0.1 DB_PORT=<isolated mysql port> DB_USER=root DB_PASSWORD='' pnpm --filter slide-api exec tsx tests/durable-completion.integration.ts
 * Creates/drops only its own random database. No model/network credentials required.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import { WebSocket } from 'ws';
import { ToolRegistry } from '@slide/agent-core';
import { DirectAdapter } from '../src/adapter/direct-adapter.js';
import { dbConnection } from '../src/db-connection.js';
import { agentRunService, AgentRunService } from '../src/adapter/agent-run-service.js';

const database = `max56_${randomUUID().replaceAll('-', '')}`;
const config = { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' };
const admin = await mysql.createConnection(config);
const workspace = await mkdtemp(join(tmpdir(), 'slide-max56-'));
const sockets: WebSocket[] = [];
let adapter: DirectAdapter | undefined;
let created = false;
let calls = 0;
let hold: Promise<void> = Promise.resolve();
let release = () => {};
const actor = { userId: 74, username: 'fixture', roles: ['viewer'], permissions: [], sessionVersion: 1, instanceScopes: {}, requestId: 'max56' };
const answer = { content: 'durable answer', finishReason: 'stop', toolCalls: [], usage: {}, shouldExecuteTools: false, hasToolCalls: false };
async function start() {
  adapter = new DirectAdapter({ workspace, tools: new ToolRegistry(), llmProvider: {
    getDefaultModel: () => 'fixture', chat: async () => answer,
    chatStream: async (_m: any, _t: any, callbacks: any) => {
      calls++; await callbacks.onContentDelta(answer.content); await hold; return answer;
    },
  } as any, actorContextService: { authenticateAccessToken: async () => actor, revalidateActor: async () => actor } });
  await adapter.start();
  const server = (adapter as any).wsServer;
  if (!server.address()) await once(server, 'listening');
  return server.address().port as number;
}
async function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`); sockets.push(socket);
  const events: any[] = [];
  socket.on('message', raw => events.push(JSON.parse(raw.toString())));
  await once(socket, 'open');
  const wait = async (type: string) => {
    for (let i = 0; i < 250; i++) {
      const event = events.find(e => e.type === type);
      if (event) return event;
      await delay(20);
    }
    throw new Error(`Missing ${type}: ${JSON.stringify(events)}`);
  };
  socket.send(JSON.stringify({ type: 'auth', token: 'fixture' })); await wait('auth_ok');
  return { socket, events, wait, send: (frame: any) => socket.send(JSON.stringify(frame)) };
}
const frame = () => ({ type: 'chat.send', protocolVersion: 2, messageId: randomUUID(), idempotencyKey: randomUUID(), message: 'answer once' });
async function check(runId: string, state: string, assistantCount: number) {
  const pool = dbConnection.getPool()!;
  const [runs] = await pool.query<any[]>('SELECT * FROM agent_runs WHERE id = ?', [runId]);
  assert.equal(runs[0].state, state);
  const [messages] = await pool.query<any[]>('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id', [runs[0].session_id]);
  assert.equal(messages.filter(m => m.role === 'assistant').length, assistantCount);
  assert.equal(messages.filter(m => m.role === 'user').length, 1);
  if (assistantCount) assert.equal(messages.at(-1).content, answer.content);
  return runs[0];
}
try {
  await admin.query(`CREATE DATABASE ${mysql.escapeId(database)}`); created = true;
  await admin.query(`USE ${mysql.escapeId(database)}`);
  const schema = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
  for (const table of ['chat_sessions', 'chat_messages']) {
    const ddl = schema.match(new RegExp('CREATE TABLE IF NOT EXISTS `' + table + '`[\\s\\S]*?;'))![0];
    await admin.query(ddl);
  }
  await admin.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY)');
  const shares = await readFile(new URL('../sql/migrations/025_security_actor_context.sql', import.meta.url), 'utf8');
  await admin.query(shares.match(/CREATE TABLE IF NOT EXISTS `chat_session_shares`[\s\S]*?;/)![0]);
  await admin.query(await readFile(new URL('../sql/migrations/028_agent_runs.sql', import.meta.url), 'utf8'));
  await admin.query(await readFile(new URL('../sql/migrations/086_agent_run_global_idempotency.sql', import.meta.url), 'utf8'));
  assert.equal(await dbConnection.initialize({ ...config, database }), true);
  process.env.AGENT_WS_PORT = '0'; process.env.AGENT_WS_HOST = '127.0.0.1';
  process.env.JWT_SECRET_KEY = 'isolated-max56-fixture-secret-long-enough';
  let port = await start();
  console.log(JSON.stringify({ pid: process.pid, port, cwd: process.cwd(), command: process.argv.slice(1),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), database }));

  for (const fault of ['assistant-insert', 'run-terminal']) {
    const trigger = fault === 'assistant-insert'
      ? "CREATE TRIGGER fail_completion BEFORE INSERT ON chat_messages FOR EACH ROW BEGIN IF NEW.role = 'assistant' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INJECTED_ASSISTANT_FAILURE'; END IF; END"
      : "CREATE TRIGGER fail_completion BEFORE UPDATE ON agent_runs FOR EACH ROW BEGIN IF NEW.state = 'completed' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INJECTED_TERMINAL_FAILURE'; END IF; END";
    await admin.query(trigger);
    const client = await connect(port); const request = frame(); const before = calls;
    client.send(request);
    const failed = await client.wait('error'); const started = await client.wait('run.started');
    assert.equal(failed.code, 'COMPLETION_STORAGE_FAILED', JSON.stringify(failed)); assert.equal(failed.retryable, true);
    assert.equal(client.events.some(e => e.type === 'complete'), false);
    const pending = await check(started.runId, 'running', 0);
    assert.equal(pending.result_json.completionPending, true);
    assert.equal(pending.result_json.event.finalContent, answer.content);
    // Repeat while storage is still broken: no new model call, no duplicated user.
    client.events.length = 0; client.send(request); await client.wait('error');
    await check(started.runId, 'running', 0); assert.equal(calls, before + 1);
    await admin.query(`DROP TRIGGER fail_completion`);
    client.socket.terminate(); await adapter!.dispose(); port = await start();
    const reconnected = await connect(port);
    if (fault === 'assistant-insert') reconnected.send(request);
    else reconnected.send({ type: 'chat.watch', sessionKey: pending.session_id });
    const snapshot = await reconnected.wait('run.snapshot');
    assert.equal(snapshot.run.state, 'completed'); await check(started.runId, 'completed', 1);
    assert.equal(snapshot.run.result.event.messageSequence > 0, true);
    reconnected.events.length = 0; reconnected.send(request);
    assert.equal((await reconnected.wait('run.snapshot')).run.state, 'completed');
    await check(started.runId, 'completed', 1); assert.equal(calls, before + 1);
    reconnected.socket.terminate();
    console.log(`PASS ${fault}: rollback, durable intent, failed retry, adapter restart, replay/watch recovery, no duplicate`);
  }

  // Disconnect during generation; another socket observes completion only after DB commit.
  hold = new Promise(resolve => { release = resolve; });
  const first = await connect(port); const request = frame(); const before = calls;
  first.send(request); const started = await first.wait('run.started'); await first.wait('text_delta');
  first.socket.terminate();
  const retry = await connect(port); retry.send(request);
  assert.equal((await retry.wait('run.snapshot')).run.state, 'running');
  release(); await retry.wait('complete'); await check(started.runId, 'completed', 1);
  const types = retry.events.map(e => e.type);
  assert.equal(types.lastIndexOf('run.snapshot') < types.indexOf('complete'), true);
  assert.equal(calls, before + 1); retry.socket.terminate();
  console.log('PASS disconnect during generation: exactly one model call; terminal snapshot precedes complete; database already committed');

  // Simulate lost COMMIT acknowledgement after the server committed.
  const session = randomUUID();
  await admin.query('INSERT INTO chat_sessions (session_id, user_id, title) VALUES (?, ?, ?)', [session, actor.userId, 'commit-ack']);
  const claimed = await agentRunService.claim(actor.userId, session, randomUUID(), randomUUID());
  const pool = dbConnection.getPool()!;
  const ambiguous = new AgentRunService(() => ({ query: pool.query.bind(pool), getConnection: async () => {
    const connection = await pool.getConnection();
    return { query: connection.query.bind(connection), beginTransaction: connection.beginTransaction.bind(connection),
      rollback: connection.rollback.bind(connection), release: connection.release.bind(connection),
      commit: async () => { await connection.commit(); throw new Error('INJECTED_LOST_COMMIT_ACK'); } };
  } }) as any);
  await assert.rejects(ambiguous.complete(claimed.run, { type: 'complete', finalContent: answer.content }), /LOST_COMMIT_ACK/);
  const replay = await agentRunService.findByIdempotencyKey(actor.userId, claimed.run.idempotencyKey);
  assert.equal(replay!.state, 'completed');
  await agentRunService.recoverCompletion(replay!);
  const [count] = await pool.query<any[]>('SELECT COUNT(*) n FROM chat_messages WHERE session_id = ?', [session]);
  assert.equal(count[0].n, 1);
  console.log('PASS lost commit acknowledgement: replay confirms completed, exactly one durable answer');

  // Two independent service instances race to submit the same durable intent.
  const concurrent = await agentRunService.claim(actor.userId, session, randomUUID(), randomUUID());
  const event = { type: 'complete' as const, finalContent: answer.content };
  const results = await Promise.all([
    new AgentRunService().complete(concurrent.run, event),
    new AgentRunService().complete(concurrent.run, event),
  ]);
  assert.equal(results.every(run => run.state === 'completed'), true);
  const [deduped] = await pool.query<any[]>('SELECT COUNT(*) n FROM chat_messages WHERE message_id = ?', [`run_${concurrent.run.id}_assistant`]);
  assert.equal(deduped[0].n, 1);
  const cancelled = await agentRunService.claim(actor.userId, session, randomUUID(), randomUUID());
  assert.equal(await agentRunService.cancelForActor(cancelled.run.id, actor.userId, session), true);
  assert.equal((await agentRunService.complete(cancelled.run, event)).state, 'cancelled');
  const [absent] = await pool.query<any[]>('SELECT COUNT(*) n FROM chat_messages WHERE message_id = ?', [`run_${cancelled.run.id}_assistant`]);
  assert.equal(absent[0].n, 0);
  console.log('PASS concurrent completions deduplicate and cancellation wins without a false completed transition');

} finally {
  release(); for (const socket of sockets) socket.terminate();
  await adapter?.dispose(); await dbConnection.close();
  if (created) await admin.query(`DROP DATABASE ${mysql.escapeId(database)}`);
  await admin.end(); await rm(workspace, { recursive: true, force: true });
}
