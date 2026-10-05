import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ToolRegistry, type LLMProvider } from '../../packages/agent-core/src/index';
import { DirectAdapter } from '../../apps/db-ops-api/src/adapter/direct-adapter';
import { chatDatabaseService } from '../../apps/db-ops-api/src/chat-database-service';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection';

test('MAX-129 real MySQL → Adapter → WS → Gateway → reducer → UI, refresh and unique completion', async ({ page, browser }) => {
  const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
  const mysql = require('mysql2/promise'); const WebSocket = require('ws');
  const schema = `slide_stream_${randomUUID().replaceAll('-', '')}`;
  const connection = await mysql.createConnection({ host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD });
  const workspace = await mkdtemp(join(tmpdir(), 'slide-stream-live-'));
  let adapter: DirectAdapter | undefined; let legacy: any; let releaseTool: (() => void) | undefined;
  const raw: Record<string, object[]> = { legacy: [], parts: [] };
  try {
    await connection.query(`CREATE DATABASE \`${schema}\``);
    Object.assign(process.env, { DB_NAME: schema, AGENT_WS_PORT: '0', AGENT_WS_HOST: '127.0.0.1',
      JWT_SECRET_KEY: randomUUID() + randomUUID(), ENCRYPTION_KEY: randomUUID(), AGENT_RUN_TIMEOUT_MS: '120000' });
    const init = spawnSync('pnpm', ['--filter', 'slide-api', 'exec', 'tsx', 'init-db.ts'], { cwd: new URL('../..', import.meta.url), env: process.env, encoding: 'utf8', timeout: 120_000 });
    expect(init.status, init.stderr).toBe(0); expect(await dbConnection.initialize()).toBe(true);
    const pool = dbConnection.getPool()!;
    const [created] = await pool.execute("INSERT INTO users (username,password_hash,status) VALUES (?, 'fixture-no-login', 'active')", [`stream-${randomUUID()}`]) as any;
    const actor = { userId: created.insertId, username: 'stream-fixture', roles: ['viewer'], permissions: [], sessionVersion: 1, instanceScopes: {}, requestId: randomUUID() };
    const session = await chatDatabaseService.createSession(actor, { title: 'MAX-129 real stream' });
    await pool.query('CREATE TABLE fixture_tool_effects (tool_id INT PRIMARY KEY)');
    let requests = 0; let executions = 0;
    const tools = new ToolRegistry();
    tools.register({ name: 'fixture_query', description: 'isolated SELECT fixture', parameters: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] }, readOnly: true, concurrencySafe: true, exclusive: false,
      execute: async (args, ctx) => {
        executions++; const index = Number(args.index);
        await pool.execute('INSERT INTO fixture_tool_effects VALUES (?)', [index]);
        const [rows] = await pool.query('SELECT 1 AS result');
        await ctx?.progressCallback?.({ completed: 1, total: 1 });
        if (index === 99) await new Promise<void>(resolve => { releaseTool = resolve; });
        return { success: true, rows };
      } });
    const chunks = Array.from({ length: 1000 }, (_, i) => `Result ${String(i).padStart(4, '0')}: SELECT ${i}; verified database row.\n`.padEnd(100, ' '));
    const body = chunks.join(''); expect(Buffer.byteLength(body)).toBe(100_000);
    const final = { content: '检查完成。', finishReason: 'stop', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, shouldExecuteTools: false, hasToolCalls: false };
    const provider: LLMProvider = { getDefaultModel: () => 'controlled-live', getModelCapabilities: () => ({ version: 'fixture/v1', model: 'controlled-live', contextWindowTokens: 200_000, maxOutputTokens: 64_000, source: 'configuration' }),
      chat: async () => final, chatStream: async (_m, _t, c) => {
        const batch = requests++;
        if (batch < 10) {
          if (batch === 0) {
            await c.onThinkingDelta?.('真实 fixture 思考');
            for (const chunk of chunks) { await c.onContentDelta(chunk); await new Promise<void>(resolve => setImmediate(resolve)); }
          }
          return { ...final, content: batch === 0 ? body : null, finishReason: 'tool_calls', hasToolCalls: true, shouldExecuteTools: true,
            toolCalls: Array.from({ length: 10 }, (_, i) => ({ id: `call-${batch * 10 + i}`, name: 'fixture_query', arguments: { index: batch * 10 + i } })) };
        }
        await c.onContentDelta(final.content); return final;
      } };
    adapter = new DirectAdapter({ workspace, concurrentTools: true, tools, toolsForActor: () => tools, llmProvider: provider,
      actorContextService: { authenticateAccessToken: async () => actor, revalidateActor: async () => actor } });
    await adapter.start(); const server = (adapter as any).wsServer;
    if (!server.address()) await once(server, 'listening'); const port = server.address().port;
    // Observe both modes on the same run, including actual server writer bytes.
    const serverTimings: object[] = [];
    server.on('connection', (socket: any) => {
      const send = socket.send.bind(socket);
      socket.send = (data: string, callback: (error?: Error) => void) => {
        const event = JSON.parse(data); const at = performance.now();
        if (event.type === 'stream.delta' || event.type === 'stream.snapshot') raw.parts.push(event);
        send(data, (error?: Error) => { serverTimings.push({ type: event.type, sendCallbackMs: performance.now() - at }); callback?.(error); });
      };
    });
    legacy = new WebSocket(`ws://127.0.0.1:${port}`);
    legacy.on('message', (data: Buffer) => { const event = JSON.parse(data.toString()); raw.legacy.push(event); if (event.type === 'auth_ok') legacy.send(JSON.stringify({ type: 'chat.watch', sessionKey: session.session_id })); });
    await once(legacy, 'open'); legacy.send(JSON.stringify({ type: 'auth', token: 'fixture' }));
    await expect.poll(() => raw.legacy.some((e: any) => e.type === 'auth_ok')).toBe(true);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,blink.user_timing', transferMode: 'ReturnAsStream' });
    const mount = async () => {
      await page.goto('/e2e/fixtures/chat-history.html'); await page.waitForFunction(() => Boolean((window as any).historyFixture));
      await page.evaluate(async ({ port, sessionKey }) => {
        const { DirectGatewayClient, handleDirectAdapterEvent } = await import('/src/app/ui/direct-gateway.ts');
        const f = (window as any).historyFixture;
        f.props.messages = []; f.props.sessionKey = sessionKey; f.props.showToolCalls = true;
        const host: any = { sessionKey, chatRunId: null, chatStream: '', chatThinkingText: '', chatToolMessages: [], chatStreamSegments: [],
          toolStreamById: new Map(), toolStreamOrder: [], chatMessages: [], chatQueue: [], chatSending: false, settings: {}, applySettings() {}, refreshSessionsAfterChat: new Set() };
        (window as any).__apiClient = { getToken: () => 'fixture' };
        const samples: any[] = []; const received: any[] = [];
        const gateway = new DirectGatewayClient({ url: `ws://127.0.0.1:${port}`, onStateChange: state => { if (state === 'connected') gateway.watchSession(sessionKey); },
          onEvent: event => {
            const at = performance.now(); received.push({ at, event }); handleDirectAdapterEvent(host, event);
            Object.assign(f.props, { messageProjection: host.chatMessageProjection, runtimePhase: host.chatRuntimePhase, runId: host.chatRunId,
              messages: host.chatMessages, sending: host.chatSending, stream: host.chatStream }); f.update();
            queueMicrotask(() => { const applied = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => {
              const end = performance.now(); samples.push({ type: event.type, at, applyMs: applied - at, paintMs: end - at });
              performance.measure('MAX129 receive-to-paint', { start: at, end });
            })); });
          } });
        host.client = gateway; gateway.connect();
        (window as any).live = { gateway, host, received, samples };
      }, { port, sessionKey: session.session_id });
      await page.waitForFunction(() => (window as any).live.gateway.isConnected());
    };
    await mount();
    await page.evaluate(() => (window as any).live.gateway.request('chat.send', { sessionKey: (window as any).live.host.sessionKey, message: '检查 fixture 数据库状态' }));
    await expect.poll(() => executions, { timeout: 30_000 }).toBe(100);
    await expect.poll(() => Boolean(releaseTool)).toBe(true);
    await expect(page.locator('.chat-tool-msg-collapse')).toHaveCount(100, { timeout: 15000 });
    const before = await page.evaluate(() => ({ samples: (window as any).live.samples, received: (window as any).live.received }));
    await page.screenshot({ path: test.info().outputPath('MAX-129-live-tools.png'), fullPage: true });
    await page.evaluate(() => (window as any).live.gateway.disconnect());
    await mount(); // browser navigation discards all projection state: genuine refresh snapshot
    await expect(page.locator('.chat-tool-msg-collapse')).toHaveCount(100, { timeout: 15000 });
    expect(executions).toBe(100); expect(requests).toBe(10);
    await expect.poll(async () => page.evaluate(() => (window as any).live.host.chatMessageProjection?.parts.filter((p: any) => p.part.type === 'text').map((p: any) => p.part.text).join(''))).toBe(body);
    releaseTool();
    await expect.poll(async () => page.evaluate(() => (window as any).live.host.chatMessageProjection?.terminal), { timeout: 15000 }).toBe('completed');
    const after = await page.evaluate(() => ({ samples: (window as any).live.samples, received: (window as any).live.received, projection: (window as any).live.host.chatMessageProjection }));
    expect(after.projection.durable).toBeTruthy();
    const [messages] = await pool.query<any[]>('SELECT content FROM chat_messages WHERE session_id = ? AND role = ?', [session.session_id, 'assistant']);
    expect(messages).toHaveLength(1); expect(messages[0].content).toBe(body + final.content);
    const [effects] = await pool.query<any[]>('SELECT COUNT(*) AS count FROM fixture_tool_effects'); expect(effects[0].count).toBe(100);
    expect(executions).toBe(100); expect(requests).toBe(11);
    await page.evaluate(() => (window as any).live.gateway.disconnect());
    await mount(); await expect.poll(async () => page.evaluate(() => (window as any).live.host.chatMessageProjection?.terminal)).toBe('completed');
    expect(executions).toBe(100); expect(requests).toBe(11);
    const metrics = (events: any[]) => {
      let bodyBytes = 0, jsonBytes = 0; const text = (v: any, key = '') => { if (typeof v === 'string' && ['delta','partText','finalContent','thinkingContent','text','content'].includes(key)) bodyBytes += Buffer.byteLength(JSON.stringify(v)); else if (v && typeof v === 'object') for (const [k, value] of Object.entries(v)) text(value, k); };
      for (const event of events) { jsonBytes += Buffer.byteLength(JSON.stringify(event)); text(event); }
      return { bodyBytes, jsonBytes, wsBytesUpperBound: jsonBytes + events.length * 14, metadataAndFrameBytesUpperBound: jsonBytes + events.length * 14 - bodyBytes, frames: events.length };
    };
    // Only the uninterrupted original subscription is compared; refresh traffic is reported separately.
    const firstSubscription = (raw.parts[0] as any).stream.subscriptionId;
    const parts = metrics(raw.parts.filter((e: any) => e.stream.subscriptionId === firstSubscription));
    const old = metrics(raw.legacy); const reduction = 1 - parts.bodyBytes / old.bodyBytes;
    expect(reduction).toBeGreaterThanOrEqual(.8);
    const accepted = before.received.find((s: any) => s.event.type === 'run.started');
    const actual = before.received.find((s: any) => s.event.snapshot?.phase === 'waiting_model' || s.event.projection?.operations.some((op: any) => op.type === 'run.status' && op.phase === 'waiting_model'));
    const acceptedToActualMs = actual.at - accepted.at; expect(acceptedToActualMs).toBeGreaterThanOrEqual(0); expect(acceptedToActualMs).toBeLessThanOrEqual(100);
    const samples = [...before.samples, ...after.samples].filter(s => s.type.startsWith('stream.'));
    const p95 = (values: number[]) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*.95)-1];
    const paintP95 = p95(samples.map(s => s.paintMs)); expect(paintP95).toBeLessThanOrEqual(100);
    const evidence = { sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      hardware: { cpu: cpus()[0].model, cores: cpus().length, memoryBytes: totalmem(), platform: platform(), release: release() }, browser: browser.version(),
      pid: process.pid, port, schema, cwd: process.cwd(), mode: 'real WS/MySQL/Gateway/reducer/renderChat; actor authentication and provider controlled; tools SELECT 1 plus isolated counter',
      fragments: 1000, generatedBytes: 100000, legacy: old, parts, reduction, refreshFrames: raw.parts.length - parts.frames,
      acceptedToActualMs, paintP95, applyP95: p95(samples.map(s => s.applyMs)), timing: 'same browser performance.now; 2 rAF conservative paint bound; server callback clock separately',
      executions, requests, assistantMessages: messages.length, durable: after.projection.durable, capacity: (adapter as any).displayStreams.stats(), samples, serverTimings };
    await writeFile(test.info().outputPath('MAX-129-live-metrics.json'), JSON.stringify(evidence, null, 2));
    await writeFile(test.info().outputPath('MAX-129-wire.json'), JSON.stringify(raw));
    const complete = new Promise<any>(resolve => cdp.once('Tracing.tracingComplete', resolve)); await cdp.send('Tracing.end'); const { stream } = await complete;
    const trace: Buffer[] = []; for (;;) { const value = await cdp.send('IO.read', { handle: stream }); trace.push(Buffer.from(value.data, value.base64Encoded ? 'base64' : 'utf8')); if (value.eof) break; }
    await cdp.send('IO.close', { handle: stream }); await writeFile(test.info().outputPath('MAX-129-live-trace.json'), Buffer.concat(trace));
    await page.evaluate(() => (window as any).live.gateway.disconnect());
  } finally {
    releaseTool?.(); legacy?.close(); await adapter?.dispose(); await dbConnection.close();
    await connection.query(`DROP DATABASE IF EXISTS \`${schema}\``); await connection.end(); await rm(workspace, { recursive: true, force: true });
  }
});
