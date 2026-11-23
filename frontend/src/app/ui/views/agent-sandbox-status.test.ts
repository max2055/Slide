import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  permissions: vi.fn(),
  put: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../../api/index.js', () => ({
  apiClient: { get: mocks.get, put: mocks.put, getToken: () => localStorage.getItem('token'), getSessionContext: () => 1 },
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

async function render(enabled = false, statusOnly = false, configReason?: string): Promise<Page> {
  mocks.get.mockImplementation(async (path: string) => {
    if (path === '/auth/permissions') return mocks.permissions();
    if (path.endsWith('/config')) return { enabled, reasonCode: configReason ?? (enabled ? 'SANDBOX_ENABLED' : 'SANDBOX_DISABLED') };
    return statusResponse();
  });
  const page = document.createElement('agent-sandbox-status-page') as Page;
  page.toggleAttribute('status-only', statusOnly);
  document.body.append(page);
  await page.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await page.updateComplete;
  return page;
}

describe('Agent Sandbox global setting', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.permissions.mockReset().mockImplementation(async () => JSON.parse(localStorage.getItem('permissions') ?? '[]'));
    mocks.put.mockReset();
    mocks.toast.mockReset();
    localStorage.setItem('permissions', JSON.stringify(['*']));
    localStorage.setItem('token', 'sandbox-test-session');
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it('loads and renders the authoritative disabled state', async () => {
    const page = await render(false);
    const toggle = page.shadowRoot?.querySelector<HTMLInputElement>('[data-action="sandbox-toggle"]');

    expect(mocks.get).toHaveBeenCalledWith('/agent/security/sandbox/config');
    expect(page.shadowRoot?.textContent).toContain('Agent 沙箱代码执行');
    expect(page.shadowRoot?.textContent).toContain('不会直接运行在宿主机');
    expect(toggle?.checked).toBe(false);
    expect(toggle?.disabled).toBe(false);
  });

  it('requires confirmation before enabling and persists a strict boolean', async () => {
    let releaseSave!: () => void;
    mocks.put.mockImplementation(() => new Promise(resolve => {
      releaseSave = () => resolve({ enabled: true, reasonCode: 'SANDBOX_ENABLED' });
    }));
    const page = await render(false);
    const root = page.shadowRoot!;
    const toggle = root.querySelector<HTMLInputElement>('[data-action="sandbox-toggle"]')!;

    toggle.click();
    await page.updateComplete;
    expect(mocks.put).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLElement & { open: boolean }>('app-dialog')?.open).toBe(true);

    const confirm = root.querySelector<HTMLButtonElement>('[data-action="confirm-enable"]')!;
    confirm.click();
    root.querySelector<HTMLButtonElement>('.btn-refresh')!.click();
    confirm.click();
    expect(mocks.put).toHaveBeenCalledExactlyOnceWith('/agent/security/sandbox/config', { enabled: true });
    expect(mocks.get.mock.calls.filter(([path]) => path === '/agent/security/sandbox')).toHaveLength(2);
    expect(mocks.permissions).toHaveBeenCalledTimes(1);
    releaseSave();
    await vi.waitFor(() => expect(toggle.checked).toBe(true));
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

  it('explains controller readiness failures instead of hiding the 503 reason', async () => {
    mocks.put.mockRejectedValue(new Error('HTTP 503: {"reasonCode":"SANDBOX_NOT_READY"}'));
    const page = await render(false);
    page.shadowRoot!.querySelector<HTMLInputElement>('[data-action="sandbox-toggle"]')!.click();
    await page.updateComplete;
    page.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="confirm-enable"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await page.updateComplete;
    expect(mocks.toast).toHaveBeenCalledWith('Sandbox Controller 未就绪，请检查 Controller 地址、rootless Docker 和运行时镜像', 'error');
  });

  it('does not expose or request the global control for non-administrators', async () => {
    localStorage.setItem('permissions', JSON.stringify(['audit:view']));
    const page = await render(false);

    expect(mocks.get).not.toHaveBeenCalledWith('/agent/security/sandbox/config');
    expect(page.shadowRoot?.querySelector('[data-action="sandbox-toggle"]')).toBeNull();
  });

  it('links from status to the existing configuration route without loading the global switch', async () => {
    const page = await render(false, true);
    const root = page.shadowRoot!;
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/settings/ai/security?view=sandbox');
    expect(mocks.get).not.toHaveBeenCalledWith('/agent/security/sandbox/config');
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: ['audit:view'] } }));
    await page.updateComplete;
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('执行环境');
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('uses current grants on entry and refresh even if cached management rights remain', async () => {
    mocks.permissions.mockResolvedValue(['audit:view']);
    const page = await render(false, true);
    const root = page.shadowRoot!;
    const refresh = root.querySelector<HTMLButtonElement>('.btn-refresh')!;
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('执行环境');

    mocks.permissions.mockResolvedValueOnce(['audit:view', 'admin:*']);
    refresh.click();
    await vi.waitFor(() => expect(root.querySelector('a')).not.toBeNull());
    refresh.click();
    await vi.waitFor(() => expect(root.querySelector('a')).toBeNull());
    expect(root.textContent).toContain('执行环境');
    expect(mocks.permissions).toHaveBeenCalledTimes(3);
    expect(mocks.get).not.toHaveBeenCalledWith('/agent/security/sandbox/config');
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('MAX-732 refreshes permissions and discards a pending configuration read after revocation', async () => {
    let releaseConfig!: () => void;
    const page = await render();
    const root = page.shadowRoot!;
    const refresh = root.querySelector<HTMLButtonElement>('.btn-refresh')!;
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/auth/permissions') return mocks.permissions();
      if (path.endsWith('/config')) return new Promise(resolve => {
        releaseConfig = () => resolve({ enabled: false, reasonCode: 'SANDBOX_DISABLED' });
      });
      return statusResponse();
    });
    refresh.click();
    await vi.waitFor(() => expect(root.textContent).toContain('正在读取全局设置'));

    mocks.permissions.mockResolvedValue(['audit:view']);
    refresh.click();
    await vi.waitFor(() => expect(mocks.permissions).toHaveBeenCalledTimes(3));
    expect(root.querySelector('.config-card')).toBeNull();
    releaseConfig();
    await new Promise(resolve => setTimeout(resolve, 0));
    await page.updateComplete;

    expect(root.querySelector('.config-card')).toBeNull();
    expect(root.querySelector('[data-action="sandbox-toggle"]')).toBeNull();
    expect(root.querySelector('app-dialog')).toBeNull();
    expect(root.textContent).toContain('运行状态');
    expect(mocks.get.mock.calls.filter(([path]) => path === '/agent/security/sandbox')).toHaveLength(3);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('hides management when permission reread fails and ignores an older grant', async () => {
    let releaseGrant!: (value: string[]) => void;
    mocks.permissions.mockImplementationOnce(() => new Promise(resolve => { releaseGrant = resolve; }));
    const page = await render(false, true);
    const root = page.shadowRoot!;
    expect(root.querySelector('a')).toBeNull();
    mocks.permissions.mockRejectedValueOnce(new Error('HTTP 503: unavailable'));
    root.querySelector<HTMLButtonElement>('.btn-refresh')!.click();
    await vi.waitFor(() => expect(mocks.permissions).toHaveBeenCalledTimes(2));
    releaseGrant(['audit:view', 'admin:*']);
    await new Promise(resolve => setTimeout(resolve, 0));
    await page.updateComplete;
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('执行环境');
  });

  it('distinguishes unreadable status from confirmed missing configuration on retry', async () => {
    const page = await render(false, true);
    const root = page.shadowRoot!;
    const refresh = root.querySelector<HTMLButtonElement>('.btn-refresh')!;
    expect(root.querySelector('.metric')?.textContent).toContain('就绪');
    mocks.get.mockRejectedValueOnce(new Error('HTTP 503: unavailable'));
    refresh.click();
    await vi.waitFor(() => expect(root.querySelector('app-empty-state')?.getAttribute('title')).toBe('暂时无法读取沙箱状态'));
    expect(root.textContent).not.toContain('Controller 未配置');
    mocks.get.mockResolvedValueOnce({ configured: true, reachable: false });
    refresh.click();
    await vi.waitFor(() => expect(root.querySelector('app-empty-state')?.getAttribute('title')).toBe('Sandbox Controller 不可达'));
    mocks.get.mockResolvedValueOnce({ configured: false, reachable: false });
    refresh.click();
    await vi.waitFor(() => expect(root.querySelector('app-empty-state')?.getAttribute('title')).toBe('Sandbox Controller 未配置'));
  });

  it('leaves runtime evidence visible when the global setting cannot be read', async () => {
    const page = await render(false, false, 'SANDBOX_CONFIG_UNAVAILABLE');
    expect(page.shadowRoot?.textContent).toContain('暂时无法读取全局设置');
    expect(page.shadowRoot?.textContent).toContain('运行状态');
    expect(page.shadowRoot?.querySelector('[data-action="sandbox-toggle"]')).toBeNull();
  });

  it('dismisses the configuration dialog on revocation while retaining audit-only status', async () => {
    const page = await render();
    const root = page.shadowRoot!;
    root.querySelector<HTMLInputElement>('[data-action="sandbox-toggle"]')!.click();
    await page.updateComplete;
    const confirm = root.querySelector<HTMLButtonElement>('[data-action="confirm-enable"]')!;
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: ['audit:view'] } }));
    confirm.click();
    await page.updateComplete;
    expect(mocks.put).not.toHaveBeenCalled();
    expect(root.querySelector('app-dialog')).toBeNull();
    expect(root.querySelector('[data-action="sandbox-toggle"]')).toBeNull();
    expect(root.textContent).toContain('执行环境');
  });
});
