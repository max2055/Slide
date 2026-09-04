import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../../api/index.js', () => ({ apiClient: { get: mocks.get } }));
vi.mock('../components/app-toast-container.js', () => ({ showToast: mocks.toast }));

import './audit-center.js';

type Page = HTMLElement & { updateComplete: Promise<unknown> };

describe('audit center', () => {
  beforeEach(() => {
    mocks.get.mockImplementation(async (path: string) => path === '/agent/security/audit'
      ? { records: [], nextCursor: null }
      : { items: [], total: 0 });
  });

  afterEach(() => {
    document.body.replaceChildren();
    window.history.replaceState({}, '', '/');
    vi.clearAllMocks();
  });

  async function renderAt(path: string) {
    window.history.replaceState({}, '', path);
    const page = document.createElement('audit-center-page') as Page;
    document.body.append(page);
    await page.updateComplete;
    await new Promise(resolve => setTimeout(resolve, 0));
    return page;
  }

  it('opens system audit by default and exposes the Agent audit sub-tab', async () => {
    const page = await renderAt('/audit');
    const tabs = page.shadowRoot!.querySelectorAll<HTMLButtonElement>('[role="tab"]');

    expect([...tabs].map(tab => tab.textContent?.trim())).toEqual(['系统审计', 'Agent 审计']);
    expect(page.shadowRoot!.querySelector('system-audit-page')).not.toBeNull();

    tabs[1].click();
    await page.updateComplete;
    expect(new URL(window.location.href).searchParams.get('view')).toBe('agent');
    expect(page.shadowRoot!.querySelector('agent-tool-audit-page')).not.toBeNull();
  });

  it('restores the requested audit sub-tab from the URL', async () => {
    const page = await renderAt('/audit?view=agent');
    expect(page.shadowRoot!.querySelector('.tab.active')?.textContent?.trim()).toBe('Agent 审计');
  });
});
