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

import './collection-settings.js';

type Page = HTMLElement & { updateComplete: Promise<unknown> };

async function render(): Promise<Page> {
  mocks.get.mockResolvedValue({
    serverIntervalSeconds: 300,
    networkDeviceIntervalSeconds: 600,
    minIntervalSeconds: 10,
    maxIntervalSeconds: 86_400,
  });
  const page = document.createElement('collection-settings-page') as Page;
  document.body.append(page);
  await page.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await page.updateComplete;
  return page;
}

describe('collection settings', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.put.mockReset();
    mocks.toast.mockReset();
  });

  afterEach(() => document.body.replaceChildren());

  it('shows both persisted collection intervals', async () => {
    const page = await render();
    const inputs = page.shadowRoot?.querySelectorAll<HTMLInputElement>('input[type="number"]');

    expect(mocks.get).toHaveBeenCalledWith('/system/collection-config');
    expect(Array.from(inputs ?? [], (input) => input.value)).toEqual(['300', '600']);
    expect(page.shadowRoot?.textContent).toContain('不需要重启服务');
  });

  it('validates the server-provided range before saving', async () => {
    const page = await render();
    const inputs = page.shadowRoot!.querySelectorAll<HTMLInputElement>('input[type="number"]');
    inputs[1].value = '9';
    inputs[1].dispatchEvent(new Event('input'));
    page.shadowRoot?.querySelector<HTMLButtonElement>('button[slot="footer"]')?.click();
    await page.updateComplete;

    expect(mocks.put).not.toHaveBeenCalled();
    const fields = page.shadowRoot!.querySelectorAll('app-form-field');
    expect((fields[1] as HTMLElement & { error: string }).error).toBe('请输入 10 到 86400 之间的整数');
  });

  it('saves both intervals and renders the authoritative response', async () => {
    mocks.put.mockResolvedValue({
      serverIntervalSeconds: 120,
      networkDeviceIntervalSeconds: 900,
      minIntervalSeconds: 10,
      maxIntervalSeconds: 86_400,
    });
    const page = await render();
    const inputs = page.shadowRoot!.querySelectorAll<HTMLInputElement>('input[type="number"]');
    inputs[0].value = '120';
    inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = '900';
    inputs[1].dispatchEvent(new Event('input'));
    page.shadowRoot?.querySelector<HTMLButtonElement>('button[slot="footer"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await page.updateComplete;

    expect(mocks.put).toHaveBeenCalledWith('/system/collection-config', {
      serverIntervalSeconds: 120,
      networkDeviceIntervalSeconds: 900,
    });
    expect(Array.from(inputs, (input) => input.value)).toEqual(['120', '900']);
    expect(mocks.toast).toHaveBeenCalledWith('采集设置已保存并生效', 'success');
  });
});
