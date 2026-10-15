import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.ts';
import { AlertsPage } from './alerts.ts';

vi.mock('../../../api/index.ts', () => ({ authFetch: vi.fn() }));
vi.mock('../components/app-toast-container.js', () => ({ showToast: vi.fn() }));
const job = { id: 'delivery-1', type: 'notification', payload: { alertId: 7, channelId: 2 }, attempts: 3, lastError: 'delivery failed', createdAt: '2026-10-15T00:00:00Z' };
const readFetch = vi.fn();
beforeEach(() => {
  vi.mocked(authFetch).mockImplementation((url, options) => url.startsWith('/api/notification/dead-letters')
    ? readFetch(url, options) : Promise.resolve(json([])));
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); vi.resetAllMocks(); });
async function view() {
  const element = new AlertsPage();
  element.mode = 'notifications'; document.body.append(element); await element.updateComplete;
  return element;
}
async function read(element: AlertsPage) {
  await (element as any).loadNotificationDeadLetters(); await element.updateComplete;
}
const text = (element: AlertsPage) => element.shadowRoot!.textContent!;

describe('notification recovery reads', () => {
  it.each([503, 403, 401])('HTTP %s remains visible without relying on a toast', async status => {
    readFetch.mockResolvedValue(json({}, status));
    const element = await view();
    await vi.waitFor(() => expect(text(element)).toContain(status === 403 ? '无权查看通知投递记录' : status === 401 ? '登录已失效' : 'HTTP 503'));
    expect(element.shadowRoot!.querySelector('app-empty-state[title="没有待重放的通知"]')).toBeNull();
    expect(text(element)).toContain('重试');
  });
  it('only a successful empty array shows an empty queue; retry replaces failure with rows', async () => {
    readFetch.mockResolvedValue(json({}, 503));
    const element = await view();
    await vi.waitFor(() => expect(text(element)).toContain('HTTP 503'));
    readFetch.mockResolvedValue(json([job]));
    (Array.from(element.shadowRoot!.querySelectorAll('button')).find(b => b.textContent?.includes('重试'))!).click();
    await vi.waitFor(() => expect(text(element)).toContain(job.id));
    expect(text(element)).not.toContain('HTTP 503');
    readFetch.mockResolvedValue(json([])); await read(element);
    expect(element.shadowRoot!.querySelector('app-empty-state')?.getAttribute('title')).toBe('没有待重放的通知');
  });
  it.each([{}, null, [{ ...job, payload: null }]])('invalid response %j is a persistent failure, not empty/success', async body => {
    readFetch.mockResolvedValue(json(body)); const element = await view();
    await vi.waitFor(() => expect(text(element)).toContain('通知投递记录格式异常'));
    expect(element.shadowRoot!.querySelector('table')).toBeNull();
  });
  it('refresh hides old rows while loading and clears them on failure', async () => {
    readFetch.mockResolvedValue(json([job])); const element = await view();
    await vi.waitFor(() => expect(text(element)).toContain(job.id));
    let resolve!: (r: Response) => void;
    readFetch.mockImplementation(() => new Promise(r => resolve = r));
    const pending = (element as any).loadNotificationDeadLetters(); await element.updateComplete;
    expect(text(element)).toContain('加载通知投递记录'); expect(element.shadowRoot!.querySelector('table')).toBeNull();
    resolve(json({}, 403)); await pending; await element.updateComplete;
    expect(text(element)).toContain('无权查看'); expect(text(element)).not.toContain(job.id);
  });
  it('bounds a hanging read with a retryable timeout', async () => {
    vi.useFakeTimers();
    readFetch.mockImplementation((_url: string, options?: RequestInit) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const element = await view();
    await vi.advanceTimersByTimeAsync(15_001); await element.updateComplete;
    expect(text(element)).toContain('加载通知投递记录超时'); expect(text(element)).toContain('重试');
  });
  it('a disconnected read cannot publish late data', async () => {
    let resolve!: (r: Response) => void;
    readFetch.mockImplementation(() => new Promise(r => resolve = r));
    const element = await view(); element.remove();
    resolve(json([job])); await Promise.resolve(); await Promise.resolve(); await element.updateComplete;
    expect(text(element)).not.toContain(job.id);
  });
  it('a network failure is persistent and retryable', async () => {
    readFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const element = await view();
    await vi.waitFor(() => expect(text(element)).toContain('网络异常'));
    expect(element.shadowRoot!.querySelector('app-empty-state')?.getAttribute('title')).toBe('无法加载通知投递记录');
  });
  it('after successful replay, a failed queue refresh stays visibly failed', async () => {
    readFetch.mockResolvedValue(json([job])); const element = await view();
    await vi.waitFor(() => expect(text(element)).toContain(job.id));
    (element.shadowRoot!.querySelector('tbody button') as HTMLButtonElement).click(); await element.updateComplete;
    const reason = element.shadowRoot!.querySelector('textarea')!;
    reason.value = '确认后重放'; reason.dispatchEvent(new Event('input')); await element.updateComplete;
    vi.mocked(authFetch).mockImplementation((url, options) => url.includes('/replay') ? Promise.resolve(json({ success: true })) : readFetch(url, options));
    readFetch.mockResolvedValue(json({}, 503));
    await (element as any)._replayNotificationDeadLetter(); await element.updateComplete;
    expect(text(element)).toContain('HTTP 503'); expect(element.shadowRoot!.querySelector('tbody')).toBeNull();
    expect(element.shadowRoot!.querySelector('app-dialog')).toBeNull();
  });
});
