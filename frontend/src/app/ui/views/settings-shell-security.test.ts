import { afterEach, describe, expect, it } from 'vitest';
import './settings-shell.js';

describe('settings navigation and routing', () => {
  afterEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
    window.history.replaceState({}, '', '/');
  });

  async function renderAt(path: string, permissions: string[]): Promise<HTMLElement & { updateComplete: Promise<unknown> }> {
    window.history.replaceState({}, '', path);
    localStorage.setItem('permissions', JSON.stringify(permissions));
    const element = document.createElement('settings-shell') as HTMLElement & { updateComplete: Promise<unknown> };
    document.body.append(element);
    await element.updateComplete;
    return element;
  }

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
