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

// MAX-413 / #427, #426, #653, #654
// These exercise the real Lit render and event handlers; HTTP is isolated.
describe('Cron creation, display and draft script testing', () => {
  beforeEach(() => {
    localStorage.clear(); localStorage.setItem('permissions', JSON.stringify(['cron:manage', 'cron:view']));
    authFetch.mockReset(); showToast.mockReset();
    authFetch.mockImplementation(async () => response([]));
  });
  afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
  it('keeps creation available on first empty list, cancellation, failure, success and deletion of the last job (#427)', async () => {
    const page = await mount();
    expect(page.shadowRoot!.querySelector('app-empty-state')).not.toBeNull();
    const create = () => page.shadowRoot!.querySelector<HTMLButtonElement>('.page-header button')!;
    expect(create().disabled).toBe(false); create().click(); await page.updateComplete;
    expect(page.shadowRoot!.querySelector('app-dialog')).not.toBeNull();
    page.closeFormDialog(); await page.updateComplete;
    expect(create().disabled).toBe(false);
    await page.openCreateDialog(); await Promise.resolve();
    page.formName = '首个任务'; page.formTaskDescription = '检查目标实例的数据库运行状态';
    authFetch.mockResolvedValueOnce(response({ error: '保存失败' }, 500));
    await page.saveTask(); await page.updateComplete;
    expect(page.showCreateDialog).toBe(true); expect(page.formError).toBe('保存失败');
    authFetch.mockImplementation(async (url, options) => url === '/api/cron/jobs' && !options ? response([job]) : response({}));
    await page.saveTask(); await vi.waitFor(() => expect(page.jobs).toHaveLength(1)); await page.updateComplete;
    expect(page.shadowRoot!.querySelectorAll('.table-row')).toHaveLength(1);
    authFetch.mockImplementation(async () => response([]));
    page.confirmDelete(job); await page.executeDelete(); await vi.waitFor(() => expect(page.jobs).toHaveLength(0)); await page.updateComplete;
    expect(create().disabled).toBe(false); create().click(); await page.updateComplete;
    expect(page.shadowRoot!.querySelector('app-dialog')).not.toBeNull();
  });
  it.each([401, 403, 500])('shows HTTP %i as a load error rather than an empty list', async status => {
    authFetch.mockResolvedValue(response({}, status)); const page = await mount();
    expect(page.shadowRoot!.textContent).toContain('加载定时任务失败');
    expect(page.shadowRoot!.querySelector('app-empty-state')).toBeNull();
  });
  it('keeps loading distinct from empty', async () => {
    authFetch.mockImplementation(() => new Promise(() => {}));
    const page = document.createElement('cron-jobs-settings') as Page; document.body.append(page); await page.updateComplete;
    expect(page.shadowRoot!.textContent).toContain('加载中'); expect(page.shadowRoot!.querySelector('app-empty-state')).toBeNull();
  });
  it('disables creation for unknown or denied permission and reacts to revocation', async () => {
    localStorage.removeItem('permissions'); const page = await mount();
    expect(page.shadowRoot!.querySelector<HTMLButtonElement>('.page-header button')!.disabled).toBe(true);
    localStorage.setItem('permissions', JSON.stringify(['cron:*'])); window.dispatchEvent(new Event('slide-permissions-loaded'));
    await page.updateComplete; await page.openCreateDialog(); expect(page.showCreateDialog).toBe(true);
    localStorage.setItem('permissions', JSON.stringify(['cron:view'])); window.dispatchEvent(new Event('slide-permissions-loaded'));
    await page.updateComplete; expect(page.showCreateDialog).toBe(false);
    authFetch.mockClear(); await page.saveTask(); expect(authFetch).not.toHaveBeenCalled();
  });
  it.each([
    [0, 'danger', '0%'], [0.3, 'danger', '30%'], [0.4999, 'danger', '50%'],
    [0.5, 'warn', '50%'], [0.7999, 'warn', '80%'], [0.8, 'ok', '80%'], [1, 'ok', '100%'],
    [undefined, '', '未知'], [null, '', '未知'], [NaN, '', '未知'], [Infinity, '', '未知'], [-0.1, '', '未知'], [1.1, '', '未知'], ['0.9', '', '未知'],
  ])('renders coverage %s with %s severity (#426)', async (coverage, severity, label) => {
    const page = await mount(); page.logViewerJob = job;
    page.viewerLogs = [{ id: 1, status: 'success', started_at: '2026-11-13T00:00:00Z', structured_result: { instances: {}, coverage_rate: coverage } }];
    await page.updateComplete;
    const stat = [...page.shadowRoot!.querySelectorAll('.sr-stat')].find(el => el.textContent!.includes('覆盖率'))!;
    expect(stat.querySelector('.sr-stat-value')!.textContent).toBe(label);
    expect(['ok', 'warn', 'danger'].filter(value => stat.classList.contains(value))).toEqual(severity ? [severity] : []);
  });
  it('uses the same Agent fallback for badges and filtering (#653)', async () => {
    const page = await mount(); page.jobs = [{ ...job }, { ...job, id: 2, task_type: null }, { ...job, id: 3, task_type: 'agent' }, { ...job, id: 4, task_type: 'script' }];
    page.filterMode = 'agent'; await page.updateComplete;
    expect(page.filteredJobs.map((j: any) => j.id)).toEqual([42, 2, 3]);
    expect(page.shadowRoot!.querySelectorAll('.table-row')).toHaveLength(3);
    page.filterMode = 'script'; expect(page.filteredJobs.map((j: any) => j.id)).toEqual([4]);
  });
  async function draft() {
    const page = await mount(); await page.openCreateDialog(); await Promise.resolve();
    page.formTaskType = 'script'; page.formTargetInstanceId = 9; page.formTargetDatabase = 'inspection'; page.scriptEditorContent = 'SELECT 1';
    authFetch.mockClear(); return page;
  }
  it.each([200, 403, 500])('tests an unsaved draft without creating a library script even with HTTP %i (#654)', async status => {
    const page = await draft(); authFetch.mockResolvedValue(response({ success: status === 200 }, status));
    await page.onTestExecute();
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(authFetch).toHaveBeenCalledWith('/api/cron/scripts/test', expect.objectContaining({ method: 'POST', body: JSON.stringify({ instance_id: 9, database: 'inspection', content: 'SELECT 1' }) }));
    expect(page.formScriptId).toBeNull(); page.closeFormDialog(); expect(authFetch).toHaveBeenCalledTimes(1);
  });
  it('updates a saved script and then tests that same ID', async () => {
    const page = await draft(); page.formScriptId = 77; authFetch.mockResolvedValue(response({ success: true }));
    await page.onTestExecute(); expect(authFetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([['/api/cron/scripts/77', 'PUT'], ['/api/cron/scripts/77/test', 'POST']]);
  });
  it('does not test a saved script when its update fails', async () => {
    const page = await draft(); page.formScriptId = 77; authFetch.mockResolvedValue(response({ error: '更新失败' }, 403));
    await page.onTestExecute(); expect(authFetch).toHaveBeenCalledTimes(1); expect(page.testResult).toContain('更新失败'); expect(page.testRunning).toBe(false);
  });
  it('prevents duplicate requests and ignores stale results after close/reopen', async () => {
    const page = await draft(); let finish!: (value: unknown) => void;
    authFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = page.onTestExecute(); await page.onTestExecute(); expect(authFetch).toHaveBeenCalledTimes(1);
    page.closeFormDialog(); await page.openCreateDialog();
    finish(response({ result: 'old' })); await pending;
    expect(page.testResult).toBeNull(); expect(page.formScriptId).toBeNull();
  });
  it('reports an uncertain network response without retrying or creating a script', async () => {
    const page = await draft(); authFetch.mockRejectedValueOnce(new Error('offline')); await page.onTestExecute();
    expect(page.testResult).toContain('offline'); expect(page.testRunning).toBe(false); expect(authFetch).toHaveBeenCalledTimes(1);
  });
});
