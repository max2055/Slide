import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Simulate the stale Vite dependency case: the optional device module cannot be loaded.
vi.mock('./device-identity.ts', () => {
  throw new Error('Outdated Optimize Dep');
});

import { initChatClient } from './direct-gateway.ts';
import { apiClient } from '../../api/index.ts';

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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (window as any).__apiClient;
  });

  it.each([
    ['HTTP failure', () => Promise.resolve(new Response('["users:manage"]', { status: 500 }))],
    ['invalid JSON', () => Promise.resolve(new Response('{'))],
    ['error object', () => Promise.resolve(Response.json({ error: 'failed' }))],
    ['mixed array', () => Promise.resolve(Response.json(['users:view', 42]))],
    ['network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('does not cache or announce %s and exposes a recoverable error', async (_name, response) => {
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockImplementation((url) =>
      url === '/api/auth/permissions' ? response() : Promise.resolve(Response.json({ agents: [], sessions: [] })),
    );
    const loaded = vi.fn();
    window.addEventListener('slide-permissions-loaded', loaded);
    try {
      const host: Record<string, unknown> = { client: null, connected: false };
      initChatClient(host);
      await vi.waitFor(() => expect(MockWebSocket.latest?.frames.length).toBeGreaterThan(0));
      MockWebSocket.latest?.receive({ type: 'auth_ok' });
      await vi.waitFor(() => expect(host.permissionsError).toBeTruthy());
      expect(localStorage.getItem('permissions')).toBeNull();
      expect(loaded).not.toHaveBeenCalled();
      expect(host.connected).toBe(true);
      initChatClient(host);
      await vi.waitFor(() => expect(MockWebSocket.latest?.frames.length).toBeGreaterThan(0));
      MockWebSocket.latest?.receive({ type: 'auth_ok' });
      expect(vi.mocked(apiClient.fetchResponseWithAuth).mock.calls.filter(([url]) => url === '/api/auth/permissions')).toHaveLength(1);
    } finally {
      window.removeEventListener('slide-permissions-loaded', loaded);
    }
  });

  it('replaces a corrupt initialization cache with validated permissions', async () => {
    localStorage.setItem('permissions', '{"error":"old failure"}');
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockImplementation((url) => Promise.resolve(
      Response.json(url === '/api/auth/permissions' ? ['servers:view'] : { agents: [], sessions: [] }),
    ));
    const host: Record<string, unknown> = { client: null, connected: false };
    initChatClient(host);
    await vi.waitFor(() => expect(MockWebSocket.latest?.frames.length).toBeGreaterThan(0));
    MockWebSocket.latest?.receive({ type: 'auth_ok' });
    await vi.waitFor(() => expect(host.userPermissions).toEqual(new Set(['servers:view'])));
    expect(localStorage.getItem('permissions')).toBe('["servers:view"]');
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
