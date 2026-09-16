import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Simulate the stale Vite dependency case: the optional device module cannot be loaded.
vi.mock('./device-identity.ts', () => {
  throw new Error('Outdated Optimize Dep');
});

import { initChatClient } from './direct-gateway.ts';
import * as api from '../../api/index.ts';
import * as appSettings from './app-settings.ts';
import { loadAgents, type AgentsState } from './controllers/agents.ts';
import { loadSessions, type SessionsState } from './controllers/sessions.ts';

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
    ['agents', 'network'], ['agents', 'http'], ['agents', 'json'],
    ['sessions', 'network'], ['sessions', 'http'], ['sessions', 'json'],
    ['both', 'network'],
  ])('continues initialization and recovers after %s %s failure', async (failedLoader, failure) => {
    const agents = { agents: [{ id: 'agent-1' }], defaultId: 'agent-1' };
    const sessions = { ok: true, sessions: [{ key: 'session-1' }], defaults: {} };
    let failing = true;
    const fetch = vi.spyOn(api, 'authFetch').mockImplementation(async (url) => {
      const isAgents = String(url) === '/api/agents';
      if (failing && (failedLoader === 'both' || failedLoader === (isAgents ? 'agents' : 'sessions'))) {
        if (failure === 'network') throw new Error('offline');
        if (failure === 'http') return new Response('', { status: 503 });
        return new Response('{invalid json');
      }
      return new Response(JSON.stringify(isAgents ? agents : sessions));
    });
    vi.spyOn(api.apiClient, 'getToken').mockReturnValue('jwt-token');
    const permissions = vi.spyOn(api.apiClient, 'fetchResponseWithAuth')
      .mockResolvedValue(new Response(JSON.stringify(['chat:read'])));
    const refresh = vi.spyOn(appSettings, 'refreshActiveTab').mockResolvedValue(undefined);
    const host = {
      client: null, connected: false, lastError: null,
      agentsLoading: false, agentsError: null, agentsList: null, agentsSelectedId: null,
      sessionsLoading: false, sessionsError: null, sessionsResult: null,
      sessionsFilterActive: '', sessionsFilterLimit: '',
      sessionsIncludeGlobal: false, sessionsIncludeUnknown: false,
    } as AgentsState & SessionsState & { lastError: string | null };

    initChatClient(host);
    await vi.waitFor(() => expect(MockWebSocket.latest?.frames.length).toBeGreaterThan(0));
    MockWebSocket.latest?.receive({ type: 'auth_ok' });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(localStorage.getItem('permissions')).toBe('["chat:read"]'));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0][0])).toBe('/api/agents');
    expect(String(fetch.mock.calls[1][0])).toMatch(/^\/api\/sessions\?/);
    expect(permissions).toHaveBeenCalledWith('/api/auth/permissions', expect.any(Object));
    expect(host.agentsLoading).toBe(false);
    expect(host.sessionsLoading).toBe(false);
    expect(host.connected).toBe(true);
    expect(host.lastError).toBeNull();
    for (const loader of ['agents', 'sessions'] as const) {
      const error = host[`${loader}Error`];
      if (failedLoader === loader || failedLoader === 'both') {
        expect(error).toMatch(failure === 'http' ? /HTTP 503/ : failure === 'network' ? /offline/ : /SyntaxError/);
      } else {
        expect(error).toBeNull();
        expect(loader === 'agents' ? host.agentsList : host.sessionsResult)
          .toEqual(loader === 'agents' ? agents : sessions);
      }
    }

    failing = false;
    await loadAgents(host);
    await loadSessions(host);
    expect(host.agentsError).toBeNull();
    expect(host.sessionsError).toBeNull();
    expect(host.agentsLoading).toBe(false);
    expect(host.sessionsLoading).toBe(false);
    expect(host.agentsList).toEqual(agents);
    expect(host.agentsSelectedId).toBe('agent-1');
    expect(host.sessionsResult).toEqual(sessions);
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
