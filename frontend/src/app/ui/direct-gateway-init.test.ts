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
}

describe('initChatClient', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'token' ? 'jwt-token' : null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    (window as any).__apiClient = { getToken: () => 'jwt-token' };
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
    await vi.waitFor(() => expect(host.connected).toBe(true));
    expect(MockWebSocket.latest?.frames).toContainEqual(JSON.stringify({ type: 'auth', token: 'jwt-token', deviceIdentity: null, deviceAuth: null }));
  });
});
