import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast }));
import './instances-db.js';

const instance = Object.freeze({ id: 319, name: 'MAX319', host: 'db.example', port: 3306,
  username: 'monitor', db_type: 'mysql', database_name: 'app', hasCredential: true, credentialVersion: 7 });
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
const createPage = () => {
  const page = document.createElement('instances-page') as any;
  page._testConnection(instance);
  return page;
};

describe('MAX-319 / #662: list connection test has no credential write side effects', () => {
  beforeEach(() => { authFetch.mockReset(); showToast.mockReset(); });
  afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

  it.each(['保存凭据失败', '重载连接失败'])('keeps success when unrelated write operations would fail: %s', async error => {
    authFetch.mockImplementation(async (url: string) => url.endsWith('/test-connection')
      ? response({ success: true, message: '连接成功' }) : response({ error }, false));
    const page = createPage();
    const reload = vi.spyOn(page, 'loadInstances');
    page.testPassword = 'different-test-credential';
    await page._handleListTestConnection();
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(authFetch).toHaveBeenCalledWith('/api/database/instances/test-connection', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(authFetch.mock.calls[0][1].body)).toMatchObject({ password: 'different-test-credential', username: instance.username });
    expect(page.listTestStatus).toBe('success');
    expect(page.listTestMessage).toBe('连接成功');
    expect(reload).not.toHaveBeenCalled();
    expect(page.testingInstance).toEqual(instance);
  });

  it('allows a failed test to be retried with another password and closed without writes', async () => {
    authFetch.mockResolvedValueOnce(response({ success: false, message: 'ER_ACCESS_DENIED_ERROR' }))
      .mockResolvedValueOnce(response({ success: true, message: '连接成功' }));
    const page = createPage();
    page.testPassword = 'invalid';
    await page._handleListTestConnection();
    expect(page.listTestStatus).toBe('error');
    expect(page.listTestMessage).toBe('用户名或密码错误');
    page.testPassword = 'different-valid';
    await page._handleListTestConnection();
    expect(page.listTestStatus).toBe('success');
    page._closeDialogs();
    expect(page.showTestDialog).toBe(false);
    page._testConnection(instance);
    expect(page.testPassword).toBe('');
    expect(page.listTestStatus).toBe('idle');
    expect(authFetch.mock.calls.map(([url]) => url)).toEqual(Array(2).fill('/api/database/instances/test-connection'));
  });

  it('rejects an empty password and reports transport failures without a write', async () => {
    const page = createPage();
    await page._handleListTestConnection();
    expect(authFetch).not.toHaveBeenCalled();
    expect(page.listTestMessage).toBe('请输入密码');
    authFetch.mockRejectedValueOnce(new Error('网络连接失败'));
    page.testPassword = 'test-only';
    await page._handleListTestConnection();
    expect(page.listTestStatus).toBe('error');
    expect(page.listTestMessage).toBe('网络连接失败');
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});
