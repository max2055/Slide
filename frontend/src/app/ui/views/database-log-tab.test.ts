import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../api/index.js', () => ({ authFetch: fetchMock }));
import './database-log-tab.js';
import '../components/alert-detail-modal.js';

// Exercise actual component handlers with controlled timers and transport, including late bodies.
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
let view: any;
beforeEach(async () => {
  vi.useFakeTimers(); fetchMock.mockReset();
  fetchMock.mockResolvedValue(response({ status: 'running' }));
  view = document.createElement('database-log-tab');
  // Connect without an instance to avoid unrelated list/stat requests.
  document.body.append(view); await view.updateComplete;
  view.instanceId = 1; await view.updateComplete; await Promise.resolve();
  fetchMock.mockClear();
  view.analysisId = 42; view.analysisLoading = true;
});
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

describe('MAX-431 observation', () => {
  it('waits for a slow response before scheduling another request', async () => {
    const slow = deferred<Response>(); fetchMock.mockReturnValueOnce(slow.promise);
    view._startPolling(42);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    slow.resolve(response({ status: 'running' })); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2999); expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('backs off HTTP, network and invalid-body errors, then resets after success', async () => {
    fetchMock.mockResolvedValueOnce(response({}, 503)).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response({ status: 'unrecognized' })).mockResolvedValue(response({ status: 'running' }));
    view._startPolling(42);
    await vi.advanceTimersByTimeAsync(3000); expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5999); expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(12000); expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(24000); expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(3000); expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each(['running', 'pending', 'http-error', 'hung'])('stops after five minutes for %s without failing or resubmitting', async status => {
    const late = deferred<Response>();
    fetchMock.mockImplementation(() => status === 'hung' ? late.promise : Promise.resolve(response({ status }, status === 'http-error' ? 503 : 200)));
    view._startPolling(42); await vi.advanceTimersByTimeAsync(300_000); await view.updateComplete;
    expect(view.shadowRoot.textContent).toContain('状态未知');
    expect(view.shadowRoot.textContent).toContain('继续查询');
    expect(view.analysisStatus).not.toBe('failed');
    const count = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000); expect(fetchMock).toHaveBeenCalledTimes(count);
    expect(fetchMock.mock.calls.every(([, options]) => !options.method)).toBe(true);
    if (status === 'hung') expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    late.resolve(response({ status: 'completed', result: { summary: 'late' } }));
    await vi.advanceTimersByTimeAsync(0); expect(view.analysisResult).toBeNull();
    fetchMock.mockResolvedValue(response({ status: 'completed', result: { summary: 'recovered' } }));
    [...view.shadowRoot.querySelectorAll('button')].find((b: any) => b.textContent.trim() === '继续查询').click();
    await vi.advanceTimersByTimeAsync(3000); await view.updateComplete;
    expect(view.analysisResult.summary).toBe('recovered');
    expect(fetchMock.mock.calls.at(-1)[0]).toBe('/api/logs/analysis/42');
  });

  it.each(['completed', 'failed'])('stops on terminal status %s', async status => {
    fetchMock.mockResolvedValue(response({ status, result: { summary: 'done' }, error_message: '失败原因' }));
    view._startPolling(42); await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(view.analysisLoading).toBe(false);
    expect(view.analysisStatus).toBe(status);
  });

  it('caps repeated errors at 30 seconds and handles invalid JSON', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('invalid JSON')) });
    view._startPolling(42);
    for (const delay of [3000, 6000, 12000, 24000, 30000]) await vi.advanceTimersByTimeAsync(delay);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(29999); expect(fetchMock).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1); expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(view.observationMessage).toContain('30 秒后重试');
  });

  it('keeps a server unknown status recoverable without inventing completion or failure', async () => {
    fetchMock.mockResolvedValue(response({ status: 'unknown' })); view._startPolling(42);
    await vi.advanceTimersByTimeAsync(300_000); await view.updateComplete;
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(view.analysisStatus).toBe('pending');
    expect(view.shadowRoot.textContent).toContain('任务状态未知');
    expect(view.analysisResult).toBeNull();
  });

  it.each(['switch', 'disconnect', 'close', 'permissions', 'restart'])('ignores late JSON after %s', async action => {
    const body = deferred<unknown>(); const json = vi.fn(() => body.promise);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json });
    view._startPolling(42); await vi.advanceTimersByTimeAsync(3000); expect(json).toHaveBeenCalled();
    if (action === 'switch') { view.instanceId = 2; await view.updateComplete; }
    if (action === 'disconnect') view.remove();
    if (action === 'close') view._closeAnalysisResult();
    if (action === 'permissions') window.dispatchEvent(new Event('slide-permissions-loaded'));
    if (action === 'restart') view._startPolling(42);
    body.resolve({ status: 'completed', result: { summary: 'obsolete' } });
    await vi.advanceTimersByTimeAsync(0); expect(view.analysisResult).toBeNull();
    view._stopPolling();
  });

  it.each([401, 403])('invalidates context on HTTP %s', async status => {
    fetchMock.mockResolvedValue(response({}, status)); view._startPolling(42);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(view.accessInvalidated).toBe(true);
    expect(view.analysisId).toBeNull();
  });
});

it('MAX-444 renders all result branches as literal text without entity artifacts or HTML nodes', () => {
  const text = `<img src=x onerror="window.pwned=1"> a < b > c & "quote" 'single'`;
  view.analysisStatus = 'completed';
  view.analysisResult = { summary: text, [text]: [text, { [text]: text }, null, 7], object: { [text]: text }, scalar: text };
  const host = document.createElement('div'); render(view._renderAnalysisSection(), host);
  expect(host.textContent).toContain(text);
  expect(host.querySelector('p')!.textContent).toBe(text);
  expect(host.querySelector('strong')!.textContent).toBe('摘要');
  expect(host.querySelector('ul')!.textContent).toContain(`${text}: ${text}`);
  expect(host.querySelector('pre')!.textContent).toBe(JSON.stringify({ [text]: text }, null, 2));
  expect(host.textContent).not.toContain('&lt;'); expect(host.querySelector('img,script')).toBeNull();
});

it.each([['pending', '等待中'], ['running', '进行中'], ['completed', '已完成'], ['failed', '失败'], ['unknown', '状态未知'], ['future-state', '状态未知']])('MAX-449 translates history %s', (status, label) => {
  const modal: any = document.createElement('alert-detail-modal');
  modal.open = true; modal.alert = { id: 1, title: '测试告警', alert_type: 'cpu', severity: 'info', status: 'unread', created_at: '2026-11-13T00:00:00Z' };
  modal.analysisHistory = [{ status, created_at: '2026-11-13T00:00:00Z' }];
  const host = document.createElement('div'); render(modal.render(), host);
  expect(host.textContent).toContain(label); expect(host.textContent).not.toContain(status);
  if (status === 'completed' || status === 'failed') {
    const span = [...host.querySelectorAll('span')].find(el => el.textContent === label)!;
    expect(span.getAttribute('style')).toContain(status === 'completed' ? 'var(--ok)' : 'var(--danger)');
  }
});
