import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import mysql, { type Pool } from 'mysql2/promise';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { ToolRegistry, type LLMProvider, type LLMResponse } from '@slide/agent-core';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { DirectAdapter } from '../direct-adapter.js';
import { dbConnection } from '../../db-connection.js';
import { chatDatabaseService } from '../../chat-database-service.js';
import { MigrationRunner } from '../../migrations/runner.js';
import { ActorContextService, signAccessToken, type ActorContext } from '../../auth/actor-context.js';
import { createVerifyToken } from '../../auth-middleware.js';
import { registerChatRoutes } from '../../chat-routes.js';

const port = process.env.INVESTIGATION_TEST_MYSQL_PORT;
if (process.env.MAX626_BROWSER_TEST && !port) throw new Error('Browser acceptance requires injected MySQL configuration');
const final: LLMResponse = { content: 'controlled answer', finishReason: 'stop', toolCalls: [], usage: {}, shouldExecuteTools: false, hasToolCalls: false };

describe.skipIf(!port)('MAX-626 real MySQL/JWT/REST/WS slash-command acceptance', () => {
  const database = `max626_${randomUUID().replaceAll('-', '')}`;
  let workspace: string;
  const secret = randomUUID();
  const clients: WebSocket[] = [];
  let admin: Pool, pool: Pool, adapter: DirectAdapter, http: FastifyInstance, actor: ActorContext, token: string, wsURL: string;
  let contexts: ActorContextService;
  let sessionKey: string;
  const providerMessages: unknown[][] = [];
  let hold: { entered: () => void; released: Promise<void> } | undefined;
  const releases: Array<() => void> = [];
  const gate = () => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(r => { entered = r; });
    const released = new Promise<void>(r => { release = r; });
    hold = { entered, released }; releases.push(release);
    return { ready, release };
  };
  const connect = async () => {
    const ws = new WebSocket(wsURL); clients.push(ws);
    const frames: any[] = [];
    const waiters: Array<{ match: (e: any) => boolean; resolve: (e: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
    ws.on('message', raw => {
      const e = JSON.parse(raw.toString()); frames.push(e);
      for (const w of [...waiters]) if (w.match(e)) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
    });
    ws.on('close', () => { for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error('socket closed')); } });
    const wait = (match: (e: any) => boolean) => {
      const prior = frames.find(match); if (prior) return Promise.resolve(prior);
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { const i = waiters.findIndex(w => w.timer === timer); if (i >= 0) waiters.splice(i, 1); reject(new Error('expected frame timed out')); }, 5000);
        waiters.push({ match, resolve, reject, timer });
      });
    };
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'auth', token })); await wait(e => e.type === 'auth_ok');
    return { ws, frames, wait, send: (frame: unknown) => ws.send(JSON.stringify(frame)) };
  };

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'max626-mysql-'));
    vi.stubEnv('AGENT_WS_PORT', '0'); vi.stubEnv('JWT_SECRET_KEY', secret); vi.stubEnv('SLIDE_MEMORY_ENABLED', 'false');
    const options = { host: process.env.REPORT_TEST_MYSQL_HOST ?? '127.0.0.1', port: Number(port), user: process.env.REPORT_TEST_MYSQL_USER ?? 'root',
      password: process.env.INVESTIGATION_TEST_MYSQL_PASSWORD ?? '', connectionLimit: 4 };
    admin = mysql.createPool(options); await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database });
    await new MigrationRunner(pool).run();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    await pool.query("INSERT INTO users (id, username, password_hash) VALUES (626, 'steer-owner', 'unused'), (627, 'steer-other', 'unused')");
    contexts = new ActorContextService(() => pool as never);
    actor = await contexts.loadActiveActor(626, 1); token = signAccessToken(actor, secret);
    sessionKey = (await chatDatabaseService.createSession(actor, { title: 'MAX-626 acceptance' })).session_id;
    const provider: LLMProvider = { getDefaultModel: () => 'controlled-fixture', chat: async () => final,
      chatStream: async messages => {
        providerMessages.push(structuredClone(messages));
        if (hold) { const current = hold; hold = undefined; current.entered(); await current.released; }
        return final;
      } };
    adapter = new DirectAdapter({ workspace, tools: new ToolRegistry(), llmProvider: provider, actorContextService: contexts });
    await adapter.start(); const server = (adapter as any).wsServer;
    if (!server.address()) await once(server, 'listening'); wsURL = `ws://127.0.0.1:${server.address().port}`;
    http = Fastify(); await registerChatRoutes(http, { verifyToken: createVerifyToken(secret, contexts), service: chatDatabaseService,
      handleChatSend: async () => { throw new Error('ordinary REST send outside this test'); } });
    await http.listen({ host: '127.0.0.1', port: 0 });
  }, 30_000);
  afterAll(async () => {
    for (const release of releases) release();
    for (const ws of clients) ws.terminate();
    await adapter?.dispose(); await http?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    try { await pool?.end(); } finally { if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS ${database}`); } finally { await admin.end(); } } }
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it('same-session REST is active without token stats; steer reaches the actual runner once and persists under the same Run', async () => {
    const c = await connect(); const g = gate();
    const id = randomUUID(); c.send({ type: 'chat.send', protocolVersion: 2, sessionKey, message: 'start', messageId: id, idempotencyKey: id });
    await g.ready; const started = await c.wait(e => e.type === 'run.started');
    const list = await http.inject({ url: '/api/sessions', headers: { authorization: `Bearer ${token}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json().sessions.find((s: any) => s.key === sessionKey)).toMatchObject({ status: 'active' });
    expect(list.json().sessions.find((s: any) => s.key === sessionKey)).not.toHaveProperty('inputTokens');
    c.send({ type: 'chat.steer', requestId: 'live', sessionKey, message: 'focus on rollback' });
    expect(await c.wait(e => e.requestId === 'live')).toMatchObject({ status: 'queued', runId: started.runId });
    c.send({ type: 'chat.steer', requestId: 'other-session', sessionKey: 'unknown', message: 'must not inject' });
    expect(await c.wait(e => e.requestId === 'other-session')).toMatchObject({ status: 'unavailable' });
    g.release(); await c.wait(e => e.type === 'complete');
    expect(providerMessages.some(messages => JSON.stringify(messages).includes('focus on rollback'))).toBe(true);
    const [runs] = await pool.query<any[]>('SELECT id,state FROM agent_runs WHERE session_id = ?', [sessionKey]);
    expect(runs).toEqual([{ id: started.runId, state: 'completed' }]);
    const messages = await chatDatabaseService.getMessages(actor, sessionKey);
    expect(messages.filter(m => m.content === 'focus on rollback')).toHaveLength(1);
    c.send({ type: 'chat.steer', requestId: 'completed', sessionKey, message: 'too late' });
    expect(await c.wait(e => e.requestId === 'completed')).toMatchObject({ status: 'no_active_run' });
  });

  it('ownership revocation and login revocation deny admission on an existing authenticated socket', async () => {
    const c = await connect(); const g = gate(); const id = randomUUID();
    c.send({ type: 'chat.send', protocolVersion: 2, sessionKey, message: 'ownership test', messageId: id, idempotencyKey: id });
    await g.ready; await c.wait(e => e.type === 'run.started');
    await pool.query('UPDATE chat_sessions SET user_id = 627 WHERE session_id = ?', [sessionKey]);
    c.send({ type: 'chat.steer', requestId: 'revoked-owner', sessionKey, message: 'forbidden-owner' });
    expect(await c.wait(e => e.requestId === 'revoked-owner')).toMatchObject({ status: 'unavailable' });
    await pool.query('UPDATE chat_sessions SET user_id = 626 WHERE session_id = ?', [sessionKey]);
    await pool.query('UPDATE users SET session_version = session_version + 1 WHERE id = 626');
    const closed = once(c.ws, 'close'); c.send({ type: 'chat.steer', requestId: 'revoked-login', sessionKey, message: 'forbidden-login' });
    expect((await closed)[0]).toBe(4001); g.release();
    await vi.waitFor(async () => {
      const [rows] = await pool.query<any[]>('SELECT state FROM agent_runs WHERE idempotency_key = ?', [id]); expect(rows[0].state).not.toBe('running');
    });
    expect(JSON.stringify(providerMessages)).not.toContain('forbidden-');
    actor = await contexts.loadActiveActor(626, 2); token = signAccessToken(actor, secret);
  });

  it.skipIf(!process.env.MAX626_BROWSER_TEST)('desktop browser keyboard path renders usage/help and steers the live Run', async () => {
    const requireFrontend = createRequire(new URL('../../../../../frontend/package.json', import.meta.url));
    const { chromium } = requireFrontend('@playwright/test');
    const { createServer } = await import(requireFrontend.resolve('vite'));
    const httpURL = `http://127.0.0.1:${(http.server.address() as any).port}`;
    const vite = await createServer({ root: fileURLToPath(new URL('../../../../../frontend', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: httpURL, configure(proxy: any) {
        proxy.on('proxyReq', (req: any) => req.setHeader('authorization', `Bearer ${token}`));
      } } } } });
    let browser: any, page: any;
    let stage = 'launch';
    try {
      await vite.listen(); const viteURL = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
      browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
      page = await browser.newPage();
      page.setDefaultTimeout(5000);
      page.on('pageerror', (error: Error) => console.error('browser page error', error.message));
      await page.addInitScript(({ wsURL, token }: any) => {
        const Native = (globalThis as any).WebSocket;
        (globalThis as any).WebSocket = class extends Native {
          constructor(url: string | URL, protocols?: string | string[]) { super(String(url).includes('/session-fixture') ? wsURL : url, protocols); }
          send(data: any) { try { const frame = JSON.parse(data); if (frame.type === 'auth') { frame.token = token; data = JSON.stringify(frame); } } catch {} super.send(data); }
        };
      }, { wsURL, token });
      stage = 'navigate';
      await page.goto(`${viteURL}/e2e/fixtures/chat-sessions.html`);
      stage = 'connected';
      await page.waitForFunction(() => (globalThis as any).sessionsFixture?.app.connected, undefined, { timeout: 5000 });
      stage = 'switch';
      await page.evaluate((key: string) => (globalThis as any).sessionsFixture.switch(key), sessionKey);
      const draft = page.locator('textarea');
      for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
        await page.setViewportSize({ width, height });
        stage = `usage-${width}`;
        await draft.fill('/usage'); await draft.press('Escape'); await draft.press('Enter');
        await page.waitForFunction(() => (globalThis as any).document.body.textContent?.includes('Input: 不可用'), undefined, { timeout: 5000 });
        expect(await draft.isVisible()).toBe(true);
        if (process.env.MAX626_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.MAX626_EVIDENCE_DIR, `usage-${width}.png`) });
      }
      stage = 'help';
      await draft.fill('/help'); await draft.press('Escape'); await draft.press('Enter');
      await page.waitForFunction(() => (globalThis as any).document.body.textContent?.includes('Available Commands'), undefined, { timeout: 5000 });
      for (const category of ['Session', 'Agents', 'Model']) expect(await page.getByText(category, { exact: true }).count()).toBe(1);
      stage = 'steer-idle';
      await draft.fill('/steer idle'); await draft.press('Escape'); await draft.press('Enter');
      await page.waitForFunction(() => (globalThis as any).document.body.textContent?.includes('没有可调整的活动运行'), undefined, { timeout: 5000 });
      expect(await page.locator('body').innerText()).not.toContain('/redirect');
      stage = 'start-run';
      const g = gate(); await draft.fill('browser start'); await draft.press('Escape'); await draft.press('Enter'); await g.ready;
      stage = 'steer-live';
      await draft.fill('/steer browser rollback'); await draft.press('Escape'); await draft.press('Enter');
      await page.waitForFunction(() => (globalThis as any).document.body.textContent?.includes('已为活动运行排队'), undefined, { timeout: 5000 });
      if (process.env.MAX626_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.MAX626_EVIDENCE_DIR, 'browser-queued.png') });
      g.release(); await page.waitForFunction(() => !(globalThis as any).sessionsFixture.app.chatRunId);
      expect(JSON.stringify(providerMessages)).toContain('browser rollback');
      await page.close();
    } catch (error) {
      console.error('browser stage', stage, await page?.locator('body').innerText());
      if (page && process.env.MAX626_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.MAX626_EVIDENCE_DIR, 'browser-failure.png') }).catch(() => {});
      throw error;
    } finally { for (const release of releases) release(); await browser?.close(); await vite.close(); }
  }, 30_000);
});
