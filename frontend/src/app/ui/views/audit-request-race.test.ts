import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../../api/index.js';
import { AgentToolAuditPage } from './agent-tool-audit.js';
import { SystemAuditPage } from './system-audit.js';
import { showToast } from '../components/app-toast-container.js';

vi.mock('../components/app-toast-container.js', () => ({ showToast: vi.fn() }));

function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const record = (id: number) => ({ id, toolName: `tool-${id}` });

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('MAX-429 / GitHub #424 detail request ownership', () => {
  function setup() {
    const view: any = new AgentToolAuditPage();
    view.records = [record(1), record(2)];
    const pending = [deferred(), deferred()];
    vi.spyOn(apiClient, 'get').mockReturnValueOnce(pending[0].promise).mockReturnValueOnce(pending[1].promise);
    return { view, pending };
  }
  for (const same of [false, true]) it(`keeps latest detail after ${same ? 'close and reopen same ID' : 'switching IDs'} with reversed responses`, async () => {
    const { view, pending } = setup();
    const old = view.openDetail(1);
    if (same) view.closeDetail();
    const current = view.openDetail(same ? 1 : 2);
    pending[1].resolve({ record: { ...record(same ? 1 : 2), args: 'current' } }); await current;
    pending[0].resolve({ record: { ...record(1), args: 'old' } }); await old;
    expect(view.selected.args).toBe('current'); expect(view.detailLoading).toBe(false);
  });
  for (const unmount of [false, true]) it(`ignores response after ${unmount ? 'disconnect' : 'close'}`, async () => {
    const { view, pending } = setup(); const old = view.openDetail(1);
    if (unmount) view.disconnectedCallback(); else view.closeDetail();
    pending[0].resolve({ record: record(1) }); await old;
    expect(view.selected).toBeNull(); expect(view.detailLoading).toBe(false);
  });
  it('ignores stale failure/finally while the current detail is pending', async () => {
    const { view, pending } = setup(); const old = view.openDetail(1); const current = view.openDetail(2);
    pending[0].reject(new Error('old')); await old;
    expect(view.selected.id).toBe(2); expect(view.detailLoading).toBe(true); expect(showToast).not.toHaveBeenCalled();
    pending[1].reject(new Error('current')); await current;
    expect(view.selected).toBeNull(); expect(view.detailLoading).toBe(false); expect(showToast).toHaveBeenCalledTimes(1);
  });
});

for (const agent of [true, false]) describe(`${agent ? 'MAX-429 #424' : 'MAX-433 #442'} list request ownership`, () => {
  function setup() {
    const view: any = agent ? new AgentToolAuditPage() : new SystemAuditPage();
    const pending = [deferred(), deferred(), deferred()];
    const get = vi.spyOn(apiClient, 'get');
    pending.forEach(p => get.mockReturnValueOnce(p.promise));
    const result = (id: number) => agent ? { records: [record(id)], nextCursor: id } : { items: [record(id)], total: id };
    return { view, pending, result, get };
  }
  it('only accepts the newest page/filter/refresh response', async () => {
    const { view, pending, result } = setup(); const old = view.load();
    if (agent) view.cursor = 25; else view.offset = 25;
    const page = view.load(); view.keyword = 'new'; view.toolName = 'new'; const query = view.load(true);
    pending[2].resolve(result(3)); await query;
    pending[1].resolve(result(2)); await page; pending[0].resolve(result(1)); await old;
    expect(view.records[0].id).toBe(3); expect(agent ? view.nextCursor : view.total).toBe(3);
    expect(agent ? view.cursor : view.offset).toBe(agent ? undefined : 0); expect(view.loading).toBe(false);
  });
  it('ignores stale errors and retains current loading until its own failure, then retries', async () => {
    const { view, pending, result } = setup(); const old = view.load(); const current = view.load(true);
    pending[0].reject(new Error('old')); await old;
    expect(view.loading).toBe(true); expect(showToast).not.toHaveBeenCalled();
    pending[1].reject(new Error('current')); await current;
    expect(view.loading).toBe(false); expect(showToast).toHaveBeenCalledTimes(1);
    const retry = view.load(); pending[2].resolve(result(3)); await retry;
    expect(view.records[0].id).toBe(3); if (!agent) expect(view.loadError).toBe('');
  });
  it('does not let an old success clear the loading of a newer request', async () => {
    const { view, pending, result } = setup(); const old = view.load(); const current = view.load();
    pending[0].resolve(result(1)); await old; expect(view.loading).toBe(true); expect(view.records).toEqual([]);
    pending[1].resolve(result(2)); await current; expect(view.records[0].id).toBe(2);
  });
  it('invalidates requests on disconnect and accepts reconnect loads', async () => {
    const { view, pending, result } = setup(); const old = view.load(); view.disconnectedCallback();
    const current = view.load(true); pending[1].resolve(result(2)); await current;
    pending[0].resolve(result(1)); await old; expect(view.records[0].id).toBe(2);
  });
  if (agent) it('synchronously blocks duplicate next/previous page cursor mutations', async () => {
    const { view, pending, result, get } = setup(); view.loading = false; view.nextCursor = 25;
    view.nextPage(); view.nextPage(); view.previousPage();
    expect(view.cursor).toBe(25); expect(view.cursorStack).toEqual([undefined]); expect(get).toHaveBeenCalledTimes(1);
    pending[0].resolve(result(50)); await pending[0].promise; await Promise.resolve();
    view.previousPage(); view.previousPage(); view.nextPage();
    expect(view.cursor).toBeUndefined(); expect(view.cursorStack).toEqual([]); expect(get).toHaveBeenCalledTimes(2);
    pending[1].resolve(result(25)); await pending[1].promise;
  });
  if (!agent) it('invalidates reads when permission/session context changes', async () => {
    const { view, pending, result } = setup(); const old = view.load(); view.accessChanged();
    pending[0].resolve(result(1)); await old;
    expect(view.records).toEqual([]); expect(view.total).toBe(0); expect(view.loading).toBe(false);
    expect(view.loadError).toContain('权限已变更');
  });
});
