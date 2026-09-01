import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch, showToast } = vi.hoisted(() => ({
  authFetch: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast }));

import './instances-db.js';
import {
  buildTestConnectionPayload,
  normalizeConnectionTestMessage,
  validateTestConnectionForm,
} from './instances-db.js';

const form = (overrides: Partial<Record<string, unknown>> = {}) => ({
  name: 'oracle-prod',
  environment: 'production',
  db_type: 'oracle',
  host: '10.17.12.15',
  port: 1521,
  username: 'monquery',
  password: 'secret',
  database_name: 'tpadc',
  description: '',
  ...overrides,
});

const response = (body: unknown, ok = true, status = ok ? 200 : 400) => ({
  ok,
  status,
  json: async () => body,
});

const existingInstance = {
  id: 29,
  name: 'oracle-prod',
  db_type: 'oracle',
  host: '10.17.12.15',
  port: 1521,
  database_name: 'tpadc',
  username: 'monquery',
  health_status: 'unknown',
  health_score: 0,
  status: 'active',
  created_at: '2026-08-10T00:00:00.000Z',
  environment: 'testing',
  description: '',
  hasCredential: true,
  credentialVersion: 1,
};

describe('database instance edit connection validation', () => {
  beforeEach(() => {
    authFetch.mockReset();
    showToast.mockReset();
    localStorage.removeItem('permissions');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires a password before testing an edited instance', () => {
    expect(validateTestConnectionForm(form({ password: '' }))).toBe('请输入密码');
  });

  it('keeps the entered username in the test payload when the password is changed', () => {
    expect(buildTestConnectionPayload(form({ password: '' }))).toMatchObject({
      username: 'monquery',
      password: '',
    });
  });

  it('copies the existing username while keeping the stored password write-only', () => {
    const page = document.createElement('instances-page') as any;

    page._editInstance(existingInstance);

    expect(page.formData.username).toBe('monquery');
    expect(page.formData.password).toBe('');
  });

  it('maps database authentication failures to a user-facing credential error', () => {
    expect(normalizeConnectionTestMessage('连接失败：ORA-01017: invalid username/password; logon denied'))
      .toBe('用户名或密码错误');
    expect(normalizeConnectionTestMessage('连接失败：ORA-28000: the account is locked'))
      .toBe('用户名或密码错误');
    expect(normalizeConnectionTestMessage('连接失败：28P01'))
      .toBe('用户名或密码错误');
    expect(normalizeConnectionTestMessage('连接失败：[-2501] login rejected'))
      .toBe('用户名或密码错误');
    expect(normalizeConnectionTestMessage('连接失败：ER_ACCOUNT_HAS_BEEN_LOCKED'))
      .toBe('用户名或密码错误');
    expect(normalizeConnectionTestMessage('连接失败：[-2501] 用户名或密码错误'))
      .toBe('用户名或密码错误');
    expect(normalizeConnectionTestMessage('连接失败：ORA-24415: Missing or null username'))
      .toBe('用户名或密码错误');
    expect(normalizeConnectionTestMessage('连接失败：ER_ACCESS_DENIED_NO_PASSWORD_ERROR'))
      .toBe('用户名或密码错误');
    expect(normalizeConnectionTestMessage('连接失败：请输入用户名'))
      .toBe('请输入用户名');
  });

  it('does not relabel a database privilege error as invalid credentials', () => {
    expect(normalizeConnectionTestMessage('连接失败：Access denied for user to database'))
      .toBe('连接失败：Access denied for user to database');
  });

  it('does not send an edited instance test request when the password is empty', async () => {
    const page = document.createElement('instances-page') as any;
    page._editInstance(existingInstance);

    await page._handleTestConnection();

    expect(authFetch).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('请输入密码', 'warning');
  });

  it('clears a stale success state when a later test is missing its password', async () => {
    const page = document.createElement('instances-page') as any;
    page._editInstance(existingInstance);
    page.testStatus = 'success';
    page.testMessage = '连接成功';
    page.formData = form({ password: '' });

    await page._handleTestConnection();

    expect(page.testStatus).toBe('error');
    expect(page.testMessage).toBe('请输入密码');
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('sends the entered username and normalizes authentication errors', async () => {
    authFetch.mockResolvedValue(response({
      success: false,
      message: '连接失败：ORA-01017: invalid username/password; logon denied',
    }));
    const page = document.createElement('instances-page') as any;
    page.formData = form();

    await page._handleTestConnection();

    const [, request] = authFetch.mock.calls[0];
    expect(JSON.parse(request.body)).toMatchObject({ username: 'monquery', password: 'secret' });
    expect(page.testStatus).toBe('error');
    expect(page.testMessage).toBe('用户名或密码错误');
  });

  it('does not trust a stale healthy status when the instance has no credential', async () => {
    authFetch.mockResolvedValue(response({}, false, 404));
    const page = document.createElement('instances-page') as any;
    await page._testConnection({
      ...existingInstance,
      health_status: 'healthy',
      hasCredential: false,
    });

    expect(page.listTestStatus).toBe('idle');
    expect(page.listTestMessage).toBe('');
    expect(page.showTestDialog).toBe(true);
    expect(authFetch).not.toHaveBeenCalled();
  });
});
