import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFormatSettings } from '../format-config.js';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../../api/index.js', () => ({ apiClient: { get: mocks.get } }));
vi.mock('../components/app-toast-container.js', () => ({ showToast: mocks.toast }));

import './system-audit.js';

type Page = HTMLElement & { updateComplete: Promise<unknown> };

describe('system audit page', () => {
  beforeEach(() => {
    mocks.get.mockResolvedValue({
      items: [{
        id: 'audit-1', eventType: 'system_operation', level: 'info', userId: '7', username: 'alice',
        action: 'PATCH /api/users/:id', resourceType: 'users', resourceId: '42',
        details: { method: 'PATCH', statusCode: 204 }, clientIp: '127.0.0.1',
        result: 'success', timestamp: 1_788_000_000_000,
      }],
      total: 1,
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    setFormatSettings({});
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function renderPage() {
    const page = document.createElement('system-audit-page') as Page;
    document.body.append(page);
    await new Promise(resolve => setTimeout(resolve, 0));
    await page.updateComplete;
    return page;
  }

  it('loads and renders system audit records', async () => {
    const page = await renderPage();

    expect(mocks.get).toHaveBeenCalledWith('/audit/logs', { params: expect.objectContaining({ limit: 50, offset: 0 }) });
    expect(page.shadowRoot?.textContent).toContain('PATCH /api/users/:id');
    expect(page.shadowRoot?.textContent).toContain('alice');
    expect(page.shadowRoot?.textContent).toContain('127.0.0.1');
  });

  it('S03 uses display preferences while preserving the recorded audit instant', async () => {
    const instant = new Date(1_788_000_000_000);
    vi.spyOn(Date, 'now').mockReturnValue(instant.getTime() + 60 * 60_000);
    const storageKey = 'slide.control.settings.v1:default';
    vi.stubGlobal('localStorage', window.localStorage);
    localStorage.setItem(storageKey, JSON.stringify({ defaultPageSize: 10 }));
    setFormatSettings({ locale: 'zh-CN', dateFormat: 'relative', timezone: 'Asia/Tokyo' });
    const page = await renderPage();
    const displayedTime = () => page.shadowRoot!.querySelector('tbody td time');

    expect(mocks.get).toHaveBeenLastCalledWith('/audit/logs', { params: expect.objectContaining({ limit: 10, offset: 0 }) });
    expect(displayedTime()?.textContent).toBe('1小时前');
    expect(displayedTime()?.getAttribute('datetime')).toBe(instant.toISOString());
    expect(displayedTime()?.getAttribute('title')).toBe(instant.toISOString());

    setFormatSettings({ locale: 'zh-CN', dateFormat: 'absolute', timezone: 'Asia/Tokyo' });
    window.dispatchEvent(new Event('slide-settings-applied'));
    await page.updateComplete;
    expect(displayedTime()?.textContent).toBe(instant.toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo' }));
    expect(mocks.get).toHaveBeenCalledTimes(1);

    localStorage.setItem(storageKey, JSON.stringify({ defaultPageSize: 20 }));
    window.dispatchEvent(new Event('slide-settings-applied'));
    await page.updateComplete;
    expect(mocks.get).toHaveBeenLastCalledWith('/audit/logs', { params: expect.objectContaining({ limit: 20, offset: 0 }) });
  });

  it('submits keyword, operation type, and time filters', async () => {
    const page = await renderPage();
    const root = page.shadowRoot!;
    const keyword = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    const eventType = root.querySelector<HTMLSelectElement>('select')!;
    const dates = root.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]');

    keyword.value = 'alice';
    keyword.dispatchEvent(new Event('input'));
    eventType.value = 'system_operation';
    eventType.dispatchEvent(new Event('change'));
    dates[0].value = '2026-09-01T08:00';
    dates[0].dispatchEvent(new Event('input'));
    dates[1].value = '2026-09-04T18:00';
    dates[1].dispatchEvent(new Event('input'));
    root.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mocks.get).toHaveBeenLastCalledWith('/audit/logs', { params: expect.objectContaining({
      keyword: 'alice',
      eventType: 'system_operation',
      startTime: new Date('2026-09-01T08:00').toISOString(),
      endTime: new Date('2026-09-04T18:00').toISOString(),
    }) });
  });
});
