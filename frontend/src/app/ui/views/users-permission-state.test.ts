import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersManagement } from './users-management.ts';
import { apiClient } from '../../../api/index.ts';

describe('MAX-672 / #687: user management permission states', () => {
  let view: UsersManagement;
  const flush = async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await view.updateComplete;
  };
  beforeEach(() => {
    apiClient.setToken('test-token');
    view = new UsersManagement();
  });
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('shows checking while pending and never reads users before authorization', async () => {
    const get = vi.spyOn(apiClient, 'get').mockReturnValue(new Promise(() => {}));
    document.body.append(view);
    await flush();
    expect(view.shadowRoot!.textContent).toContain('正在检查权限');
    expect(view.shadowRoot!.textContent).not.toContain('需要 admin 角色');
    expect(get.mock.calls.map(call => call[0])).toEqual(['/v1/rbac/roles']);
    expect(view.shadowRoot!.querySelector('.btn-primary')).toBeNull();
  });

  it.each([
    ['HTTP 401: Unauthorized', '未登录'],
    ['HTTP 403: Forbidden', '无权限访问此页面，需要 admin 角色'],
    ['HTTP 500: service unavailable', '权限检查失败: HTTP 500: service unavailable'],
    ['offline', '权限检查失败: offline'],
  ])('renders %s distinctly and recovers with retry', async (message, text) => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new Error(message)).mockResolvedValue([]);
    document.body.append(view);
    await flush();
    expect(view.shadowRoot!.textContent).toContain(text);
    if (!message.startsWith('HTTP 403')) expect(view.shadowRoot!.textContent).not.toContain('需要 admin 角色');
    expect(get).toHaveBeenCalledTimes(1);
    view.shadowRoot!.querySelector<HTMLButtonElement>('button')!.click();
    await flush();
    expect(view.shadowRoot!.querySelector('.btn-primary')?.textContent).toContain('新建用户');
    expect(get).toHaveBeenCalledWith('/users');
  });

  it('shows unauthenticated without reading protected endpoints when no token exists', async () => {
    apiClient.setToken(null);
    const get = vi.spyOn(apiClient, 'get');
    document.body.append(view);
    await flush();
    expect(view.shadowRoot!.textContent).toContain('未登录');
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['disconnect', 'session', 'identity'])('discards a late admin check after %s', async change => {
    let resolve!: (roles: unknown[]) => void;
    const get = vi.spyOn(apiClient, 'get').mockReturnValue(new Promise(done => { resolve = done; }));
    document.body.append(view);
    await flush();
    if (change === 'disconnect') view.remove();
    if (change === 'session') window.dispatchEvent(new Event('slide-session-expired'));
    if (change === 'identity') apiClient.setToken('another-user');
    resolve([]);
    await flush();
    expect(view.shadowRoot!.querySelector('.btn-primary')).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'])('keeps expired-session state when a users read later %s', async outcome => {
    let resolve!: (users: unknown[]) => void;
    let reject!: (error: Error) => void;
    const get = vi.spyOn(apiClient, 'get').mockImplementation(endpoint => endpoint === '/users'
      ? new Promise((done, fail) => { resolve = done; reject = fail; })
      : Promise.resolve([]));
    document.body.append(view);
    await flush();
    window.dispatchEvent(new Event('slide-session-expired'));
    if (outcome === 'resolve') resolve([{ id: 42, username: 'old-admin-data' }]);
    else reject(new Error('offline'));
    await flush();
    expect(view.shadowRoot!.textContent).toContain('未登录');
    expect(view.shadowRoot!.textContent).not.toContain('old-admin-data');
    expect(get.mock.calls.map(call => call[0])).toEqual(['/v1/rbac/roles', '/users', '/v1/rbac/roles']);
  });
});
