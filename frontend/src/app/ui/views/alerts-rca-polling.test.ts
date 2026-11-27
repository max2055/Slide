import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.ts';
import { AlertsPage } from './alerts.ts';
vi.mock('../../../api/index.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../api/index.ts')>(), authFetch: vi.fn(),
}));
vi.mock('../components/app-toast-container.js', () => ({ showToast: vi.fn() }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let el: any;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.mocked(authFetch).mockResolvedValue(json([]));
  el = new AlertsPage(); document.body.append(el);
  await el.updateComplete; await vi.advanceTimersByTimeAsync(0);
  vi.mocked(authFetch).mockClear();
  el.activeRCAAnalysis = { alertId: 1, analysisId: 11 };
  el.diagnosisStatus = 'running';
});
afterEach(() => { el.remove(); vi.useRealTimers(); vi.resetAllMocks(); });
it.each([503, 'running'])('#425: HTTP %s and ongoing execution stop observation after 60s without declaring failure', async status => {
  vi.mocked(authFetch).mockImplementation(async () => status === 503 ? json({}, 503) : json({ status }));
  el._startDiagnosisPolling(11);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(el.diagnosisStatus).toBe('unknown');
  expect(el.diagnosisError).toContain('状态未知');
  const calls = vi.mocked(authFetch).mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000); expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(calls);
});
it('#425: a hanging read does not overlap, aborts at deadline and ignores late completion', async () => {
  let resolve!: (r: Response) => void; let signal: AbortSignal | undefined | null;
  vi.mocked(authFetch).mockImplementation((_url, opts) => { signal = opts?.signal; return new Promise(r => resolve = r); });
  el._startDiagnosisPolling(11); await vi.advanceTimersByTimeAsync(59_000);
  expect(authFetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_001); expect(signal?.aborted).toBe(true);
  resolve(json({ status: 'failed' })); await vi.advanceTimersByTimeAsync(0);
  expect(el.diagnosisStatus).toBe('unknown');
});
it.each(['switch', 'unmount'])('#425: %s invalidates a late full-result response', async action => {
  let resolve!: (r: Response) => void;
  vi.mocked(authFetch).mockImplementation(async url => url.endsWith('/status') ? json({ status: 'completed' }) : new Promise(r => resolve = r));
  el._startDiagnosisPolling(11); await vi.advanceTimersByTimeAsync(3000);
  if (action === 'unmount') el.remove();
  else { el.activeRCAAnalysis = { alertId: 2, analysisId: 22 }; el._startDiagnosisPolling(22); }
  resolve(json({ result: 'old' })); await vi.advanceTimersByTimeAsync(0);
  expect(el.diagnosisResult).not.toBe('old'); expect(el.analyzedStatuses.has(2)).toBe(false);
});
it('#425: unknown backend status is recoverable using GET only', async () => {
  vi.mocked(authFetch).mockImplementation(async () => json({ status: 'unknown' }));
  el._startDiagnosisPolling(11); await vi.advanceTimersByTimeAsync(3000); await el.updateComplete;
  expect(el.diagnosisStatus).toBe('unknown');
  const button = [...el.shadowRoot.querySelectorAll('button')].find((b: any) => b.textContent.includes('继续观察')) as HTMLButtonElement;
  expect(button).toBeTruthy(); button.click();
  vi.mocked(authFetch).mockImplementation(async url => url.endsWith('/status') ? json({ status: 'completed' }) : json({ result: { summary: 'recovered' } }));
  await vi.advanceTimersByTimeAsync(3000);
  expect(el.diagnosisStatus).toBe('completed');
  expect(vi.mocked(authFetch).mock.calls.every(([,opts]) => !opts?.method || opts.method === 'GET')).toBe(true);
});

it.each(['network', 'invalid-json', 'result-http'])('#425: %s read failure stays bounded and recoverable', async fault => {
  vi.mocked(authFetch).mockImplementation(async url => {
    if (fault === 'network') throw new TypeError('offline');
    if (fault === 'invalid-json') return new Response('broken-json');
    return url.endsWith('/status') ? json({ status: 'completed' }) : json({}, 503);
  });
  el._startDiagnosisPolling(11); await vi.advanceTimersByTimeAsync(60_001);
  expect(el.diagnosisStatus).toBe('unknown');
  expect(el.diagnosisResult).toBeNull();
});
it('#425: authoritative backend failure remains failure and stops reads', async () => {
  vi.mocked(authFetch).mockImplementation(async () => json({ status: 'failed', error_message: 'backend failure' }));
  el._startDiagnosisPolling(11); await vi.advanceTimersByTimeAsync(3000);
  expect(el.diagnosisStatus).toBe('failed'); expect(el.diagnosisError).toBe('backend failure');
  const calls = vi.mocked(authFetch).mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000); expect(authFetch).toHaveBeenCalledTimes(calls);
});
it('#425: a late POST handoff cannot replace a newly started alert', async () => {
  let resolve!: (r: Response) => void;
  vi.mocked(authFetch).mockImplementation(async url => url.includes('/1/investigation')
    ? new Promise(r => resolve = r) : json({ id: 22 }));
  const old = el._startRCA({ id: 1 });
  await el._startRCA({ id: 2 }); resolve(json({ id: 11 })); await old;
  expect(el.activeRCAAnalysis).toMatchObject({ alertId: 2, analysisId: 22 });
});
it('#425: detail modal shows unknown and its resume cannot resubmit analysis', async () => {
  el.alerts = [{ id: 1, title: 'test alert', alert_type: 'performance', message: 'test', status: 'unread', severity: 'warning', created_at: new Date().toISOString() }];
  el.detailAlert = el.alerts[0]; el.diagnosisStatus = 'unknown'; el.diagnosisError = '状态未知';
  await el.updateComplete;
  const modal = el.shadowRoot.querySelector('alert-detail-modal') as any; await modal.updateComplete;
  expect(modal.shadowRoot.textContent).toContain('状态未知');
  const button = [...modal.shadowRoot.querySelectorAll('button')].find((b: any) => b.textContent === '继续观察') as HTMLButtonElement;
  button.click(); await vi.advanceTimersByTimeAsync(3000);
  expect(vi.mocked(authFetch).mock.calls.every(([, opts]) => opts?.method !== 'POST')).toBe(true);
});
