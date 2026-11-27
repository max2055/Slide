import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import '../sql-console.js';
import { authFetch } from '../../../../api/index.js';

vi.mock('../../../../api/index.js', () => ({ authFetch: vi.fn() }));
const fetchHistory = vi.mocked(authFetch);
const response = (items: any[] = [], total = items.length) => ({ ok: true, json: async () => ({ items, total }) }) as Response;
function subject(): any {
  const Ctor = customElements.get('sql-console-page')!;
  const el: any = new Ctor();
  el.sidebarView = 'history';
  el.instances = [{ id: 1, name: '一号库' }, { id: 2, name: '二号库' }];
  el.historyInstanceFilter = 1;
  return el;
}
function view(el: any) {
  const host = document.createElement('div');
  document.body.append(host);
  render(el.render(), host);
  return host;
}

describe('MAX-561/#684 and MAX-562/#685 history', () => {
  beforeEach(() => { fetchHistory.mockReset(); localStorage.clear(); });
  afterEach(() => { document.body.replaceChildren(); });

  it('all instances explains the single-instance scope without requesting instance 0', async () => {
    const el = subject();
    el.historyInstanceFilter = 0;
    await el._loadHistory(true);
    expect(fetchHistory).not.toHaveBeenCalled();
    expect(view(el).textContent).toContain('当前不支持跨实例查看查询历史');
    expect(view(el).textContent).not.toContain('暂无查询记录');
  });

  it.each(['http', 'network', 'json', 'shape'])('distinguishes %s failure from empty success and supports retry', async kind => {
    const el = subject();
    if (kind === 'network') fetchHistory.mockRejectedValueOnce(new Error('offline'));
    else if (kind === 'shape') fetchHistory.mockResolvedValueOnce({ ok: true, json: async () => ({ total: 0 }) } as Response);
    else fetchHistory.mockResolvedValueOnce(kind === 'http' ? { ok: false } as Response : { ok: true, json: async () => { throw new Error('bad json'); } } as unknown as Response);
    await el._loadHistory(true);
    const host = view(el);
    expect(host.querySelector('[role=alert]')?.textContent).toContain('查询历史加载失败');
    expect(host.textContent).not.toContain('暂无查询记录');
    fetchHistory.mockResolvedValueOnce(response());
    (host.querySelector('.btn-refresh') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(el.historyLoading).toBe(false));
    expect(el.historyError).toBe('');
    expect(view(el).textContent).toContain('暂无查询记录');
  });

  it('failed pagination preserves rows and cursor, blocks scroll retries and retries the same page', async () => {
    const el = subject();
    el.historyItems = [{ id: 1, sql: 'SELECT 1' }]; el.historyOffset = 1;
    fetchHistory.mockResolvedValueOnce({ ok: false } as Response);
    await el._loadHistory();
    await el._loadHistory();
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(el.historyItems).toHaveLength(1);
    expect(el.historyOffset).toBe(1);
    el.historyError = '';
    fetchHistory.mockResolvedValueOnce(response([{ id: 2 }], 2));
    await el._loadHistory();
    expect(fetchHistory.mock.calls[1][0]).toContain('offset=1');
    expect(el.historyItems.map((row: any) => row.id)).toEqual([1, 2]);
  });

  it.each(['success', 'failure'])('ignores late %s from a previous instance while the new request is loading', async kind => {
    const el = subject();
    let finish!: (value: Response) => void;
    let fail!: (error: Error) => void;
    fetchHistory.mockReturnValueOnce(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    const old = el._loadHistory(true);
    el.historyInstanceFilter = 2;
    let finishNew!: (value: Response) => void;
    fetchHistory.mockReturnValueOnce(new Promise(resolve => { finishNew = resolve; }));
    const current = el._loadHistory(true);
    if (kind === 'success') finish(response([{ id: 1 }], 100)); else fail(new Error('old error'));
    await old;
    expect(el.historyLoading).toBe(true);
    expect(el.historyError).toBe('');
    expect(el.historyItems).toEqual([]);
    finishNew(response([{ id: 2 }])); await current;
    expect(el.historyItems).toEqual([{ id: 2 }]);
    expect(el.historyOffset).toBe(1);
  });

  it('all instances invalidates pending search results', async () => {
    const el = subject();
    let finish!: (value: Response) => void;
    fetchHistory.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const old = el._loadHistory(true);
    el.historyInstanceFilter = 0; await el._loadHistory(true);
    finish(response([{ id: 1 }])); await old;
    expect(el.historyItems).toEqual([]);
    expect(el.historyLoading).toBe(false);
    expect(el.historyHasMore).toBe(false);
  });

  it('select display follows history filter independently of toolbar selection', async () => {
    const el = subject(); el.selectedId = 2;
    const host = view(el);
    const select = host.querySelector('.history-instance-filter') as HTMLSelectElement;
    expect(select.value).toBe('1');
    el.selectedId = 1;
    render(el.render(), host);
    expect(select.value).toBe('1');
    select.value = '0'; select.dispatchEvent(new Event('change'));
    await Promise.resolve();
    expect(el.historyInstanceFilter).toBe(0);
    expect(fetchHistory).not.toHaveBeenCalled();
    render(el.render(), host);
    expect(select.value).toBe('0');
  });
});
