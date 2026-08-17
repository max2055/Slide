import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../../api/index.js', () => ({
  apiClient: { get: mocks.get, put: mocks.put },
}));
vi.mock('../components/app-toast-container.js', () => ({ showToast: mocks.toast }));

import './agent-sandbox-status.js';

type Page = HTMLElement & { updateComplete: Promise<unknown> };

function statusResponse() {
  return {
    configured: true,
    reachable: true,
    status: {
      status: 'ok', activeJobs: 0, maxConcurrentJobs: 4,
      daemon: { checkedAt: new Date().toISOString(), reachable: true, rootless: true },
      policy: {
        network: 'none', rootFilesystem: 'read-only', user: '65532:65532',
        capabilities: 'none', noNewPrivileges: true, runtimes: ['node'], limits: {},
      },
      recentJobs: [],
    },
  };
}

async function render(enabled = false): Promise<Page> {
  mocks.get.mockImplementation(async (path: string) => path.endsWith('/config')
    ? { enabled, reasonCode: enabled ? 'SANDBOX_ENABLED' : 'SANDBOX_DISABLED' }
    : statusResponse());
  const page = document.createElement('agent-sandbox-status-page') as Page;
  document.body.append(page);
  await page.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await page.updateComplete;
  return page;
}

describe('Agent Sandbox global setting', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.put.mockReset();
    mocks.toast.mockReset();
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it('loads and renders the authoritative disabled state', async () => {
    const page = await render(false);
    const toggle = page.shadowRoot?.querySelector<HTMLInputElement>('[data-action="sandbox-toggle"]');

    expect(mocks.get).toHaveBeenCalledWith('/agent/security/sandbox/config');
    expect(toggle?.checked).toBe(false);
    expect(toggle?.disabled).toBe(false);
  });

  it('requires confirmation before enabling and persists a strict boolean', async () => {
    mocks.put.mockResolvedValue({ enabled: true, reasonCode: 'SANDBOX_ENABLED' });
    const page = await render(false);
    const toggle = page.shadowRoot!.querySelector<HTMLInputElement>('[data-action="sandbox-toggle"]')!;

    toggle.click();
    await page.updateComplete;
    expect(mocks.put).not.toHaveBeenCalled();
    expect(page.shadowRoot?.querySelector<HTMLElement & { open: boolean }>('app-dialog')?.open).toBe(true);

    page.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="confirm-enable"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await page.updateComplete;
    expect(mocks.put).toHaveBeenCalledWith('/agent/security/sandbox/config', { enabled: true });
    expect(toggle.checked).toBe(true);
  });

  it('disables immediately without an enable confirmation', async () => {
    mocks.put.mockResolvedValue({ enabled: false, reasonCode: 'SANDBOX_DISABLED' });
    const page = await render(true);
    const toggle = page.shadowRoot!.querySelector<HTMLInputElement>('[data-action="sandbox-toggle"]')!;

    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await page.updateComplete;
    expect(mocks.put).toHaveBeenCalledWith('/agent/security/sandbox/config', { enabled: false });
    expect(page.shadowRoot?.querySelector('app-dialog')).toBeNull();
    expect(toggle.checked).toBe(false);
  });

  it('keeps authoritative state and reports a failed update', async () => {
    mocks.put.mockRejectedValue(new Error('HTTP detail'));
    const page = await render(true);
    const toggle = page.shadowRoot!.querySelector<HTMLInputElement>('[data-action="sandbox-toggle"]')!;

    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await page.updateComplete;
    expect(toggle.checked).toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith('更新 Agent Sandbox 设置失败', 'error');
  });

  it('does not expose or request the global control for non-administrators', async () => {
    localStorage.setItem('permissions', JSON.stringify(['audit:view']));
    const page = await render(false);

    expect(mocks.get).not.toHaveBeenCalledWith('/agent/security/sandbox/config');
    expect(page.shadowRoot?.querySelector('[data-action="sandbox-toggle"]')).toBeNull();
  });
});
