import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { apiClient, notifySessionExpired, SESSION_EXPIRED_EVENT } from '../../api/index.ts';
import { loadPermissions, readCachedPermissions, renderPermissionsError, type PermissionsState } from './permissions.ts';

describe('permission loading and recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    apiClient.setToken('test-token');
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([{ permissions: [] }, { permissions: ['servers:view', 'users:manage'] }])('caches validated permissions $permissions and updates the view', async ({ permissions }) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(permissions));
    const listener = vi.fn();
    window.addEventListener('slide-permissions-loaded', listener);
    try {
      const state: PermissionsState = {};
      await loadPermissions(state);
      expect(JSON.parse(localStorage.getItem('permissions')!)).toEqual(permissions);
      expect(state.userPermissions).toEqual(new Set(permissions));
      expect(listener).toHaveBeenCalledOnce();
      expect(state.permissionsError).toBeNull();
    } finally {
      window.removeEventListener('slide-permissions-loaded', listener);
    }
  });

  it.each(['{}', 'null', '"users:manage"', '[42]', '{'])('discards corrupt cache %s', (raw) => {
    localStorage.setItem('permissions', raw);
    expect(readCachedPermissions()).toBeNull();
    expect(localStorage.getItem('permissions')).toBeNull();
  });

  it('preserves a valid empty cache', () => {
    localStorage.setItem('permissions', '[]');
    expect(readCachedPermissions()).toEqual(new Set());
    expect(localStorage.getItem('permissions')).toBe('[]');
  });

  it('recovers through the visible button, deduplicates clicks and removes the error', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('network failure'))
      .mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const state: PermissionsState = {};
    await loadPermissions(state);
    expect(fetch).toHaveBeenCalledTimes(1);
    const container = document.createElement('div');
    render(renderPermissionsError(state), container);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('权限加载失败');
    container.querySelector('button')!.click();
    container.querySelector('button')!.click();
    render(renderPermissionsError(state), container);
    expect(container.querySelector('button')!.disabled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    resolve(Response.json(['servers:view']));
    await vi.waitFor(() => expect(state.permissionsLoading).toBe(false));
    expect(state.userPermissions?.has('servers:view')).toBe(true);
    expect(localStorage.getItem('permissions')).toBe('["servers:view"]');
    render(renderPermissionsError(state), container);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps existing 401 session expiry handling and does not publish success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    const expired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    try {
      const state: PermissionsState = {};
      await loadPermissions(state);
      expect(expired).toHaveBeenCalledOnce();
      expect(localStorage.getItem('token')).toBeNull();
      expect(localStorage.getItem('permissions')).toBeNull();
      expect(state.permissionsError).toBeUndefined();
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
    }
  });

  it('ignores a successful response arriving after logout', async () => {
    let resolve!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((done) => { resolve = done; }));
    const state: PermissionsState = {};
    const pending = loadPermissions(state);
    notifySessionExpired();
    resolve(Response.json(['users:manage']));
    await pending;
    expect(localStorage.getItem('permissions')).toBeNull();
    expect(state.userPermissions).toBeUndefined();
  });
});
