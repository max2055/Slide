/**
 * Phase 109-04 — DirectGatewayClient contract tests.
 *
 * Tests the new DirectAdapter WS client API shape:
 * - Class construction with options
 * - Method signatures match expected API
 * - sendChat produces correct JSON wire format
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as directGateway from './direct-gateway.ts';
import { DirectGatewayClient } from './direct-gateway.ts';
import type {
  AdapterChatEvent,
  AdapterSessionCreatedEvent,
  AdapterTextDeltaEvent,
  ConnectionState,
} from './direct-gateway.ts';

describe('109-04: DirectGatewayClient', () => {
  let onEvent: ReturnType<typeof vi.fn<(event: AdapterChatEvent) => void>>;
  let onStateChange: ReturnType<typeof vi.fn<(state: ConnectionState) => void>>;

  beforeEach(() => {
    onEvent = vi.fn<(event: AdapterChatEvent) => void>();
    onStateChange = vi.fn<(state: ConnectionState) => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('can be constructed with required options', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    expect(client).toBeInstanceOf(DirectGatewayClient);
  });

  it('can be constructed with custom URL', () => {
    const client = new DirectGatewayClient({
      url: 'ws://localhost:9999',
      onEvent,
      onStateChange,
    });
    expect(client).toBeInstanceOf(DirectGatewayClient);
  });

  it('uses the same-origin TLS WebSocket endpoint by default', () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'slide.example.com' });
    expect(directGateway.defaultAdapterUrl()).toBe('wss://slide.example.com/agent-ws');
  });

  it('exposes expected API methods', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    expect(typeof client.connect).toBe('function');
    expect(typeof client.disconnect).toBe('function');
    expect(typeof client.sendChat).toBe('function');
    expect(typeof client.requestHistory).toBe('function');
    expect(typeof client.isConnected).toBe('function');
  });

  it('rejects sendChat when no WebSocket is available', async () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    await expect(client.sendChat('test-session', 'hello world')).rejects.toThrow(/not connected/);
  });

  it('reports chat.send as rejected when no WebSocket is available', async () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    await expect(client.request('chat.send', { sessionKey: 'session-1', message: 'hello' }))
      .rejects.toThrow(/could not be queued/);
  });

  it('requestHistory does not throw', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    expect(() => client.requestHistory('test-session')).not.toThrow();
  });

  it('surfaces chat.history transport failures instead of returning an empty transcript', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const client = new DirectGatewayClient({ onEvent, onStateChange });

    await expect(client.request('chat.history', { sessionKey: 'session-1' }))
      .rejects.toThrow('network down');
  });

  it('returns empty history without a REST request when sessionKey is blank', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new DirectGatewayClient({ onEvent, onStateChange });

    await expect(client.request('chat.history', { sessionKey: '   ' }))
      .resolves.toEqual({ messages: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards cursor pagination and preserves the response cursor and stable IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messages: [{ id: 'm-1', role: 'user', content: 'hello' }], nextBefore: 17, thinkingLevel: 'low',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    await expect(client.request('chat.history', { sessionKey: 'agent:main:session-1', paged: true, before: 30, limit: 200 }))
      .resolves.toMatchObject({ messages: [{ id: 'm-1' }], nextBefore: 17, thinkingLevel: 'low' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('sessionKey=session-1&limit=200&paged=true&before=30');
  });

  it('includes the REST response body in errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'sessionKey parameter is required' }),
      { status: 400, statusText: 'Bad Request' },
    )));
    const client = new DirectGatewayClient({ onEvent, onStateChange });

    await expect(client.request('chat.history', { sessionKey: 'session-1' }))
      .rejects.toThrow(/sessionKey parameter is required/);
  });

  it('connect calls onStateChange with connecting state', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.connect();
    expect(onStateChange).toHaveBeenCalledWith('connecting');
    client.disconnect();
  });

  it('does not report connected until auth_ok is received', async () => {
    const socket = installMockWebSocket();
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.connect();

    await Promise.resolve();
    expect(onStateChange).not.toHaveBeenCalledWith('connected');
    expect(client.isConnected()).toBe(false);

    socket.receive({ type: 'auth_ok' });
    expect(onStateChange).toHaveBeenCalledWith('connected');
    expect(client.isConnected()).toBe(true);
    client.disconnect();
  });

  it('isConnected returns false initially', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    expect(client.isConnected()).toBe(false);
  });

  it('disconnect cleans up without throwing', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    expect(() => client.disconnect()).not.toThrow();
  });

  it('disconnect sets state to disconnected', () => {
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.disconnect();
    expect(onStateChange).toHaveBeenCalledWith('disconnected');
  });

  it('AdapterChatEvent types are correctly typed', () => {
    const delta: AdapterTextDeltaEvent = { type: 'text_delta', delta: 'hello' };
    expect(delta.type).toBe('text_delta');
    expect(delta.delta).toBe('hello');

    const all: AdapterChatEvent[] = [
      { type: 'session.created', sessionKey: 'server-session' },
      { type: 'text_delta', delta: '' },
      { type: 'tool_start', toolName: 'test', args: {} },
      { type: 'tool_result', toolName: 'test', result: null },
      { type: 'tool_error', toolName: 'test', error: 'err' },
      { type: 'complete', finalContent: 'done' },
      { type: 'error', error: 'fail' },
    ];
    expect(all.length).toBe(7);
  });

  it('sends a pending new-session chat without inventing a client session key', async () => {
    const socket = installMockWebSocket();
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.connect();
    socket.receive({ type: 'auth_ok' });

    const sent = client.request('chat.send', { sessionKey: '', message: 'hello' });
    acknowledgeLastChat(socket);
    await sent;

    expect(socket.frames.at(-1)).toEqual(expect.objectContaining({
      type: 'chat.send', protocolVersion: 2, message: 'hello',
      messageId: expect.any(String), idempotencyKey: expect.any(String),
    }));
  });

  it('preserves idempotency and attachments in the protocol v2 frame', async () => {
    const socket = installMockWebSocket();
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.connect();
    socket.receive({ type: 'auth_ok' });
    const attachments = [{ type: 'image', mimeType: 'image/png', content: 'AA==' }];

    const sent = client.request('chat.send', {
      sessionKey: 'session-1', message: 'inspect image', idempotencyKey: '1234567890abcdef', attachments,
    });
    acknowledgeLastChat(socket);
    await sent;

    expect(socket.frames.at(-1)).toEqual(expect.objectContaining({
      type: 'chat.send', idempotencyKey: '1234567890abcdef', attachments,
    }));
  });

  it('keeps queued messages across a reconnect until auth succeeds', async () => {
    const socket = installMockWebSocket();
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.connect();
    const sent = client.sendChat('session-1', 'queued');
    expect((client as any).pendingMessages).toHaveLength(1);

    client.connect();
    expect((client as any).pendingMessages).toHaveLength(1);
    socket.receive({ type: 'auth_ok' });
    acknowledgeLastChat(socket);
    await sent;
    expect(socket.frames.at(-1)).toEqual(expect.objectContaining({ type: 'chat.send', message: 'queued' }));
    client.disconnect();
  });

  it('keeps chat.send pending during authentication and rejects it on 4001', async () => {
    const socket = installMockWebSocket();
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.connect();
    const request = client.request('chat.send', { sessionKey: 'session-1', message: 'queued' });
    let settled = false;
    void request.then(() => { settled = true; }, () => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(socket.frames.some((frame) => frame.type === 'chat.send')).toBe(false);

    socket.closeWith(4001, 'Unauthorized');
    await expect(request).rejects.toThrow('登录已失效，请重新登录。');
    expect((client as any).pendingMessages).toHaveLength(0);
    expect(onStateChange).toHaveBeenCalledWith('auth_failed');
  });

  it.each([
    [1006, 'network lost', 'network_interrupted'],
    [1012, 'service restart', 'service_restarting'],
  ] as const)('reconciles an unacknowledged chat after close code %s', async (code, reason, state) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const socket = installMockWebSocket();
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.connect();
    socket.receive({ type: 'auth_ok' });

    const request = client.request('chat.send', { sessionKey: '', message: 'first message' });
    const originalFrame = socket.frames.at(-1)!;
    socket.receive({
      type: 'session.created',
      sessionKey: 'server-session',
      messageId: originalFrame.messageId,
    });
    socket.closeWith(code, reason, false);
    expect(onStateChange).toHaveBeenCalledWith(state);

    let settled = false;
    void request.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    socket.receive({ type: 'auth_ok' });
    const replayedFrame = socket.frames.at(-1)!;
    expect(replayedFrame).toMatchObject({
      type: 'chat.send',
      messageId: originalFrame.messageId,
      idempotencyKey: originalFrame.idempotencyKey,
      sessionKey: 'server-session',
    });

    const snapshot = {
      type: 'run.snapshot',
      messageId: replayedFrame.messageId,
      run: {
        id: 'existing-run',
        sessionId: 'server-session',
        messageId: replayedFrame.messageId,
        idempotencyKey: replayedFrame.idempotencyKey,
        state: 'running',
      },
    };
    socket.receive(snapshot);

    await expect(request).resolves.toBeUndefined();
    expect(onEvent).toHaveBeenCalledWith(snapshot);
  });

  it('treats a duplicate chat snapshot as durable acceptance', async () => {
    const socket = installMockWebSocket();
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.connect();
    socket.receive({ type: 'auth_ok' });

    const request = client.request('chat.send', { sessionKey: 'session-1', message: 'duplicate' });
    const frame = socket.frames.at(-1);
    const snapshot = {
      type: 'run.snapshot',
      messageId: frame?.messageId,
      run: {
        id: 'existing-run', sessionId: 'session-1', state: 'running',
        messageId: frame?.messageId, idempotencyKey: frame?.idempotencyKey,
      },
    };
    socket.receive(snapshot);

    await expect(request).resolves.toBeUndefined();
    expect(onEvent).toHaveBeenCalledWith(snapshot);
  });

  it.each([
    [4001, 'Unauthorized', '登录已失效，请重新登录。', 'auth_failed'],
    [4008, 'Rate limit exceeded', '请求过于频繁，请稍后再试。', 'rate_limited'],
  ] as const)('rejects an unacknowledged chat with close-specific error %s', async (code, reason, error, state) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const socket = installMockWebSocket();
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.connect();
    socket.receive({ type: 'auth_ok' });

    const request = client.request('chat.send', { sessionKey: 'session-1', message: 'hello' });
    socket.closeWith(code, reason, true);

    await expect(request).rejects.toThrow(error);
    expect(onStateChange).toHaveBeenCalledWith(state);
  });

  it('forwards session.created as a first-class adapter event', () => {
    const socket = installMockWebSocket();
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.connect();
    const created: AdapterSessionCreatedEvent = {
      type: 'session.created',
      sessionKey: 'server-session',
    };

    socket.receive(created);

    expect(onEvent).toHaveBeenCalledWith(created);
  });

  it('forwards an explicit cancelled terminal event', () => {
    const socket = installMockWebSocket();
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.connect();
    const cancelled = { type: 'cancelled', runId: 'run-1', sessionKey: 'session-1' };

    socket.receive(cancelled);

    expect(onEvent).toHaveBeenCalledWith(cancelled);
  });

  it('keeps thinking events separate from answer deltas and preserves their order', async () => {
    const host = {
      chatRunId: 'run-1',
      sessionKey: 'session-1',
      chatThinkingText: '',
      chatThinkingComplete: false,
      chatStream: '',
      chatMessages: [],
      chatSending: true,
      lastError: null,
      settings: { lastActiveSessionKey: '' },
      applySettings(next: Record<string, unknown>) {
        this.settings = next;
      },
      refreshSessionsAfterChat: new Set<string>(),
      chatToolMessages: [],
      chatStreamSegments: [],
      toolStreamById: new Map(),
      toolStreamOrder: [],
      toolStreamSyncTimer: null,
    };
    const events: Array<Record<string, unknown>> = [
      { type: 'thinking_delta', delta: 'inspect ' },
      { type: 'thinking_delta', delta: 'the target' },
      { type: 'thinking_end' },
      { type: 'text_delta', delta: 'Done.' },
    ];

    for (const event of events) {
      (directGateway as any).handleDirectAdapterEvent(host, event);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(host.chatThinkingText).toBe('inspect the target');
    expect(host.chatThinkingComplete).toBe(true);
    expect(host.chatStream).toBe('Done.');
    expect(host.chatMessages).toEqual([]);
  });

  it('coalesces rapid answer deltas and keeps the latest text', async () => {
    const host = {
      chatRunId: 'run-1', sessionKey: 'session-1', chatThinkingText: '', chatThinkingComplete: false,
      chatStream: '', chatMessages: [], chatSending: true, lastError: null,
      settings: { lastActiveSessionKey: '' }, applySettings(next: Record<string, unknown>) { this.settings = next; },
      refreshSessionsAfterChat: new Set<string>(), chatToolMessages: [], chatStreamSegments: [],
      toolStreamById: new Map(), toolStreamOrder: [], toolStreamSyncTimer: null,
    };

    (directGateway as any).handleDirectAdapterEvent(host, { type: 'text_delta', delta: '第一段' });
    (directGateway as any).handleDirectAdapterEvent(host, { type: 'text_delta', delta: '第一段第二段' });
    expect(host.chatStream).toBe('');

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(host.chatStream).toBe('第一段第二段');
  });

  it('cancels pending stream updates when an expired session is cleared', async () => {
    const host = {
      connected: true, chatLoading: true, chatSending: true, chatRunId: 'run-1',
      sessionKey: 'session-1', chatThinkingText: '', chatThinkingComplete: false,
      chatStream: '', chatStreamStartedAt: Date.now(), chatQueue: [{ id: 'queued' }],
      refreshSessionsAfterChat: new Set(['run-1']), chatToolMessages: [], chatStreamSegments: [],
      toolStreamById: new Map(), toolStreamOrder: [], toolStreamSyncTimer: null,
      chatMessages: [], lastError: null,
      settings: { lastActiveSessionKey: '' }, applySettings() {},
    };

    (directGateway as any).handleDirectAdapterEvent(host, { type: 'text_delta', delta: 'stale' });
    directGateway.clearExpiredChatState(host);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(host.chatStream).toBeNull();
    expect(host.chatRunId).toBeNull();
    expect(host.chatLoading).toBe(false);
    expect(host.chatSending).toBe(false);
  });

  it('adopts the server session key without resetting the active run and uses it next', async () => {
    const socket = installMockWebSocket();
    const client = new DirectGatewayClient({ onEvent, onStateChange });
    client.connect();
    socket.receive({ type: 'auth_ok' });
    const applySettings = vi.fn();
    const host = {
      sessionKey: '',
      chatRunId: 'run-1',
      chatStream: 'partial answer',
      settings: { sessionKey: '', lastActiveSessionKey: '' },
      applySettings(next: Record<string, unknown>) {
        applySettings(next);
        this.settings = next as typeof this.settings;
      },
    };

    (directGateway as any).handleDirectAdapterEvent(host, {
      type: 'session.created',
      sessionKey: 'server-session',
    });
    const sent = client.request('chat.send', { sessionKey: host.sessionKey, message: 'follow-up' });
    acknowledgeLastChat(socket);
    await sent;

    expect(host.sessionKey).toBe('server-session');
    expect(host.chatRunId).toBe('run-1');
    expect(host.chatStream).toBe('partial answer');
    expect(applySettings).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'server-session',
      lastActiveSessionKey: 'server-session',
    }));
    expect(socket.frames.at(-1)).toEqual(expect.objectContaining({
      type: 'chat.send', protocolVersion: 2, sessionKey: 'server-session', message: 'follow-up',
      messageId: expect.any(String), idempotencyKey: expect.any(String),
    }));
  });
});

function acknowledgeLastChat(socket: MockWebSocket): void {
  const frame = socket.frames.at(-1);
  socket.receive({
    type: 'run.started',
    runId: 'server-run',
    sessionKey: String(frame?.sessionKey ?? 'server-session'),
    messageId: frame?.messageId,
  });
}

class MockWebSocket {
  static readonly OPEN = 1;
  readonly readyState = MockWebSocket.OPEN;
  readonly frames: Array<Record<string, unknown>> = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  send(raw: string): void {
    this.frames.push(JSON.parse(raw));
  }

  close(): void {}

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>);
  }

  closeWith(code: number, reason: string, wasClean = code !== 1006): void {
    this.onclose?.({ code, reason, wasClean } as CloseEvent);
  }
}

function installMockWebSocket(): MockWebSocket {
  let socket: MockWebSocket | undefined;
  class InstalledWebSocket extends MockWebSocket {
    constructor() {
      super();
      socket = this;
    }
  }
  vi.stubGlobal('WebSocket', InstalledWebSocket);
  queueMicrotask(() => socket?.onopen?.(new Event('open')));
  return new Proxy({} as MockWebSocket, {
    get(_target, property) {
      return Reflect.get(socket as object, property, socket);
    },
  });
}
