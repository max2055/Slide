import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../../api/index.js', () => ({ apiClient: { get: mocks.get, put: mocks.put } }));
vi.mock('../components/app-toast-container.js', () => ({ showToast: mocks.toast }));

import './agent-security-policy.js';

type Page = HTMLElement & { updateComplete: Promise<unknown> };

describe('Agent security execution controls', () => {
  beforeEach(() => {
    localStorage.setItem('permissions', JSON.stringify(['admin:*', 'ai:view', 'audit:view']));
    mocks.get.mockImplementation(async (path: string) => path.endsWith('/history')
      ? { records: [] }
      : { agents: [{ id: 'slide-db-ops', name: 'Slide' }], policies: [{ agentId: 'slide-db-ops', toolAllowlist: null, skillAllowlist: null, allowedEffects: ['read'], resourceScope: { instanceIds: null, serverIds: null, networkDeviceIds: null }, version: 1, updatedBy: null, updatedAt: null }], tools: [], skills: [] });
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('loads and persists the independent approval and restricted network switches', async () => {
    mocks.get.mockImplementation(async (path: string) => path.endsWith('/history')
      ? { records: [] }
      : path === '/agent/security/config'
        ? { approvalEnabled: true, restrictedNetworkEnabled: false, reasonCode: 'EXECUTION_CONFIG_READY' }
        : { agents: [{ id: 'slide-db-ops', name: 'Slide' }], policies: [{ agentId: 'slide-db-ops', toolAllowlist: null, skillAllowlist: null, allowedEffects: ['read'], resourceScope: { instanceIds: null, serverIds: null, networkDeviceIds: null }, version: 1, updatedBy: null, updatedAt: null }], tools: [], skills: [] });
    mocks.put.mockResolvedValue({ approvalEnabled: false, restrictedNetworkEnabled: true, reasonCode: 'EXECUTION_CONFIG_UPDATED' });
    const page = document.createElement('agent-security-policy-page') as Page;
    document.body.append(page);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await page.updateComplete;

    expect(mocks.get).toHaveBeenCalledWith('/agent/security/config');
    expect(page.shadowRoot?.textContent).toContain('网络设备范围');
    const approval = page.shadowRoot?.querySelector<HTMLInputElement>('[data-action="approval-toggle"]');
    const network = page.shadowRoot?.querySelector<HTMLInputElement>('[data-action="restricted-network-toggle"]');
    expect(approval?.checked).toBe(true);
    expect(network?.checked).toBe(false);

    approval?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await page.updateComplete;
    expect(mocks.put).toHaveBeenCalledWith('/agent/security/config', { approvalEnabled: false, restrictedNetworkEnabled: false });
  });
});
