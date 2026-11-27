import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './sql-audit-tab.js';

type View = HTMLElement & { instanceId: number; sqlText: string; updateComplete: Promise<boolean>; _loadHistory(): Promise<void>; _submitAudit(): Promise<void> };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const item = (id = 101, status = 'completed') => ({ id, status, created_at: '2026-10-15T01:00:00Z' });
async function mount(rows: unknown = [item()], status = 200) {
  authFetch.mockResolvedValueOnce(response(rows, status));
  const view = document.createElement('sql-audit-tab') as View;
  view.instanceId = 1; document.body.append(view);
  await vi.waitFor(() => expect(view.shadowRoot!.querySelector('.history-toggle') || view.shadowRoot!.textContent!.includes('暂无审核记录') || view.shadowRoot!.querySelector('[role="alert"]')).toBeTruthy());
  return view;
}
const root = (view: View) => view.shadowRoot!;
const text = (view: View) => root(view).textContent!;
async function open(view: View, index = 0) {
  (root(view).querySelectorAll('.history-toggle')[index] as HTMLButtonElement).click();
  await view.updateComplete;
}

describe('SQL audit history compatibility and read failures', () => {
  beforeEach(() => authFetch.mockReset());
  afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

  it('explains an unavailable audit model without claiming an analysis was accepted', async () => {
    const view = await mount([]);
    authFetch.mockResolvedValueOnce(response({ error: 'SQL_AUDIT_MODEL_UNAVAILABLE' }, 422));
    view.sqlText = 'SELECT 1';
    await view._submitAudit();
    await view.updateComplete;
    expect(text(view)).toContain('没有可用于 SQL 审核的模型');
    expect(text(view)).not.toContain('LLM 深度分析进行中');
  });

  it('reports a failed current result read and retries the same analysis without resubmission', async () => {
    const view = await mount([]);
    vi.useFakeTimers();
    authFetch.mockImplementation(async (path: string) => {
      if (path === '/api/sql/audit') return response({ analysis_id: 101 });
      if (path?.endsWith('/status')) return response({ id: 101, status: 'completed' });
      if (path === '/api/sql/audit/101') return response({}, 503);
      return response([]);
    });
    view.sqlText = 'SELECT 1';
    await view._submitAudit();
    await vi.advanceTimersByTimeAsync(3_000);
    await view.updateComplete;
    expect(text(view)).toContain('审核已完成，但读取结果失败');
    const retry = [...root(view).querySelectorAll('button')].find(button => button.textContent?.trim() === '重试读取审核结果');
    expect(retry).toBeDefined();
    authFetch.mockImplementation(async () => response({ id: 101, instance_id: 1, status: 'completed', result: { summary: '读取原审核结果' } }));
    retry!.click();
    await vi.advanceTimersByTimeAsync(0);
    await view.updateComplete;
    expect(text(view)).toContain('读取原审核结果');
    expect(authFetch.mock.calls.filter(([path]) => path === '/api/sql/audit')).toHaveLength(1);
    expect(authFetch.mock.calls.filter(([path]) => path === '/api/sql/audit/101')).toHaveLength(2);
  });

  it('ignores a current result that arrives after switching instances', async () => {
    const view = await mount([]);
    const result = deferred();
    vi.useFakeTimers();
    authFetch.mockImplementation(async (path: string) => {
      if (path === '/api/sql/audit') return response({ analysis_id: 101 });
      if (path?.endsWith('/status')) return response({ id: 101, status: 'completed' });
      if (path === '/api/sql/audit/101') return result.promise;
      return response([]);
    });
    view.sqlText = 'SELECT 1';
    await view._submitAudit();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(text(view)).toContain('正在读取审核结果');
    view.instanceId = 2;
    await view.updateComplete;
    result.resolve(response({ id: 101, instance_id: 1, status: 'completed', result: { summary: '上一实例审核结果' } }));
    await vi.advanceTimersByTimeAsync(0);
    await view.updateComplete;
    expect(text(view)).not.toContain('上一实例审核结果');
    expect(text(view)).not.toContain('正在读取审核结果');
    expect(authFetch.mock.calls.some(([path]) => path === '/api/sql/audit/instance/2?limit=20')).toBe(true);
  });

  it('shows list fields actually returned by ai_analysis without inventing SQL or risk', async () => {
    const view = await mount([item(), { id: 102, status: 'unknown', created_at: null }, { id: 103, status: 'future-state', risk_level: 'future-risk', created_at: 'invalid' }]);
    expect(text(view)).toContain('列表未提供 SQL，请查看详情');
    expect(text(view)).toContain('风险未提供'); expect(text(view)).toContain('审核完成');
    expect(text(view)).toContain('状态待确认'); expect(text(view)).toContain('未知状态');
    expect(text(view)).toContain('未知风险等级'); expect(text(view)).toContain('时间未记录'); expect(text(view)).toContain('时间无效');
    expect(root(view).querySelector('app-badge[variant="ok"]')?.textContent).toContain('审核完成');
  });

  it.each([401, 403, 404, 500])('distinguishes HTTP %s from a successful empty history', async status => {
    const view = await mount({}, status);
    expect(root(view).querySelector('[role="alert"]')).toBeTruthy();
    expect(text(view)).not.toContain('暂无审核记录');
    authFetch.mockResolvedValueOnce(response([])); await view._loadHistory(); await view.updateComplete;
    expect(text(view)).toContain('暂无审核记录'); expect(root(view).querySelector('[role="alert"]')).toBeNull();
  });

  it.each([null, {}, [null], [{ status: 'completed' }]])('rejects a malformed list %j', async body => {
    const view = await mount(body); expect(text(view)).toContain('数据格式异常');
  });

  it.each(['network', 'json'])('keeps %s list failures actionable without exposing parser/transport details', async failure => {
    const view = await mount([]);
    if (failure === 'network') authFetch.mockRejectedValueOnce(new Error('PRIVATE_TRANSPORT_DETAILS'));
    else authFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('PRIVATE_RESPONSE_DETAILS'); } });
    await view._loadHistory(); await view.updateComplete;
    expect(root(view).querySelector('[role="alert"]')?.textContent).toContain('审核历史加载失败，请重试');
    expect(text(view)).not.toContain('PRIVATE_'); expect(text(view)).not.toContain('暂无审核记录');
  });

  it('displays the full SQL and risk from the joined detail; completion does not imply safety', async () => {
    const view = await mount();
    authFetch.mockResolvedValueOnce(response({ ...item(), audit_record: { sql_text: 'DROP TABLE example', risk_level: 'P0' }, result: { raw_content: '<script>literal</script>' } }));
    await open(view);
    await vi.waitFor(() => expect(text(view)).toContain('DROP TABLE example'));
    expect(text(view)).toContain('高风险（P0）'); expect(text(view)).toContain('完成审核不代表 SQL 无风险');
    expect(text(view)).toContain('<script>literal</script>'); expect(root(view).querySelector('script')).toBeNull();
    expect(root(view).querySelector('.history-toggle')?.getAttribute('aria-expanded')).toBe('true');
  });

  it.each(['completed', 'unknown', 'future-state', 'failed'])('terminates loading when %s has no stored result', async status => {
    const view = await mount([item(101, status)]);
    authFetch.mockResolvedValueOnce(response({ ...item(101, status), result: null }));
    await open(view); await vi.waitFor(() => expect(text(view)).toContain('未保存分析结果'));
    expect(text(view)).not.toContain('加载审核详情'); expect(authFetch).toHaveBeenCalledTimes(2);
  });

  it.each([403, 404, 500, 'network', 'malformed'])('exposes detail error %s with retry', async failure => {
    const view = await mount();
    if (failure === 'network') authFetch.mockRejectedValueOnce(new Error('网络不可用'));
    else authFetch.mockResolvedValueOnce(response(failure === 'malformed' ? {} : null, typeof failure === 'number' ? failure : 200));
    await open(view); await vi.waitFor(() => expect(root(view).querySelector('[role="alert"]')).toBeTruthy());
    expect(text(view)).not.toContain('加载审核详情');
    authFetch.mockResolvedValueOnce(response({ ...item(), result: {} }));
    (root(view).querySelector('.history-detail button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(root(view).querySelector('[role="alert"]')).toBeNull());
    expect(text(view)).toContain('未保存分析结果');
  });

  it('ignores a late result from another row and from a collapsed detail', async () => {
    const view = await mount([item(101), item(102)]); const first = deferred(), second = deferred();
    authFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await open(view, 0); await open(view, 1);
    second.resolve(response({ ...item(102), result: { summary: 'SECOND' } }));
    await vi.waitFor(() => expect(text(view)).toContain('SECOND'));
    first.resolve(response({ ...item(101), result: { summary: 'STALE' } }));
    await Promise.resolve(); await view.updateComplete;
    expect(text(view)).not.toContain('STALE'); await open(view, 1);
    expect(root(view).querySelector('.history-detail')).toBeNull();
  });

  it('refreshes history on instance changes and rejects a late list from the previous instance', async () => {
    const view = await mount(); const oldRead = deferred();
    authFetch.mockReturnValueOnce(oldRead.promise); const oldLoad = view._loadHistory();
    authFetch.mockResolvedValueOnce(response([])); view.instanceId = 2; await view.updateComplete;
    await vi.waitFor(() => expect(text(view)).toContain('暂无审核记录'));
    oldRead.resolve(response([item(999)])); await oldLoad; await view.updateComplete;
    expect(text(view)).not.toContain('#999');
  });

  it('updates the row when an active analysis finishes and stops polling', async () => {
    const view = await mount([item(101, 'running')]); vi.useFakeTimers();
    authFetch.mockResolvedValueOnce(response({ ...item(101, 'running'), result: null }));
    await open(view); await Promise.resolve(); await view.updateComplete;
    authFetch.mockResolvedValueOnce(response({ ...item(101, 'completed'), result: { summary: '已完成分析' } }));
    await vi.advanceTimersByTimeAsync(3000); await view.updateComplete;
    expect(text(view)).toContain('已完成分析');
    expect(root(view).querySelector('tbody tr')?.textContent).toContain('审核完成');
    await vi.advanceTimersByTimeAsync(6000); expect(authFetch).toHaveBeenCalledTimes(3);
  });

  it('stops active detail polling when another row opens and when detached', async () => {
    const view = await mount([item(101, 'running'), item(102, 'unknown')]);
    vi.useFakeTimers();
    authFetch.mockResolvedValueOnce(response({ ...item(101, 'running'), result: null }));
    await open(view); await Promise.resolve(); await view.updateComplete;
    authFetch.mockResolvedValueOnce(response({ ...item(102, 'unknown'), result: null }));
    await open(view, 1); await Promise.resolve(); await view.updateComplete;
    await vi.advanceTimersByTimeAsync(6000); expect(authFetch).toHaveBeenCalledTimes(3);
    view.remove(); await vi.advanceTimersByTimeAsync(6000); expect(authFetch).toHaveBeenCalledTimes(3);
  });
});
