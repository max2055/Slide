import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { WebSocket, type WebSocketServer, type RawData } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type LLMProvider, type LLMResponse } from '@slide/agent-core';
import { MigrationRunner } from '../../migrations/runner.js';
import { ActorContextService, signAccessToken } from '../../auth/actor-context.js';
import { dbConnection } from '../../db-connection.js';
import { chatDatabaseService } from '../../chat-database-service.js';
import { WorkerLease } from '../../lifecycle/worker-lease.js';
import { AgentRunService, type AgentRun } from '../agent-run-service.js';
import { DirectAdapter, type DirectAdapterOptions } from '../direct-adapter.js';
import type { CompleteEvent } from '../types.js';

const port = Number(process.env.AGENT_RUN_TEST_MYSQL_PORT);
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const answer: CompleteEvent = { type: 'complete', finalContent: 'durable answer', stopReason: 'completed' };
const response: LLMResponse = { content: answer.finalContent, finishReason: 'stop', toolCalls: [],
  hasToolCalls: false, shouldExecuteTools: false, usage: { prompt_tokens: 1, completion_tokens: 1 } };

// Opt-in like the other real-MySQL qualifications. The T04-A command supplies
// an isolated port; a skipped default unit run is not acceptance evidence.
describe.skipIf(!port)('T04-A durable terminal and real WebSocket regressions', () => {
  const database = `agent_run_recovery_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const secret = randomUUID();
  let admin: Pool, pool: Pool, service: AgentRunService, contexts: ActorContextService;
  const adapters: DirectAdapter[] = [];
  const clients: WebSocket[] = [];
  const directories: string[] = [];
  const providerReleases: Array<() => void> = [];
  const handlers = new Set<Promise<unknown>>();
  const cachedChat = chatDatabaseService as unknown as { pool: Pool | null };
  const priorChatPool = cachedChat.pool;

  beforeAll(async () => {
    const options = { host: '127.0.0.1', port, user: 'root',
      password: process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database, connectionLimit: 10 });
    await new MigrationRunner(pool).run();
    await pool.query("INSERT INTO users (id, username, password_hash) VALUES (7, 'run-owner', 'not-a-login-hash'), (8, 'other-owner', 'not-a-login-hash')");
    service = new AgentRunService(() => pool as never);
    contexts = new ActorContextService(() => pool as never);
  }, 60_000);
  beforeEach(async () => {
    vi.stubEnv('AGENT_WS_HOST', '127.0.0.1');
    vi.stubEnv('AGENT_WS_PORT', '0');
    vi.stubEnv('JWT_SECRET_KEY', secret);
    vi.stubEnv('SLIDE_MEMORY_PIPELINE_ENABLED', 'false');
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    cachedChat.pool = pool;
    await pool.query('DROP TRIGGER IF EXISTS reject_answer');
    for (const table of ['agent_canonical_facts', 'chat_messages', 'agent_runs', 'chat_sessions']) await pool.query(`DELETE FROM ${table}`);
    await pool.query("UPDATE users SET status = 'active', session_version = 1");
    await pool.query("INSERT INTO chat_sessions (session_id, user_id, title) VALUES ('owned:key', 7, 'Owned'), ('other:key', 8, 'Other')");
  });
  afterEach(async () => {
    for (const release of providerReleases.splice(0)) release();
    for (const client of clients.splice(0)) client.terminate();
    await Promise.all(handlers);
    await Promise.all(adapters.splice(0).map(adapter => adapter.dispose()));
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    cachedChat.pool = priorChatPool;
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });

  const claim = async () => (await service.claim(7, 'owned:key', randomUUID(), randomUUID())).run;
  const current = async (run: AgentRun) => (await service.getForActor(run.id, 7, run.sessionId))!;
  const messages = async () => (await pool.query<RowDataPacket[]>('SELECT * FROM chat_messages ORDER BY id'))[0];
  async function staged(): Promise<AgentRun> {
    const run = await claim();
    const crashed = new AgentRunService(() => ({ query: pool.query.bind(pool),
      getConnection: async () => { throw new Error('CRASH_AFTER_STAGING'); } }) as never);
    await expect(crashed.complete(run, answer)).rejects.toThrow('CRASH_AFTER_STAGING');
    expect(await current(run)).toMatchObject({ state: 'running', result: { completionPending: true } });
    return current(run);
  }

  it.each([false, 0, '', 'false', 'null', '0', 'plain text', { code: 'FAILED' }, null, undefined])('round trips non-success result/error %j without losing legitimate falsy values', async value => {
    const run = await claim();
    expect(await service.finish(run.id, 'failed', value, value)).toBe(true);
    expect(await current(run)).toMatchObject({ state: 'failed', result: value ?? null, error: value ?? null });
    expect(await service.findByIdempotencyKey(7, run.idempotencyKey)).toMatchObject({ result: value ?? null, error: value ?? null });
    expect((await service.claim(7, run.sessionId, run.messageId, run.idempotencyKey)).run).toMatchObject({ result: value ?? null, error: value ?? null });
    expect(await service.finish(run.id, 'partial', 'late')).toBe(false);
  });
  it('a new service recovers staged completion once without executing a provider', async () => {
    const run = await staged();
    const restarted = new AgentRunService(() => pool as never);
    expect(await restarted.pendingCompletions(7, run.sessionId)).toHaveLength(1);
    expect(await restarted.recoverCompletion(run)).toMatchObject({ state: 'completed' });
    expect(await restarted.recoverCompletion(run)).toMatchObject({ state: 'completed' });
    expect(await messages()).toHaveLength(1);
    expect(await restarted.pendingCompletions(7, run.sessionId)).toHaveLength(0);
  });
  it('cancel wins before completion locks the row and removes the staged success intent', async () => {
    const run = await staged();
    const waiting = deferred(), resume = deferred();
    const paused = new AgentRunService(() => ({ query: pool.query.bind(pool), getConnection: async () => {
      const connection = await pool.getConnection();
      return { beginTransaction: async () => { await connection.beginTransaction(); waiting.resolve(); await resume.promise; },
        query: connection.query.bind(connection), commit: () => connection.commit(), rollback: () => connection.rollback(), release: () => connection.release() };
    } }) as never);
    const recovery = paused.recoverCompletion(run);
    try {
      await waiting.promise;
      expect(await service.cancelForActor(run.id, 7, run.sessionId)).toBe(true);
    } finally { resume.resolve(); }
    expect(await recovery).toMatchObject({ state: 'cancelled', result: null });
    expect(await current(run)).toMatchObject({ state: 'cancelled', result: null, error: { reasonCode: 'CANCELLED_BY_ACTOR' } });
    expect(await messages()).toHaveLength(0);
    expect(await service.pendingCompletions(7, run.sessionId)).toHaveLength(0);
    expect(await service.complete(run, answer)).toMatchObject({ state: 'cancelled', result: null });
  });
  it('completion row lock makes concurrent cancel lose after the atomic answer commit', async () => {
    const run = await staged();
    const locked = deferred(), resume = deferred();
    const paused = new AgentRunService(() => ({ query: pool.query.bind(pool), getConnection: async () => {
      const connection = await pool.getConnection();
      return { beginTransaction: () => connection.beginTransaction(),
        query: async (sql: string, values: unknown[]) => {
          const result = await connection.query(sql, values);
          if (sql.includes('FROM agent_runs') && sql.includes('FOR UPDATE')) { locked.resolve(); await resume.promise; }
          return result;
        }, commit: () => connection.commit(), rollback: () => connection.rollback(), release: () => connection.release() };
    } }) as never);
    const recovery = paused.recoverCompletion(run);
    await locked.promise;
    const cancellation = service.cancelForActor(run.id, 7, run.sessionId);
    try {
      await vi.waitFor(async () => {
        const [locks] = await pool.query<RowDataPacket[]>('SELECT * FROM performance_schema.data_lock_waits');
        expect(locks.length).toBeGreaterThan(0);
      });
    } finally { resume.resolve(); }
    expect(await recovery).toMatchObject({ state: 'completed' });
    expect(await cancellation).toBe(false);
    expect(await current(run)).toMatchObject({ state: 'completed' });
    expect(await messages()).toHaveLength(1);
  });
  it('failed answer transaction leaves a recoverable intent that can instead be cancelled', async () => {
    const run = await staged();
    await pool.query("CREATE TRIGGER reject_answer BEFORE INSERT ON chat_messages FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ANSWER_STORAGE_FAILURE'");
    await expect(service.recoverCompletion(run)).rejects.toThrow('ANSWER_STORAGE_FAILURE');
    expect(await messages()).toHaveLength(0);
    expect(await service.cancelForActor(run.id, 7, run.sessionId)).toBe(true);
    expect(await service.recoverCompletion(run)).toMatchObject({ state: 'cancelled', result: null });
  });
  it('lost commit acknowledgement replays the stored terminal without a duplicate message', async () => {
    const run = await staged();
    const lostAck = new AgentRunService(() => ({ query: pool.query.bind(pool), getConnection: async () => {
      const connection = await pool.getConnection();
      return { beginTransaction: () => connection.beginTransaction(), query: connection.query.bind(connection),
        commit: async () => { await connection.commit(); throw new Error('COMMIT_ACK_LOST'); },
        rollback: () => connection.rollback(), release: () => connection.release() };
    } }) as never);
    await expect(lostAck.recoverCompletion(run)).rejects.toThrow('COMMIT_ACK_LOST');
    expect(await service.recoverCompletion(run)).toMatchObject({ state: 'completed' });
    expect(await service.cancelForActor(run.id, 7, run.sessionId)).toBe(false);
    expect(await messages()).toHaveLength(1);
  });
  it('wrong actor/session cannot cancel or disturb staged completion', async () => {
    const run = await staged();
    expect(await service.cancelForActor(run.id, 8, run.sessionId)).toBe(false);
    expect(await service.cancelForActor(run.id, 7, 'other:key')).toBe(false);
    expect(await service.recoverCompletion(run)).toMatchObject({ state: 'completed' });
  });

  function provider() {
    const started = deferred(), finish = deferred<LLMResponse>();
    let calls = 0;
    const implementation: LLMProvider = { getDefaultModel: () => 'controlled-test-provider',
      getModelCapabilities: () => ({ model: 'controlled-test-provider', contextWindowTokens: 200_000,
        preferredOutputTokens: 4096, source: 'configuration', version: 't04-a-test/v1' }),
      chat: async () => { throw new Error('NON_STREAMING_NOT_EXPECTED'); },
      chatStream: async () => { calls++; started.resolve(); return finish.promise; } };
    const release = () => finish.resolve(response);
    providerReleases.push(release);
    return { implementation, started: started.promise, release, calls: () => calls };
  }
  async function socketAdapter(llmProvider: LLMProvider, authority: DirectAdapterOptions['actorContextService'] = contexts) {
    const workspace = await mkdtemp(join(tmpdir(), 't04-a-ws-')); directories.push(workspace);
    const tools = new ToolRegistry();
    const adapter = new DirectAdapter({ llmProvider, tools, toolsForActor: () => tools, actorContextService: authority, workspace });
    adapters.push(adapter); await adapter.start();
    const server = (adapter as unknown as { wsServer: WebSocketServer }).wsServer;
    if (!server.address()) await new Promise<void>(r => server.once('listening', r));
    return { adapter, server };
  }
  async function connect(server: WebSocketServer, userId = 7) {
    const address = server.address();
    if (typeof address === 'string') throw new Error('EXPECTED_TCP_ADDRESS');
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`); clients.push(client);
    const events: any[] = [], handled: string[] = [];
    client.on('message', raw => events.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    const socket = [...server.clients].find(peer => (peer as any)._actorContext === undefined)!;
    // Observe settlement of actual network-delivered async handlers, without
    // directly invoking handlers or mocking authentication/persistence.
    const original = socket.listeners('message')[0] as (raw: RawData) => Promise<void>;
    socket.removeListener('message', original);
    socket.on('message', raw => {
      const pending = original.call(socket, raw).then(() => { handled.push(JSON.parse(raw.toString()).type); });
      handlers.add(pending);
      void pending.finally(() => handlers.delete(pending));
    });
    client.send(JSON.stringify({ type: 'auth', token: signAccessToken(await contexts.loadActiveActor(userId, 1), secret) }));
    await vi.waitFor(() => expect(events.some(event => event.type === 'auth_ok')).toBe(true));
    return { client, socket, events, handled, send: (frame: unknown) => client.send(JSON.stringify(frame)) };
  }
  const sendFrame = (sessionKey: string, idempotencyKey = randomUUID()) => ({ type: 'chat.send',
    sessionKey, idempotencyKey, messageId: 'test-message', message: 'inspect' });
  async function startedRun(peer: Awaited<ReturnType<typeof connect>>) {
    await vi.waitFor(() => expect(peer.events.some(event => event.type === 'run.started')).toBe(true));
    return peer.events.find(event => event.type === 'run.started').runId as string;
  }

  it.each([
    ['owned:key', 'owned:key'], ['agent:ops:owned:key', 'agent:ops:owned:key'],
    ['owned:key', 'agent:ops:owned:key'], ['agent:ops:owned:key', 'owned:key'],
  ])('real WS send %s and cancel %s reach the same actor-owned run', async (sendKey, cancelKey) => {
    const controlled = provider(); const { server } = await socketAdapter(controlled.implementation);
    const peer = await connect(server); peer.send(sendFrame(sendKey));
    const runId = await startedRun(peer); await controlled.started;
    peer.send({ type: 'chat.cancel', runId, sessionKey: cancelKey });
    await vi.waitFor(async () => expect(await service.getForActor(runId, 7, 'owned:key')).toMatchObject({ state: 'cancelled' }));
    controlled.release();
    await vi.waitFor(() => expect(peer.handled).toContain('chat.send'));
    expect(peer.events.some(event => event.type === 'complete')).toBe(false);
    expect(controlled.calls()).toBe(1);
  });
  it('WS mismatched actor/session cannot abort the owner run', async () => {
    const controlled = provider(); const { server } = await socketAdapter(controlled.implementation);
    const owner = await connect(server); owner.send(sendFrame('owned:key'));
    const runId = await startedRun(owner); await controlled.started;
    const other = await connect(server, 8);
    other.send({ type: 'chat.cancel', runId, sessionKey: 'agent:ops:owned:key' });
    owner.send({ type: 'chat.cancel', runId, sessionKey: 'agent:ops:other:key' });
    await vi.waitFor(() => { expect(other.handled).toContain('chat.cancel'); expect(owner.handled).toContain('chat.cancel'); });
    expect(await service.getForActor(runId, 7, 'owned:key')).toMatchObject({ state: 'running' });
    controlled.release();
    await vi.waitFor(() => expect(owner.handled).toContain('chat.send'));
    expect(await service.getForActor(runId, 7, 'owned:key')).toMatchObject({ state: 'completed' });
  });
  it('socket disconnect keeps the accepted run executing and replay reads its durable answer', async () => {
    const controlled = provider(); const { server } = await socketAdapter(controlled.implementation);
    const peer = await connect(server); const frame = sendFrame('agent:ops:owned:key'); peer.send(frame);
    const runId = await startedRun(peer); await controlled.started;
    const closed = new Promise(resolve => peer.client.once('close', resolve)); peer.client.close(); await closed;
    controlled.release(); await vi.waitFor(() => expect(peer.handled).toContain('chat.send'));
    const reconnect = await connect(server); reconnect.send(frame);
    await vi.waitFor(() => expect(reconnect.events.some(event => event.type === 'run.snapshot')).toBe(true));
    expect(reconnect.events.find(event => event.type === 'run.snapshot').run).toMatchObject({ id: runId, state: 'completed' });
    expect(controlled.calls()).toBe(1); expect(await messages()).toHaveLength(2);
  });
  it('late command revalidation cannot resurrect a closed authentication generation', async () => {
    const waiting = deferred(), resume = deferred();
    const authority: NonNullable<DirectAdapterOptions['actorContextService']> = {
      authenticateAccessToken: (...args) => contexts.authenticateAccessToken(...args),
      revalidateActor: async (...args) => { const actor = await contexts.revalidateActor(...args); waiting.resolve(); await resume.promise; return actor; },
    };
    const controlled = provider(); const { server } = await socketAdapter(controlled.implementation, authority);
    const peer = await connect(server); peer.send(sendFrame('owned:key')); await waiting.promise;
    peer.send({ type: 'auth', token: 'second-auth-is-rejected' });
    await vi.waitFor(() => expect((peer.socket as any)._authState).toBe('closed'));
    resume.resolve(); controlled.release();
    await vi.waitFor(() => expect(peer.handled).toContain('chat.send'));
    expect((peer.socket as any)._actorContext).toBeUndefined();
    expect(await messages()).toHaveLength(0);
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM agent_runs'))[0]).toHaveLength(0);
    expect(controlled.calls()).toBe(0);
  });
  it('singleton lease release cannot remove a new owner even though its unused token resets', async () => {
    const old = new WorkerLease(pool as never, 't04-a-singleton');
    const next = new WorkerLease(pool as never, 't04-a-singleton');
    expect(await old.acquire()).toBe(true); await old.release();
    expect(await next.acquire()).toBe(true); await old.release();
    expect(await old.renew()).toBe(false); expect(await next.renew()).toBe(true);
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM worker_leases WHERE lease_name = 't04-a-singleton'");
    expect(rows[0]).toMatchObject({ owner_id: next.ownerId, fencing_token: 1 });
    await next.release();
  });
  it('expired singleton owner cannot renew or release its replacement', async () => {
    const old = new WorkerLease(pool as never, 't04-a-expired');
    const next = new WorkerLease(pool as never, 't04-a-expired');
    expect(await old.acquire()).toBe(true);
    await pool.query("UPDATE worker_leases SET expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE lease_name = 't04-a-expired'");
    expect(await next.acquire()).toBe(true);
    expect(await old.renew()).toBe(false); await old.release();
    expect(await next.renew()).toBe(true); await next.release();
  });
});
