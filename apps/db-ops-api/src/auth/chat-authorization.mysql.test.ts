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
  async function client(jwt: string) {
    const server = (adapter as any).wsServer;
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    clients.push(socket);
    const events: any[] = [];
    socket.on('message', data => events.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'auth', token: jwt }));
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
    const s = scope(await actor(68401, 1)); await vi.waitFor(() => expect(s.controller.signal.aborted).toBe(true), { timeout: 1800 });
    await expect(withChatExecution(s, () => guardedChatProvider(provider).chat([], []))).rejects.toThrow();
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
    const before = run.chatAuthority; await client(await token());
    expect((await runs.getForActor(run.id, a.userId, session))?.chatAuthority).toEqual(before);
    expect(before?.expiresAt).toBe(chatCredential(a)?.expiresAt);
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
