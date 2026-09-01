import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_EXPIRED_EVENT,
  apiClient,
  authFetch,
  isSessionExpiryInProgress,
} from './index.js';

describe('API authentication response handling', () => {
  beforeEach(() => {
    localStorage.clear();
    apiClient.setToken('access-token');
    apiClient.setRefreshToken('refresh-token');
  });

  afterEach(() => vi.restoreAllMocks());

  it('refreshes and retries a raw authenticated request after a 401', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: 'new-access-token',
        refreshToken: 'new-refresh-token',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    const response = await authFetch('/api/protected');

    expect(response.status).toBe(200);
    expect(apiClient.getToken()).toBe('new-access-token');
    expect(apiClient.getRefreshToken()).toBe('new-refresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get('Authorization'))
      .toBe('Bearer new-access-token');
  });

  it('clears authentication and emits one event when refresh is rejected', async () => {
    const expired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));

    expect((await authFetch('/api/protected')).status).toBe(401);
    expect((await authFetch('/api/another-protected')).status).toBe(401);

    expect(expired).toHaveBeenCalledTimes(1);
    expect(isSessionExpiryInProgress()).toBe(true);
    expect(apiClient.getToken()).toBeNull();
    expect(apiClient.getRefreshToken()).toBeNull();
    window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  });

  it('leaves authentication and permission failures untouched for a 403', async () => {
    const expired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"error":"权限不足"}', { status: 403 }));

    const response = await authFetch('/api/admin-only');

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
    expect(apiClient.getToken()).toBe('access-token');
    expect(apiClient.getRefreshToken()).toBe('refresh-token');
    window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  });
});
