import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast }));
import './cron-jobs-settings.js';

type Page = HTMLElement & Record<string, any>;
const job = { id: 42, name: '准确指标采集', cron_expr: '* * * * *', enabled: true };
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });

async function mount(): Promise<Page> {
  const page = document.createElement('cron-jobs-settings') as Page;
  document.body.append(page);
  await vi.waitFor(() => expect(page.loading).toBe(false));
  await page.updateComplete;
  return page;
}

async function openDialog(page: Page) {
  const execute = Array.from(page.shadowRoot!.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => button.textContent === '执行')!;
  execute.click();
  await page.updateComplete;
}

describe('Cron manual trigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    authFetch.mockReset();
    showToast.mockReset();
    authFetch.mockImplementation(async (url: string) => {
      if (url === '/api/cron/jobs') return response([job]);
      if (url.endsWith('/run')) return response({});
      return response({ logs: [{ status: 'success' }] });
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('polls the submitted job after confirmation closes the dialog, without null in requests', async () => {
    const page = await mount();
    await openDialog(page);
    page.shadowRoot!.querySelector<HTMLButtonElement>('app-dialog .btn-primary')!.click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('已触发执行'));
    await page.updateComplete;
    expect(page.shadowRoot!.querySelector('app-dialog')).toBeNull();

    await vi.advanceTimersByTimeAsync(3000);

    expect(authFetch).toHaveBeenCalledWith('/api/cron/jobs/42/run', { method: 'POST' });
    expect(authFetch).toHaveBeenCalledWith('/api/cron/jobs/42/logs?limit=1');
    expect(authFetch.mock.calls.every(([url]) => !url.includes('null'))).toBe(true);
  });

  it('keeps the submitted ID if the dialog is dismissed while POST is pending', async () => {
    const page = await mount();
    await openDialog(page);
    let resolve!: (value: unknown) => void;
    authFetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = page.confirmTrigger();
    page.closeTriggerDialog();
    resolve(response({}));
    await pending;
    await vi.advanceTimersByTimeAsync(3000);
    expect(authFetch).toHaveBeenCalledWith('/api/cron/jobs/42/logs?limit=1');
    expect(authFetch.mock.calls.every(([url]) => !url.includes('null'))).toBe(true);
  });

  it('keeps a failed trigger retryable and does not poll', async () => {
    const page = await mount();
    await openDialog(page);
    authFetch.mockResolvedValueOnce(response({ error: '无执行权限' }, false));
    await page.confirmTrigger();
    await page.updateComplete;
    expect(page.shadowRoot!.querySelector('app-dialog')?.textContent).toContain('无执行权限');
    await vi.advanceTimersByTimeAsync(3000);
    expect(authFetch.mock.calls.some(([url]) => url.includes('/logs'))).toBe(false);
    expect(showToast).not.toHaveBeenCalled();

    await page.confirmTrigger();
    await vi.advanceTimersByTimeAsync(3000);
    expect(authFetch).toHaveBeenCalledWith('/api/cron/jobs/42/logs?limit=1');
  });

  it('does not send a trigger request without a selected job', async () => {
    const page = await mount();
    authFetch.mockClear();
    await page.confirmTrigger();
    await vi.advanceTimersByTimeAsync(3000);
    expect(authFetch).not.toHaveBeenCalled();
  });
});
