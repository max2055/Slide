import { beforeEach, describe, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import { ApprovalDashboard, approvalDecision, approvalExecution } from './approval-dashboard.ts';
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body });
const row = (id: number, status = 'approved', execution_result: unknown = null) => ({ id, kind: 'sql', instance_id: 7, sql_text: `SELECT ${id}`, risk_level: 'high', status, execution_result, created_at: '2026-10-15T00:00:00Z' });
const reconciliation = { success: false, executionState: 'unknown', retryable: false,
  error: 'SQL_OUTCOME_REQUIRES_RECONCILIATION: SQL may have committed; do not retry; inspect durable intent and target database' };
const flush = async (subject: ApprovalDashboard) => { await new Promise(resolve => setTimeout(resolve, 0)); await subject.updateComplete; };
beforeEach(() => { document.body.replaceChildren(); sessionStorage.clear(); authFetch.mockReset(); });
async function history(items: unknown[]) {
  authFetch.mockResolvedValue(response({ items }));
  const subject = document.createElement('approval-dashboard') as ApprovalDashboard;
  document.body.append(subject); await flush(subject);
  (subject as any).switchFilter('processed'); await flush(subject); return subject;
}
describe('MAX-177 result evidence', () => {
  it.each([reconciliation, JSON.stringify(reconciliation)])('preserves formal unknown receipt %j through filtering and complete evidence', async (receipt) => {
    const source = row(1, 'executing', receipt);
    expect(approvalExecution(source)).toBe('unknown');
    const subject = await history([source, row(2, 'execution_failed', { success: false, error: 'definite failure' }), row(3), row(4, 'executed', { success: true })]);
    (subject as any).changeHistoryFilter('executionFilter', 'failed'); await flush(subject);
    expect(subject.shadowRoot!.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(subject.shadowRoot!.querySelector('tbody')!.textContent).toContain('SELECT 2');
    (subject as any).changeHistoryFilter('executionFilter', 'unknown'); await flush(subject);
    expect(subject.shadowRoot!.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(subject.shadowRoot!.querySelector('tbody')!.textContent).toContain('结果未知');
    authFetch.mockImplementation(async (url: string) => response(url.endsWith('/events') ? [] : source));
    (subject as any).openDetail(source); await flush(subject);
    const dialog = subject.shadowRoot!.querySelector('app-dialog')!;
    expect(dialog.querySelector('.evidence-meta')!.textContent).toContain('结果未知');
    expect(dialog.textContent).toContain('SQL 可能已提交');
    expect(dialog.textContent).toContain('请勿重试');
    expect(dialog.textContent).toContain('对账');
    expect(dialog.textContent).toContain(reconciliation.error);
    expect(dialog.textContent).toContain('"retryable":' + (typeof receipt === 'string' ? 'false' : ' false'));
    expect(dialog.textContent).not.toContain('执行失败');
    expect([...dialog.querySelectorAll('button')].some(button => button.textContent?.includes('重试'))).toBe(false);
  });
  it.each(['executed', 'execution_failed', 'rejected'])('retains conflict for unknown evidence versus terminal %s', (status) => {
    expect(approvalExecution({ status, execution_result: reconciliation })).toBe('conflict');
  });
  it.each([
    ['approved', null, 'unconfirmed'], ['rejected', 'null', 'none'], ['execution_failed', null, 'unconfirmed'],
    ['approved', '{"success":false,"error":"timeout"}', 'failed'], ['approved', '{}', 'unconfirmed'],
    ['approved', 'malformed-json', 'unconfirmed'], ['executed', null, 'unconfirmed'],
    ['execution_failed', { success: false, executionState: 'not_started' }, 'none'],
    ['rejected', { success: true }, 'conflict'], ['executed', { success: false }, 'conflict'],
    ['approved', { success: true, error: 'ambiguous' }, 'conflict'], ['future', null, 'unconfirmed'],
  ])('%s with %j displays %s', (status, execution_result, expected) => {
    expect(approvalExecution({ status, execution_result })).toBe(expected);
  });
  it('does not turn Agent consumption into an execution receipt', () => {
    expect(approvalDecision('consumed')).toBe('approved');
    expect(approvalExecution({ status: 'consumed' }, true)).toBe('unconfirmed');
    expect(approvalExecution({ status: 'expired', used_count: 1 }, true)).toBe('unconfirmed');
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
    const filters = restored.shadowRoot!.querySelectorAll<HTMLSelectElement>('.history-toolbar select');
    expect([...filters].map(filter => filter.value)).toEqual(['approved', 'failed']);
    expect(restored.shadowRoot!.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(restored.shadowRoot!.querySelector('tbody')!.textContent).toContain('执行失败');
  });
  it('retains complete SQL/analysis/error originals in the evidence dialog and exposes partial events', async () => {
    const source = { ...row(1, 'execution_failed', 'raw-error'.repeat(1000)), sql_text: 'SELECT 1;\n'.repeat(1000), ai_recommendation: '{"reasoning":"full-reason"}' };
    const subject = await history([source]);
    authFetch.mockImplementation(async (url: string) => url.endsWith('/events') ? response({}, 503) : response(source));
    (subject as any).openDetail(source); await flush(subject);
    const dialog = subject.shadowRoot!.querySelector('app-dialog')!;
    expect(dialog.textContent).toContain(source.sql_text); expect(dialog.textContent).toContain(source.execution_result);
    expect(dialog.textContent).toContain(source.ai_recommendation); expect(dialog.textContent).toContain('证据不完整');
  });
  it.each([
    ['rejected', null, '未执行'],
    ['approved', null, '结果待确认'],
    ['executed', { success: true, rowCount: 0, duration_ms: 24 }, '执行成功'],
  ])('summarizes %s readably and preserves the raw receipt', async (status, receipt, label) => {
    const source = {
      ...row(1, status, receipt),
      review_notes: null,
      ai_recommendation: JSON.stringify({ reasoning: '按审批时的规则核对目标库。', recommendation: 'reject' }),
    };
    const subject = await history([source]);
    authFetch.mockImplementation(async (url: string) => response(url.endsWith('/events') ? [] : source));
    (subject as any).openDetail(source);
    await flush(subject);
    const dialog = subject.shadowRoot!.querySelector('app-dialog')!;
    const facts = dialog.querySelector('.evidence-facts')!;
    expect(dialog.querySelector('.evidence-meta')!.textContent).toContain(label);
    expect(facts.textContent).toContain('未填写');
    expect(facts.textContent).toContain('按审批时的规则核对目标库。');
    expect(facts.textContent).not.toContain('null');
    if (receipt) expect(facts.textContent).toContain('影响 0 行 · 耗时 24 ms');
    const raw = dialog.querySelector('details')!;
    expect(raw.open).toBe(false);
    expect(raw.textContent).toContain('"execution_result": ' + (receipt ? '{' : 'null'));
    expect(raw.textContent).toContain(source.ai_recommendation);
  });
  it.each([
    ['matching', [{ request_id: 1, created_by: 2 }], '未执行'],
    ['another request', [{ request_id: 3, created_by: 2 }], '结果待确认'],
    ['another reviewer', [{ request_id: 1, created_by: 3 }], '结果待确认'],
    ['contradictory execution', [{ request_id: 1, created_by: 2 }, { request_id: 1, event_type: 'executed' }], '结果待确认'],
  ])('uses only consistent approved-only detail evidence (%s)', async (_case, events, label) => {
    const source = { ...row(1), reviewed_by: 2 };
    const subject = await history([source]);
    authFetch.mockImplementation(async (url: string) => response(url.endsWith('/events')
      ? events.map(event => ({ event_type: 'approved', event_data: { execute_after_approve: false }, ...event }))
      : source));
    subject.shadowRoot!.querySelector<HTMLButtonElement>('.history-detail')!.click();
    await flush(subject);
    expect(subject.shadowRoot!.querySelector('.evidence-meta')!.textContent).toContain(label);
    expect(subject.shadowRoot!.querySelector('tbody')!.textContent).toContain('结果待确认');
  });
  it.each(['/api/approval/1', '/api/approval/1/events'])('clears old approvals as soon as %s is denied and rereads on retry', async (deniedPath) => {
    const source = row(1);
    const subject = await history([source]);
    let releaseList!: (value: unknown) => void;
    let releaseDetail!: (value: unknown) => void;
    const lateList = new Promise(resolve => { releaseList = resolve; });
    const lateDetail = new Promise(resolve => { releaseDetail = resolve; });
    authFetch.mockImplementation((url: string) => {
      if (url === deniedPath) return Promise.resolve(response({}, 403));
      return url.includes('/unified') ? lateList : lateDetail;
    });
    void (subject as any).loadRequests();
    subject.shadowRoot!.querySelector<HTMLButtonElement>('.history-detail')!.click();
    await flush(subject);
    expect(subject.shadowRoot!.querySelector('[role="alert"]')!.textContent).toContain('无权查看审批');
    expect(subject.shadowRoot!.querySelector('app-data-table, app-dialog')).toBeNull();
    releaseList(response({ items: [source] }));
    releaseDetail(response(deniedPath.endsWith('/events') ? source : []));
    await flush(subject);
    expect(subject.shadowRoot!.querySelector('app-data-table, app-dialog')).toBeNull();
    authFetch.mockResolvedValue(response({ items: [row(2)] }));
    subject.shadowRoot!.querySelector<HTMLButtonElement>('[data-read-retry]')!.click();
    await flush(subject);
    expect(authFetch.mock.calls.at(-1)?.[0]).toBe('/api/approval/unified?status=processed');
    expect(subject.shadowRoot!.querySelector('tbody')!.textContent).toContain('SELECT 2');
    expect(subject.shadowRoot!.textContent).not.toContain('SELECT 1');
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
    authFetch.mockResolvedValueOnce(response([{ id: 1, success: false, error: '权限已撤回' }]))
      .mockResolvedValueOnce(response({ items: [] }));
    await (subject as any)._confirmBatch(); await flush(subject);
    expect(subject.shadowRoot!.querySelector('app-dialog [role="status"]')?.textContent).toContain('#1 · 未完成 · 权限已撤回');
    const submission = authFetch.mock.calls.find(([url]) => url === '/api/approval/batch-review');
    expect(JSON.parse(submission![1].body)).toMatchObject({ ids: [1], action: 'approve', execute_ids: [1] });
  });
  it.each(['permissions', 'history', 'disconnected'])('ignores a late batch response after %s invalidates its view', async reason => {
    const subject = await history([]);
    (subject as any).switchFilter('pending'); await flush(subject);
    const draw = subject as any;
    draw._openBatchDialog([17], 'approve');
    let settle!: (value: unknown) => void;
    const batchBody = new Promise(resolve => { settle = resolve; });
    const readBody = vi.fn(() => batchBody);
    authFetch.mockResolvedValueOnce({ ok: true, status: 200, json: readBody });
    const pending = draw._confirmBatch();
    await vi.waitFor(() => expect(readBody).toHaveBeenCalledOnce());
    if (reason === 'permissions') window.dispatchEvent(new Event('slide-permissions-loaded'));
    else if (reason === 'history') draw.switchFilter('processed');
    else subject.remove();
    const lastRead = authFetch.mock.calls.length;
    settle([{ id: 17, success: true }]);
    await pending;
    if (reason !== 'disconnected') await flush(subject);
    expect(draw.batchDialogOpen).toBe(false);
    expect(draw.batchLoading).toBe(false);
    expect(authFetch.mock.calls).toHaveLength(lastRead);
    if (reason === 'permissions') expect(subject.shadowRoot?.textContent).toContain('权限已变更');
  });
  it.each(['malformed JSON', 'missing item', 'transport failure', 'server failure'])('does not submit again after %s leaves the batch outcome unknown', async failure => {
    const subject = await history([]);
    const draw = subject as any;
    draw.switchFilter('pending'); await flush(subject);
    draw._openBatchDialog([17, 18], 'approve');
    if (failure === 'malformed JSON') authFetch.mockResolvedValueOnce({ ...response({}), json: async () => { throw new SyntaxError('bad body'); } });
    else if (failure === 'missing item') authFetch.mockResolvedValueOnce(response([{ id: 17, success: true }]));
    else if (failure === 'server failure') authFetch.mockResolvedValueOnce(response({ error: 'unavailable' }, 503));
    else authFetch.mockRejectedValueOnce(new TypeError('disconnected'));
    await draw._confirmBatch(); await flush(subject);
    expect(subject.shadowRoot?.querySelector('app-dialog [role="alert"]')?.textContent).toContain('结果待确认');
    expect(subject.shadowRoot?.querySelector('app-dialog .btn-success')).toBeNull();
    await draw._confirmBatch();
    expect(authFetch.mock.calls.filter(([url]) => url === '/api/approval/batch-review')).toHaveLength(1);
    subject.shadowRoot?.querySelector<HTMLButtonElement>('app-dialog button[slot="footer"]')!.click();
    await flush(subject);
    expect(subject.shadowRoot?.querySelector('app-dialog')).toBeNull();
    expect(authFetch.mock.lastCall?.[0]).toBe('/api/approval/unified?status=pending');
  });
  it('allows a manual retry after a definite HTTP rejection without changing success handling', async () => {
    const subject = await history([]);
    const draw = subject as any;
    draw._openBatchDialog([17], 'approve');
    authFetch.mockResolvedValueOnce(response({ error: '请求未受理' }, 400))
      .mockResolvedValueOnce(response([{ id: 17, success: true }]));
    await draw._confirmBatch(); await flush(subject);
    expect(subject.shadowRoot?.querySelector('app-dialog [role="alert"]')?.textContent).toContain('请求未受理');
    expect(subject.shadowRoot?.querySelector('app-dialog .btn-success')).not.toBeNull();
    await draw._confirmBatch(); await flush(subject);
    expect(subject.shadowRoot?.querySelector('app-dialog')).toBeNull();
    expect(authFetch.mock.calls.filter(([url]) => url === '/api/approval/batch-review')).toHaveLength(2);
  });
  it('shows permission failure without presenting it as an empty history', async () => {
    const subject = await history([]); authFetch.mockResolvedValue(response({}, 403));
    await (subject as any).loadRequests(); await flush(subject);
    expect(subject.shadowRoot!.querySelector('[role="alert"]')!.textContent).toContain('权限');
    expect(subject.shadowRoot!.querySelector('app-data-table')).toBeNull();
  });
  it('rereads the child approval from the original audit after a retry loses its acknowledgement', async () => {
    const source = { ...row(1, 'execution_failed', { success: false, executionState: 'rolled_back' }), operation_id: 'op-original' };
    const subject = await history([source]);
    const draw = subject as any;
    let committed = false;
    authFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') { committed = true; return response({}, 503); }
      if (url === '/api/operations/op-original/events') {
        return response({ events: committed ? [{ reasonCode: 'RETRY_CREATED', metadata: { retryApprovalId: 21, retryAttempt: 2 } }] : [] });
      }
      if (url === '/api/operations/op-original') return response({ state: 'failed' });
      return response(url.endsWith('/events') ? [] : source);
    });
    draw.openDetail(source);
    await flush(subject);
    await draw._retryOperation();
    await flush(subject);
    let dialog = subject.shadowRoot!.querySelector('app-dialog')!;
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('回执待确认');
    expect(dialog.querySelector('.actions button')).toBeNull();
    await draw._retryOperation();
    await draw._loadDetail(1);
    await flush(subject);
    dialog = subject.shadowRoot!.querySelector('app-dialog')!;
    expect(dialog.querySelector('[role="status"]')?.textContent).toContain('#21');
    expect(authFetch.mock.calls.filter(([url]) => url === '/api/operations/op-original/retry')).toHaveLength(1);
  });
});
