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

import './session-settings.js';

type Page = HTMLElement & { updateComplete: Promise<unknown> };

async function render(): Promise<Page> {
  mocks.get.mockResolvedValue({
    idleTimeoutMinutes: 10_080,
    minIdleTimeoutMinutes: 5,
    maxIdleTimeoutMinutes: 43_200,
  });
  const page = document.createElement('session-settings-page') as Page;
  document.body.append(page);
  await page.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await page.updateComplete;
  return page;
}

describe('session settings', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.put.mockReset();
    mocks.toast.mockReset();
  });

  afterEach(() => document.body.replaceChildren());

  it('shows the persisted inactivity policy and compatibility note', async () => {
    const page = await render();
    const input = page.shadowRoot?.querySelector<HTMLInputElement>('input[type="number"]');

    expect(mocks.get).toHaveBeenCalledWith('/auth/session-config');
    expect(input?.value).toBe('10080');
    expect(page.shadowRoot?.textContent).toContain('下一次成功续期后使用新设置');
  });

  it('validates the server-provided range before saving', async () => {
    const page = await render();
    const input = page.shadowRoot!.querySelector<HTMLInputElement>('input[type="number"]')!;
    input.value = '4';
    input.dispatchEvent(new Event('input'));
    page.shadowRoot?.querySelector<HTMLButtonElement>('button[slot="footer"]')?.click();
    await page.updateComplete;

    expect(mocks.put).not.toHaveBeenCalled();
    expect((page.shadowRoot?.querySelector('app-form-field') as HTMLElement & { error: string }).error)
      .toBe('请输入 5 到 43200 之间的整数');
  });

  it('saves an integer timeout and renders the authoritative response', async () => {
    mocks.put.mockResolvedValue({
      idleTimeoutMinutes: 120,
      minIdleTimeoutMinutes: 5,
      maxIdleTimeoutMinutes: 43_200,
    });
    const page = await render();
    const input = page.shadowRoot!.querySelector<HTMLInputElement>('input[type="number"]')!;
    input.value = '120';
    input.dispatchEvent(new Event('input'));
    page.shadowRoot?.querySelector<HTMLButtonElement>('button[slot="footer"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await page.updateComplete;

    expect(mocks.put).toHaveBeenCalledWith('/auth/session-config', { idleTimeoutMinutes: 120 });
    expect(input.value).toBe('120');
    expect(mocks.toast).toHaveBeenCalledWith('登录安全设置已保存', 'success');
  });
});
