import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Simulate the stale Vite dependency case: the optional device module cannot be loaded.
vi.mock('./device-identity.ts', () => {
  throw new Error('Outdated Optimize Dep');
});

import { initChatClient } from './direct-gateway.ts';

class MockWebSocket {
  static readonly OPEN = 1;
  static latest: MockWebSocket | null = null;
  readonly readyState = MockWebSocket.OPEN;
  readonly frames: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    MockWebSocket.latest = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(raw: string): void {
    this.frames.push(raw);
  }
  close(): void {}

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>);
  }

  closeWith(code: number, reason: string): void {
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

describe('initChatClient', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const values = new Map<string, string>([['token', 'jwt-token']]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
    (window as any).__apiClient = { getToken: () => localStorage.getItem('token') };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as any).__apiClient;
  });

  it('continues with JWT WebSocket login when device identity import fails', async () => {
    const host: Record<string, unknown> = {
      client: null,
      connected: false,
      lastError: null,
    };

    initChatClient(host);
    expect(host.client).toBeTruthy();
    await vi.waitFor(() => expect(MockWebSocket.latest?.frames).toContainEqual(JSON.stringify({ type: 'auth', token: 'jwt-token', deviceIdentity: null, deviceAuth: null })));
    expect(host.connected).toBe(false);
    MockWebSocket.latest?.receive({ type: 'auth_ok' });
    await vi.waitFor(() => expect(host.connected).toBe(true));
  });

  it('clears busy chat state and tokens after WebSocket authentication fails', async () => {
    const host: Record<string, unknown> = {
      client: null,
      connected: false,
      lastError: null,
      chatLoading: true,
      chatSending: true,
      chatRunId: 'run-1',
      chatStream: 'partial',
      chatStreamStartedAt: Date.now(),
      chatThinkingText: 'thinking',
      chatThinkingComplete: false,
      chatQueue: [{ id: 'queued' }],
      refreshSessionsAfterChat: new Set(['run-1']),
      toolStreamById: new Map(),
      toolStreamOrder: [],
      chatToolMessages: [],
      chatStreamSegments: [],
      toolStreamSyncTimer: null,
    };

    initChatClient(host);
    await vi.waitFor(() => expect(MockWebSocket.latest?.frames.length).toBeGreaterThan(0));
    MockWebSocket.latest?.closeWith(4001, 'Unauthorized');

    expect(host.connected).toBe(false);
    expect(host.chatLoading).toBe(false);
    expect(host.chatSending).toBe(false);
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(host.chatQueue).toEqual([]);
    expect(host.lastError).toBe('登录已失效，请重新登录。');
    expect(localStorage.getItem('token')).toBeNull();
  });
});
