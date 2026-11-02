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

  it('retains the session after refresh 503 and never blindly repeats unknown rotation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const first = await authFetch('/api/protected');
    expect(first.status).toBe(503);
    expect(apiClient.getToken()).toBe('access-token');
    expect(apiClient.getRefreshToken()).toBe('refresh-token');
    expect((await authFetch('/api/protected')).status).toBe(503);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('keeps an unknown network refresh result without sending the rotation again', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockRejectedValueOnce(new TypeError('response lost after commit'))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    expect((await authFetch('/api/protected')).status).toBe(503);
    expect((await authFetch('/api/protected')).status).toBe(503);
    expect(apiClient.getToken()).toBe('access-token');
    expect(apiClient.getRefreshToken()).toBe('refresh-token');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('does not replay a failed write when the next read succeeds', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    expect((await authFetch('/api/action', { method: 'POST', body: '{}' })).status).toBe(503);
    await authFetch('/api/protected');
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('Chief R3: a cancelled old-resource 401 cannot refresh or expire the current session', async () => {
    const controller=new AbortController();
    const fetchMock=vi.spyOn(globalThis,'fetch').mockImplementationOnce(async()=>{
      controller.abort();return new Response('{}',{status:401});
    });
    await authFetch('/api/metrics/discovery/network_device/1',{signal:controller.signal});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(apiClient.getToken()).toBe('access-token');
  });

  it('discovery ownership survives refresh but explicit login and external token writes invalidate it', async () => {
    const session=apiClient.getSessionContext();
    vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('{}',{status:401}))
      .mockResolvedValueOnce(new Response(JSON.stringify({token:'rotated-access',refreshToken:'rotated-refresh'})))
      .mockResolvedValueOnce(new Response('{}'));
    await authFetch('/api/metrics/discovery/network_device/1');
    expect(apiClient.getSessionContext()).toBe(session);
    apiClient.setToken('rotated-access');expect(apiClient.getSessionContext()).not.toBe(session);
    const relog=apiClient.getSessionContext();localStorage.setItem('token','external-access');expect(apiClient.getSessionContext()).not.toBe(relog);
  });
  it.each([200,403])('a late old-session refresh %s cannot overwrite or expire a new login', async status => {
    let release!:(r:Response)=>void,arrived!:()=>void;const seen=new Promise<void>(r=>arrived=r);
    const held=new Promise<Response>(r=>release=r);
    vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('{}',{status:401}))
      .mockImplementationOnce(()=>{arrived();return held;});
    const pending=authFetch('/api/metrics/discovery/network_device/1');await seen;
    apiClient.setToken('different-login');apiClient.setRefreshToken('different-refresh');const session=apiClient.getSessionContext();
    release(new Response(JSON.stringify({token:'obsolete-access',refreshToken:'obsolete-refresh'}),{status}));await pending;
    expect(apiClient.getToken()).toBe('different-login');expect(apiClient.getRefreshToken()).toBe('different-refresh');expect(apiClient.getSessionContext()).toBe(session);
  });

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
