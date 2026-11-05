import { afterEach, describe, expect, it, vi } from 'vitest';
import './settings-shell.js';
import { apiClient } from '../../../api/index.ts';
import { permissionMatches } from '../settings-navigation.ts';

describe('settings navigation and routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.body.replaceChildren();
    window.history.replaceState({}, '', '/');
  });

  async function renderAt(path: string, permissions: string[]): Promise<HTMLElement & { updateComplete: Promise<unknown> }> {
    window.history.replaceState({}, '', path);
    localStorage.setItem('permissions', JSON.stringify(permissions));
    const element = document.createElement('settings-shell') as HTMLElement & { updateComplete: Promise<unknown> };
    vi.spyOn(apiClient, 'getToken').mockReturnValue('test-token');
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockResolvedValue(new Response(JSON.stringify(permissions)));
    document.body.append(element);
    await new Promise(resolve => setTimeout(resolve, 0));
    await element.updateComplete;
    return element;
  }

  it('denies unknown permissions but preserves public and wildcard access', () => {
    expect(permissionMatches(null, 'admin:*')).toBe(false);
    expect(permissionMatches(null)).toBe(true);
    expect(permissionMatches(new Set(['*']), 'admin:*')).toBe(true);
    expect(permissionMatches(new Set(['ai:*']), 'ai:view')).toBe(true);
  });

  it.each([null, '{', '{}', '[1]', '["*"]'])('does not mount restricted views from cache %s before a real response', async cache => {
    window.history.replaceState({}, '', '/settings/access/users?view=accounts');
    if (cache !== null) localStorage.setItem('permissions', cache);
    vi.spyOn(apiClient, 'getToken').mockReturnValue('test-token');
    let resolve!: (response: Response) => void;
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockReturnValue(new Promise(done => { resolve = done; }));
    const element = document.createElement('settings-shell') as HTMLElement & { updateComplete: Promise<unknown> };
    document.body.append(element);
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector('users-management')).toBeNull();
    expect(element.shadowRoot!.querySelector('app-empty-state')?.getAttribute('title')).toBe('权限加载中');
    resolve(new Response(JSON.stringify(['admin:*'])));
    await new Promise(done => setTimeout(done, 0));
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector('users-management')).not.toBeNull();
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: [] } }));
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector('users-management')).toBeNull();
    expect(element.shadowRoot!.querySelector('rbac-admin-page')).toBeNull();
  });

  it('keeps failed permission loads closed despite a cached admin grant', async () => {
    window.history.replaceState({}, '', '/settings/access/users');
    localStorage.setItem('permissions', '["*"]');
    vi.spyOn(apiClient, 'getToken').mockReturnValue('test-token');
    vi.spyOn(apiClient, 'fetchResponseWithAuth').mockRejectedValue(new Error('offline'));
    const element = document.createElement('settings-shell') as HTMLElement & { updateComplete: Promise<unknown> };
    document.body.append(element);
    await new Promise(done => setTimeout(done, 0));
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector('users-management')).toBeNull();
    expect(element.shadowRoot!.querySelector('app-empty-state')?.getAttribute('title')).toBe('权限不可用');
  });

  it('removes revoked tabs and clears pages on malformed updates and session expiry', async () => {
    const element = await renderAt('/settings/ai/security?view=sandbox', ['audit:view', 'ai:view']);
    expect(element.shadowRoot!.querySelector('agent-sandbox-status-page')).not.toBeNull();
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: ['ai:view'] } }));
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector('agent-sandbox-status-page')).toBeNull();
    expect(element.shadowRoot!.querySelector('agent-security-policy-page')).not.toBeNull();
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: ['*', 1] } }));
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector('agent-security-policy-page')).toBeNull();
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: ['ai:view'] } }));
    await element.updateComplete;
    window.dispatchEvent(new Event('slide-session-expired'));
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector('agent-security-policy-page')).toBeNull();
  });

  it('shows four non-clickable groups and redirects the settings root to the first accessible page', async () => {
    const element = await renderAt('/settings?source=menu', ['*']);
    const root = element.shadowRoot!;

    expect([...root.querySelectorAll('.settings-group__label')].map((node) => node.textContent)).toEqual([
      '平台设置', '监控与分析', 'AI 与 Agent', '用户与权限',
    ]);
    expect(root.querySelectorAll('.settings-group__label button')).toHaveLength(0);
    expect(window.location.pathname).toBe('/settings/platform/branding');
    expect(new URL(window.location.href).searchParams.get('source')).toBe('menu');
  });

  it('preserves query parameters while redirecting a legacy settings page', async () => {
    await renderAt('/scoring-settings?instance=42', ['scoring:view']);

    expect(window.location.pathname).toBe('/settings/monitoring/analysis');
    expect(new URL(window.location.href).searchParams.get('instance')).toBe('42');
    expect(new URL(window.location.href).searchParams.get('view')).toBe('scoring');
  });

  it('restores Agent sessions in AI settings and redirects the legacy route', async () => {
    const element = await renderAt('/agent-sessions?source=legacy', ['ai:view']);
    const root = element.shadowRoot!;

    expect(window.location.pathname).toBe('/settings/ai/sessions');
    expect(new URL(window.location.href).searchParams.get('source')).toBe('legacy');
    expect([...root.querySelectorAll('.settings-item')].some((node) => node.textContent?.includes('Agent 会话'))).toBe(true);
    expect(root.querySelector('agent-sessions-page')).not.toBeNull();
  });

  it('filters whole groups and merged-page tabs without expanding permissions', async () => {
    const element = await renderAt('/settings/ai/security?view=policy', ['ai:view']);
    const text = element.shadowRoot?.textContent ?? '';

    expect(new URL(window.location.href).searchParams.get('view')).toBe('policy');
    expect(element.shadowRoot?.querySelector('agent-security-policy-page')).not.toBeNull();
    expect(text).not.toContain('沙箱配置');
    expect(text).not.toContain('用户与权限');
    expect(text).not.toContain('登录安全');
    expect(text).not.toContain('Agent 审计');
  });

  it('Profiles deep links require ai:view and leave legacy settings routes intact', async () => {
    const element = await renderAt('/settings/ai/profiles', ['chat:view']);
    expect(element.shadowRoot!.querySelector('investigation-profiles-page')).toBeNull();
    expect(element.shadowRoot!.querySelector('app-empty-state')?.getAttribute('title')).toBe('无权访问');
  });

  it('restores the selected merged-page view from browser history', async () => {
    const element = await renderAt('/settings/monitoring/analysis?view=automatic', ['ai:view', 'scoring:view']);
    const scoring = [...element.shadowRoot!.querySelectorAll<HTMLButtonElement>('.content-tab')]
      .find((button) => button.textContent?.trim() === '评分权重')!;

    scoring.click();
    await element.updateComplete;
    expect(new URL(window.location.href).searchParams.get('view')).toBe('scoring');

    window.history.replaceState({}, '', '/settings/monitoring/analysis?view=automatic');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector('.content-tab.active')?.textContent?.trim()).toBe('自动分析');
  });
});
