import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient, authFetch, notifySessionExpired } from '../../../api/index.ts';
import { AlertsPage } from './alerts.ts';

vi.mock('../../../api/index.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../api/index.ts')>(), authFetch: vi.fn(),
}));
vi.mock('../components/app-toast-container.js', () => ({ showToast: vi.fn() }));
const job = { id: 'delivery-1', type: 'notification', payload: { alertId: 7, channelId: 2 }, attempts: 3, lastError: 'delivery failed', createdAt: '2026-10-15T00:00:00Z' };
const legacyReceipt = { id: 'legacy-receipt', alert_id: '7', channel_id: 2, phase: 'problem', job_state: 'completed' };
const readFetch = vi.fn();
const receiptFetch = vi.fn();
beforeEach(() => {
  receiptFetch.mockImplementation(async () => json([]));
  vi.mocked(authFetch).mockImplementation((url, options) => {
    if (url === '/api/notification/deliveries') return receiptFetch(url, options);
    if (url.startsWith('/api/notification/dead-letters')) return readFetch(url, options);
    return Promise.resolve(json([]));
  });
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => {
  document.body.replaceChildren();
  apiClient.setToken(null);
  apiClient.setRefreshToken(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
async function view() {
  const element = new AlertsPage();
  element.mode = 'notifications'; document.body.append(element); await element.updateComplete;
  return element;
}
async function read(element: AlertsPage) {
  await (element as any).loadNotificationDeadLetters(); await element.updateComplete;
}
const text = (element: AlertsPage) => element.shadowRoot!.textContent!;
const receiptRoot = (element: AlertsPage) => element.shadowRoot!.querySelector('notification-deliveries')!.shadowRoot!;
const receiptRefresh = (root: ShadowRoot) => root.querySelector('button')!;

describe('notification recovery reads', () => {
  it.each([503, 403, 401])('HTTP %s remains visible without relying on a toast', async status => {
    readFetch.mockResolvedValue(json({}, status));
    const element = await view();
    await vi.waitFor(() => expect(text(element)).toContain(status === 403 ? '无权查看通知死信' : status === 401 ? '登录已失效' : 'HTTP 503'));
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
    await vi.waitFor(() => expect(text(element)).toContain('通知死信格式异常'));
    expect(element.shadowRoot!.querySelector('table')).toBeNull();
  });
  it('refresh hides old rows while loading and clears them on failure', async () => {
    readFetch.mockResolvedValue(json([job])); const element = await view();
    await vi.waitFor(() => expect(text(element)).toContain(job.id));
    let resolve!: (r: Response) => void;
    readFetch.mockImplementation(() => new Promise(r => resolve = r));
    const pending = (element as any).loadNotificationDeadLetters(); await element.updateComplete;
    expect(text(element)).toContain('加载通知死信'); expect(element.shadowRoot!.querySelector('table')).toBeNull();
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
    expect(text(element)).toContain('加载通知死信超时'); expect(text(element)).toContain('重试');
  });
  it('ends a dead-letter read even when shared auth recovery ignores its abort signal', async () => {
    vi.useFakeTimers();
    readFetch.mockImplementation(async () => json([job]));
    const element = await view();
    await vi.advanceTimersByTimeAsync(0);
    expect(text(element)).toContain(job.id);

    let signal: AbortSignal | null | undefined;
    let resolveLate!: (response: Response) => void;
    readFetch.mockImplementationOnce((_url, options: RequestInit) => {
      signal = options.signal;
      return new Promise(resolve => { resolveLate = resolve; });
    });
    const settled = vi.fn();
    void read(element).then(settled);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signal?.aborted).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(text(element)).toContain('加载通知死信超时');
    expect(text(element)).not.toContain(job.id);

    const retry = Array.from(element.shadowRoot!.querySelectorAll('button')).find(button => button.textContent?.includes('重试读取死信'))!;
    retry.click();
    await vi.advanceTimersByTimeAsync(0);
    resolveLate(json([{ ...job, id: 'late-dead-letter' }]));
    await vi.advanceTimersByTimeAsync(0);
    expect(text(element)).toContain(job.id);
    expect(text(element)).not.toContain('late-dead-letter');
    expect(receiptFetch).toHaveBeenCalledTimes(1);
  });
  it.each(['external replacement', 'local expiry', 'local replacement'])('rejects late dead letters after %s', async boundary => {
    apiClient.setToken('current-session');
    let signal: AbortSignal | null | undefined;
    let resolveLate!: (response: Response) => void;
    readFetch.mockImplementationOnce((_url, options: RequestInit) => {
      signal = options.signal;
      return new Promise(resolve => { resolveLate = resolve; });
    }).mockImplementation(async () => json([]));
    const element = await view();
    if (boundary === 'local expiry') {
      notifySessionExpired();
    } else {
      apiClient.setToken('replacement-session');
      if (boundary === 'external replacement') {
        window.dispatchEvent(new StorageEvent('storage', { key: 'token', storageArea: localStorage }));
      }
    }
    if (boundary !== 'local replacement') expect(signal?.aborted).toBe(true);

    resolveLate(json([job]));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(text(element)).not.toContain(job.id);
    if (boundary === 'local expiry') expect(text(element)).toContain('登录已失效');
    if (boundary === 'local replacement') expect(text(element)).toContain('登录状态已变化');
    if (boundary === 'external replacement') expect(text(element)).toContain('没有待重放的通知');
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
    expect(element.shadowRoot!.querySelector('app-empty-state')?.getAttribute('title')).toBe('无法加载通知死信');
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

describe('E14 notification receipt reads', () => {
  beforeEach(() => {
    apiClient.setToken('current-session');
    readFetch.mockImplementation(async () => json([job]));
  });

  it.each([
    ['401', () => json({}, 401), '登录已失效'],
    ['403', () => json({}, 403), '无权查看投递回执'],
    ['503', () => json({}, 503), 'HTTP 503'],
    ['non-array', () => json({}), '投递回执格式异常'],
    ['empty row', () => json([{}]), '投递回执格式异常'],
    ['malformed nested attempt', () => json([legacyReceipt, { ...legacyReceipt, attempts: [null] }]), '投递回执格式异常'],
    ['malformed JSON', () => new Response('[invalid'), '投递回执格式异常'],
  ])('keeps the %s error local and offers retry', async (_name, response, message) => {
    receiptFetch.mockImplementation(async () => response());
    const element = await view();
    const root = receiptRoot(element);
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain(message));
    expect(root.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(root.textContent).not.toContain('暂无可查看的投递回执');
    expect(receiptRefresh(root).disabled).toBe(false);

    receiptFetch.mockImplementation(async () => json([legacyReceipt]));
    receiptRefresh(root).click();
    await vi.waitFor(() => expect(root.querySelector('tbody')?.textContent).toContain(legacyReceipt.id));
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(text(element)).toContain(job.id);
    expect(readFetch).toHaveBeenCalledTimes(1);

    receiptFetch.mockImplementation(async () => json([]));
    receiptRefresh(root).click();
    await vi.waitFor(() => expect(root.textContent).toContain('暂无可查看的投递回执'));
    expect(readFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['headers', 'body'])('bounds stalled %s and ignores late rows after retry', async (stage) => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    let resolveLate!: () => void;
    const lateRows = [{ ...legacyReceipt, id: 'late-receipt' }];
    receiptFetch.mockImplementationOnce((_url, options: RequestInit) => {
      signal = options.signal;
      if (stage === 'headers') return new Promise(resolve => { resolveLate = () => resolve(json(lateRows)); });
      const response = json(null);
      vi.spyOn(response, 'text').mockImplementation(() => new Promise(resolve => { resolveLate = () => resolve(JSON.stringify(lateRows)); }));
      return Promise.resolve(response);
    });
    const element = await view();
    const root = receiptRoot(element);
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('[role="status"]')?.textContent).toContain('加载投递回执');
    expect(receiptRefresh(root).disabled).toBe(true);
    expect(root.textContent).not.toContain('暂无可查看的投递回执');

    await vi.advanceTimersByTimeAsync(15_000);
    expect(signal?.aborted).toBe(true);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('加载投递回执超时');
    expect(receiptRefresh(root).disabled).toBe(false);
    expect(root.textContent).not.toContain('暂无可查看的投递回执');

    receiptFetch.mockImplementation(async () => json([legacyReceipt]));
    receiptRefresh(root).click();
    await vi.advanceTimersByTimeAsync(0);
    resolveLate();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('tbody')?.textContent).toContain(legacyReceipt.id);
    expect(root.querySelector('tbody')?.textContent).not.toContain(lateRows[0].id);
    expect(receiptFetch).toHaveBeenCalledTimes(2);
    expect(readFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['disconnected', 'new session', 'expired session'])('cancels an outstanding read when %s', async (boundary) => {
    let signal: AbortSignal | null | undefined;
    let resolveLate!: (response: Response) => void;
    receiptFetch.mockImplementationOnce((_url, options: RequestInit) => {
      signal = options?.signal;
      return new Promise(resolve => { resolveLate = resolve; });
    });
    const element = await view();
    const root = receiptRoot(element);
    if (boundary === 'disconnected') element.remove();
    else if (boundary === 'expired session') notifySessionExpired();
    else {
      apiClient.setToken('replacement-session');
      window.dispatchEvent(new StorageEvent('storage', { key: 'token', storageArea: localStorage }));
      await vi.waitFor(() => expect(root.textContent).toContain('暂无可查看的投递回执'));
    }
    expect(signal?.aborted).toBe(true);
    resolveLate(json([legacyReceipt]));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelectorAll('tbody tr')).toHaveLength(0);
    if (boundary === 'expired session') expect(root.querySelector('[role="alert"]')?.textContent).toContain('登录已失效');
  });

  it('accepts a valid receipt after authFetch refreshes the same session', async () => {
    apiClient.setRefreshToken('current-refresh');
    const fetch = vi.fn(async (url: string, options: RequestInit) => {
      if (url === '/api/auth/refresh') return json({ token: 'rotated-session', refreshToken: 'rotated-refresh' });
      if (new Headers(options.headers).get('Authorization') === 'Bearer current-session') return json({}, 401);
      return json([{
        ...legacyReceipt, alert_id: 7, error_code: null,
        delivery: { business_key: 'notification:7:2', state: 'sent', error_code: null },
        attempts: [{ attempt_number: 1, status: 'sent', error_code: null }],
      }]);
    });
    vi.stubGlobal('fetch', fetch);
    receiptFetch.mockImplementation((url, options) => apiClient.fetchResponseWithAuth(url, options));
    const element = await view();
    const root = receiptRoot(element);
    await vi.waitFor(() => expect(root.querySelector('tbody')?.textContent).toContain('notification:7:2'));
    expect(root.querySelector('tbody')?.textContent).toContain('已确认发送');
    expect(apiClient.getToken()).toBe('rotated-session');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/notification/deliveries', '/api/auth/refresh', '/api/notification/deliveries',
    ]);
    expect(readFetch).toHaveBeenCalledTimes(1);
  });
});
