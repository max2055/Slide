import { beforeEach, describe, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import { ApprovalDashboard, approvalDecision, approvalExecution } from './approval-dashboard.ts';
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body });
const row = (id: number, status = 'approved', execution_result: unknown = null) => ({ id, kind: 'sql', instance_id: 7, sql_text: `SELECT ${id}`, risk_level: 'high', status, execution_result, created_at: '2026-10-15T00:00:00Z' });
const flush = async (subject: ApprovalDashboard) => { await new Promise(resolve => setTimeout(resolve, 0)); await subject.updateComplete; };
beforeEach(() => { document.body.replaceChildren(); sessionStorage.clear(); authFetch.mockReset(); });
async function history(items: unknown[]) {
  authFetch.mockResolvedValue(response({ items }));
  const subject = document.createElement('approval-dashboard') as ApprovalDashboard;
  document.body.append(subject); await flush(subject);
  (subject as any).switchFilter('processed'); await flush(subject); return subject;
}
describe('MAX-177 result evidence', () => {
  it.each([
    ['approved', null, 'none'], ['rejected', null, 'none'], ['execution_failed', null, 'failed'],
    ['approved', '{"success":false,"error":"timeout"}', 'failed'], ['approved', '{}', 'unknown'],
    ['approved', 'malformed-json', 'unknown'], ['executed', null, 'success'],
    ['rejected', { success: true }, 'conflict'], ['executed', { success: false }, 'conflict'],
    ['approved', { success: true, error: 'ambiguous' }, 'conflict'], ['future', null, 'unknown'],
  ])('%s with %j displays %s', (status, execution_result, expected) => {
    expect(approvalExecution({ status, execution_result })).toBe(expected);
  });
  it('does not turn Agent consumption into an execution receipt', () => {
    expect(approvalDecision('consumed')).toBe('approved');
    expect(approvalExecution({ status: 'consumed' }, true)).toBe('unknown');
  });
  it('filters decisions and execution independently, resets pages, preserves refresh and bounded context', async () => {
    const subject = await history([...Array.from({ length: 8 }, (_, i) => row(i + 1)), row(9, 'execution_failed', { error: 'LONG_ERROR'.repeat(1000) }), row(10, 'rejected')]);
    expect(subject.shadowRoot!.querySelectorAll('tbody tr')).toHaveLength(6);
    (subject as any).historyPage = 1; await flush(subject);
    await (subject as any).loadRequests(); await flush(subject);
    expect((subject as any).historyPage).toBe(1);
    (subject as any).changeHistoryFilter('decisionFilter', 'approved');
    (subject as any).changeHistoryFilter('executionFilter', 'failed'); await flush(subject);
    expect((subject as any).historyPage).toBe(0);
    expect(subject.shadowRoot!.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(subject.shadowRoot!.querySelector('tbody')!.textContent).toContain('执行失败');
    expect(subject.shadowRoot!.querySelector('tbody')!.textContent).not.toContain('LONG_ERROR');
    expect(subject.shadowRoot!.textContent).toContain('不代表全部历史');
    subject.remove(); const restored = document.createElement('approval-dashboard') as ApprovalDashboard;
    document.body.append(restored); await flush(restored);
    expect((restored as any).executionFilter).toBe('failed'); expect((restored as any).filter).toBe('processed');
  });
  it('retains complete SQL/analysis/error originals in the evidence dialog and exposes partial events', async () => {
    const source = { ...row(1, 'execution_failed', 'raw-error'.repeat(1000)), sql_text: 'SELECT 1;\n'.repeat(1000), ai_recommendation: '{"reasoning":"full-reason"}' };
    const subject = await history([source]);
    authFetch.mockImplementation(async (url: string) => url.endsWith('/events') ? response({}, 403) : response(source));
    (subject as any).openDetail(source); await flush(subject);
    const dialog = subject.shadowRoot!.querySelector('app-dialog')!;
    expect(dialog.textContent).toContain(source.sql_text); expect(dialog.textContent).toContain(source.execution_result);
    expect(dialog.textContent).toContain(source.ai_recommendation); expect(dialog.textContent).toContain('证据不完整');
  });
  it('rejects a stale list response after switching tabs', async () => {
    let release!: (value: unknown) => void;
    authFetch.mockReturnValueOnce(new Promise(resolve => { release = resolve; })).mockResolvedValue(response({ items: [row(2)] }));
    const subject = document.createElement('approval-dashboard') as ApprovalDashboard; document.body.append(subject);
    (subject as any).switchFilter('processed'); await flush(subject);
    release(response({ items: [row(1, 'pending')] })); await flush(subject);
    expect((subject as any).requests.map((item: any) => item.id)).toEqual([2]);
  });
  it('keeps a failed batch dialog and feedback when HTTP 200 contains per-item failures', async () => {
    const subject = await history([]); (subject as any)._openBatchDialog([1], 'approve');
    authFetch.mockResolvedValue(response([{ id: 1, success: false, error: '权限已撤回' }]));
    await (subject as any)._confirmBatch(); await flush(subject);
    expect((subject as any).batchDialogOpen).toBe(true); expect((subject as any).batchError).toContain('权限已撤回');
    expect(JSON.parse(authFetch.mock.calls.at(-1)![1].body)).toMatchObject({ ids: [1], action: 'approve', execute_ids: [1] });
  });
  it('shows permission failure without presenting it as an empty history', async () => {
    const subject = await history([]); authFetch.mockResolvedValue(response({}, 403));
    await (subject as any).loadRequests(); await flush(subject);
    expect(subject.shadowRoot!.querySelector('[role="alert"]')!.textContent).toContain('权限');
    expect(subject.shadowRoot!.querySelector('app-data-table')).toBeNull();
  });
});
