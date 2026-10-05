import { afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setImmediate as nextTick } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import { ToolRegistry, type LLMProvider } from '@slide/agent-core';
import { reduceDisplayStream, type DisplayStreamState, type DisplayStreamEvent } from '@slide/agent-core/display-stream';
import { DirectAdapter } from '../direct-adapter.js';
import { createMessageProjection, reduceMessageProjection, type ProjectionFrame } from '@slide/agent-core/message-projection';
import { canonicalStore } from '../canonical-store.js';
import { agentRunService } from '../agent-run-service.js';
import { chatDatabaseService } from '../../chat-database-service.js';
import type { ActorContext } from '../../auth/actor-context.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const actor: ActorContext = { userId: 81, username: 'fixture', roles: ['admin'], permissions: [], sessionVersion: 1, instanceScopes: {}, requestId: 'display-stream-fixture' };
const final = { content: 'end', finishReason: 'stop', toolCalls: [], usage: {}, shouldExecuteTools: false, hasToolCalls: false };
function mockBoundaries() {
  vi.stubEnv('AGENT_WS_PORT', '0');
  vi.stubEnv('JWT_SECRET_KEY', 'fixture-only-secret-long-enough-for-tests');
  vi.spyOn(canonicalStore, 'getPage').mockResolvedValue({ messages: [], nextBefore: null });
  vi.spyOn(canonicalStore, 'appendToolFacts').mockResolvedValue(undefined);
  vi.spyOn(canonicalStore, 'saveCheckpoint').mockResolvedValue(undefined);
  vi.spyOn(chatDatabaseService, 'getSessionMetadata').mockResolvedValue(null);
  vi.spyOn(chatDatabaseService, 'authorizeSession').mockResolvedValue({} as any);
  vi.spyOn(chatDatabaseService, 'addMessage').mockResolvedValue(1);
  vi.spyOn(agentRunService, 'pendingCompletions').mockResolvedValue([]);
}
async function peer(port: number, subscriptionId: string, modern = true) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const events: any[] = [];
  const received = new Map<any, number>();
  const listeners = new Set<() => void>();
  socket.on('message', raw => { const event = JSON.parse(raw.toString()); events.push(event); received.set(event, performance.now()); for (const notify of listeners) notify(); });
  const wait = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    const finish = () => { if (!predicate()) return; clearTimeout(timer); listeners.delete(finish); resolve(); };
    const timer = setTimeout(() => { listeners.delete(finish); reject(new Error(`WS timeout: ${events.map(e => e.type + ':' + (e.error ?? '')).slice(-15).join(',')}`)); }, 10_000);
    listeners.add(finish); finish();
  });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'auth', token: 'fixture-token', ...(modern ? { capabilities: ['parts-stream-v1'] } : {}) }));
  await wait(() => events.some(e => e.type === 'auth_ok'));
  return { socket, events, received, wait, subscriptionId, watch: (cursor?: unknown) => socket.send(JSON.stringify({ type: 'chat.watch', sessionKey: 'fixture', subscriptionId, cursor })) };
}
function fold(events: DisplayStreamEvent[], subscriptionId: string, previous?: DisplayStreamState) {
  let state: DisplayStreamState = previous ? { ...previous, subscriptionId } : { subscriptionId, recovering: true };
  for (const event of events) if (event.stream && event.stream.runId !== 'cold') state = reduceDisplayStream(state, event).state;
  return state;
}
function measure(events: any[]) {
  let body = 0, total = 0;
  const textValues = (v: any, key = '') => {
    if (typeof v === 'string') { if (['delta', 'partText', 'finalContent', 'thinkingContent', 'text', 'content'].includes(key)) body += Buffer.byteLength(JSON.stringify(v)); return; }
    if (v && typeof v === 'object') for (const [k, child] of Object.entries(v)) textValues(child, k);
  };
  for (const event of events) { total += Buffer.byteLength(JSON.stringify(event)) + 14; textValues(event); }
  return { wsBytes: total, bodyBytes: body, metadataAndFrameBytes: total - body, frames: events.length };
}

it('MAX-128 accepted receipt precedes actual waiting-model phase within 100ms over real WS', async () => {
  mockBoundaries();
  vi.spyOn(agentRunService, 'findByIdempotencyKey').mockResolvedValue(null);
  vi.spyOn(agentRunService, 'claim').mockResolvedValue({ created: true,
    run: { id: 'admitted-run', actorId: actor.userId, sessionId: 'fixture', messageId: 'admitted-message', idempotencyKey: 'admitted-key', state: 'running' } });
  vi.spyOn(agentRunService, 'complete').mockImplementation(async (run, event) => ({ ...run, state: 'completed', result: { event } }));
  let release!: () => void;
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chat: async () => final,
    chatStream: async (_, __, callbacks) => { await new Promise<void>(resolve => { release = resolve; }); await callbacks.onContentDelta('end'); return final; } };
  const workspace = mkdtempSync(join(tmpdir(), 'phase-admission-'));
  const adapter = new DirectAdapter({ workspace, tools: new ToolRegistry(), llmProvider: provider,
    actorContextService: { authenticateAccessToken: vi.fn().mockResolvedValue(actor), revalidateActor: vi.fn().mockResolvedValue(actor) } });
  vi.spyOn(adapter as any, 'extractCompletedMemory').mockResolvedValue(undefined);
  let socket: WebSocket | undefined;
  try {
    await adapter.start(); const server = (adapter as any).wsServer; if (!server.address()) await once(server, 'listening');
    const live = await peer(server.address().port, 'admission'); socket = live.socket; live.watch();
    socket.send(JSON.stringify({ type: 'chat.send', sessionKey: 'fixture', message: 'phase', messageId: 'admitted-message', idempotencyKey: 'admitted-key', subscriptionId: 'admission' }));
    await live.wait(() => !!release && live.events.some(e => e.snapshot?.phase === 'waiting_model' || e.projection?.operations.some((op: any) => op.type === 'run.status' && op.phase === 'waiting_model')));
    const accepted = live.events.find(e => e.type === 'run.started');
    const waiting = live.events.find(e => e.snapshot?.phase === 'waiting_model' || e.projection?.operations.some((op: any) => op.type === 'run.status' && op.phase === 'waiting_model'));
    const acceptedToActualMs = live.received.get(waiting)! - live.received.get(accepted)!;
    expect(acceptedToActualMs).toBeGreaterThanOrEqual(0); expect(acceptedToActualMs).toBeLessThanOrEqual(100);
    expect(live.events.flatMap(e => e.projection?.operations ?? []).some(op => op.phase === 'generating')).toBe(false);
    if (process.env.MAX128_ACCEPTANCE_METRICS_FILE) writeFileSync(process.env.MAX128_ACCEPTANCE_METRICS_FILE,
      JSON.stringify({ acceptedToActualMs, clock: 'same Node performance.now at real authenticated WS receipt', storage: 'mocked admission/completion; provider held before first output; no paid model' }, null, 2));
    release(); await live.wait(() => live.events.some(e => e.type === 'run.snapshot' && e.run?.state === 'completed'));
  } finally { release?.(); socket?.close(); await adapter.dispose(); rmSync(workspace, { recursive: true, force: true }); }
}, 15_000);

it('real WS old/new clients, disconnect/refresh, capture suffix and bounded long result preserve projection without tool replay', async () => {
  mockBoundaries();
  let releaseTool!: () => void;
  let executions = 0, requests = 0;
  const tools = new ToolRegistry();
  tools.register({ name: 'query', description: 'fixture', parameters: { type: 'object', properties: {} }, readOnly: true, exclusive: false, concurrencySafe: true,
    execute: async (_args, ctx) => {
      executions++;
      await ctx?.progressCallback?.({ completed: 1, total: 2 });
      await new Promise<void>(resolve => { releaseTool = resolve; });
      return { success: true, rows: ['r'.repeat(300_000)] };
    } });
  const chunk = 'a'.repeat(100);
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', getModelCapabilities: () => ({ version: 'fixture/v1', model: 'fixture', contextWindowTokens: 200_000, maxOutputTokens: 4096, source: 'configuration' }), chat: async () => final,
    chatStream: async (_m, _t, callbacks) => {
      if (requests++ === 0) {
        await callbacks.onThinkingDelta?.('thought');
        for (let i = 0; i < 1000; i++) { await callbacks.onContentDelta(chunk); await nextTick(); }
        return { ...final, content: chunk.repeat(1000), finishReason: 'tool_calls', shouldExecuteTools: true, hasToolCalls: true,
          toolCalls: [{ id: 'tool', name: 'query', arguments: {} }] };
      }
      await callbacks.onContentDelta('end'); return final;
    } };
  const workspace = mkdtempSync(join(tmpdir(), 'display-stream-ws-'));
  const adapter = new DirectAdapter({ workspace, tools, toolsForActor: () => tools, llmProvider: provider,
    actorContextService: { authenticateAccessToken: vi.fn().mockResolvedValue(actor), revalidateActor: vi.fn().mockResolvedValue(actor) } });
  const sockets: WebSocket[] = [];
  const published = new Map<number, number>();
  const serverTimings: Array<{ type: string; queueFromLastOperationMs?: number; sendCallbackMs: number }> = [];
  const publish = (adapter as any).displayStreams.publish.bind((adapter as any).displayStreams);
  vi.spyOn((adapter as any).displayStreams, 'publish').mockImplementation((session: string, frame: ProjectionFrame) => {
    published.set(frame.sequence, performance.now()); return publish(session, frame);
  });
  try {
    await adapter.start(); const server = (adapter as any).wsServer;
    if (!server.address()) await once(server, 'listening');
    server.on('connection', (socket: any) => {
      const nativeSend = socket.send.bind(socket);
      socket.send = (data: string, callback: (error?: Error) => void) => {
        const event = JSON.parse(String(data)); const at = performance.now();
        const queued = published.get(event.projection?.sequence);
        nativeSend(data, (error?: Error) => { serverTimings.push({ type: event.type,
          ...(queued !== undefined ? { queueFromLastOperationMs: at - queued } : {}), sendCallbackMs: performance.now() - at }); callback?.(error); });
      };
    });
    const port = server.address().port;
    const legacy = await peer(port, 'legacy', false); sockets.push(legacy.socket); legacy.watch();
    const modern = await peer(port, 'live'); sockets.push(modern.socket); modern.watch();
    const modern2 = await peer(port, 'other'); sockets.push(modern2.socket); modern2.watch();
    const sendAt = performance.now();
    legacy.socket.send(JSON.stringify({ type: 'chat.send', sessionKey: 'fixture', message: 'stream fixture' }));
    await modern.wait(() => !!releaseTool && modern.events.some(e => e.projection?.operations.some((o: any) => o.type === 'tool.state' && o.event.phase === 'running')));
    expect(executions).toBe(1);
    const before = fold(modern.events, 'live');
    const streamRun = before.cursor!.runId;
    expect(before.projection?.parts.some(p => p.part.type === 'tool_call' && p.part.tool?.phase === 'running')).toBe(true);
    modern.socket.close(); await once(modern.socket, 'close');
    const resumed = await peer(port, 'resumed'); sockets.push(resumed.socket); resumed.watch(before.cursor);
    // An in-window resume may have no suffix; then provoke a genuine progress update.
    const refresh = await peer(port, 'refresh'); sockets.push(refresh.socket); refresh.watch();
    await refresh.wait(() => refresh.events.some(e => e.type === 'stream.snapshot' && e.stream.runId === streamRun));
    const restored = fold(refresh.events, 'refresh');
    expect(restored.projection?.parts.map(p => p.part.id)).toEqual(before.projection?.parts.map(p => p.part.id));
    expect(restored.projection?.phase).toBe(before.projection?.phase);
    expect(restored.projection?.attempt).toBe(before.projection?.attempt);
    expect(restored.projection?.anchorId).toBe(before.projection?.anchorId);
    releaseTool();
    const terminal = (p: typeof modern) => p.events.some(e => e.snapshot?.terminal || e.projection?.operations.some((o: any) => o.type === 'run.terminal'));
    await Promise.all([modern2.wait(() => terminal(modern2)), resumed.wait(() => terminal(resumed)), refresh.wait(() => terminal(refresh)), legacy.wait(() => legacy.events.some(e => e.type === 'complete'))]);
    const uninterrupted = fold(modern2.events, 'other');
    const continuation = fold(resumed.events, 'resumed', before);
    const fresh = fold(refresh.events, 'refresh');
    expect(continuation.projection).toEqual(uninterrupted.projection);
    expect(fresh.projection).toEqual(uninterrupted.projection);
    expect(fresh.projection?.terminal).toBe('completed');
    expect(fresh.projection?.durable).toBeTruthy();
    const phases = modern2.events.flatMap(e => e.projection?.operations ?? []).filter(op => op.type === 'run.status').map(op => op.phase);
    expect(phases).toEqual(expect.arrayContaining(['waiting_model', 'generating', 'tools', 'saving']));
    const firstState = modern2.events.find(e => e.projection?.operations.some((op: any) => op.type === 'run.status'));
    const sendToFirstPhaseMs = modern2.received.get(firstState)! - sendAt;
    expect(sendToFirstPhaseMs).toBeLessThanOrEqual(100);
    const metrics = { sendToFirstPhaseMs, phases, timing: 'local WS sender/receiver performance.now for send-to-state; this legacy send has no admission receipt; server publish-to-writer/send callback measured in server monotonic clock separately; queue duration starts at last operation in coalesced frame', raw: serverTimings };
    if (process.env.MAX128_SERVER_METRICS_FILE) writeFileSync(process.env.MAX128_SERVER_METRICS_FILE, JSON.stringify(metrics, null, 2));
    expect(fresh.projection?.parts.filter(p => p.part.type === 'tool_call')).toHaveLength(1);
    expect(executions).toBe(1); expect(requests).toBe(2);
    expect(modern2.events.some(e => e.type === 'text_delta' || e.type === 'complete')).toBe(false);
    const text = legacy.events.filter(e => e.type === 'text_delta');
    expect(text.at(-1).delta).toBe(chunk.repeat(1000) + 'end');
    expect(uninterrupted.projection?.parts.filter(p => p.part.type === 'text').map(p => 'text' in p.part ? p.part.text : '').join('')).toBe(text.at(-1).delta);
    const oldBytes = measure(legacy.events), newBytes = measure(modern2.events);
    expect(newBytes.bodyBytes / oldBytes.bodyBytes).toBeLessThan(0.2);
    expect(newBytes.bodyBytes).toBeLessThan(700_000);
    process.stdout.write('MAX-127 WS payload fixture ' + JSON.stringify({ fragments: 1000, generatedBodyBytes: 100_000, sample: 'one run/two peers; per-provider-fragment setImmediate', legacy: oldBytes, parts: newBytes,
      reduction: 1 - newBytes.bodyBytes / oldBytes.bodyBytes, capacity: (adapter as any).displayStreams.stats() }) + '\n');
  } finally {
    releaseTool?.(); for (const socket of sockets) socket.close(); await adapter.dispose(); rmSync(workspace, { recursive: true, force: true });
  }
}, 30_000);

it('real WS receive fault injection makes Gateway drop duplicates/old subscriptions and recover gaps without chat.send', async () => {
  mockBoundaries();
  const requireFrontend = createRequire(new URL('../../../../../frontend/package.json', import.meta.url));
  const { JSDOM } = requireFrontend('jsdom'); const dom = new JSDOM('', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'customElements', 'localStorage', 'location', 'navigator']) vi.stubGlobal(key, dom.window[key]);
  const consumerPath = new URL('../../../../../frontend/src/app/ui/direct-gateway.ts', import.meta.url).pathname;
  const { DirectGatewayClient, handleDirectAdapterEvent } = await import(consumerPath);
  const projectionPath = new URL('../../../../../frontend/src/app/ui/chat/message-projection.ts', import.meta.url).pathname;
  const { getChatProjection } = await import(projectionPath);
  const tools = new ToolRegistry();
  let release!: () => void;
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chat: async () => final, chatStream: async (_m, _t, c) => {
    await c.onContentDelta('first'); await new Promise<void>(resolve => { release = resolve; }); await c.onContentDelta('second'); return { ...final, content: 'firstsecond' };
  } };
  const workspace = mkdtempSync(join(tmpdir(), 'display-gateway-ws-'));
  const adapter = new DirectAdapter({ workspace, tools, llmProvider: provider,
    actorContextService: { authenticateAccessToken: vi.fn().mockResolvedValue(actor), revalidateActor: vi.fn().mockResolvedValue(actor) } });
  const host: any = { sessionKey: 'fixture', chatRunId: null, chatStream: '', chatThinkingText: '', chatToolMessages: [], chatStreamSegments: [], toolStreamById: new Map(),
    toolStreamOrder: [], chatMessages: [], chatQueue: [], chatSending: false, settings: { lastActiveSessionKey: '' }, applySettings() {}, refreshSessionsAfterChat: new Set(), client: null };
  const gateway = new DirectGatewayClient({ onEvent: (e: any) => handleDirectAdapterEvent(host, e), onStateChange: () => {} });
  let socket: WebSocket | undefined;
  try {
    await adapter.start(); const server = (adapter as any).wsServer; if (!server.address()) await once(server, 'listening');
    const live = await peer(server.address().port, 'native'); socket = live.socket;
    (gateway as any).ws = socket; (gateway as any).authenticated = true; (gateway as any).partsStream = true;
    (gateway as any).streamSubscriptions.set('fixture', 'native');
    live.watch();
    socket.send(JSON.stringify({ type: 'chat.send', sessionKey: 'fixture', message: 'fixture', subscriptionId: 'admission-old' }));
    live.watch(); // newer watch wins even if chat admission authorizes later
    await live.wait(() => !!release && live.events.some(e => e.projection?.operations.some((o: any) => o.type === 'part.start')));
    const stream = live.events.filter(e => e.stream && e.stream.runId !== 'cold');
    expect(stream.every(e => e.stream.subscriptionId === 'native')).toBe(true);
    for (const event of stream) (gateway as any).dispatchEvent(event);
    handleDirectAdapterEvent(host, { type: 'thinking_end' });
    const runId = stream.at(-1).stream.runId;
    expect(host.chatStream).toBe('first');
    const oldState = getChatProjection(host, runId);
    (gateway as any).dispatchEvent(stream.at(-1));
    expect(getChatProjection(host, runId)).toBe(oldState);
    // Real received frame with an injected missing interval. Gateway requests only watch.
    const lost = structuredClone(stream.at(-1)); lost.stream.fromSeq += 2; lost.stream.toSeq += 2;
    lost.projection = { version: 1, runId, attempt: 1, sequence: lost.projection.sequence + 2, operations: [{ type: 'part.append', partId: oldState.parts[0].part.id, text: 'bad' }] };
    const sends: any[] = []; const originalSend = socket.send.bind(socket);
    vi.spyOn(socket, 'send').mockImplementation(((data: any, ...rest: any[]) => { sends.push(JSON.parse(String(data))); return originalSend(data, ...rest); }) as any);
    (gateway as any).dispatchEvent(lost);
    expect(sends.map(e => e.type)).toEqual(['chat.watch']);
    expect(getChatProjection(host, runId)).toBe(oldState);
    const subscriptionId = sends[0].subscriptionId;
    await live.wait(() => live.events.some(e => e.type === 'stream.snapshot' && e.stream.subscriptionId === subscriptionId));
    const recovered = live.events.find(e => e.type === 'stream.snapshot' && e.stream.subscriptionId === subscriptionId);
    (gateway as any).dispatchEvent(recovered);
    (gateway as any).dispatchEvent(lost); // old subscription arriving after recovery
    expect(host.chatStream).toBe('first');
    release();
    await live.wait(() => live.events.some(e => e.projection?.operations.some((o: any) => o.type === 'run.terminal')));
    const suffix = live.events.filter(e => e.type === 'stream.delta' && e.stream.subscriptionId === subscriptionId);
    for (const event of suffix) (gateway as any).dispatchEvent(event);
    expect(getChatProjection(host, runId).terminal).toBe('completed');
    expect(getChatProjection(host, runId).parts.filter((p: any) => p.part.type === 'text').map((p: any) => p.part.text).join('')).toBe('firstsecond');
    expect(sends.every(e => e.type !== 'chat.send')).toBe(true);
  } finally { release?.(); handleDirectAdapterEvent(host, { type: 'thinking_end' }); gateway.disconnect(); socket?.close(); await adapter.dispose(); dom.window.close(); rmSync(workspace, { recursive: true, force: true }); }
}, 20_000);

it('real WS isolates a stalled write callback peer, evicts cache epochs and still delivers normal terminal', async () => {
  mockBoundaries();
  const workspace = mkdtempSync(join(tmpdir(), 'display-slow-ws-'));
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chat: async () => final, chatStream: async () => final };
  const adapter = new DirectAdapter({ workspace, tools: new ToolRegistry(), llmProvider: provider,
    displayStreamLimits: { maxRuns: 1 },
    actorContextService: { authenticateAccessToken: vi.fn().mockResolvedValue(actor), revalidateActor: vi.fn().mockResolvedValue(actor) } });
  const sockets: WebSocket[] = [];
  try {
    await adapter.start(); const server = (adapter as any).wsServer; if (!server.address()) await once(server, 'listening');
    const normal = await peer(server.address().port, 'normal'); sockets.push(normal.socket); normal.watch();
    const slow = await peer(server.address().port, 'slow'); sockets.push(slow.socket); slow.watch();
    await normal.wait(() => normal.events.some(e => e.type === 'stream.snapshot'));
    await slow.wait(() => slow.events.some(e => e.type === 'stream.snapshot'));
    const normalServer = [...server.clients].find((ws: any) => ws._socket.remotePort === (normal.socket as any)._socket.localPort) as WebSocket;
    (adapter as any).sendSocketEvent(normalServer, { type: 'run.snapshot', sessionKey: 'fixture', run: { id: 'stored', sessionId: 'fixture', messageId: 'stored-message',
      idempotencyKey: 'stored-key', state: 'completed', result: { event: { type: 'complete', finalContent: 'x'.repeat(2_000_000) } } } });
    await normal.wait(() => normal.events.some(e => e.type === 'run.snapshot'));
    const status = normal.events.find(e => e.type === 'run.snapshot');
    expect(status.run.state).toBe('completed'); expect(status.run.result).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThan(1024);
    const slowServer = [...server.clients].find((ws: any) => ws._socket.remotePort === (slow.socket as any)._socket.localPort) as WebSocket;
    // Actual socket/auth/close remain real; inject stalled transport acceptance only.
    vi.spyOn(slowServer, 'send').mockImplementation(() => {});
    const hub = (adapter as any).displayStreams;
    let state = createMessageProjection('run');
    hub.start('fixture', 'run', 'turn', () => state);
    const publish = (operations: ProjectionFrame['operations']) => {
      const frame: ProjectionFrame = { version: 1, runId: 'run', attempt: 1, sequence: state.sequence + 1, operations };
      state = reduceMessageProjection(state, frame); hub.publish('fixture', frame);
    };
    publish([{ type: 'part.start', messageId: 'message', part: { id: 'part', type: 'text', text: 'visible', source: 'fact', status: 'partial' } }]);
    await normal.wait(() => normal.events.some(e => e.stream?.runId === 'run'));
    const firstEpoch = normal.events.find(e => e.stream?.runId === 'run').stream.streamEpoch;
    const other = createMessageProjection('other-run'); hub.start('other', 'other-run', 'other-turn', () => other);
    hub.publish('other', { version: 1, runId: 'other-run', attempt: 0, sequence: 1, operations: [{ type: 'run.status', phase: 'generating' }] });
    publish([{ type: 'run.status', phase: 'tools' }]);
    await normal.wait(() => normal.events.some(e => e.stream?.runId === 'run' && e.stream.streamEpoch !== firstEpoch));
    const closed = once(slow.socket, 'close');
    for (let i = 0; i < 140; i++) { publish([{ type: 'run.status', phase: i % 2 ? 'tools' : 'generating' }]); await nextTick(); }
    expect((await closed)[0]).toBe(4009);
    const pending = (adapter as any).socketWriter.pending.get(slowServer);
    expect(pending.events).toBeLessThanOrEqual(128); expect(pending.bytes).toBeLessThanOrEqual(1024 * 1024);
    publish([{ type: 'run.terminal', outcome: 'failed' }]);
    await normal.wait(() => normal.events.some(e => e.projection?.operations.some((o: any) => o.type === 'run.terminal')));
    expect(normal.socket.readyState).toBe(WebSocket.OPEN);
    expect(hub.stats().runs).toBeLessThanOrEqual(1); expect(hub.stats().bytes).toBeLessThanOrEqual(hub.limits.maxGlobalBytes);
  } finally { for (const socket of sockets) socket.close(); await adapter.dispose(); rmSync(workspace, { recursive: true, force: true }); }
}, 15_000);
