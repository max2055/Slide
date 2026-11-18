import { createRequire } from 'node:module';
import { PlatformUnavailableError } from '../lifecycle/platform-unavailable.js';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql, { type Pool } from 'mysql2/promise';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { AgentRunner, OpenAIProvider, ToolRegistry, type LLMProvider } from '@slide/agent-core';
import { ActorContextService, signAccessToken, type ActorContext } from './actor-context.js';
import { ChatAuthorization } from './chat-authorization.js';
import { ChatExecution, withChatExecution, guardedChatProvider, guardedChatTools } from './chat-execution.js';
import { chatCredential } from './chat-credential.js';
import { createVerifyToken } from '../auth-middleware.js';
import { chatDatabaseService } from '../chat-database-service.js';
import { dbConnection } from '../db-connection.js';
import { handleChatSend } from '../chat-handler.js';
import * as engines from '../adapter/get-agent-engine.js';
import { registerChatRoutes } from '../chat-routes.js';
import { MigrationRunner, loadMigrations } from '../migrations/runner.js';
import { DirectAdapter } from '../adapter/direct-adapter.js';
import { AgentRunService } from '../adapter/agent-run-service.js';
import { SubagentManager } from '../agents/subagent-manager.js';
import { SubagentRegistry } from '../agents/subagent-registry.js';
import { analysisAuthorizationVersion, authorizeAnalysisRequest } from '../analysis/analysis-identity.js';
import { CronAuthorityService } from '../cron/cron-authority.js';
import { InvestigationAuthorization } from '../investigations/authorization.js';

const port = Number(process.env.MAX684_MYSQL_PORT);
const enabled = process.env.MAX684_ACCEPTANCE === '1';
if (enabled && !port) throw new Error('MAX684_MYSQL_PORT is required for explicit acceptance');
const observed: Array<{ id: string; status: string }> = [];
describe.skipIf(!port)('MAX-684 real SQL/JWT/HTTP/WS; controlled model endpoint', () => {
  const database = 'max684_' + randomUUID().replaceAll('-', '');
  const secret = randomUUID();
  let admin: Pool, pool: Pool, app: FastifyInstance, endpoint: Server, workspace: string, adapter: DirectAdapter;
  let actors: ActorContextService, access: ChatAuthorization, provider: LLMProvider, runs: AgentRunService;
  let session: string, other: string, modelCalls = 0, toolCalls = 0;
  let hold = false;
  const releases: Array<() => void> = [];
  const clients: WebSocket[] = [];
  const scopes: ChatExecution[] = [];
  const oldPool = (chatDatabaseService as any).pool;
  const token = async (id = 68401, seconds = 60) => signAccessToken(await actors.loadActiveActor(id), secret, seconds);
  const actor = async (id = 68401, seconds = 60) => actors.authenticateAccessToken(await token(id, seconds), secret);
  const scope = (a: ActorContext, key = session, signal?: AbortSignal) => {
    const s = new ChatExecution(a, key, randomUUID(), () => chatDatabaseService.authorizeSession(a, key, 'append'), signal);
    scopes.push(s); return s;
  };
  const revoke = (id = 68401, code = 'chat:view') => pool.query('DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=? AND p.code=?', [id, code]);
  const grant = (id = 68401, code = 'chat:view') => pool.query('INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code=?', [id, code]);
  const call = async (path: string, method = 'GET', body?: unknown, jwt?: string) => {
    const response = await fetch(String(app.listeningOrigin) + path, { method, headers: { ...(jwt ? { authorization: 'Bearer ' + jwt } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.text() };
  };
  async function client(jwt: string, parts = false) {
    const server = (adapter as any).wsServer;
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    clients.push(socket);
    const events: any[] = [];
    socket.on('message', data => events.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'auth', token: jwt, ...(parts ? { capabilities: ['parts-stream-v1'] } : {}) }));
    await vi.waitFor(() => expect(events.some(e => e.type === 'auth_ok')).toBe(true));
    return { socket, events };
  }
  async function caseDone(id: string, work: () => Promise<void>) {
    try { await work(); observed.push({ id, status: 'passed' }); }
    catch (error) { observed.push({ id, status: 'failed' }); throw error; }
  }
  beforeAll(async () => {
    if (port === 3306) throw new Error('Use isolated test SQL, never platform 3306');
    const config = { host: process.env.MAX684_MYSQL_HOST ?? '127.0.0.1', port,
      user: process.env.MAX684_MYSQL_USER ?? 'root', password: process.env.MAX684_MYSQL_PASSWORD ?? '', connectionLimit: 8 };
    admin = mysql.createPool(config);
    await admin.query('CREATE DATABASE ' + database);
    pool = mysql.createPool({ ...config, database });
    const oldDirectory = await mkdtemp(join(tmpdir(), 'max684-migrations-'));
    try {
      for (const migration of await loadMigrations()) {
        if (migration.id !== '160_chat_execution_authority.sql') await writeFile(join(oldDirectory, migration.id), migration.sql);
      }
      await new MigrationRunner(pool, oldDirectory).run();
    } finally { await rm(oldDirectory, { recursive: true, force: true }); }
    await new MigrationRunner(pool).run();
    // Same runner, repeated upgrade: no checksum bypass or duplicate-column repair.
    await new MigrationRunner(pool).run();
    const [columns] = await pool.query<any[]>("SELECT COLUMN_NAME, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_runs' AND COLUMN_NAME LIKE 'chat_%'");
    expect(columns).toHaveLength(3); expect(columns.every(c => c.COLUMN_COMMENT.length > 0)).toBe(true);
    const freshDatabase = database + '_fresh';
    await admin.query('CREATE DATABASE ' + freshDatabase);
    const fresh = mysql.createPool({ ...config, database: freshDatabase });
    try { await new MigrationRunner(fresh).run(); }
    finally { await fresh.end(); await admin.query('DROP DATABASE ' + freshDatabase); }
    actors = new ActorContextService(() => pool as never); access = new ChatAuthorization(actors); runs = new AgentRunService(() => pool as never);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    (chatDatabaseService as any).pool = pool;
    await pool.query("INSERT IGNORE INTO permissions(code,name,resource,action) VALUES('ai:manage','fixture AI business permission','ai','manage')");
    for (const id of [68401, 68402]) {
      await pool.query("INSERT INTO users(id,username,password_hash) VALUES(?,?,'test-not-login')", [id, 'max684-' + id]);
      await pool.query('INSERT INTO roles(id,name) VALUES(?,?)', [id, 'max684-' + id]);
      await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(?,?)', [id, id]);
      for (const code of ['chat:view', 'ai:manage', 'cron:manage']) await grant(id, code);
    }
    endpoint = createServer(async (req, res) => {
      if (req.url === '/tool') { toolCalls++; res.end('{}'); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      modelCalls++;
      if (hold) await new Promise<void>(resolve => releases.push(resolve));
      const content = 'CONTROLLED_MODEL_PRIVATE';
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const chunk of [{ delta: { content }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, ...chunk }] }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); }
    });
    await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
    provider = new OpenAIProvider({ apiKey: 'controlled-local-fixture', baseURL: `http://127.0.0.1:${(endpoint.address() as any).port}/v1`, model: 'fixture' });
    workspace = await mkdtemp(join(tmpdir(), 'max684-'));
    vi.stubEnv('AGENT_WS_HOST', '127.0.0.1'); vi.stubEnv('AGENT_WS_PORT', '0'); vi.stubEnv('JWT_SECRET_KEY', secret); vi.stubEnv('SLIDE_MEMORY_PIPELINE_ENABLED', 'false');
    adapter = new DirectAdapter({ tools: new ToolRegistry(), toolsForActor: () => new ToolRegistry(), llmProvider: provider, workspace, actorContextService: actors });
    await adapter.start();
    app = Fastify();
    vi.spyOn(engines, 'getAgentEngine').mockResolvedValue(adapter);
    await registerChatRoutes(app, { verifyToken: createVerifyToken(secret, actors), service: chatDatabaseService,
      getGreeting: () => 'fixture greeting', handleChatSend });
    await app.listen({ host: '127.0.0.1', port: 0 });
  }, 60000);
  beforeEach(async () => {
    hold = false;
    await pool.query("UPDATE users SET status='active',session_version=1 WHERE id IN (68401,68402)");
    for (const id of [68401, 68402]) for (const code of ['chat:view', 'ai:manage', 'cron:manage']) await grant(id, code);
    session = (await chatDatabaseService.createSession(await actor())).session_id;
    other = (await chatDatabaseService.createSession(await actor(68402))).session_id;
    await chatDatabaseService.addMessage(await actor(), session, { messageId: randomUUID(), role: 'user', content: 'PRIVATE_OWNER_HISTORY' });
  });
  afterEach(async () => {
    hold = false; for (const release of releases.splice(0)) release();
    for (const s of scopes.splice(0)) { s.controller.abort(new Error('fixture cleanup')); s.release(); }
    for (const ws of clients.splice(0)) ws.terminate();
  });
  afterAll(async () => {
    hold = false; for (const release of releases.splice(0)) release();
    for (const ws of clients) ws.terminate();
    await app?.close(); await adapter?.dispose();
    await new Promise<void>(resolve => endpoint ? endpoint.close(() => resolve()) : resolve());
    (chatDatabaseService as any).pool = oldPool; vi.restoreAllMocks(); vi.unstubAllEnvs();
    await pool?.end();
    if (admin) { await admin.query('DROP DATABASE IF EXISTS ' + database); await admin.end(); }
    if (workspace) await rm(workspace, { recursive: true, force: true });
    if (process.env.MAX684_EVIDENCE) await writeFile(process.env.MAX684_EVIDENCE, JSON.stringify({ observed, modelCalls, toolCalls,
      modelBoundary: 'real local OpenAI-compatible HTTP endpoint, controlled output; no paid provider',
      serviceBoundary: 'real Fastify routes/DirectAdapter runner, real WS, real MySQL migrations and JWT', schemaDropped: true }, null, 2));
  });

  it.each(['revocation', 'expiry', 'query failure'])('Legacy rejects queued frames on %s before sending', async change => {
    const jwt = await token(68401, change === 'expiry' ? 2 : 60);
    const live = await client(jwt);
    const listenerActor = await actors.authenticateAccessToken(jwt, secret);
    const peer = [...(adapter as any).wsServer.clients].find((ws: any) => ws._actorContext?.userId === listenerActor.userId);
    const closed: number[] = [];
    live.socket.on('close', code => closed.push(code));
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    const revalidate = actors.revalidateActor.bind(actors);
    const finalCheck = vi.spyOn(actors, 'revalidateActor').mockImplementationOnce(async actorToCheck => {
      await promise;
      return revalidate(actorToCheck);
    });
    const rawExecute = pool.execute.bind(pool);
    const execute = vi.spyOn(pool, 'execute');
    try {
      for (const sequence of [1, 2]) expect((adapter as any).sendSocketEvent(peer, {
        type: 'text_delta', sessionKey: session, sequence, delta: 'QUEUED_LEGACY_PRIVATE',
      })).toBe(true);
      const drained = (adapter as any).socketWriter.authorizationTail(peer);
      await vi.waitFor(() => expect(finalCheck).toHaveBeenCalledTimes(1));
      if (change === 'revocation') await revoke();
      else if (change === 'expiry') await vi.waitFor(() => expect(closed).toEqual([4001]), { timeout: 3000 });
      else execute.mockImplementation(((sql: string, ...args: any[]) => {
        if (sql.includes('FROM users u')) return Promise.reject(Object.assign(new Error('fixture SQL failure'), { code: 'ECONNRESET' }));
        return (rawExecute as any)(sql, ...args);
      }) as typeof pool.execute);
      resolve();
      await drained;
      if (change === 'revocation') await vi.waitFor(() => expect(live.events.some(event => event.code === 'CHAT_FORBIDDEN')).toBe(true));
      if (change === 'query failure') await vi.waitFor(() => expect(closed).toEqual([1013]));
      expect(live.events.some(event => event.type === 'text_delta')).toBe(false);
    } finally { resolve(); finalCheck.mockRestore(); execute.mockRestore(); }
  });

  // MF-I2: actual server denial frames drive the released client/controller,
  // with A hidden and B holding a genuine pending admission receipt.
  it.each(['watch', 'history', 'replay'])('MF-I2 real %s denial isolates hidden A from active B', async entry => {
    const a = await actor(), b = await actor(68402);
    const hidden = (await chatDatabaseService.createSession(b)).session_id;
    const previousRun = (await runs.claim(b.userId, hidden, randomUUID(), randomUUID(), b)).run;
    // Persist an old admitted owner's run, then the current owner/share ACL.
    await pool.query('UPDATE chat_sessions SET user_id=? WHERE session_id=?', [a.userId, hidden]);
    await chatDatabaseService.grantSessionShare(a, hidden, b.userId, 'read');
    const jwt = await token(68402);
    expect((await call('/api/chat/history?sessionKey=' + hidden, 'GET', undefined, jwt)).status).toBe(200);
    await pool.query('DELETE FROM chat_session_shares WHERE session_id=?', [hidden]);
    const requireFrontend = createRequire(new URL('../../../../frontend/package.json', import.meta.url));
    const { JSDOM } = requireFrontend('jsdom'), dom = new JSDOM('', { url: String(app.listeningOrigin) });
    for (const key of ['window', 'document', 'HTMLElement', 'customElements', 'localStorage', 'sessionStorage', 'location', 'navigator', 'CustomEvent']) vi.stubGlobal(key, dom.window[key]);
    vi.stubGlobal('WebSocket', WebSocket);
    const gatewayPath = new URL('../../../../frontend/src/app/ui/direct-gateway.ts', import.meta.url).href;
    const sessionPath = new URL('../../../../frontend/src/app/ui/chat-session-state.ts', import.meta.url).href;
    const { DirectGatewayClient, handleDirectAdapterEvent } = await import(gatewayPath);
    const { activateChatSession, chatSessionHost } = await import(sessionPath);
    const state: any = { sessionKey: hidden, chatMessages: [{ content: 'MF_I2_HIDDEN_PRIVATE' }], chatMessage: 'A draft', chatAttachments: [], chatQueue: [],
      chatLoading: false, chatSending: false, chatRunId: null, chatStream: null, chatStreamStartedAt: null,
      chatThinkingText: '', chatToolMessages: [], chatStreamSegments: [], toolStreamById: new Map(), toolStreamOrder: [], toolStreamSyncTimer: null,
      refreshSessionsAfterChat: new Set(), settings: {}, applySettings() {} };
    const retiredA = chatSessionHost(state); activateChatSession(state, other);
    const preservedB = [{ content: 'MF_I2_AUTHORIZED_B' }]; state.chatMessages = preservedB; state.chatMessage = 'B draft';
    const frames: any[] = [], changes: string[] = [];
    const gateway = new DirectGatewayClient({ url: `ws://127.0.0.1:${(adapter as any).wsServer.address().port}`, chatAcceptTimeoutMs: 5000,
      onEvent: (event: any) => { frames.push(event); handleDirectAdapterEvent(state, event); }, onStateChange: (change: string) => changes.push(change) });
    (dom.window as any).__apiClient = { getToken: () => jwt }; state.client = gateway;
    const sendEvent = (adapter as any).sendSocketEvent.bind(adapter);
    const lost = vi.spyOn(adapter as any, 'sendSocketEvent').mockImplementation((ws: any, event: any) => event.type === 'run.started' ? true : sendEvent(ws, event));
    const send = vi.spyOn(WebSocket.prototype, 'send');
    const count = modelCalls, tools = toolCalls;
    let settledB = false;
    try {
      gateway.connect(); await vi.waitFor(() => expect(changes).toContain('connected'));
      gateway.watchSession(other);
      hold = true;
      const acknowledgement = gateway.sendChat(other, 'B pending receipt').then(() => { settledB = true; }, () => { settledB = true; });
      await vi.waitFor(() => expect(modelCalls).toBe(count + 1));
      const pendingB = [...(gateway as any).pendingChatAcknowledgements.keys()]; expect(pendingB).toHaveLength(1);
      const messageId = entry === 'replay' ? previousRun.messageId : randomUUID();
      const request: any = { type: entry === 'replay' ? 'chat.send' : 'chat.' + entry, sessionKey: ' agent:main:' + hidden + ' ', messageId, runId: previousRun.id };
      if (entry === 'replay') Object.assign(request, { message: 'must not replay', idempotencyKey: previousRun.idempotencyKey });
      (gateway as any).ws.send(JSON.stringify(request));
      await vi.waitFor(() => expect(frames.some(e => e.code === 'CHAT_SESSION_NOT_FOUND')).toBe(true));
      const denial = frames.find(e => e.code === 'CHAT_SESSION_NOT_FOUND');
      expect(denial).toMatchObject({ sessionKey: hidden, messageId, runId: previousRun.id });
      expect(state.chatMessages).toBe(preservedB); expect(state.chatMessage).toBe('B draft');
      expect(state.chatAccessDenied).not.toBe(true); expect(settledB).toBe(false);
      expect([...(gateway as any).pendingChatAcknowledgements.keys()]).toEqual(pendingB);
      const peer = [...(adapter as any).wsServer.clients].find((ws: any) => ws._actorContext?.userId === b.userId) as WebSocket;
      expect((adapter as any).sessionSubscribers.get(other)?.has(peer)).toBe(true);
      // MF-I2 frontend fallback: transport-corrupted/unknown association cannot
      // guess B; these are explicit injected frames, not server contract proof.
      (gateway as any).dispatchEvent({ type: 'error', code: 'CHAT_SESSION_NOT_FOUND' });
      (gateway as any).dispatchEvent({ type: 'error', code: 'CHAT_SESSION_NOT_FOUND', runId: 'unknown-run' });
      expect(state.chatMessages).toBe(preservedB); expect(state.chatMessage).toBe('B draft');
      expect([...(gateway as any).pendingChatAcknowledgements.keys()]).toEqual(pendingB);
      // Late transport response and old async receiver cannot restore denied A.
      (gateway as any).dispatchEvent({ type: 'complete', sessionKey: hidden, finalContent: 'MF_I2_LATE_A' });
      retiredA.chatMessages = [{ content: 'MF_I2_LATE_RECEIVER' }];
      expect(state.chatMessages).toBe(preservedB);
      activateChatSession(state, hidden); expect(state.chatMessages).toEqual([]); expect(state.chatAccessDenied).toBe(true);
      activateChatSession(state, other); expect(state.chatMessages).toBe(preservedB); expect(state.chatMessage).toBe('B draft');
      expect(modelCalls).toBe(count + 1); expect(toolCalls).toBe(tools);
      const sends = send.mock.calls.map(([raw]) => { try { return JSON.parse(String(raw)); } catch { return {}; } }).filter(f => f.type === 'chat.send');
      expect(sends.filter(f => f.message === 'B pending receipt')).toHaveLength(1);
      // A genuine global denial still clears both scopes and ends B's unknown
      // receipt, without replaying the admitted request or held model call.
      await revoke(b.userId);
      (gateway as any).ws.send(JSON.stringify({ type: 'chat.watch', sessionKey: other }));
      await vi.waitFor(() => expect(frames.some(e => e.code === 'CHAT_FORBIDDEN')).toBe(true));
      expect(state.chatMessages).toEqual([]); expect(state.chatAccessDenied).toBe(true);
      await acknowledgement; expect(settledB).toBe(true);
      expect(modelCalls).toBe(count + 1); expect(toolCalls).toBe(tools);
      gateway.disconnect(); await acknowledgement;
      observed.push({ id: 'MF-I2-real-dual-view-' + entry, status: 'passed' });
    } finally {
      gateway.disconnect(); lost.mockRestore(); send.mockRestore(); hold = false; for (const release of releases.splice(0)) release();
      vi.unstubAllGlobals(); dom.window.close();
    }
  }, 12000);

  // Independent implementation review MF-I1: transaction failure must never
  // turn staged reconciliation data into a legacy or parts display result.
  it.each(['watch', 'replay'].flatMap(entry => [false, true].flatMap(parts =>
    ['expired', 'unbound', 'version'].flatMap(binding => ['acquire', 'begin'].map(fault => ({ entry, parts, binding, fault }))))))(
    'MF-I1 $entry parts=$parts $binding recovery-$fault keeps staged SQL private', async ({ entry, parts, binding, fault }) => {
      const a = await actor(68401, binding === 'expired' ? 1 : 60);
      const run = (await runs.claim(a.userId, session, randomUUID(), randomUUID(), a)).run;
      const interrupted = new AgentRunService(() => ({ query: pool.query.bind(pool), getConnection: async () => { throw new Error('staging interruption'); } }) as never);
      await expect(interrupted.complete(run, { type: 'complete', finalContent: 'MF_I1_STAGED_PRIVATE', stopReason: 'completed' })).rejects.toThrow('staging interruption');
      if (binding === 'expired') await new Promise(resolve => setTimeout(resolve, Math.max(0, run.chatAuthority!.expiresAt - Date.now() + 20)));
      if (binding === 'unbound') await pool.query('UPDATE agent_runs SET chat_session_version=NULL,chat_credential_ref=NULL,chat_credential_expires_ms=NULL WHERE id=?', [run.id]);
      if (binding === 'version') await pool.query('UPDATE users SET session_version=2 WHERE id=68401');
      const live = await client(await token(), parts), count = modelCalls, tools = toolCalls;
      const getConnection = pool.getConnection.bind(pool);
      const failure = vi.spyOn(pool, 'getConnection').mockImplementationOnce(async () => {
        if (fault === 'acquire') throw new Error('MF-I1 recovery acquisition fault');
        const connection = await getConnection();
        const begin = vi.spyOn(connection, 'beginTransaction').mockRejectedValueOnce(new Error('MF-I1 recovery transaction fault'));
        const release = connection.release.bind(connection);
        vi.spyOn(connection, 'release').mockImplementationOnce(() => { begin.mockRestore(); release(); });
        return connection;
      });
      try {
        live.socket.send(JSON.stringify(entry === 'watch'
          ? { type: 'chat.watch', sessionKey: session, subscriptionId: randomUUID() }
          : { type: 'chat.send', sessionKey: session, message: 'must not reexecute', messageId: run.messageId, idempotencyKey: run.idempotencyKey }));
        await vi.waitFor(() => expect(live.events.some(e => e.code === 'COMPLETION_STORAGE_FAILED')).toBe(true));
        expect(live.events.some(e => JSON.stringify(e).includes('MF_I1_STAGED_PRIVATE'))).toBe(false);
        const snapshot = live.events.find(e => e.type === 'run.snapshot');
        expect(snapshot.run.result).toEqual({ completionPending: true });
        expect(snapshot.run.chatAuthority).toBeUndefined();
        const [rows] = await pool.query<any[]>('SELECT result_json,state FROM agent_runs WHERE id=?', [run.id]);
        expect(JSON.stringify(rows)).toContain('MF_I1_STAGED_PRIVATE'); expect(rows[0].state).toBe('running');
        expect(modelCalls).toBe(count); expect(toolCalls).toBe(tools);
      } finally { failure.mockRestore(); }
      // A fresh observation after dependency recovery cancels the old authority;
      // it never extends exp/version or retries a model/tool operation.
      live.socket.send(JSON.stringify({ type: 'chat.watch', sessionKey: session, subscriptionId: randomUUID() }));
      await vi.waitFor(() => expect(live.events.some(e => e.type === 'run.snapshot' && e.run.state === 'cancelled')).toBe(true));
      const [messages] = await pool.query<any[]>("SELECT id FROM chat_messages WHERE session_id=? AND role='assistant'", [session]);
      expect(messages).toHaveLength(0);
      expect(live.events.some(e => JSON.stringify(e).includes('MF_I1_STAGED_PRIVATE'))).toBe(false);
      expect(modelCalls).toBe(count); expect(toolCalls).toBe(tools);
      observed.push({ id: `MF-I1-${entry}-${parts ? 'parts' : 'legacy'}-${binding}-${fault}`, status: 'passed' });
    });

  it.each(['identity', 'acl-share', 'owner', 'linked-investigation'])(
    'MF-I3 %s SQL failure stays temporary at admission and output', async stage => {
      const a = await actor(), b = await actor(68402);
      await chatDatabaseService.grantSessionShare(a, session, b.userId, 'read');
      const jwt = await token(68402), live = await client(jwt);
      const count = modelCalls, tools = toolCalls;
      const closed: number[] = []; live.socket.on('close', code => closed.push(code));
      // Only the targeted SQL read fails; identity queries before ACL/owner are real.
      const rawQuery = pool.query.bind(pool), rawExecute = pool.execute.bind(pool);
      let hits = 0, identitySuccess = 0;
      const matches = (sql: string, values: any[]) => stage === 'identity' ? /FROM users u/.test(sql) && values?.[0] === 68402
        : stage === 'acl-share' ? /SELECT cs\.\* FROM chat_sessions cs/.test(sql)
        : stage === 'owner' ? /FROM users u/.test(sql) && values?.[0] === 68401
        : /SELECT id FROM investigations WHERE session_id/.test(sql);
      const intercept = (raw: any) => async (sql: any, values: any, ...rest: any[]) => {
        if (matches(String(sql), values)) { hits++; throw Object.assign(new Error('MF-I3 targeted SQL connection reset'), { code: 'ECONNRESET' }); }
        const result = await raw(sql, values, ...rest);
        if (/FROM users u/.test(String(sql)) && values?.[0] === 68402) identitySuccess++;
        return result;
      };
      const queryFault = vi.spyOn(pool, 'query').mockImplementation(intercept(rawQuery) as any);
      const executeFault = vi.spyOn(pool, 'execute').mockImplementation(intercept(rawExecute) as any);
      try {
        const http = await call('/api/chat/history?sessionKey=' + session, 'GET', undefined, jwt);
        expect(http.status).toBe(503); expect(http.body).not.toContain('PRIVATE_OWNER_HISTORY');
        live.socket.send(JSON.stringify({ type: 'chat.watch', sessionKey: session }));
        await vi.waitFor(() => expect(closed).toEqual([1013]));
        expect(live.events.some(e => ['CHAT_SESSION_NOT_FOUND', 'CHAT_FORBIDDEN'].includes(e.code))).toBe(false);
        // Reconnect first, then fail at actual guarded dispatch, after admission.
      } finally { queryFault.mockRestore(); executeFault.mockRestore(); }
      const output = await client(jwt), outputClosed: number[] = [];
      output.socket.on('close', code => outputClosed.push(code));
      output.socket.send(JSON.stringify({ type: 'chat.watch', sessionKey: session }));
      await vi.waitFor(() => expect((adapter as any).sessionSubscribers.get(session)?.size).toBe(1));
      const queryOutput = vi.spyOn(pool, 'query').mockImplementation(intercept(rawQuery) as any);
      const executeOutput = vi.spyOn(pool, 'execute').mockImplementation(intercept(rawExecute) as any);
      try {
        const peer = [...(adapter as any).wsServer.clients].find((ws: any) => ws._actorContext?.userId === b.userId) as WebSocket;
        (adapter as any).sendSocketEvent(peer, { type: 'complete', sessionKey: session, finalContent: 'MF_I3_OUTBOUND_PRIVATE' });
        await vi.waitFor(() => expect(outputClosed).toEqual([1013]));
        expect(JSON.stringify(output.events)).not.toContain('MF_I3_OUTBOUND_PRIVATE');
        expect(output.events.some(e => ['CHAT_SESSION_NOT_FOUND', 'CHAT_FORBIDDEN'].includes(e.code))).toBe(false);
      } finally { queryOutput.mockRestore(); executeOutput.mockRestore(); }
      const recovered = await client(jwt);
      recovered.socket.send(JSON.stringify({ type: 'chat.watch', sessionKey: session }));
      await vi.waitFor(() => expect((adapter as any).sessionSubscribers.get(session)?.size).toBe(1));
      expect((await call('/api/chat/history?sessionKey=' + session, 'GET', undefined, jwt)).status).toBe(200);
      expect(modelCalls).toBe(count); expect(toolCalls).toBe(tools); expect(hits).toBeGreaterThan(0);
      if (stage !== 'identity') expect(identitySuccess).toBeGreaterThan(0);
      await pool.query('DELETE FROM chat_session_shares WHERE session_id=?', [session]);
      expect((await call('/api/chat/history?sessionKey=' + session, 'GET', undefined, jwt)).status).toBe(404);
      observed.push({ id: 'MF-I3-' + stage, status: 'passed' });
    });

  it.each(['history', 'send', 'replay'])('MF-I3 ACL SQL failure in %s closes 1013 without permanent denial or execution', async entry => {
    const a = await actor(), jwt = await token(), live = await client(jwt);
    const previous = (await runs.claim(a.userId, session, randomUUID(), randomUUID(), a)).run;
    const codes: number[] = []; live.socket.on('close', code => codes.push(code));
    const raw = pool.query.bind(pool), count = modelCalls, tools = toolCalls;
    const failure = vi.spyOn(pool, 'query').mockImplementation((async (sql: any, ...args: any[]) => {
      if (/SELECT cs\.\* FROM chat_sessions cs/.test(String(sql))) throw Object.assign(new Error('MF-I3 command ACL connection reset'), { code: 'ECONNRESET' });
      return (raw as any)(sql, ...args);
    }) as any);
    try {
      live.socket.send(JSON.stringify({ type: entry === 'history' ? 'chat.history' : 'chat.send', sessionKey: session,
        message: 'not admitted', messageId: entry === 'replay' ? previous.messageId : randomUUID(),
        idempotencyKey: entry === 'replay' ? previous.idempotencyKey : randomUUID() }));
      await vi.waitFor(() => expect(codes).toEqual([1013]));
      expect(live.events.some(e => ['CHAT_FORBIDDEN', 'CHAT_SESSION_NOT_FOUND'].includes(e.code))).toBe(false);
      expect(live.events.some(e => e.type === 'run.started' || e.finalContent)).toBe(false);
      expect(modelCalls).toBe(count); expect(toolCalls).toBe(tools);
    } finally { failure.mockRestore(); }
    observed.push({ id: 'MF-I3-ACL-' + entry, status: 'passed' });
  });

  it('MF-I3 HTTP final authority read failure replaces already loaded history with 503', async () => {
    const jwt = await token(), raw = pool.query.bind(pool); let aclReads = 0;
    const failure = vi.spyOn(pool, 'query').mockImplementation((async (sql: any, ...args: any[]) => {
      if (/SELECT cs\.\* FROM chat_sessions cs/.test(String(sql)) && ++aclReads === 3)
        throw Object.assign(new Error('MF-I3 final HTTP authority read reset'), { code: 'ECONNRESET' });
      return (raw as any)(sql, ...args);
    }) as any);
    try {
      const result = await call('/api/chat/history?sessionKey=' + session, 'GET', undefined, jwt);
      expect(aclReads).toBe(3); expect(result.status).toBe(503); expect(result.body).not.toContain('PRIVATE_OWNER_HISTORY');
    } finally { failure.mockRestore(); }
    observed.push({ id: 'MF-I3-HTTP-outbound', status: 'passed' });
  });

  it('MF-I3 unknown ACL exceptions remain internal errors, never a permanent not-found or unavailable label', async () => {
    const jwt = await token(), live = await client(jwt);
    const query = pool.query.bind(pool);
    const fault = vi.spyOn(pool, 'query').mockImplementation((async (sql: any, ...args: any[]) => {
      if (/SELECT cs\.\* FROM chat_sessions cs/.test(String(sql))) throw new TypeError('MF-I3 unknown query bug');
      return (query as any)(sql, ...args);
    }) as any);
    try {
      expect((await call('/api/chat/history?sessionKey=' + session, 'GET', undefined, jwt)).status).toBe(500);
      live.socket.send(JSON.stringify({ type: 'chat.watch', sessionKey: session, messageId: 'unknown-error' }));
      await vi.waitFor(() => expect(live.events.some(e => e.type === 'error')).toBe(true));
      expect(live.events.some(e => ['CHAT_SESSION_NOT_FOUND', 'CHAT_FORBIDDEN', 'PLATFORM_UNAVAILABLE'].includes(e.code))).toBe(false);
      expect(live.socket.readyState).toBe(WebSocket.OPEN);
    } finally { fault.mockRestore(); }
    observed.push({ id: 'MF-I3-unknown-not-reclassified', status: 'passed' });
  });

  it('HTTP/WS complete rejection matrix: no authority creates no run/session/model request', async () => {
    const jwt = await token(); await revoke(); const before = modelCalls;
    const routes: Array<[string, string, unknown?]> = [['/api/chat/greeting', 'GET'], ['/api/chat/history?sessionKey=' + session, 'GET'], ['/api/sessions', 'GET'], ['/api/chat/send', 'POST', { message: 'new' }], ['/api/chat/send', 'POST', { sessionKey: session, message: 'own' }], ['/api/sessions/' + session, 'PATCH', { model: 'x' }], ['/api/sessions/' + session, 'DELETE'], ['/api/sessions/' + session + '/cap', 'POST', { maxMessages: 1 }]];
    for (const [path, method, body] of routes) { const r = await call(path, method, body, jwt); expect(r.status).toBe(403); expect(r.body).not.toContain('PRIVATE_OWNER_HISTORY'); }
    const ws = await client(jwt);
    for (const type of ['chat.send', 'chat.steer', 'chat.history', 'chat.watch', 'memory.list', 'memory.retry', 'memory.export', 'memory.import', 'memory.delete', 'memory.share']) ws.socket.send(JSON.stringify({ type, sessionKey: session, message: 'denied' }));
    await vi.waitFor(() => expect(ws.events.filter(e => e.code === 'CHAT_FORBIDDEN').length).toBe(10));
    expect(modelCalls).toBe(before);
    expect((await call('/api/chat/history?sessionKey=' + session)).status).toBe(401);
    await grant();
    expect((await call('/api/chat/history?sessionKey=' + other, 'GET', undefined, jwt)).status).toBe(404);
    await chatDatabaseService.grantSessionShare(await actor(68402), other, 68401, 'read');
    expect((await call('/api/chat/history?sessionKey=' + other, 'GET', undefined, jwt)).status).toBe(200);
    expect((await call('/api/chat/send', 'POST', { sessionKey: other, message: 'read-only share' }, jwt)).status).toBe(404);
    const live = await client(await token());
    const messageId = randomUUID(), idempotencyKey = randomUUID();
    live.socket.send(JSON.stringify({ type: 'chat.send', sessionKey: session, message: 'real WS controlled response', messageId, idempotencyKey }));
    await vi.waitFor(() => expect(live.events.some(e => e.type === 'complete')).toBe(true), { timeout: 3000 });
    const stored = await runs.findByIdempotencyKey(68401, idempotencyKey);
    expect(stored?.state).toBe('completed'); expect(JSON.stringify(live.events)).not.toContain('credentialRef'); expect(stored?.chatAuthority?.credentialRef).toHaveLength(64);
    const bound = (await chatDatabaseService.createSession(await actor())).session_id;
    await pool.query("INSERT INTO investigations(id,title,goal,profile_id,profile_version,session_id,owner_kind,owner_id,scope_version) VALUES(?,'fixture','fixture','ops',1,?,'user',68401,?)", [randomUUID(), bound, 'a'.repeat(64)]);
    expect((await call('/api/chat/send', 'POST', { sessionKey: bound, message: 'cannot bypass investigation executor' }, await token())).status).toBe(404);
    await revoke();
    expect((await call('/api/chat/history?sessionKey=' + bound, 'GET', undefined, jwt)).status).toBe(403);
    observed.push({ id: 'HTTP-WS-rejection-matrix', status: 'passed' });
  });
  it('refuses unbound legacy child access and cascades explicit parent cancellation', async () => {
    const a = await actor(), parent = new AbortController(), s = scope(a, session, parent.signal), registry = new SubagentRegistry();
    const manager = new SubagentManager(new AgentRunner(guardedChatProvider(provider)), undefined, undefined, registry);
    const legacy = registry.register({ sessionKey: 'legacy', task: 'unknown origin', ownerId: a.userId });
    expect((await withChatExecution(s, () => manager.access(legacy.runId, a))).found).toBe(false);
    hold = true;
    const id = await withChatExecution(s, () => manager.spawn('fixture', 'held child', session, a));
    await vi.waitFor(() => expect(releases.length).toBe(1)); parent.abort();
    await vi.waitFor(() => expect(registry.getRun(id)?.status).not.toBe('running'));
    expect(registry.getRun(id)?.result).toBeUndefined(); hold = false; releases.shift()!();
    observed.push({ id: 'parent-cancel-and-unbound-legacy', status: 'passed' });
  });
  it('staged answer recovery checks original authority and preserves reconciliation facts', async () => {
    const a = await actor();
    const run = (await runs.claim(a.userId, session, randomUUID(), randomUUID(), a)).run;
    const failedCommit = new AgentRunService(() => ({ query: pool.query.bind(pool), getConnection: async () => { throw new Error('fixture-staging-crash'); } }) as never);
    await expect(failedCommit.complete(run, { type: 'complete', finalContent: 'STAGED_PRIVATE', stopReason: 'completed' })).rejects.toThrow('fixture-staging-crash');
    const count = modelCalls; await revoke();
    const pending = (await runs.getForActor(run.id, a.userId, session))!;
    expect((await runs.recoverCompletion(pending)).state).toBe('cancelled');
    const [rows] = await pool.query<any[]>('SELECT result_json FROM agent_runs WHERE id=?', [run.id]);
    expect(JSON.stringify(rows[0])).toContain('STAGED_PRIVATE');
    const [messages] = await pool.query<any[]>("SELECT id FROM chat_messages WHERE session_id=? AND role='assistant'", [session]);
    expect(messages).toHaveLength(0); expect(modelCalls).toBe(count);
    observed.push({ id: 'completion-recovery-original-authority', status: 'passed' });
  });
  it('integrated frontend uses real HTTP/WS denial, clears late content and reconnects without execution replay', async () => {
    const requireFrontend = createRequire(new URL('../../../../frontend/package.json', import.meta.url));
    const { JSDOM } = requireFrontend('jsdom');
    const dom = new JSDOM('', { url: String(app.listeningOrigin) });
    const nativeFetch = globalThis.fetch;
    for (const key of ['window', 'document', 'HTMLElement', 'customElements', 'localStorage', 'sessionStorage', 'location', 'navigator', 'CustomEvent']) vi.stubGlobal(key, dom.window[key]);
    vi.stubGlobal('WebSocket', WebSocket);
    vi.stubGlobal('fetch', (input: any, options?: any) => nativeFetch(typeof input === 'string' ? new URL(input, String(app.listeningOrigin)) : input, options));
    const apiPath = new URL('../../../../frontend/src/api/index.ts', import.meta.url).href;
    const gatewayPath = new URL('../../../../frontend/src/app/ui/direct-gateway.ts', import.meta.url).href;
    const controllerPath = new URL('../../../../frontend/src/app/ui/controllers/chat.ts', import.meta.url).href;
    const { apiClient } = await import(apiPath);
    const { DirectGatewayClient, handleDirectAdapterEvent, clearExpiredChatState } = await import(gatewayPath);
    const { loadChatHistory } = await import(controllerPath);
    const state: any = { client: null, connected: false, sessionKey: session, chatMessages: [], chatMessage: '', chatAttachments: [],
      chatLoading: false, chatSending: false, chatThinkingLevel: null, chatRunId: null, chatStream: null, chatStreamStartedAt: null,
      chatThinkingText: '', chatToolMessages: [], chatStreamSegments: [], toolStreamById: new Map(), toolStreamOrder: [], toolStreamSyncTimer: null,
      chatQueue: [], lastError: null, settings: {}, applySettings() {}, refreshSessionsAfterChat: new Set() };
    const changes: string[] = [];
    const sent = vi.spyOn(WebSocket.prototype, 'send');
    const gateway = new DirectGatewayClient({ url: `ws://127.0.0.1:${(adapter as any).wsServer.address().port}`, chatAcceptTimeoutMs: 500,
      onEvent: (event: any) => handleDirectAdapterEvent(state, event), onStateChange: (change: string) => {
        changes.push(change); state.connected = change === 'connected';
        if (change === 'auth_failed') clearExpiredChatState(state);
      } });
    const frames = () => sent.mock.calls.map(([raw]) => { try { return JSON.parse(String(raw)); } catch { return {}; } }).filter(frame => frame.type === 'chat.send').length;
    state.client = gateway;
    apiClient.setToken(await token()); (dom.window as any).__apiClient = apiClient;
    try {
      gateway.connect(); await vi.waitFor(() => expect(state.connected).toBe(true));
      await loadChatHistory(state); expect(JSON.stringify(state.chatMessages)).toContain('PRIVATE_OWNER_HISTORY');
      state.chatStream = 'stale private stream'; state.chatToolMessages = [{ content: 'stale private tool' }];
      await revoke();
      await expect(gateway.sendChat(session, 'must be refused before model')).rejects.toThrow();
      await vi.waitFor(() => expect(state.chatMessages).toEqual([]));
      expect(state.chatStream).toBeNull(); expect(state.chatToolMessages).toEqual([]);
      const peer = [...(adapter as any).wsServer.clients].find((ws: any) => ws._actorContext?.userId === 68401) as WebSocket;
      // Transport fault injection: a late frame bypasses the server writer solely
      // to test the released frontend's stale receiver. Real output is guarded.
      peer.send(JSON.stringify({ type: 'complete', sessionKey: session, runId: 'retired', finalContent: 'FAULT_INJECTED_LATE_PRIVATE' }));
      await new Promise(resolve => setTimeout(resolve, 30)); expect(JSON.stringify(state.chatMessages)).not.toContain('FAULT_INJECTED_LATE_PRIVATE');
      await grant(); await loadChatHistory(state); expect(JSON.stringify(state.chatMessages)).toContain('PRIVATE_OWNER_HISTORY');
      const originalMessages = state.chatMessages;
      const outage = vi.spyOn(actors, 'authenticateAccessToken').mockRejectedValueOnce(new PlatformUnavailableError());
      await loadChatHistory(state); expect(state.chatMessages).toBe(originalMessages); outage.mockRestore();
      // Lose the admission receipt after the actual server admitted one request.
      const sendEvent = (adapter as any).sendSocketEvent.bind(adapter);
      const lostReceipt = vi.spyOn(adapter as any, 'sendSocketEvent').mockImplementation((ws: any, event: any) => event.type === 'run.started' ? true : sendEvent(ws, event));
      const startFrames = frames(), startCalls = modelCalls; hold = true;
      const acknowledgement = gateway.sendChat(session, 'unknown receipt, never replay').then(() => null, (error: Error) => error);
      await vi.waitFor(() => expect(modelCalls).toBe(startCalls + 1));
      const failOnce = vi.spyOn(actors, 'revalidateActor').mockRejectedValueOnce(new PlatformUnavailableError());
      gateway.watchSession(session);
      await vi.waitFor(() => expect(changes).toContain('service_unavailable'));
      failOnce.mockRestore();
      await vi.waitFor(() => expect(changes.filter(change => change === 'connected').length).toBeGreaterThan(1), { timeout: 2500 });
      expect(frames()).toBe(startFrames + 1); expect(modelCalls).toBe(startCalls + 1);
      expect(await acknowledgement).toBeInstanceOf(Error);
      lostReceipt.mockRestore(); hold = false; for (const release of releases.splice(0)) release();
      // A new token uses a new connection; exp of A cannot clear newer B.
      gateway.disconnect();
      const a = await token(68401, 1), b = await token(68401, 60); apiClient.setToken(a);
      const secondChanges: string[] = [];
      const renewed = new DirectGatewayClient({ url: `ws://127.0.0.1:${(adapter as any).wsServer.address().port}`,
        onEvent: () => {}, onStateChange: (change: string) => secondChanges.push(change) });
      try {
        renewed.connect(); await vi.waitFor(() => expect(secondChanges).toContain('connected'));
        apiClient.setToken(b);
        await vi.waitFor(() => expect(secondChanges).toContain('credentials_changed'), { timeout: 1800 });
        await vi.waitFor(() => expect(secondChanges.filter(change => change === 'connected').length).toBe(2), { timeout: 2500 });
        expect(apiClient.getToken()).toBe(b); expect(secondChanges).not.toContain('auth_failed');
      } finally { renewed.disconnect(); }
      observed.push({ id: 'integrated-frontend-real-authority', status: 'passed' });
    } finally {
      gateway.disconnect(); sent.mockRestore(); hold = false; for (const release of releases.splice(0)) release();
      vi.unstubAllGlobals(); dom.window.close();
    }
  }, 12000);
  it('MF1-parent-completed: child retains original scope after parent release', () => caseDone('MF1-parent-completed', async () => {
    const a = await actor(); const s = scope(a); const registry = new SubagentRegistry();
    const manager = new SubagentManager(new AgentRunner(guardedChatProvider(provider)), undefined, undefined, registry);
    hold = true;
    const id = await withChatExecution(s, () => manager.spawn('fixture', 'child', session, a));
    await vi.waitFor(() => expect(releases.length).toBe(1));
    // Child owns a reference; completion of the parent's lexical scope does not revoke it.
    s.release(); scopes.splice(scopes.indexOf(s), 1);
    hold = false; releases.shift()!();
    await vi.waitFor(() => expect(registry.getRun(id)?.status).toBe('completed'));
  }));
  async function childFixture(a: ActorContext, pauseTool = false) {
    let requests = 0;
    let toolStarted = false;
    let releaseTool!: () => void;
    const toolGate = new Promise<void>(resolve => { releaseTool = resolve; });
    releases.push(releaseTool);
    const tools = new ToolRegistry();
    tools.register({ name: 'probe', description: 'controlled local protocol endpoint', parameters: { type: 'object', properties: {} }, readOnly: true, concurrencySafe: true, exclusive: false,
      execute: async () => {
        toolStarted = true; toolCalls++;
        if (pauseTool) await toolGate;
        return { success: true, data: 'observed external fact' };
      } });
    const controlled: LLMProvider = { getDefaultModel: () => provider.getDefaultModel(), chatStream: provider.chatStream.bind(provider),
      chat: async (messages, schemas, options) => {
        const result = await provider.chat(messages, schemas, options);
        if (++requests === 1) return { ...result, content: null, finishReason: 'tool_calls', hasToolCalls: true, shouldExecuteTools: true, toolCalls: [{ id: 'probe-1', name: 'probe', arguments: {} }] };
        return result;
      } };
    const s = scope(a), registry = new SubagentRegistry();
    const manager = new SubagentManager(new AgentRunner(guardedChatProvider(controlled)), undefined, () => tools, registry);
    const id = await withChatExecution(s, () => manager.spawn('fixture', 'child', session, a));
    return { s, registry, id, releaseTool, toolStarted: () => toolStarted };
  }
  it('MF1-second-model: revoked actual child makes no second model call', () => caseDone('MF1-second-model', async () => {
    const child = await childFixture(await actor(), true);
    await vi.waitFor(() => expect(child.toolStarted()).toBe(true)); const count = modelCalls;
    await revoke(); child.releaseTool();
    await vi.waitFor(() => expect(child.registry.getRun(child.id)?.status).not.toBe('running'));
    expect(modelCalls).toBe(count); expect(child.registry.getRun(child.id)?.result).toBeUndefined();
  }));
  it('MF1-next-tool: disable/version blocks actual child next tool dispatch', () => caseDone('MF1-next-tool', async () => {
    for (const mutation of ["status='inactive'", 'session_version=2']) {
      await pool.query("UPDATE users SET status='active',session_version=1 WHERE id=68401");
      const a = await actor(); hold = true; const child = await childFixture(a);
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(1));
      const count = toolCalls; await pool.query('UPDATE users SET ' + mutation + ' WHERE id=68401');
      hold = false; for (const release of releases.splice(0)) release();
      await vi.waitFor(() => expect(child.registry.getRun(child.id)?.status).not.toBe('running'));
      expect(toolCalls).toBe(count); expect(child.registry.getRun(child.id)?.result).toBeUndefined();
    }
  }));
  it('MF1-child-exp: initiating expiry cancels child scope', () => caseDone('MF1-child-exp', async () => {
    const a = await actor(68401, 1), s = scope(a), registry = new SubagentRegistry();
    const manager = new SubagentManager(new AgentRunner(guardedChatProvider(provider)), undefined, undefined, registry);
    hold = true; const id = await withChatExecution(s, () => manager.spawn('fixture', 'child outlives parent', session, a));
    await vi.waitFor(() => expect(releases.length).toBe(1));
    s.release(); scopes.splice(scopes.indexOf(s), 1);
    await vi.waitFor(() => expect(registry.getRun(id)?.status).not.toBe('running'), { timeout: 1800 });
    expect(registry.getRun(id)?.result).toBeUndefined(); await expect(scope(await actor()).check()).resolves.toBeUndefined();
    hold = false; releases.shift()!();
  }));
  it('MF1-access: no chat and wrong owner cannot read child result', () => caseDone('MF1-access', async () => {
    const a = await actor(), s = scope(a), registry = new SubagentRegistry();
    const manager = new SubagentManager(new AgentRunner(guardedChatProvider(provider)), undefined, undefined, registry);
    const id = await withChatExecution(s, () => manager.spawn('fixture', 'child', session, a));
    await vi.waitFor(() => expect(registry.getRun(id)?.status).toBe('completed'));
    expect((await withChatExecution(scope(await actor(68402), other), () => manager.access(id, a))).found).toBe(false);
    await revoke(); await expect(withChatExecution(s, () => manager.access(id, a))).rejects.toThrow();
  }));
  it('MF2-A-B: expiration of A leaves independent fresh B usable', () => caseDone('MF2-A-B', async () => {
    const a = scope(await actor(68401, 1)), b = scope(await actor());
    await vi.waitFor(() => expect(a.controller.signal.aborted).toBe(true), { timeout: 1800 });
    await expect(b.check()).resolves.toBeUndefined();
    await expect(withChatExecution(b, () => guardedChatProvider(provider).chat([], []))).resolves.toMatchObject({ content: 'CONTROLLED_MODEL_PRIVATE' });
  }));
  it('MF2-version: v+1 works while old version is rejected', () => caseDone('MF2-version', async () => {
    const old = scope(await actor()); await pool.query('UPDATE users SET session_version=2 WHERE id=68401');
    const fresh = scope(await actor()); await expect(old.check()).rejects.toThrow(); await expect(fresh.check()).resolves.toBeUndefined();
  }));
  it('MF2-http-send: HTTP send crossing exp returns 401 without body', () => caseDone('MF2-http-send', async () => {
    hold = true; const pending = call('/api/chat/send', 'POST', { sessionKey: session, message: 'held' }, await token(68401, 1));
    await vi.waitFor(() => expect(releases.length).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 1100)); hold = false; releases.shift()!();
    const result = await pending; expect(result.status).toBe(401); expect(result.body).not.toContain('CONTROLLED_MODEL_PRIVATE');
  }));
  it('MF2-http-history: slow HTTP history checks exp before serialization', () => caseDone('MF2-http-history', async () => {
    const original = chatDatabaseService.getMessages.bind(chatDatabaseService);
    const spy = vi.spyOn(chatDatabaseService, 'getMessages').mockImplementation(async (...args) => { const data = await original(...args); await new Promise(resolve => setTimeout(resolve, 1100)); return data; });
    try { const result = await call('/api/chat/history?sessionKey=' + session, 'GET', undefined, await token(68401, 1)); expect(result.status).toBe(401); expect(result.body).not.toContain('PRIVATE_OWNER_HISTORY'); }
    finally { spy.mockRestore(); }
  }));
  it('MF2-observer: observer expiry leaves owner scope active', () => caseDone('MF2-observer', async () => {
    const owner = scope(await actor()); await chatDatabaseService.grantSessionShare(await actor(), session, 68402, 'read');
    const watcher = await client(await token(68402, 1)); watcher.socket.send(JSON.stringify({ type: 'chat.watch', sessionKey: session }));
    await vi.waitFor(() => expect(watcher.socket.readyState).toBe(WebSocket.CLOSED), { timeout: 1800 }); await expect(owner.check()).resolves.toBeUndefined();
  }));
  it('MF2-reconnect: fresh observer never rebinds durable execution', () => caseDone('MF2-reconnect', async () => {
    const a = await actor(68401, 1); const run = (await runs.claim(a.userId, session, randomUUID(), randomUUID(), a)).run;
    const before = run.chatAuthority; const observer = await client(await token());
    observer.socket.send(JSON.stringify({ type: 'chat.watch', sessionKey: session }));
    await vi.waitFor(() => expect((adapter as any).sessionSubscribers.get(session)?.size).toBe(1));
    expect((await runs.getForActor(run.id, a.userId, session))?.chatAuthority).toEqual(before);
    expect(before?.expiresAt).toBe(chatCredential(a)?.expiresAt);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, before!.expiresAt - Date.now() + 10)));
    expect((await runs.recoverCompletion((await runs.getForActor(run.id, a.userId, session))!)).state).toBe('cancelled');
    expect(observer.socket.readyState).toBe(WebSocket.OPEN);
  }));
  async function analysisRequest(a?: ActorContext) {
    return { actor: a, purpose: 'fault_diagnosis', subject: { type: 'server', id: 68401 }, authorizationVersion: analysisAuthorizationVersion(a) } as any;
  }
  async function resource() { await pool.query("INSERT IGNORE INTO servers(id,label,host,port,os_type,credential_type,credential_encrypted) VALUES(68401,'fixture','127.0.0.1',22,'Linux','password','fixture-not-secret')"); }
  it('MF3-analysis-chat: original full snapshot fails, new business snapshot passes', () => caseDone('MF3-analysis-chat', async () => {
    // Resource permissions are granted by the fixture, never bypassed by chat.
    await resource(); for (const code of ['servers:view']) await grant(68401, code);
    const before = await analysisRequest(await actor()); await revoke();
    await expect(authorizeAnalysisRequest(before)).rejects.toThrow('ANALYSIS_AUTHORITY_REVOKED');
    const current = await actors.loadActiveActor(68401); expect(analysisAuthorizationVersion(current)).not.toBe(before.authorizationVersion);
    await expect(authorizeAnalysisRequest(await analysisRequest(current))).resolves.toBeUndefined();
  }));
  it('MF3-analysis-business: actual business removal and disabled actor fail', () => caseDone('MF3-analysis-business', async () => {
    await resource(); await grant(68401, 'servers:view'); const request = await analysisRequest(await actor());
    await revoke(68401, 'ai:manage'); await expect(authorizeAnalysisRequest(request)).rejects.toThrow('ANALYSIS_AUTHORITY_REVOKED');
    await pool.query("UPDATE users SET status='inactive' WHERE id=68401"); await expect(authorizeAnalysisRequest(request)).rejects.toThrow('ANALYSIS_AUTHORITY_REVOKED');
  }));
  it('MF3-cron: chat loss preserves business delegation; business loss/disable rejects', () => caseDone('MF3-cron', async () => {
    const job = { id: 68401, principal_type: 'user', identity_status: 'bound', owner_user_id: 68401, task_type: 'agent', target_instance_id: null,
      resource_scope: { version: 1, instanceIds: [], serverIds: [], networkDeviceIds: [], targetInstanceId: null } } as any;
    await revoke(); await expect(new CronAuthorityService().authorize(job)).resolves.toHaveProperty('actor');
    await revoke(68401, 'cron:manage'); await expect(new CronAuthorityService().authorize(job)).rejects.toThrow('CRON_OWNER_PERMISSION_REVOKED');
    await pool.query("UPDATE users SET status='inactive' WHERE id=68401"); await expect(new CronAuthorityService().authorize(job)).rejects.toThrow('CRON_OWNER_UNAVAILABLE');
  }));
  it('MF3-system: user changes do not grant or revoke system authority', () => caseDone('MF3-system', async () => {
    await resource(); await revoke(); await pool.query("UPDATE users SET status='inactive' WHERE id=68401");
    await pool.query("INSERT INTO system_config(config_key,config_value) VALUES('auto_analysis_config','{\"enabled\":true}') ON DUPLICATE KEY UPDATE config_value=VALUES(config_value)");
    await expect(authorizeAnalysisRequest(await analysisRequest())).resolves.toBeUndefined();
    await pool.query("UPDATE system_config SET config_value='{\"enabled\":false}' WHERE config_key='auto_analysis_config'");
    await expect(authorizeAnalysisRequest(await analysisRequest())).rejects.toThrow('ANALYSIS_AUTOMATION_DISABLED');
  }));
  it('MF3-service: investigation remains under its separate authorization', () => caseDone('MF3-service', async () => {
    await pool.query("INSERT INTO users(id,username,password_hash) VALUES(68403,'slide-investigation-fixture','!slide-investigation-no-login!')");
    await pool.query("INSERT INTO roles(id,name) VALUES(68403,'max684-service')");
    await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(68403,68403)');
    await grant(68403);
    const connection = { execute: (sql: string, values?: unknown[]) => pool.execute(sql, values as any) };
    const service = { ...await actors.loadInvestigationActorFrom(connection, 68403, 'service', 1), resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } };
    const investigation = { id: randomUUID(), sessionId: session, owner: { kind: 'service', id: 68403 }, profileId: 'ops', profileVersion: 1, resources: [], scopeVersion: 'a'.repeat(64) } as any;
    const authority = new InvestigationAuthorization(actors);
    await revoke(); await pool.query("UPDATE users SET status='inactive' WHERE id=68401");
    await expect(authority.authorize(connection, service, investigation, 'read')).resolves.toBeDefined();
    await revoke(68403);
    await expect(authority.authorize(connection, service, investigation, 'read')).rejects.toThrow();
  }));
  it('recipient share withdrawal removes only that observation, preserving another authorized session', async () => {
    const a = await actor(), b = await actor(68402);
    const second = (await chatDatabaseService.createSession(a)).session_id;
    await chatDatabaseService.grantSessionShare(a, session, b.userId, 'read');
    await chatDatabaseService.grantSessionShare(a, second, b.userId, 'read');
    const watcher = await client(await token(68402));
    for (const key of [session, second]) watcher.socket.send(JSON.stringify({ type: 'chat.watch', sessionKey: key }));
    await vi.waitFor(() => expect((adapter as any).sessionSubscribers.get(second)?.size).toBe(1));
    await pool.query('DELETE FROM chat_session_shares WHERE session_id=? AND recipient_user_id=?', [session, b.userId]);
    const peer = [...(adapter as any).wsServer.clients].find((ws: any) => ws._actorContext?.userId === b.userId) as WebSocket;
    (adapter as any).sendSocketEvent(peer, { type: 'complete', sessionKey: session, finalContent: 'WITHDRAWN_PRIVATE' });
    (adapter as any).sendSocketEvent(peer, { type: 'complete', sessionKey: second, finalContent: 'STILL_AUTHORIZED' });
    await vi.waitFor(() => expect(watcher.events.some(e => e.finalContent === 'STILL_AUTHORIZED')).toBe(true));
    expect(watcher.events.some(e => e.finalContent === 'WITHDRAWN_PRIVATE')).toBe(false);
    expect((adapter as any).sessionSubscribers.get(second)?.has(peer)).toBe(true);
    observed.push({ id: 'share-withdrawal-observation-isolation', status: 'passed' });
  });
  it('D3-owner: suspension retains share and restoration restores new reads', () => caseDone('D3-owner', async () => {
    await chatDatabaseService.grantSessionShare(await actor(), session, 68402, 'read'); const jwt = await token(68402);
    for (const change of ['chat', 'disabled']) {
      if (change === 'chat') await revoke(); else await pool.query("UPDATE users SET status='inactive' WHERE id=68401");
      const denied = await call('/api/chat/history?sessionKey=' + session, 'GET', undefined, jwt); expect(denied.status).toBe(404); expect(denied.body).not.toContain('PRIVATE_OWNER_HISTORY');
      expect((await call('/api/sessions', 'GET', undefined, jwt)).body).not.toContain(session);
      await grant(); await pool.query("UPDATE users SET status='active' WHERE id=68401");
      expect((await call('/api/chat/history?sessionKey=' + session, 'GET', undefined, jwt)).status).toBe(200);
    }
    const [shares] = await pool.query<any[]>('SELECT id FROM chat_session_shares WHERE session_id=?', [session]); expect(shares).toHaveLength(1);
  }));
  it('D3-token: owner credential expiry/version does not revoke sharing', () => caseDone('D3-token', async () => {
    await chatDatabaseService.grantSessionShare(await actor(), session, 68402, 'read');
    await pool.query('UPDATE users SET session_version=2 WHERE id=68401');
    expect((await call('/api/chat/history?sessionKey=' + session, 'GET', undefined, await token(68402))).status).toBe(200);
    const legacy = (await runs.claim(68401, session, randomUUID(), randomUUID())).run;
    expect((await runs.complete(legacy, { type: 'complete', finalContent: 'UNBOUND_STAGED_PRIVATE', stopReason: 'completed' })).state).toBe('cancelled');
  }));
});
