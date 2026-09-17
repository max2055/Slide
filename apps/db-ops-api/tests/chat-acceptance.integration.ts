/** Opt-in: DOTENV_CONFIG_PATH=<local env> pnpm --filter slide-api exec tsx tests/chat-acceptance.integration.ts
 * Requires a local MySQL account with CREATE/DROP DATABASE; clones schema only.
 * Uses real WS, DirectAdapter, AgentRunner and persistence; deterministic LLM/auth fixtures.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import { WebSocket } from 'ws';
import { ToolRegistry, type LLMProvider } from '@slide/agent-core';
import { DirectAdapter } from '../src/adapter/direct-adapter.js';
import { dbConnection } from '../src/db-connection.js';
import { agentRunService } from '../src/adapter/agent-run-service.js';
import type { ActorContext } from '../src/auth/actor-context.js';

const database = `max48_acceptance_${randomUUID().replaceAll('-', '')}`;
const source = process.env.DB_NAME || 'db_ops_ai';
const config = { host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' };
const admin = await mysql.createConnection(config);
const workspace = await mkdtemp(join(tmpdir(), 'slide-max48-'));
const sockets: WebSocket[] = [];
let adapter: DirectAdapter | undefined;
let created = false;
let calls = 0;
let release!: () => void;
const hold = new Promise<void>(resolve => { release = resolve; });
let started!: () => void;
const executionStarted = new Promise<void>(resolve => { started = resolve; });
const actor: ActorContext = { userId: 1, username: 'acceptance-fixture', roles: ['viewer'], permissions: [],
  sessionVersion: 1, instanceScopes: {}, requestId: 'max48-acceptance' };
const response = { content: 'accepted once', finishReason: 'stop', toolCalls: [],
  usage: { prompt_tokens: 1, completion_tokens: 1 }, shouldExecuteTools: false, hasToolCalls: false };
const provider: LLMProvider = {
  getDefaultModel: () => 'acceptance-fixture',
  async chat() { throw new Error('Expected streaming'); },
  async chatStream(_messages, _tools, callbacks) {
    calls++;
    started();
    await hold;
    await callbacks.onContentDelta(response.content);
    return response;
  },
};

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Integration step timed out')), 5000);
    })]);
  } finally { clearTimeout(timer!); }
}

async function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on('message', raw => events.push(JSON.parse(raw.toString())));
  await bounded(once(socket, 'open'));
  const waitFor = async (type: string) => {
    for (let i = 0; i < 250; i++) {
      const event = events.find(item => item.type === type);
      if (event) return event;
      const error = events.find(item => item.type === 'error' || item.type === 'protocol.error');
      if (error) throw new Error(JSON.stringify(error));
      await delay(20);
    }
    throw new Error(`Missing ${type}`);
  };
  socket.send(JSON.stringify({ type: 'auth', token: 'local-test-fixture' }));
  await waitFor('auth_ok');
  return { socket, events, waitFor };
}

try {
  await admin.query(`CREATE DATABASE ${mysql.escapeId(database)}`);
  created = true;
  for (const table of ['agent_runs', 'chat_sessions', 'chat_messages', 'chat_session_shares']) {
    await admin.query(`CREATE TABLE ${mysql.escapeId(database)}.${mysql.escapeId(table)} LIKE ${mysql.escapeId(source)}.${mysql.escapeId(table)}`);
  }
  assert.equal(await dbConnection.initialize({ ...config, database }), true);
  process.env.AGENT_WS_PORT = '0';
  process.env.AGENT_WS_HOST = '127.0.0.1';
  adapter = new DirectAdapter({ tools: new ToolRegistry(), llmProvider: provider, workspace,
    actorContextService: {
      async authenticateAccessToken(token) { assert.equal(token, 'local-test-fixture'); return actor; },
      async revalidateActor() { return actor; },
    },
  });
  await adapter.start();
  const server = (adapter as any).wsServer;
  if (!server.address()) await bounded(once(server, 'listening'));
  const port = server.address().port;
  console.log(JSON.stringify({ pid: process.pid, port, cwd: process.cwd(), command: process.argv.slice(1),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() }));
  const frame = { type: 'chat.send', protocolVersion: 2, messageId: randomUUID(), idempotencyKey: randomUUID(), message: 'Confirm only once' };
  const first = await connect(port);
  first.socket.send(JSON.stringify(frame));
  await bounded(executionStarted);
  // Discard all acceptance frames, including the newly allocated session key.
  first.events.length = 0;
  first.socket.close();
  await bounded(once(first.socket, 'close'));

  const retry = await connect(port);
  retry.socket.send(JSON.stringify(frame));
  const running = await retry.waitFor('run.snapshot');
  assert.equal(running.run.state, 'running');
  assert.equal(running.messageId, frame.messageId);
  assert.equal(running.run.idempotencyKey, frame.idempotencyKey);
  assert.equal(calls, 1);
  release();
  await retry.waitFor('complete');
  for (let i = 0; i < 250; i++) {
    const run = await agentRunService.findByIdempotencyKey(actor.userId, frame.idempotencyKey);
    if (run?.state === 'completed') break;
    await delay(20);
  }
  retry.events.length = 0;
  retry.socket.send(JSON.stringify(frame));
  const completed = await retry.waitFor('run.snapshot');
  assert.equal(completed.run.state, 'completed');
  assert.equal(completed.run.id, running.run.id);
  const pool = dbConnection.getPool()!;
  const [runs] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM agent_runs');
  const [sessions] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM chat_sessions');
  const [messages] = await pool.query<any[]>('SELECT role, COUNT(*) AS n FROM chat_messages GROUP BY role');
  assert.equal(runs[0].n, 1);
  assert.equal(sessions[0].n, 1);
  assert.deepEqual(Object.fromEntries(messages.map(row => [row.role, row.n])), { user: 1, assistant: 1 });
  assert.equal(calls, 1);
  console.log('PASS: lost acceptance + reconnect + running/completed replay: 1 LLM call, 1 run, 1 session, 1 user/assistant message pair');
} finally {
  release();
  for (const socket of sockets) socket.terminate();
  await adapter?.dispose();
  await dbConnection.close();
  if (created) await admin.query(`DROP DATABASE ${mysql.escapeId(database)}`);
  await admin.end();
  await rm(workspace, { recursive: true, force: true });
}
