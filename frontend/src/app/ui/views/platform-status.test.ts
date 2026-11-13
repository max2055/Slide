import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformStatusPage } from './platform-status.js';
import './platform-status.js';

const children = 'health-center-page, platform-observations-page, agent-sandbox-status-page';
async function mount(permissions: unknown = ['*'], view = 'health') {
  if (permissions !== undefined) localStorage.setItem('permissions', JSON.stringify(permissions));
  history.replaceState({}, '', `/health?view=${view}`);
  const page = document.createElement('platform-status-page') as PlatformStatusPage;
  document.body.append(page);
  await page.updateComplete;
  return page;
}
function permissions(values: string[]) {
  localStorage.setItem('permissions', JSON.stringify(values));
  window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: values } }));
}
beforeEach(() => localStorage.clear());
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('MAX-651 #436 permission mount boundary', () => {
  it.each([[], null, {}, 'config:view', [42], ['CONFIG:VIEW'], ['config:viewer']])('denies invalid/absent grants %j', async grants => {
    const page = await mount(grants);
    expect(page.shadowRoot!.querySelectorAll(children)).toHaveLength(0);
    expect(page.shadowRoot!.querySelector('app-empty-state')?.getAttribute('title')).toBe('无权限访问平台状态');
  });
  it('preserves direct view intent while permissions are loading', async () => {
    const page = await mount(null, 'sandbox');
    expect(page.shadowRoot!.querySelectorAll(children)).toHaveLength(0);
    expect(location.search).toBe('?view=sandbox');
    permissions(['config:view', 'audit:view']); await page.updateComplete;
    expect(page.shadowRoot!.querySelector('agent-sandbox-status-page')).not.toBeNull();
  });
  it('denies missing and corrupt storage', async () => {
    localStorage.setItem('permissions', '{');
    const page = document.createElement('platform-status-page') as PlatformStatusPage;
    document.body.append(page); await page.updateComplete;
    expect(page.shadowRoot!.querySelectorAll(children)).toHaveLength(0);
    page.remove(); localStorage.clear(); document.body.append(page); await page.updateComplete;
    expect(page.shadowRoot!.querySelectorAll(children)).toHaveLength(0);
  });
  it.each([['config:view', 'health-center-page'], ['config:*', 'health-center-page'], ['audit:view', 'agent-sandbox-status-page'], ['audit:*', 'agent-sandbox-status-page'], ['*', 'health-center-page']])('keeps valid grant %s', async (grant, tag) => {
    const page = await mount([grant]);
    expect(page.shadowRoot!.querySelector(tag)).not.toBeNull();
  });
  it('revokes active page, falls back to allowed view, then denies all', async () => {
    const page = await mount(['*'], 'sandbox');
    permissions(['config:view']); await page.updateComplete;
    expect(page.shadowRoot!.querySelector('health-center-page')).not.toBeNull();
    expect(location.search).toBe('?view=health');
    permissions([]); await page.updateComplete;
    expect(page.shadowRoot!.querySelectorAll(children)).toHaveLength(0);
    permissions(['audit:view']); await page.updateComplete;
    expect(page.shadowRoot!.querySelector('agent-sandbox-status-page')).not.toBeNull();
  });
});
describe('MAX-663 #667 history and lifecycle', () => {
  it.each(['health', 'observations', 'sandbox'])('opens direct legal view %s', async view => {
    const page = await mount(['*'], view);
    expect(page.shadowRoot!.querySelector('[aria-selected="true"]')?.textContent?.trim()).toBe({ health: '平台自检', observations: '平台观测', sandbox: 'Agent 沙箱' }[view]);
  });
  it('uses URL on popstate and resets absent/unknown view to legal default', async () => {
    const page = await mount(['*'], 'sandbox');
    for (const query of ['?view=observations', '', '?view=unknown']) {
      history.replaceState({}, '', `/health${query}`); window.dispatchEvent(new PopStateEvent('popstate')); await page.updateComplete;
      expect(page.shadowRoot!.querySelector(query.includes('observations') ? 'platform-observations-page' : 'health-center-page')).not.toBeNull();
    }
  });
  it('does not rewrite another page view during shell teardown', async () => {
    const page = await mount(['*']);
    history.replaceState({ kept: true }, '', '/settings/monitoring/metrics?view=audit');
    window.dispatchEvent(new PopStateEvent('popstate')); await page.updateComplete;
    expect(location.pathname + location.search).toBe('/settings/monitoring/metrics?view=audit');
    expect(history.state).toEqual({ kept: true });
  });
  it('pairs listeners and refreshes URL and permissions on reconnection', async () => {
    const add = vi.spyOn(window, 'addEventListener'); const remove = vi.spyOn(window, 'removeEventListener');
    const page = await mount(['*']);
    page.remove();
    for (const event of ['popstate', 'slide-permissions-loaded']) {
      const registration = add.mock.calls.find(call => call[0] === event)!;
      expect(remove).toHaveBeenCalledWith(event, registration[1]);
    }
    permissions([]);
    history.replaceState({}, '', '/health?view=sandbox');
    window.dispatchEvent(new PopStateEvent('popstate')); await page.updateComplete;
    expect(page.shadowRoot!.querySelector('health-center-page')).not.toBeNull();
    document.body.append(page); await page.updateComplete;
    expect(page.shadowRoot!.querySelectorAll(children)).toHaveLength(0);
  });
});
