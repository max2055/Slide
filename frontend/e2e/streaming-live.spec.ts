import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, platform, release, totalmem, loadavg } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ToolRegistry, type LLMProvider } from '../../packages/agent-core/src/index';
import { DirectAdapter } from '../../apps/db-ops-api/src/adapter/direct-adapter';
import { chatDatabaseService } from '../../apps/db-ops-api/src/chat-database-service';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection';
import { canonicalStore } from '../../apps/db-ops-api/src/adapter/canonical-store';
import { registerChatRoutes } from '../../apps/db-ops-api/src/chat-routes';
import { createVerifyToken } from '../../apps/db-ops-api/src/auth-middleware';
import { streamingIdentity } from '../../apps/db-ops-api/tests/streaming-auth-fixture';

// Real login/JWT frames must not enter the automatically uploaded trace.zip.
// The original CDP performance trace and numeric/wire diagnostics remain below.
test.use({ trace: 'off' });

// Stop browser timers/WS, then await route.fetch while its backend still lives.
async function closeStreamingPage(page: Page) {
  if (page.isClosed()) return;
  try {
    await page.evaluate(() => (window as any).live?.gateway.disconnect());
    await page.goto('about:blank');
    await page.unrouteAll({ behavior: 'wait' });
  } finally { await page.close(); }
}

function combinedFailure(primary: unknown, cleanup: unknown[]) {
  return cleanup.length ? new AggregateError([primary, ...cleanup].filter(e => e !== undefined),
    'Live stream test or cleanup failed', { cause: primary ?? cleanup[0] }) : primary;
}

// MAX-684: test-only observation. No payload/identifier/error strings survive
// aggregation; fixed enums and finite numbers are the entire export schema.
function streamObservation(now: () => number) {
  const types = ['auth_ok', 'run.started', 'stream.delta', 'stream.snapshot', 'text_delta', 'chat', 'error', 'protocol.error', 'other'];
  const boundaries = ['tool99-paused', 'tool99-before-refresh', 'finally-before-cleanup'];
  const connections: any[] = [], snapshots: any[] = [];
  let collectionFailed = 0, dropped = 0;
  const safe = (fn: () => void) => { try { fn(); } catch { collectionFailed++; } };
  const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const metrics = (event: any) => {
    let bodyBytes = 0;
    const text = (value: any, key = '') => {
      if (typeof value === 'string' && ['delta', 'partText', 'finalContent', 'thinkingContent', 'text', 'content'].includes(key)) bodyBytes += Buffer.byteLength(JSON.stringify(value));
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) text(v, k);
    };
    text(event);
    return { bodyBytes, jsonBytes: Buffer.byteLength(JSON.stringify(event)) };
  };
  const totals = () => ({ frames: 0, bodyBytes: 0, jsonBytes: 0, eventCounts: types.map(() => 0) });
  const frame = (target: any, event: any) => {
    const size = metrics(event); target.frames++; target.bodyBytes += size.bodyBytes; target.jsonBytes += size.jsonBytes;
    const index = types.indexOf(event.type); target.eventCounts[index < 0 ? types.length - 1 : index]++;
  };
  const queue = (writer: any, socket: any) => ({
    queuedEvents: numeric(writer.queued.get(socket)?.events ?? 0), queuedBytes: numeric(writer.queued.get(socket)?.bytes ?? 0),
    pendingEvents: numeric(writer.pending.get(socket)?.events ?? 0), pendingBytes: numeric(writer.pending.get(socket)?.bytes ?? 0),
    bufferedAmount: numeric(socket.bufferedAmount), maxEvents: numeric(writer.maxEvents), maxBytes: numeric(writer.maxBytes),
  });
  const reasonCode = (reason: unknown) => {
    // Recognize only exact product literals. Never retain the original reason.
    const value = typeof reason === 'string' ? reason : Buffer.isBuffer(reason) ? reason.toString() : '';
    return value === 'Slow consumer' ? 'guard-queue-limit' : value === 'Slow consumer; reconnect for history/snapshot' ? 'raw-pending-limit'
      : value === 'Service unavailable' ? 'guard-failed' : value === '' ? 'empty' : 'other';
  };
  const observers = new WeakMap<object, any>();
  const samplers: Array<() => void> = [];
  return {
    connect(writer: any, socket: any) {
      if (connections.length >= 16) { dropped++; return undefined; }
      const entry: any = { connectionIndex: connections.length + 1,
        // This fixture opens legacy first, then the original browser and refreshes.
        mode: connections.length === 0 ? 'legacy' : 'parts', admissionCalls: 0, admissionAccepted: 0, admissionRejected: 0,
        actualSend: totals(), clientReceive: connections.length === 0 ? totals() : null, callbackOK: 0, callbackFailed: 0, closeCode: null, reasonCode: 'not-closed',
        closed: 0, closeRequests: 0, lastQueue: null, peakQueue: null, closeQueue: null, closeAt: null };
      connections.push(entry);
      const sample = () => {
        const value = queue(writer, socket); entry.lastQueue = value;
        entry.peakQueue ??= { ...value };
        for (const key of Object.keys(value)) entry.peakQueue[key] = Math.max(entry.peakQueue[key] ?? 0, value[key] ?? 0);
      };
      const originalSend = writer.send;
      // One wrapper per writer, installed when the first socket is observed.
      if (connections.length === 1) {
        writer.send = function (ws: any, data: string) {
          const observer = observers.get(ws);
          observer?.before();
          try { const result = originalSend.call(this, ws, data); observer?.admitted(result); return result; }
          finally { observer?.sample(); }
        };
      }
      const observation = {
        before() { safe(() => { entry.admissionCalls++; sample(); }); },
        admitted(result: boolean) { safe(() => { entry[result ? 'admissionAccepted' : 'admissionRejected']++; }); },
        sample() { safe(sample); },
        sent(event: any) { safe(() => { frame(entry.actualSend, event); sample(); }); },
        callback(error?: Error) { safe(() => { entry[error ? 'callbackFailed' : 'callbackOK']++; sample(); }); },
        closing(code: number, reason: unknown) { safe(() => { entry.closeRequests++; entry.closeCode = numeric(code); entry.reasonCode = reasonCode(reason); entry.closeAt = numeric(now()); entry.closeQueue = queue(writer, socket); }); },
        closed(code: number, reason: unknown) { safe(() => { entry.closed = 1; entry.closeCode = numeric(code); if (!entry.closeRequests) entry.reasonCode = reasonCode(reason); sample(); }); },
      };
      observers.set(socket, observation);
      samplers.push(observation.sample); observation.sample(); return observation;
    },
    legacyReceived(event: any) { safe(() => { if (connections[0]) frame(connections[0].clientReceive, event); }); },
    legacyClosed(code: number, reason: unknown) { safe(() => {
      if (connections[0]) { connections[0].closed = 1; connections[0].closeCode = numeric(code);
        if (!connections[0].closeRequests) connections[0].reasonCode = reasonCode(reason); }
    }); },
    boundary(boundary: string, prefix?: { parts: object[]; legacy: object[] }) { safe(() => {
      if (!boundaries.includes(boundary)) throw new Error('Unknown numeric boundary');
      if (snapshots.length >= 3) { dropped++; return; }
      for (const sample of samplers) sample();
      // Copy now: later callbacks, closes and refreshes cannot rewrite a prefix.
      const summarize = (events: object[]) => {
        let bodyBytes = 0, jsonBytes = 0;
        for (const event of events) { const size = metrics(event); bodyBytes += size.bodyBytes; jsonBytes += size.jsonBytes; }
        return { prefixFrameCount: events.length, bodyBytes, jsonBytes };
      };
      const parts = prefix ? summarize(prefix.parts) : null, legacy = prefix ? summarize(prefix.legacy) : null;
      const comparison = parts && legacy ? { parts, legacy, reduction: legacy.bodyBytes > 0 ? 1 - parts.bodyBytes / legacy.bodyBytes : null } : null;
      snapshots.push(JSON.parse(JSON.stringify({ boundary, mono: numeric(now()), comparison, connections })));
    }); },
    save(path: string, sourceHead: string, businessExit: number, persist: (path: string, data: string) => void) {
      for (const sample of samplers) sample();
      const document = { version: 1, sourceHead: /^[a-f0-9]{40}$/.test(sourceHead) ? sourceHead : null,
        scenario: 'MAX-129', clockDomain: 'node-performance', eventTypes: types,
        collectionFailed, dropped, overflow: 0, businessExit, snapshots, connections };
      let serialized = JSON.stringify(document);
      if (Buffer.byteLength(serialized) > 65536) {
        document.overflow = 1; document.dropped += snapshots.length + connections.length;
        document.snapshots = []; document.connections = []; serialized = JSON.stringify(document);
      }
      persist(path, serialized);
      if (document.collectionFailed || document.dropped || document.overflow) throw new Error('Numeric observation incomplete');
    },
  };
  // Socket identities remain memory-only; no run/session HMAC is needed.
}

test('MAX-129 real MySQL → Adapter → WS → Gateway → reducer → UI, refresh and unique completion', async ({ page, browser }) => {
  const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
  const mysql = require('mysql2/promise'); const WebSocket = require('ws');
  const schema = `slide_stream_${randomUUID().replaceAll('-', '')}`;
  const connection = await mysql.createConnection({ host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD });
  const workspace = await mkdtemp(join(tmpdir(), 'slide-stream-live-'));
  let adapter: DirectAdapter | undefined; let legacy: any; let rest: any; let releaseTool: (() => void) | undefined;
  const raw: Record<string, object[]> = { legacy: [], parts: [] };
  const observation = streamObservation(() => performance.now());
  // MAX-279: numeric metadata only; no SQL, arguments, messages or credentials.
  const serverTimings: object[] = [];
  const stages: Array<{ stage: string; start: number; end?: number }> = [];
  const cleanup: Array<{ stage: string; at: number }> = [];
  const environment = { load: loadavg(), cores: cpus().length, platform: platform(), release: release() };
  let startupStart: number | undefined; let startupEnd: number | undefined;
  let startupCpu: NodeJS.CpuUsage | undefined;
  let startupLoop: ReturnType<typeof performance.eventLoopUtilization> | undefined;
  let startupUsage: object | undefined;
  let failure: unknown; let cleanupFailure: unknown;
  const service = chatDatabaseService as any;
  const originals: Array<() => void> = [];
  const secrets: string[] = [];
  const redact = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[fixture-credential-redacted]'), value);
  const observeCalls = (target: any, methods: string[]) => {
    for (const method of methods) {
      const original = target[method]; originals.push(() => { target[method] = original; });
      target[method] = async function (...args: any[]) {
        const span = startupStart !== undefined && startupEnd === undefined
          ? { stage: method, start: performance.now(), end: undefined as number | undefined } : undefined;
        if (span) stages.push(span);
        try { return await original.apply(this, args); }
        finally { if (span) span.end = performance.now(); }
      };
    }
  };
  observeCalls(service, ['addMessage', 'getMessages', 'authorizeSession', 'getSessionMetadata']);
  try {
    await connection.query(`CREATE DATABASE \`${schema}\``);
    Object.assign(process.env, { DB_NAME: schema, AGENT_WS_PORT: '0', AGENT_WS_HOST: '127.0.0.1',
      JWT_SECRET_KEY: randomUUID() + randomUUID(), ENCRYPTION_KEY: randomUUID(), AGENT_RUN_TIMEOUT_MS: '120000' });
    const init = spawnSync('pnpm', ['--filter', 'slide-api', 'exec', 'tsx', 'init-db.ts'], { cwd: new URL('../..', import.meta.url), env: process.env, encoding: 'utf8', timeout: 120_000 });
    expect(init.status, init.stderr).toBe(0); expect(await dbConnection.initialize()).toBe(true);
    const pool = dbConnection.getPool()!;
    const username = `stream-${randomUUID()}`;
    const password = randomUUID().replaceAll('-', ''); secrets.push(password);
    const [created] = await pool.execute('INSERT INTO users (username,password_hash,status) VALUES (?, ?, \'active\')', [username, await require('bcrypt').hash(password, 10)]) as any;
    const [role] = await pool.execute('INSERT INTO roles(name) VALUES(?)', [username]) as any;
    await pool.execute('INSERT INTO user_roles(user_id,role_id) VALUES(?,?)', [created.insertId, role.insertId]);
    await pool.execute("INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code='chat:view'", [role.insertId]);
    const identity = streamingIdentity();
    rest = require('fastify')();
    identity.registerLogin(rest);
    await registerChatRoutes(rest, { service: chatDatabaseService,
      verifyToken: createVerifyToken(identity.secret, identity.actors), handleChatSend: async () => { throw new Error('fixture uses WS admission'); } });
    await rest.listen({ port: 0, host: '127.0.0.1' }); const restPort = rest.server.address().port;
    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      const original = new URL(route.request().url());
      const response = await route.fetch({ url: `http://127.0.0.1:${restPort}${original.pathname}${original.search}` });
      await route.fulfill({ response });
    });
    await page.goto('/e2e/fixtures/streaming-login.html');
    await page.locator('input[autocomplete="username"]').fill(username);
    await page.locator('input[autocomplete="current-password"]').fill(password);
    const login = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/login');
    await page.locator('.login-gate__connect').click();
    const loggedIn = await login; expect(loggedIn.status()).toBe(200);
    const token = (await loggedIn.json()).token; secrets.push(token);
    await expect(page.locator('#fixture')).toHaveAttribute('data-authenticated', 'true');
    const { session } = await identity.createSession(token);
    await pool.query('CREATE TABLE fixture_tool_effects (tool_id INT PRIMARY KEY)');
    let requests = 0; let executions = 0;
    const tools = new ToolRegistry();
    tools.register({ name: 'fixture_query', description: 'isolated SELECT fixture', parameters: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] }, readOnly: true, concurrencySafe: true, exclusive: false,
      execute: async (args, ctx) => {
        executions++; const index = Number(args.index);
        await pool.execute('INSERT INTO fixture_tool_effects VALUES (?)', [index]);
        const [rows] = await pool.query('SELECT 1 AS result');
        await ctx?.progressCallback?.({ completed: 1, total: 1 });
        if (index === 99) { observation.boundary('tool99-paused'); await new Promise<void>(resolve => { releaseTool = resolve; }); }
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
      actorContextService: identity.actors });
    observeCalls(canonicalStore, ['getPage', 'saveCheckpoint']);
    observeCalls((adapter as any).contextBuilder, ['buildMessages']);
    observeCalls((adapter as any).sessionManager, ['save']);
    await adapter.start(); const server = (adapter as any).wsServer;
    if (!server.address()) await once(server, 'listening'); const port = server.address().port;
    // Observe both modes on the same run, including actual server writer bytes.
    server.on('connection', (socket: any) => {
      const numeric = observation.connect((adapter as any).socketWriter, socket);
      const close = socket.close;
      socket.close = function (code: number, reason: unknown) { numeric?.closing(code, reason); return close.call(this, code, reason); };
      socket.on('close', (code: number, reason: Buffer) => numeric?.closed(code, reason));
      const send = socket.send.bind(socket);
      socket.send = (data: string, callback: (error?: Error) => void) => {
        const event = JSON.parse(data); const at = performance.now();
        numeric?.sent(event);
        if (event.type === 'stream.delta' || event.type === 'stream.snapshot') raw.parts.push(event);
        const phase = event.snapshot?.phase ?? event.projection?.operations?.find((op: any) => op.type === 'run.status')?.phase;
        if (event.type === 'run.started' && startupStart === undefined) {
          startupStart = at; startupCpu = process.cpuUsage(); startupLoop = performance.eventLoopUtilization();
        }
        if (phase === 'waiting_model' && startupStart !== undefined && startupEnd === undefined) {
          startupEnd = at;
          startupUsage = { cpuMicros: process.cpuUsage(startupCpu), eventLoop: performance.eventLoopUtilization(startupLoop) };
        }
        send(data, (error?: Error) => { serverTimings.push({ type: event.type, phase, at, sendCallbackMs: performance.now() - at }); numeric?.callback(error); callback?.(error); });
      };
    });
    legacy = new WebSocket(`ws://127.0.0.1:${port}`);
    legacy.on('message', (data: Buffer) => { const event = JSON.parse(data.toString()); raw.legacy.push(event); observation.legacyReceived(event); if (event.type === 'auth_ok') legacy.send(JSON.stringify({ type: 'chat.watch', sessionKey: session.session_id })); });
    legacy.on('close', (code: number, reason: Buffer) => observation.legacyClosed(code, reason));
    await once(legacy, 'open'); legacy.send(JSON.stringify({ type: 'auth', token }));
    await expect.poll(() => raw.legacy.some((e: any) => e.type === 'auth_ok')).toBe(true);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,blink.user_timing', transferMode: 'ReturnAsStream' });
    const mount = async () => {
      await page.goto('/e2e/fixtures/chat-history.html'); await page.waitForFunction(() => Boolean((window as any).historyFixture));
      await page.evaluate(async ({ port, sessionKey, token }) => {
        const { DirectGatewayClient, handleDirectAdapterEvent } = await import('/src/app/ui/direct-gateway.ts');
        const { getChatProjection } = await import('/src/app/ui/chat/message-projection.ts');
        const f = (window as any).historyFixture;
        f.props.messages = []; f.props.sessionKey = sessionKey; f.props.showToolCalls = true;
        const update = (target: any) => {
          Object.assign(f.props, { messageProjection: target.chatMessageProjection, runtimePhase: target.chatRuntimePhase, runId: target.chatRunId,
            messages: target.chatMessages, sending: target.chatSending, stream: target.chatStream }); f.update();
        };
        // Fixture shell supplies Lit's reactive host boundary; rendering, Gateway,
        // reducer, HTTP history routes, transactions and tool execution are real.
        const host: any = new Proxy({ sessionKey, connected: true, chatRunId: null, chatStream: '', chatThinkingText: '', chatToolMessages: [], chatStreamSegments: [],
          toolStreamById: new Map(), toolStreamOrder: [], chatMessages: [], chatQueue: [], chatSending: false, settings: {}, applySettings() {}, refreshSessionsAfterChat: new Set() },
          { set(target, key, value) { Reflect.set(target, key, value); update(target); return true; } });
        (window as any).__apiClient = { getToken: () => token };
        const samples: any[] = []; const received: any[] = [];
        let latestProjection: any;
        const gateway = new DirectGatewayClient({ url: `ws://127.0.0.1:${port}`, onStateChange: state => { if (state === 'connected') gateway.watchSession(sessionKey); },
          onEvent: event => {
            const at = performance.now(); received.push({ at, event }); handleDirectAdapterEvent(host, event);
            if (event.stream) latestProjection = getChatProjection(host, event.stream.runId);
            queueMicrotask(() => { const applied = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => {
              const end = performance.now(); samples.push({ type: event.type, at, applyMs: applied - at, paintMs: end - at });
              performance.measure('MAX129 receive-to-paint', { start: at, end });
            })); });
          } });
        host.client = gateway; gateway.connect();
        (window as any).live = { gateway, host, received, samples, get projection() { return latestProjection; } };
      }, { port, sessionKey: session.session_id, token });
      await page.waitForFunction(() => (window as any).live.gateway.isConnected());
    };
    await mount();
    await page.evaluate(() => (window as any).live.gateway.request('chat.send', { sessionKey: (window as any).live.host.sessionKey, message: '检查 fixture 数据库状态' }));
    await expect.poll(() => executions, { timeout: 30_000 }).toBe(100);
    await expect.poll(() => Boolean(releaseTool)).toBe(true);
    await expect(page.locator('.chat-tool-msg-collapse')).toHaveCount(100, { timeout: 15000 });
    const before = await page.evaluate(() => ({ samples: (window as any).live.samples, received: (window as any).live.received }));
    const uninterrupted = { parts: [...raw.parts], legacy: [...raw.legacy] };
    observation.boundary('tool99-before-refresh', uninterrupted);
    await page.screenshot({ path: test.info().outputPath('MAX-129-live-tools.png'), fullPage: true });
    await page.evaluate(() => (window as any).live.gateway.disconnect());
    await mount(); // browser navigation discards all projection state: genuine refresh snapshot
    await expect(page.locator('.chat-tool-msg-collapse')).toHaveCount(100, { timeout: 15000 });
    expect(executions).toBe(100); expect(requests).toBe(10);
    await expect.poll(async () => page.evaluate(() => (window as any).live.host.chatMessageProjection?.parts.filter((p: any) => p.part.type === 'text').map((p: any) => p.part.text).join(''))).toBe(body);
    releaseTool();
    await expect.poll(async () => page.evaluate(() => (window as any).live.projection?.terminal), { timeout: 15000 }).toBe('completed');
    const after = await page.evaluate(() => ({ samples: (window as any).live.samples, received: (window as any).live.received, projection: (window as any).live.projection }));
    expect(after.projection.durable).toBeTruthy();
    const [messages] = await pool.query<any[]>('SELECT content FROM chat_messages WHERE session_id = ? AND role = ?', [session.session_id, 'assistant']);
    expect(messages).toHaveLength(1); expect(messages[0].content).toContain(final.content);
    const [effects] = await pool.query<any[]>('SELECT COUNT(*) AS count FROM fixture_tool_effects'); expect(effects[0].count).toBe(100);
    expect(executions).toBe(100); expect(requests).toBe(11);
    await page.evaluate(() => (window as any).live.gateway.disconnect());
    await mount(); await expect.poll(async () => page.evaluate(() => (window as any).live.projection?.terminal)).toBe('completed');
    await expect(page.locator('.chat-tool-msg-collapse')).toHaveCount(100, { timeout: 15000 });
    expect(executions).toBe(100); expect(requests).toBe(11);
    const metrics = (events: any[]) => {
      let bodyBytes = 0, jsonBytes = 0; const text = (v: any, key = '') => { if (typeof v === 'string' && ['delta','partText','finalContent','thinkingContent','text','content'].includes(key)) bodyBytes += Buffer.byteLength(JSON.stringify(v)); else if (v && typeof v === 'object') for (const [k, value] of Object.entries(v)) text(value, k); };
      for (const event of events) { jsonBytes += Buffer.byteLength(JSON.stringify(event)); text(event); }
      return { bodyBytes, jsonBytes, wsBytesUpperBound: jsonBytes + events.length * 14, metadataAndFrameBytesUpperBound: jsonBytes + events.length * 14 - bodyBytes, frames: events.length };
    };
    // Only the uninterrupted original subscription is compared; refresh traffic is reported separately.
    // Admission replaces the idle watch subscription. Capture every frame on
    // the original connection up to the same paused-tool boundary in both modes.
    const parts = metrics(uninterrupted.parts);
    const old = metrics(uninterrupted.legacy); const reduction = 1 - parts.bodyBytes / old.bodyBytes;
    expect(parts.bodyBytes).toBeGreaterThanOrEqual(100_000);
    expect(reduction).toBeGreaterThanOrEqual(.8);
    const accepted = before.received.find((s: any) => s.event.type === 'run.started');
    const actual = before.received.find((s: any) => s.event.snapshot?.phase === 'waiting_model' || s.event.projection?.operations.some((op: any) => op.type === 'run.status' && op.phase === 'waiting_model'));
    const acceptedToActualMs = actual.at - accepted.at;
    // Preserve boundary clocks even when the unchanged performance gate fails.
    // Browser and server clocks are independent; compare durations, not epochs.
    await writeFile(test.info().outputPath('MAX-129-startup-boundary.json'), JSON.stringify({
      acceptedToActualMs, browserAcceptedAt: accepted.at, browserWaitingAt: actual.at,
      serverFrames: serverTimings.filter((s: any) => s.type === 'run.started' || s.phase === 'waiting_model'),
      sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    }, null, 2));
    expect(acceptedToActualMs).toBeGreaterThanOrEqual(0); expect(acceptedToActualMs).toBeLessThanOrEqual(100);
    const samples = [...before.samples, ...after.samples].filter(s => s.type.startsWith('stream.'));
    const p95 = (values: number[]) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*.95)-1];
    const paintP95 = p95(samples.map(s => s.paintMs)); expect(paintP95).toBeLessThanOrEqual(100);
    const evidence = { sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      hardware: { cpu: cpus()[0].model, cores: cpus().length, memoryBytes: totalmem(), platform: platform(), release: release() }, browser: browser.version(),
      pid: process.pid, port, schema, cwd: process.cwd(), mode: 'real UI login/JWT/SQL identity, WS/MySQL/Gateway/reducer/renderChat; provider controlled; tools SELECT 1 plus isolated counter',
      fragments: 1000, generatedBytes: 100000, legacy: old, parts, reduction, refreshFrames: raw.parts.length - parts.frames,
      comparisonBoundary: 'same run prefix through 100th tool paused, before first refresh; all original connection subscriptions',
      includingRefresh: { parts: metrics(raw.parts), legacy: metrics(raw.legacy) },
      acceptedToActualMs, paintP95, applyP95: p95(samples.map(s => s.applyMs)), timing: 'same browser performance.now; 2 rAF conservative paint bound; server callback clock separately',
      executions, requests, assistantMessages: messages.length, durable: after.projection.durable, capacity: (adapter as any).displayStreams.stats(), samples, serverTimings };
    await writeFile(test.info().outputPath('MAX-129-live-metrics.json'), JSON.stringify(evidence, null, 2));
    await writeFile(test.info().outputPath('MAX-129-wire.json'), redact(JSON.stringify(raw)));
    const complete = new Promise<any>(resolve => cdp.once('Tracing.tracingComplete', resolve)); await cdp.send('Tracing.end'); const { stream } = await complete;
    const trace: Buffer[] = []; for (;;) { const value = await cdp.send('IO.read', { handle: stream }); trace.push(Buffer.from(value.data, value.base64Encoded ? 'base64' : 'utf8')); if (value.eof) break; }
    await cdp.send('IO.close', { handle: stream }); await writeFile(test.info().outputPath('MAX-129-live-trace.json'), redact(Buffer.concat(trace).toString('utf8')));
    await page.evaluate(() => (window as any).live.gateway.disconnect());
  } catch (error) {
    failure = error; cleanup.push({ stage: 'assertion-or-test-failed', at: performance.now() });
    try {
      await writeFile(test.info().outputPath('MAX-129-failure-wire.json'), redact(JSON.stringify(raw)));
      console.log('MAX-129 failure boundary', await page.evaluate(() => {
        const live = (window as any).live;
        return { lastError: live?.host.lastError, runId: live?.host.chatRunId,
          phase: live?.host.chatMessageProjection?.phase, terminal: live?.host.chatMessageProjection?.terminal };
      }));
    } catch (diagnosticError) { cleanupFailure = diagnosticError; }
    throw error;
  } finally {
    observation.boundary('finally-before-cleanup');
    const errors: unknown[] = cleanupFailure === undefined ? [] : [cleanupFailure];
    const step = async (stage: string, task: () => Promise<unknown>) => {
      cleanup.push({ stage: `${stage}-start`, at: performance.now() });
      try { await task(); }
      catch (error) { errors.push(error); }
      finally { cleanup.push({ stage: `${stage}-end`, at: performance.now() }); }
    };
    // Every stage still runs after a failure; closing a backend must never race
    // a live browser poll or an in-flight forwarded request.
    await step('browser-close', () => closeStreamingPage(page));
    releaseTool?.();
    await step('legacy-close', async () => {
      if (legacy && legacy.readyState !== legacy.CLOSED) {
        const closed = once(legacy, 'close'); legacy.close(); await closed;
      }
    });
    await step('adapter-close', async () => { await adapter?.dispose(); });
    await step('rest-close', async () => { await rest?.close(); });
    await step('database-close', () => dbConnection.close());
    await step('schema-drop', () => connection.query(`DROP DATABASE IF EXISTS \`${schema}\``));
    await step('connection-close', () => connection.end());
    await step('workspace-remove', () => rm(workspace, { recursive: true, force: true }));
    for (const restore of originals.reverse()) restore();
    const describe = (error: unknown) => error instanceof Error ? { name: error.name, message: error.message } : String(error);
    try {
      await writeFile(test.info().outputPath('MAX-279-startup-diagnostics.json'), JSON.stringify({
        environment, loadAfter: loadavg(), startupStart, startupEnd,
        startupMs: startupStart !== undefined && startupEnd !== undefined ? startupEnd - startupStart : null,
        startupUsage, stages, cleanup, serverFrames: serverTimings.filter((s: any) => s.type === 'run.started' || s.phase === 'waiting_model'),
        failed: failure !== undefined, primaryFailure: failure === undefined ? undefined : describe(failure),
        cleanupFailed: errors.length > 0, cleanupFailures: errors.map(describe),
      }, null, 2));
    } catch (error) { errors.push(error); }
    try {
      observation.save(test.info().outputPath('MAX-684-streaming-numeric.json'),
        spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
        failure !== undefined || errors.length ? 1 : 0, writeFileSync);
    } catch (error) { errors.push(error); }
    if (errors.length) throw combinedFailure(failure, errors);
  }
});

test('MAX-626 drains browser API routes before closing REST and preserves the primary failure', async ({ page }) => {
  const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
  const rest = require('fastify')();
  let arrived!: () => void, release!: () => void;
  const pending = new Promise<void>(r => { arrived = r; });
  const gate = new Promise<void>(r => { release = r; });
  rest.get('/api/health/ready', async () => { arrived(); await gate; return { ready: true }; });
  await rest.listen({ host: '127.0.0.1', port: 0 });
  const failures: unknown[] = [];
  await page.route('**/api/**', async route => {
    try { await route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${rest.server.address().port}/api/health/ready` }) }); }
    catch (error) { failures.push(error); }
  });
  try {
    await page.route('**/lifecycle-client', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>lifecycle</title>' }));
    await page.goto('/lifecycle-client');
    await page.evaluate(() => { void fetch('/api/health/ready'); });
    await pending;
    const closing = closeStreamingPage(page);
    release(); await closing;
    await rest.close();
    expect(failures).toEqual([]);
    const primary = new Error('original 100ms boundary assertion');
    expect(combinedFailure(primary, [])).toBe(primary);
    const cleanup = new Error('cleanup failure');
    const both = combinedFailure(primary, [cleanup]) as AggregateError;
    expect(both.cause).toBe(primary); expect(both.errors).toEqual([primary, cleanup]);
  } finally { release(); await page.close(); await rest.close(); }
});
