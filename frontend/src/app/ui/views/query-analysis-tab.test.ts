import { afterEach, describe, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.js';
import { QueryAnalysisTab } from './query-analysis-tab.js';
vi.mock('../../../api/index.js', () => ({ authFetch: vi.fn() }));
const fetchMock = vi.mocked(authFetch);
const elements: QueryAnalysisTab[] = [];
const row = (name: string, sql_text: string | null = `SELECT '${name}'`) => ({ fingerprint: `SELECT ? /* ${name} */`, sql_text, calls: 1, avg_time_ms: 1, total_time_ms: 1, max_time_ms: 1, rows_examined: 1 });
const response = (name: string) => new Response(JSON.stringify({ plan: { 'Node Type': name } }));
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function page() {
  fetchMock.mockResolvedValue(new Response('[]'));
  const el = new QueryAnalysisTab() as any; el.instanceId = 1; elements.push(el); document.body.append(el);
  await el.updateComplete; await vi.waitFor(() => expect(el.loading).toBe(false)); fetchMock.mockReset(); return el;
}
async function content(el: QueryAnalysisTab) { await el.updateComplete; return el.shadowRoot!.textContent; }
afterEach(() => { elements.splice(0).forEach(e => e.remove()); fetchMock.mockReset(); });
describe('MAX-537 / #434 #668 #669 execution plan ownership', () => {
  it('sends executable text and never falls back to the fingerprint', async () => {
    const el = await page(); fetchMock.mockResolvedValue(response('Current'));
    await el._selectQuery(row('A')); expect(new URL(fetchMock.mock.calls[0][0] as string, 'http://test').searchParams.get('sql')).toBe("SELECT 'A'");
    expect(await content(el)).toContain('Current'); fetchMock.mockClear();
    await el._selectQuery(row('B', null)); expect(fetchMock).not.toHaveBeenCalled(); expect(await content(el)).toContain('没有可执行的语句文本'); expect(await content(el)).not.toContain('Current');
  });
  it.each([400, 403, 404, 500])('clears the old plan and shows HTTP %s, then recovers', async status => {
    const el = await page(); fetchMock.mockResolvedValueOnce(response('Old')); await el._selectQuery(row('A'));
    fetchMock.mockResolvedValueOnce(new Response('{}', { status })); await el._selectQuery(row('B'));
    expect(el.explainPlan).toBeNull(); expect(await content(el)).toContain(String(status)); expect(el.explainLoading).toBe(false);
    fetchMock.mockResolvedValueOnce(response('Recovered')); await el._selectQuery(row('B')); expect(await content(el)).toContain('Recovered');
  });
  it.each(['success', 'http', 'network', 'json'])('ignores late A %s after B succeeds', async kind => {
    const el = await page(); const old = deferred<Response>(); fetchMock.mockReturnValueOnce(old.promise); const a = el._selectQuery(row('A'));
    fetchMock.mockResolvedValueOnce(response('Latest')); await el._selectQuery(row('B'));
    if (kind === 'network') old.reject(new Error('offline')); else old.resolve(kind === 'success' ? response('Stale') : kind === 'http' ? new Response('{}', { status: 500 }) : new Response('invalid'));
    await a; expect(await content(el)).toContain('Latest'); expect(el.explainError).toBe(''); expect(el.explainLoading).toBe(false);
  });
  it('old completion cannot stop the new loading indicator, including a repeated selection', async () => {
    const el = await page(); const old = deferred<Response>(), latest = deferred<Response>(); const target = row('A');
    fetchMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const a = el._selectQuery(target), b = el._selectQuery(target); old.resolve(response('Stale')); await a;
    expect(el.explainLoading).toBe(true); expect(el.explainPlan).toBeNull(); latest.resolve(response('Latest')); await b; expect(await content(el)).toContain('Latest');
  });
  it('guards JSON parsing as well as fetch completion', async () => {
    const el = await page(); const body = deferred<any>(); fetchMock.mockResolvedValueOnce({ ok: true, json: () => body.promise } as Response);
    const a = el._selectQuery(row('A')); await Promise.resolve(); fetchMock.mockResolvedValueOnce(response('Latest')); await el._selectQuery(row('B'));
    body.resolve({ plan: { 'Node Type': 'Stale' } }); await a; expect(await content(el)).toContain('Latest');
  });
  it.each([0, 2])('switching to instance %s clears old selection and ignores delayed plan and QAN', async instance => {
    const el = await page(); const plan = deferred<Response>(), qan = deferred<Response>();
    fetchMock.mockReturnValueOnce(plan.promise); const pending = el._selectQuery(row('A'));
    fetchMock.mockReturnValueOnce(qan.promise); const oldList = el.loadQanData();
    fetchMock.mockResolvedValue(new Response('[]')); el.instanceId = instance; await el.updateComplete;
    plan.resolve(response('Stale')); qan.resolve(new Response(JSON.stringify([row('Old instance')]))); await Promise.all([pending, oldList]);
    expect(el.selectedQuery).toBeNull(); expect(el.explainPlan).toBeNull(); expect(el.qanData).toEqual([]); expect(el.explainLoading).toBe(false);
  });
  it.each(['network', 'invalid-json', 'plan-error', 'missing-plan'])('shows a current %s failure without a previous plan', async kind => {
    const el = await page(); fetchMock.mockResolvedValueOnce(response('Old')); await el._selectQuery(row('A'));
    if (kind === 'network') fetchMock.mockRejectedValueOnce(new Error('offline'));
    else fetchMock.mockResolvedValueOnce(new Response(kind === 'invalid-json' ? 'invalid' : kind === 'plan-error' ? '{"plan":{"error":"denied"}}' : '{}'));
    await el._selectQuery(row('B')); expect(el.explainPlan).toBeNull(); expect(await content(el)).toContain('执行计划加载失败'); expect(el.explainLoading).toBe(false);
  });
});

it('MAX-717 offers plan selection only after a successful read produces rows', async () => {
  const el = await page();
  const prompt = '选择左侧查询查看执行计划';
  expect(await content(el)).toContain('没有已记录的查询指纹');
  expect(await content(el)).not.toContain(prompt);

  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
  await el.loadQanData();
  expect(await content(el)).not.toContain('没有已记录的查询指纹');
  expect(await content(el)).not.toContain(prompt);
  fetchMock.mockResolvedValueOnce(Response.json([row('Recovered')]));
  el.shadowRoot.querySelector('[role="alert"] button').click();
  await vi.waitFor(() => expect(el.shadowRoot.querySelector('tbody tr')).toBeTruthy());
  expect(await content(el)).toContain(prompt);
});
