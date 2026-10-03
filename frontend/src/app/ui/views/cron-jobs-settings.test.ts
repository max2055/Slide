import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { authFetch, showToast } = vi.hoisted(() => ({ authFetch: vi.fn(), showToast: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast }));
import './cron-jobs-settings.js';
type Page = HTMLElement & Record<string, any>;
const job = { id: 42, name: '准确指标采集', cron_expr: '* * * * *', enabled: true, last_result: 'success' };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
async function mount(): Promise<Page> {
  const page = document.createElement('cron-jobs-settings') as Page;
  document.body.append(page);
  await vi.waitFor(() => expect(page.loading).toBe(false));
  await page.updateComplete;
  return page;
}
async function submit(page: Page, id = 42) {
  page.openTriggerDialog({ ...job, id });
  await page.confirmTrigger();
  await page.updateComplete;
}
describe('Cron exact run tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers(); localStorage.clear(); authFetch.mockReset(); showToast.mockReset();
    authFetch.mockImplementation(async (url: string) => {
      if (url === '/api/cron/jobs') return response([job]);
      if (url.endsWith('/run')) { const jobId = Number(url.split('/')[4]); return response({ jobId, runId: `run-${jobId}`, status: 'queued' }, 202); }
      const jobId = Number(url.split('/')[4]);
      return response({ jobId, runId: `run-${jobId}`, status: 'running' });
    });
  });
  afterEach(() => { document.body.replaceChildren(); vi.clearAllTimers(); vi.useRealTimers(); });
  it('keeps queued state despite historical success and polls the exact ID after dialog closure', async () => {
    const page = await mount(); await submit(page);
    expect(page.shadowRoot!.textContent).toContain('排队中');
    await vi.advanceTimersByTimeAsync(3000);
    expect(authFetch).toHaveBeenCalledWith('/api/cron/jobs/42/runs/run-42', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(authFetch.mock.calls.every(([url]) => !url.includes('/logs') && !url.includes('null'))).toBe(true);
  });
  it('keeps the submitted ID when the dialog closes while POST is pending', async () => {
    const page = await mount(); page.openTriggerDialog(job);
    let resolve!: (value: unknown) => void;
    authFetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = page.confirmTrigger(); page.closeTriggerDialog();
    resolve(response({ jobId: 42, runId: 'run-42', status: 'queued' }, 202)); await pending;
    await vi.advanceTimersByTimeAsync(3000);
    expect(authFetch).toHaveBeenCalledWith('/api/cron/jobs/42/runs/run-42', expect.anything());
  });
  it('tracks two runs independently and aborts every outstanding poll on unmount', async () => {
    const page = await mount(); await submit(page); await submit(page, 43);
    authFetch.mockImplementation(async (_url: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    await vi.advanceTimersByTimeAsync(3000);
    const signals = authFetch.mock.calls.filter(([url]) => url.includes('/runs/')).map(([, options]) => options.signal);
    expect(signals).toHaveLength(2); page.remove();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    const count = authFetch.mock.calls.length; await vi.advanceTimersByTimeAsync(6000);
    expect(authFetch).toHaveBeenCalledTimes(count);
  });
  it('shows connection loss as unconfirmed, resumes after refresh and never sends a new POST', async () => {
    const page = await mount(); await submit(page);
    authFetch.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(3000); await page.updateComplete;
    expect(page.shadowRoot!.textContent).toContain('状态待确认');
    page.remove(); const fresh = await mount();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fresh.runTracker.runs.get(42)).toMatchObject({ runId: 'run-42', status: 'running' });
    expect(authFetch.mock.calls.filter(([url]) => url.endsWith('/run'))).toHaveLength(1);
  });
  it('recovers a dropped POST response with a read-only request lookup', async () => {
    const page = await mount(); authFetch.mockRejectedValueOnce(new Error('offline'));
    await submit(page);
    const key = page.runTracker.runs.get(42).requestKey;
    authFetch.mockImplementation(async (url: string) => url === '/api/cron/jobs' ? response([job]) : response({ jobId: 42, runId: 'original', status: 'failed', completion: { summary: 'failure evidence' } }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(authFetch).toHaveBeenCalledWith(`/api/cron/jobs/42/runs?requestKey=${key}`, expect.anything());
    expect(page.runTracker.runs.get(42)).toMatchObject({ runId: 'original', status: 'failed', summary: 'failure evidence' });
  });
  it('allows explicit retry using the same key after uncertain submission', async () => {
    const page = await mount(); authFetch.mockRejectedValueOnce(new Error('offline')); await submit(page);
    await submit(page);
    const posts = authFetch.mock.calls.filter(([url]) => url.endsWith('/run'));
    expect(posts[0][1].headers).toEqual(posts[1][1].headers);
  });
  it('keeps a permission-denied trigger retryable without polling', async () => {
    const page = await mount(); authFetch.mockResolvedValueOnce(response({ error: '无执行权限' }, 403)); await submit(page);
    expect(page.triggerError).toBe('无执行权限');
    await vi.advanceTimersByTimeAsync(3000);
    expect(authFetch.mock.calls.some(([url]) => url.includes('/runs'))).toBe(false);
    await submit(page); expect(showToast).toHaveBeenCalledWith('已触发执行');
  });
  it('marks historical success as legacy runner semantics without inventing business completion', async () => {
    const page = await mount();
    authFetch.mockResolvedValueOnce(response({ logs: [{ id: 1, job_id: 42, run_id: null, status: 'success', started_at: '2026-10-03T00:00:00Z', finished_at: '2026-10-03T00:01:00Z' }] }));
    await page.openLogViewer(job); await page.updateComplete;
    expect(page.shadowRoot!.textContent).toContain('旧成功（仅 runner 结束）');
  });
  it('does not trigger without a selected job', async () => {
    const page = await mount(); authFetch.mockClear(); await page.confirmTrigger();
    expect(authFetch).not.toHaveBeenCalled();
  });
});
