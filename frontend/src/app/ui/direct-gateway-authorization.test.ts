// MAX-684 contract substitutes: these tests do not exercise server authorization.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../api/index.ts';
import { activateChatSession, chatSessionHost, registerChatSend } from './chat-session-state.ts';
import { ChatAcceptanceTimeoutError, DirectGatewayClient, clearExpiredChatState, handleDirectAdapterEvent } from './direct-gateway.ts';
import { loadChatHistory, sendChatMessage } from './controllers/chat.ts';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  frames: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  constructor() { Socket.instances.push(this); }
  send(raw: string) { this.frames.push(JSON.parse(raw)); }
  receive(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  closeWith(code: number) { this.readyState = 3; this.onclose?.({ code, reason: 'contract substitute', wasClean: true }); }
  close() { this.readyState = 3; }
}

function host() {
  return {
    client: null as DirectGatewayClient | null, connected: true, sessionKey: 'one',
    chatMessages: [{ role: 'assistant', content: 'private history' }] as unknown[],
    chatMessage: 'private draft', chatAttachments: [], chatQueue: [{ id: 'queued' }],
    chatLoading: false, chatSending: true, chatThinkingLevel: null,
    chatRunId: 'old-run' as string | null, chatStream: 'private stream' as string | null,
    chatStreamStartedAt: 1, chatThinkingText: 'private reasoning', chatThinkingComplete: true,
    chatToolMessages: [{ content: 'private tool' }], chatStreamSegments: [{ text: 'private segment' }],
    toolStreamById: new Map([['tool', {}]]), toolStreamOrder: ['tool'], toolStreamSyncTimer: null,
    chatMessageProjection: { parts: ['private projection'] }, chatSideResult: { text: 'private result' },
    sidebarOpen: true, sidebarContent: 'private detail', lastError: null as string | null,
    refreshSessionsAfterChat: new Set(['old-run']), settings: {}, applySettings() {},
  };
}

function expectCleared(state: ReturnType<typeof host>) {
  expect(state.chatMessages).toEqual([]);
  expect(state.chatStream).toBeNull();
  expect(state.chatRunId).toBeNull();
  expect(state.chatThinkingText).toBe('');
  expect(state.chatToolMessages).toEqual([]);
  expect(state.chatStreamSegments).toEqual([]);
  expect(state.toolStreamById.size).toBe(0);
  expect(state.chatMessageProjection).toBeNull();
  expect(state.chatSideResult).toBeNull();
  expect(state.sidebarContent).toBeNull();
  expect(state.chatQueue).toEqual([]);
  expect(state.chatSending).toBe(false);
  expect(state.chatLoading).toBe(false);
}

describe('MAX-684 denied chat state and credential recovery', () => {
  const clients: DirectGatewayClient[] = [];
  function connected(state = host(), parts = false) {
    const changes = vi.fn();
    const client = new DirectGatewayClient({ onEvent: event => handleDirectAdapterEvent(state, event), onStateChange: changes });
    clients.push(client); state.client = client;
    client.connect();
    const socket = Socket.instances.at(-1)!;
    socket.onopen?.();
    socket.receive({ type: 'auth_ok', capabilities: parts ? ['parts-stream-v1'] : [] });
    return { state, client, socket, changes };
  }
  beforeEach(() => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(1);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('WebSocket', Socket); Socket.instances = [];
    localStorage.clear(); sessionStorage.clear(); apiClient.setToken('credential-A');
    (window as any).__apiClient = apiClient;
  });
  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    delete (window as any).__apiClient;
  });

  // MF-I2: a missing association must never select the visible B by default.
  it.each([false, true])('MF-I2: ignores unlocated denial in client and reducer (parts=%s)', parts => {
    const { state, socket } = connected(host(), parts);
    chatSessionHost(state); activateChatSession(state, 'two');
    state.chatMessages = [{ content: 'authorized B' }]; state.chatMessage = 'B draft';
    for (const association of [{}, { sessionKey: '   ' }, { sessionKey: 'unknown' }, { messageId: 'unknown' }, { runId: 'unknown' }]) {
      for (const type of ['error', 'protocol.error'] as const) {
        socket.receive({ type, code: 'CHAT_SESSION_NOT_FOUND', error: 'missing', ...association });
        handleDirectAdapterEvent(state, { type, code: 'CHAT_SESSION_NOT_FOUND', error: 'missing', ...association });
      }
    }
    expect(state.chatMessages).toEqual([{ content: 'authorized B' }]);
    expect(state.chatMessage).toBe('B draft');
  });

  it.each([
    [false, 'key'], [false, 'message'], [false, 'run'],
    [true, 'key'], [true, 'message'], [true, 'run'],
  ] as const)('MF-I2: hidden A denial (parts=%s, association=%s) preserves B', async (parts, correlation) => {
    const { state, socket, client } = connected(host(), parts);
    const pendingA = client.sendChat('one', 'A', { idempotencyKey: 'message-A' }).catch(error => error);
    // Bind both the UI receiver and the transport run mapping.
    registerChatSend(state, 'message-A');
    socket.receive({ type: 'run.started', sessionKey: 'one', runId: 'old-run', messageId: 'other' });
    client.watchSession('one');
    const subscriptionId = socket.frames.at(-1)!.subscriptionId;
    let finishHistory!: (value: Response) => void;
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockImplementation(() => new Promise(resolve => { finishHistory = resolve; }));
    const historyA = loadChatHistory(state);
    const steerA = client.request('chat.steer', { sessionKey: 'one', message: 'adjust A' }).catch(error => error);
    const oldA = chatSessionHost(state);
    activateChatSession(state, 'two'); state.chatMessages = [{ content: 'authorized B' }]; state.chatMessage = 'B draft';
    state.refreshSessionsAfterChat.add('run-B'); client.watchSession('two');
    const pendingB = client.sendChat('two', 'B', { idempotencyKey: 'message-B' }).catch(error => error);
    const steerB = client.request('chat.steer', { sessionKey: 'two', message: 'adjust B' }).catch(error => error);
    const steerBFrame = socket.frames.at(-1)!;
    socket.receive({ type: 'error', code: 'CHAT_SESSION_NOT_FOUND', error: 'missing',
      ...(correlation === 'key' ? { sessionKey: 'one' } : correlation === 'message' ? { messageId: 'message-A' } : { runId: 'old-run' }) });
    expect(state.chatMessages).toEqual([{ content: 'authorized B' }]); expect(state.chatMessage).toBe('B draft');
    expect(state.refreshSessionsAfterChat.has('run-B')).toBe(true);
    expect(state.refreshSessionsAfterChat.has('old-run')).toBe(false);
    oldA.chatMessages = [{ content: 'late A' }];
    finishHistory(Response.json({ messages: [{ content: 'late A history' }] }));
    await historyA;
    socket.receive({ type: 'stream.snapshot', sessionKey: 'one',
      stream: { version: 1, streamEpoch: 'old', runId: 'old-run', turnId: 'turn', subscriptionId, fromSeq: 1, toSeq: 1 },
      snapshot: { version: 1, runId: 'old-run', attempt: 1, sequence: 1, phase: 'generating',
        parts: [{ messageId: 'assistant', part: { id: 'late', type: 'text', text: 'late A replay', source: 'fact', status: 'partial' } }] } });
    socket.receive({ type: 'complete', sessionKey: 'one', runId: 'old-run', finalContent: 'late A' });
    socket.receive({ type: 'run.started', sessionKey: 'two', runId: 'run-B', messageId: 'message-B' });
    socket.receive({ type: 'steer.result', requestId: steerBFrame.requestId, status: 'queued', runId: 'run-B' });
    await vi.advanceTimersByTimeAsync(100);
    await expect(pendingB).resolves.toBeUndefined();
    expect(await pendingA).toBeInstanceOf(Error);
    expect(await steerA).toBeInstanceOf(Error);
    expect(await steerB).toMatchObject({ runId: 'run-B' });
    expect(state.chatMessages).toEqual([{ content: 'authorized B' }]); expect(state.chatMessage).toBe('B draft');
    expect((client as any).watchedSessions.has('two')).toBe(true);
    activateChatSession(state, 'one'); expectCleared(state);
  });

  it('MF-I2: associates a new-session denial by message without denying another empty view', async () => {
    const { state, socket, client } = connected();
    chatSessionHost(state); activateChatSession(state, '');
    registerChatSend(state, 'new-A');
    const pendingA = client.sendChat(undefined, 'A', { idempotencyKey: 'new-A' }).catch(error => error);
    activateChatSession(state, ''); state.chatMessage = 'new B draft';
    socket.receive({ type: 'error', code: 'CHAT_SESSION_NOT_FOUND', error: 'missing', messageId: 'new-A' });
    expect(await pendingA).toBeInstanceOf(Error);
    expect(state.chatMessage).toBe('new B draft');
    const pendingB = client.sendChat(undefined, 'B', { idempotencyKey: 'new-B' }).catch(error => error);
    socket.receive({ type: 'run.started', sessionKey: 'allocated-B', runId: 'run-B', messageId: 'new-B' });
    await expect(pendingB).resolves.toBeUndefined();
  });

  it('MF-I2: reducer uses a known run even when the visible view has no run', () => {
    const state = host();
    chatSessionHost(state); activateChatSession(state, 'two'); state.chatMessage = 'B draft';
    handleDirectAdapterEvent(state, { type: 'error', code: 'CHAT_SESSION_NOT_FOUND', error: 'missing', runId: 'old-run' });
    expect(state.chatMessage).toBe('B draft');
    activateChatSession(state, 'one'); expectCleared(state);
  });

  it('MF-I2: explicit requested key takes precedence over a conflicting message identity', () => {
    const { state, socket } = connected();
    chatSessionHost(state); activateChatSession(state, 'two');
    state.chatMessage = 'B draft'; registerChatSend(state, 'message-B');
    socket.receive({ type: 'error', code: 'CHAT_SESSION_NOT_FOUND', error: 'missing', sessionKey: ' one ', messageId: 'message-B' });
    expect(state.chatMessage).toBe('B draft');
    activateChatSession(state, 'one'); expectCleared(state);
  });

  it('MF-I2: a delayed hidden HTTP history denial retains its request receiver', async () => {
    const { state, client } = connected();
    let finishHistory!: (value: Response) => void;
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockImplementation(() => new Promise(resolve => { finishHistory = resolve; }));
    const oldA = chatSessionHost(state);
    const historyA = loadChatHistory(state);
    activateChatSession(state, 'two'); state.chatMessages = [{ content: 'authorized B' }]; state.chatMessage = 'B draft';
    client.watchSession('two');
    finishHistory(Response.json({ code: 'CHAT_SESSION_NOT_FOUND', error: 'missing' }, { status: 404 }));
    await historyA;
    expect(state.chatMessages).toEqual([{ content: 'authorized B' }]); expect(state.chatMessage).toBe('B draft');
    expect((client as any).watchedSessions.has('two')).toBe(true);
    oldA.chatMessages = [{ content: 'late A' }];
    activateChatSession(state, 'one'); expectCleared(state);
  });

  it.each([403, 404, 401])('clears HTTP %s history denial and retains structured status/code', async status => {
    const { state, client } = connected();
    const code = status === 403 ? 'CHAT_FORBIDDEN' : 'CHAT_SESSION_NOT_FOUND';
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockImplementation(async () => Response.json({ error: 'denied', code }, { status }));
    await expect(client.request('chat.history', { sessionKey: 'one' })).rejects.toMatchObject({ status, code });
    await loadChatHistory(state);
    expectCleared(state);
    expect(state.lastError).toContain(status === 401 ? '登录已失效' : status === 403 ? '无权使用聊天' : '不可见');
  });

  it.each(['CHAT_FORBIDDEN', 'CHAT_SESSION_NOT_FOUND'])('blocks delayed history, stream and admission after WS %s', async code => {
    const { state, socket } = connected();
    let complete!: (value: Response) => void;
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const pending = loadChatHistory(state);
    handleDirectAdapterEvent(state, { type: 'text_delta', sessionKey: 'one', runId: 'old-run', delta: 'late stream' });
    socket.receive({ type: 'error', code, error: 'denied', sessionKey: 'one' });
    expectCleared(state);
    complete(Response.json({ messages: [{ content: 'late history' }] }));
    await pending;
    socket.receive({ type: 'run.started', sessionKey: 'one', runId: 'old-run' });
    socket.receive({ type: 'complete', sessionKey: 'one', runId: 'old-run', finalContent: 'late completion' });
    await vi.advanceTimersByTimeAsync(100);
    expectCleared(state);
    await sendChatMessage(state, 'blocked send');
    expect(socket.frames.some(frame => frame.type === 'chat.send')).toBe(false);
  });

  it('a global denial clears hidden sessions; a 404 preserves unrelated views', () => {
    const { state, socket } = connected();
    const hidden = chatSessionHost(state);
    activateChatSession(state, 'two'); state.chatMessages = [{ content: 'other view' }];
    socket.receive({ type: 'error', code: 'CHAT_SESSION_NOT_FOUND', error: 'missing', sessionKey: 'one' });
    expect(state.chatMessages).toEqual([{ content: 'other view' }]);
    activateChatSession(state, 'one'); expectCleared(state);
    hidden.chatMessages = [{ content: 'late hidden write' }];
    expect(state.chatMessages).toEqual([]);
    activateChatSession(state, 'two');
    socket.receive({ type: 'error', code: 'CHAT_FORBIDDEN', error: 'denied', sessionKey: 'one' });
    expectCleared(state);
    activateChatSession(state, 'one'); expectCleared(state);
    activateChatSession(state, '');
    expect(state.lastError).toBe('无权使用聊天，请联系管理员。');
    expectCleared(state);
  });

  it('rejects the matching pending send on 404 while preserving another acknowledgement', async () => {
    const { state, client, socket } = connected();
    const first = client.sendChat('one', 'first', { idempotencyKey: 'first' }).catch(error => error);
    const second = client.sendChat('two', 'second', { idempotencyKey: 'second' });
    socket.receive({ type: 'error', code: 'CHAT_SESSION_NOT_FOUND', error: 'missing', sessionKey: 'one', messageId: 'first' });
    expect(await first).toMatchObject({ code: 'CHAT_SESSION_NOT_FOUND' });
    socket.receive({ type: 'run.started', sessionKey: 'two', messageId: 'second', runId: 'second-run' });
    await expect(second).resolves.toBeUndefined(); expectCleared(state);
  });

  it('rejects all pending sends and an unknown steer on chat revocation but keeps cancel available', async () => {
    const { client, socket } = connected();
    const sent = client.sendChat(undefined, 'new session').catch(error => error);
    const steer = client.request('chat.steer', { sessionKey: 'one', message: 'adjust' }).catch(error => error);
    socket.receive({ type: 'error', code: 'CHAT_FORBIDDEN', error: 'denied' });
    expect(await sent).toMatchObject({ code: 'CHAT_FORBIDDEN' });
    expect(await steer).toMatchObject({ message: expect.stringContaining('未自动重试') });
    await expect(client.request('chat.steer', { sessionKey: 'one', message: 'new adjustment' })).rejects.toThrow('指令未发送');
    expect(client.cancelChat('old-run', 'one')).toBe(true);
    expect(socket.frames.at(-1)).toMatchObject({ type: 'chat.cancel' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.frames.filter(frame => frame.type === 'chat.send')).toHaveLength(1);
  });

  it('ignores a delayed send resolution after denial, including its queued follow-up', async () => {
    const state = host();
    let accept!: () => void;
    state.client = { request: vi.fn(() => new Promise<void>(resolve => { accept = resolve; })) } as any;
    const sending = sendChatMessage(state, 'pending question');
    handleDirectAdapterEvent(state, { type: 'error', code: 'CHAT_FORBIDDEN', error: 'denied' });
    accept();
    expect(await sending).toBeNull(); expectCleared(state);
  });

  it('a rejected older history page clears the previously visible transcript without publishing partial pages', async () => {
    const { state } = connected();
    vi.spyOn(apiClient, 'fetchResponseWithAuth')
      .mockResolvedValueOnce(Response.json({ messages: [{ content: 'partial private page' }], nextBefore: 20 }))
      .mockResolvedValueOnce(Response.json({ code: 'CHAT_SESSION_NOT_FOUND' }, { status: 404 }));
    await loadChatHistory(state); expectCleared(state);
  });

  it('replaces parts subscriptions after reauthorization and drops the revoked stream cursor', async () => {
    const { state, client, socket } = connected(host(), true);
    client.watchSession('one');
    const subscriptionId = socket.frames.at(-1)!.subscriptionId;
    const stream = { version: 1, streamEpoch: 'old', runId: 'old-run', turnId: 'turn', subscriptionId, fromSeq: 1, toSeq: 1 };
    const snapshot = { type: 'stream.snapshot', sessionKey: 'one', stream,
      snapshot: { version: 1, runId: 'old-run', attempt: 1, sequence: 1, phase: 'generating',
        parts: [{ messageId: 'assistant', part: { id: 'private', type: 'text', text: 'private parts', source: 'fact', status: 'partial' } }] } };
    socket.receive(snapshot);
    expect(state.chatStream).toBe('private parts');
    socket.receive({ type: 'error', code: 'CHAT_FORBIDDEN', error: 'denied' });
    expectCleared(state);
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockResolvedValue(Response.json({ messages: [] }));
    await loadChatHistory(state);
    const watch = socket.frames.at(-1)!;
    expect(watch.type).toBe('chat.watch'); expect(watch.subscriptionId).not.toBe(subscriptionId);
    expect(watch.cursor).toBeUndefined();
    socket.receive(snapshot); await vi.advanceTimersByTimeAsync(100); expectCleared(state);
  });

  it.each(['CHAT_FORBIDDEN', 'CHAT_SESSION_NOT_FOUND'])('invalidates explicit retry identities after %s', async code => {
    const { client, socket } = connected();
    const result = client.sendChat('one', 'unknown', { idempotencyKey: 'unknown' }).catch(error => error);
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await result as ChatAcceptanceTimeoutError;
    socket.receive({ type: 'error', code, error: 'denied', sessionKey: 'one' });
    await expect(error.retry()).rejects.toThrow('重试资格已失效');
    expect(socket.frames.filter(frame => frame.type === 'chat.send')).toHaveLength(1);
  });

  it('only fresh authorized history restores observation and never revives the denied run', async () => {
    const { state, client, socket } = connected();
    client.watchSession('one');
    socket.receive({ type: 'run.started', sessionKey: 'one', runId: 'old-run' });
    socket.receive({ type: 'error', code: 'CHAT_FORBIDDEN', error: 'denied' });
    client.watchSession('one');
    expect(socket.frames.filter(frame => frame.type === 'chat.watch')).toHaveLength(1);
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockResolvedValue(Response.json({ messages: [{ role: 'assistant', content: 'authorized saved history' }] }));
    await loadChatHistory(state);
    expect(state.chatMessages).toEqual([{ role: 'assistant', content: 'authorized saved history' }]);
    expect(state.chatRunId).toBeNull();
    expect(socket.frames.filter(frame => frame.type === 'chat.watch')).toHaveLength(2);
    socket.receive({ type: 'run.started', sessionKey: 'one', runId: 'old-run' });
    expect(state.chatRunId).toBeNull();
    expect(socket.frames.some(frame => frame.type === 'chat.send')).toBe(false);
  });

  it('preserves existing content on HTTP 503 and reports a recoverable error', async () => {
    const { state } = connected();
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockResolvedValue(Response.json({ error: 'unavailable' }, { status: 503 }));
    await loadChatHistory(state);
    expect(state.chatMessages).toEqual([{ role: 'assistant', content: 'private history' }]);
    expect(state.chatStream).toBe('private stream');
    expect(state.lastError).toContain('503'); expect(state.chatLoading).toBe(false);
  });

  it('1013 ends pending acknowledgement, preserves display and reconnects with observation only', async () => {
    const { state, client, socket, changes } = connected();
    client.watchSession('one');
    const result = client.sendChat('one', 'unknown').catch(error => error);
    socket.closeWith(1013);
    expect(await result).toBeInstanceOf(ChatAcceptanceTimeoutError);
    expect(changes).toHaveBeenLastCalledWith('service_unavailable');
    expect(localStorage.getItem('token')).toBe('credential-A');
    expect(state.chatStream).toBe('private stream');
    await vi.advanceTimersByTimeAsync(1_000);
    const next = Socket.instances.at(-1)!; next.onopen?.(); next.receive({ type: 'auth_ok' });
    expect(next.frames).toContainEqual({ type: 'chat.watch', sessionKey: 'one' });
    expect(next.frames.some(frame => frame.type === 'chat.send' || frame.type === 'chat.steer')).toBe(false);
  });

  it('4001 clears expired visible/hidden content and blocks old sockets, reads and retry closures', async () => {
    const { state, client, socket, changes } = connected();
    const result = client.sendChat('one', 'unknown').catch(error => error);
    await vi.advanceTimersByTimeAsync(60_000);
    const retry = await result as ChatAcceptanceTimeoutError;
    const old = chatSessionHost(state);
    activateChatSession(state, 'two'); state.chatMessages = [{ content: 'hidden private' }];
    socket.closeWith(4001); clearExpiredChatState(state);
    expectCleared(state);
    expect(changes).toHaveBeenLastCalledWith('auth_failed');
    old.chatMessages = [{ content: 'late private' }];
    activateChatSession(state, 'one'); expectCleared(state);
    socket.receive({ type: 'text_delta', delta: 'late' });
    await expect(retry.retry()).rejects.toThrow('重试资格已失效');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(Socket.instances).toHaveLength(1); expectCleared(state);
  });

  it('new credentials require a new connection and cannot replay old unknown sends', async () => {
    const { client, socket } = connected();
    const result = client.sendChat('one', 'unknown').catch(error => error);
    await vi.advanceTimersByTimeAsync(60_000);
    const retry = await result as ChatAcceptanceTimeoutError;
    apiClient.setToken('credential-B');
    await expect(retry.retry()).rejects.toThrow('重试资格已失效');
    await expect(client.sendChat('one', 'new')).rejects.toThrow('建立新连接');
    socket.closeWith(1013);
    await vi.advanceTimersByTimeAsync(1_000);
    const next = Socket.instances.at(-1)!; next.onopen?.(); next.receive({ type: 'auth_ok' });
    expect(next.frames.filter(frame => frame.type === 'chat.send')).toHaveLength(0);
  });

  it('does not rebind an in-flight A send when credentials change immediately before a transient close', async () => {
    const { client, socket } = connected();
    const result = client.sendChat('one', 'unknown').catch(error => error);
    apiClient.setToken('credential-B'); socket.closeWith(1013);
    const error = await result as ChatAcceptanceTimeoutError;
    await vi.advanceTimersByTimeAsync(1_000);
    const next = Socket.instances.at(-1)!; next.onopen?.(); next.receive({ type: 'auth_ok' });
    await expect(error.retry()).rejects.toThrow('重试资格已失效');
    expect(next.frames.some(frame => frame.type === 'chat.send')).toBe(false);
  });

  it('expiry of socket credential A preserves fresh credential B and restores observation without execution', async () => {
    const { client, socket, changes } = connected();
    client.watchSession('one');
    const result = client.sendChat('one', 'unknown').catch(error => error);
    apiClient.setToken('credential-B'); socket.closeWith(4001);
    expect(await result).toBeInstanceOf(Error);
    expect(changes).toHaveBeenLastCalledWith('credentials_changed');
    expect(localStorage.getItem('token')).toBe('credential-B');
    await vi.advanceTimersByTimeAsync(1_000);
    const next = Socket.instances.at(-1)!; next.onopen?.(); next.receive({ type: 'auth_ok' });
    expect(next.frames).toContainEqual(expect.objectContaining({ type: 'auth', token: 'credential-B' }));
    expect(next.frames).toContainEqual({ type: 'chat.watch', sessionKey: 'one' });
    expect(next.frames.some(frame => frame.type === 'chat.send')).toBe(false);
  });
});
