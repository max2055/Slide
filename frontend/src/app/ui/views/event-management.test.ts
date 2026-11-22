import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../api/index.js', () => ({ authFetch: vi.fn(async (url: string) =>
  url.startsWith('/api/metrics/template-events/')
    // These fixtures are legacy events, so the production evidence API returns
    // 404, rather than a successful legacy event-list payload.
    ? { ok: false, status: 404, json: async () => ({ code: 'TEMPLATE_EVENT_NOT_FOUND' }) }
    : { ok: true, json: async () => ({ items: [], total: 0 }) }) }));
import { authFetch } from '../../../api/index.js';
import { EventManagementPage } from './event-management.js';

describe('migrated attention event states', () => {
  afterEach(() => { document.body.replaceChildren(); vi.mocked(authFetch).mockReset(); });
  it.each([403, 503, 200])('clears facts and never renders a successful empty state on invalid read %s', async status => {
    const page = new EventManagementPage() as any;
    Object.assign(page, {events:[{id:1,title:'private',severity:'warning',status:'open'}], selectedEvent:{id:1}, eventMembers:[{title:'secret'}], loading:false});
    vi.mocked(authFetch).mockResolvedValue({ok:status===200,status,json:async()=>({})} as Response);
    await page._loadEvents();
    expect(page.events).toEqual([]); expect(page.selectedEvent).toBeNull(); expect(page.eventMembers).toEqual([]);
    expect(page.loadError).toBeTruthy();
    expect(page.stats).toBeNull();
  });
  it('invalidates a pending list on unmount', async () => {
    const page = new EventManagementPage() as any;
    let release!:(value:Response)=>void;
    vi.mocked(authFetch).mockImplementationOnce(()=>new Promise(resolve=>release=resolve));
    vi.mocked(authFetch).mockResolvedValue({ok:true,json:async()=>({})} as Response);
    const pending=page._loadEvents();
    page.disconnectedCallback();
    release({ok:true,json:async()=>({items:[{id:99,title:'late private'}]})} as Response);
    await pending; expect(page.events).toEqual([]);
  });
});

describe('manual recovery confirmation', () => {
  afterEach(() => document.body.replaceChildren());

  async function renderEvent(extra: Record<string, unknown> = {}) {
    const page = new EventManagementPage();
    const event = { id: '1', status: 'resolved', title: 'fixture', severity: 'warning', alert_count: 0, ...extra };
    Object.assign(page, { _loadEvents: async () => {}, events: [event], selectedEvent: event, loading: false });
    document.body.append(page);
    await page.updateComplete;
    const evidence = page.shadowRoot!.querySelector('template-event-evidence') as any;
    await new Promise(resolve => setTimeout(resolve, 0));
    await evidence.updateComplete;
    expect(evidence.shadowRoot.querySelector('h4')).toBeNull();
    expect(evidence.shadowRoot.querySelector('[role="alert"]')).toBeNull();
    return page.shadowRoot!;
  }

  it('asks for a manual basis and does not imply automatic metric verification', async () => {
    const root = await renderEvent();
    expect(root.textContent).toContain('人工确认恢复');
    expect(root.textContent).toContain('不代表客观指标观察窗验证通过');
    const input = root.querySelector<HTMLTextAreaElement>('[aria-label="人工恢复确认依据"]')!;
    expect(input.maxLength).toBe(1024);
    expect([...root.querySelectorAll('button')].find(b => b.textContent === '人工确认恢复')?.disabled).toBe(true);
    expect([...root.querySelectorAll('button')].some(b => b.textContent === '关闭事件')).toBe(false);
  });

  it('keeps actor/time/reason visible after close and identifies legacy unknown actors', async () => {
    const root = await renderEvent({ status: 'closed', verification_passed_at: '2026-10-03T12:00:00Z', verification_actor_id: 42, verification_reason: 'checked manually' });
    expect(root.textContent).toContain('人工恢复确认');
    expect(root.textContent).toContain('42');
    expect(root.textContent).toContain('checked manually');
    expect(root.textContent).toContain('不代表客观指标观察窗验证通过');
    const legacy = await renderEvent({ verification_passed_at: '2026-10-03T12:00:00Z', verification_actor_id: null });
    expect(legacy.textContent).toContain('历史记录未提供');
  });
});

// MAX-584 / #657 and #656: preserve drafts and reject stale responses.
describe('event interaction recovery', () => {
  afterEach(() => { vi.clearAllMocks(); document.body.replaceChildren(); });
  const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;
  function pageWithDraft() {
    const page = new EventManagementPage() as any;
    Object.assign(page, { selectedEvent: { id: '1' }, noteText: ' note ', postmortemText: ' review ', showPostmortemForm: true,
      _loadEvents: async () => {}, _selectEvent: async () => {} });
    return page;
  }
  it.each(['note', 'postmortem'])('preserves %s while pending and on failure, then clears on success', async kind => {
    const page = pageWithDraft();
    const field = kind === 'note' ? 'noteText' : 'postmortemText';
    const method = kind === 'note' ? '_addNote' : '_addPostmortem';
    let finish!: (r: Response) => void;
    vi.mocked(authFetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = page[method]();
    expect(page[field]).toBe(kind === 'note' ? ' note ' : ' review ');
    finish(response({}, false));
    await pending;
    expect(page[field]).toBe(kind === 'note' ? ' note ' : ' review ');
    expect(page.showPostmortemForm).toBe(true);
    vi.mocked(authFetch).mockResolvedValueOnce(response({}));
    await page[method]();
    expect(page[field]).toBe('');
    const options = vi.mocked(authFetch).mock.calls.at(-1)![1]!;
    expect(JSON.parse(options.body as string)).toEqual(kind === 'note' ? { note: 'note' } : { postmortem: 'review' });
    if (kind === 'postmortem') expect(page.showPostmortemForm).toBe(false);
  });
  it.each(['note', 'postmortem'])('preserves %s on HTTP 200 business failure', async kind => {
    const page = pageWithDraft();
    vi.mocked(authFetch).mockResolvedValueOnce(response({ success: false, error: 'write rejected' }));
    await page[kind === 'note' ? '_addNote' : '_addPostmortem']();
    expect(page[kind === 'note' ? 'noteText' : 'postmortemText']).not.toBe('');
    expect(page.error).toBe('write rejected');
  });
  it('does not erase edits made during a successful save', async () => {
    const page = pageWithDraft();
    let finish!: (r: Response) => void;
    vi.mocked(authFetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = page._addPostmortem();
    page.postmortemText = 'new draft';
    finish(response({}));
    await pending;
    expect(page.postmortemText).toBe('new draft');
    expect(page.showPostmortemForm).toBe(true);
  });
  it.each(['note', 'postmortem'])('late %s save leaves another event draft intact', async kind => {
    const page = pageWithDraft();
    const field = kind === 'note' ? 'noteText' : 'postmortemText';
    let finish!: (r: Response) => void;
    vi.mocked(authFetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = page[kind === 'note' ? '_addNote' : '_addPostmortem']();
    page.selectedEvent = { id: '2' };
    // Even identical drafts must belong to the currently selected event.
    finish(response({}));
    await pending;
    expect(page[field]).toBe(kind === 'note' ? ' note ' : ' review ');
    expect(page.showPostmortemForm).toBe(true);
  });
  it('ignores late detail and logs even when returning to the same event', async () => {
    const page = new EventManagementPage() as any;
    const pending: Array<(r: Response) => void> = [];
    vi.mocked(authFetch).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const old = page._selectEvent({ id: '1', title: 'old' });
    const middle = page._selectEvent({ id: '2' });
    const current = page._selectEvent({ id: '1', title: 'current' });
    pending[4](response({ id: '1', title: 'fresh', alerts: ['fresh member'] }));
    pending[5](response(['fresh log']));
    await current;
    pending[0](response({ id: '1', title: 'stale', alerts: ['stale member'] }));
    pending[1](response(['stale log']));
    pending[2](response({ id: '2' }));
    pending[3](response([]));
    await Promise.all([old, middle]);
    expect(page.selectedEvent.title).toBe('fresh');
    expect(page.eventMembers).toEqual(['fresh member']);
    expect(page.eventLogs).toEqual(['fresh log']);
  });
});

// MAX-572 / #430 / #659
 describe('event failure recovery', () => {
  afterEach(() => { vi.clearAllMocks(); localStorage.clear(); document.body.replaceChildren(); });
  const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body }) as Response;
  it('offers retry after loading fails and clears the old load error on success', async () => {
    const page = new EventManagementPage() as any;
    vi.mocked(authFetch).mockResolvedValue(response({}, false));
    await page._loadEvents();
    expect(page.loadError).toContain('503');
    expect(page.render().values).toBeDefined();
    vi.mocked(authFetch).mockResolvedValue(response({ items: [], total: 0 }));
    await page._loadEvents();
    expect(page.loadError).toBeNull();
  });
  it.each([{}, { analysisIds: [] }, { analysisIds: 'bad', sessionKeys: [] }, { analysisIds: [1], sessionKeys: [null] }, { success: false, analysisIds: [], sessionKeys: [] }])('discards invalid persisted RCA %j', async value => {
    localStorage.setItem('event_rca_result', JSON.stringify({ ...value, eventId: 1 }));
    const page = new EventManagementPage() as any;
    page._loadEvents = async () => {};
    document.body.append(page);
    await page.updateComplete;
    expect(page.rcaResult).toBeNull();
    expect(localStorage.getItem('event_rca_result')).toBeNull();
  });
  it('rejects business failure without persisting and accepts valid results', async () => {
    const page = new EventManagementPage() as any;
    page.selectedEvent = { id: '1' };
    vi.mocked(authFetch).mockResolvedValue(response({ success: false }));
    await page._triggerRCA();
    expect(page.rcaResult).toBeNull();
    expect(page.error).toContain('根因分析失败');
    expect(localStorage.getItem('event_rca_result')).toBeNull();
    vi.mocked(authFetch).mockResolvedValue(response({ success: true, analysisIds: [7], sessionKeys: ['session-7'] }));
    await page._triggerRCA();
    expect(page.error).toBeNull();
    expect(page.rcaResult.analysisIds).toEqual([7]);
    expect(JSON.parse(localStorage.getItem('event_rca_result')!).sessionKeys).toEqual(['session-7']);
  });
});

// Chief review MAX-572: queries must preserve the latest tab/page/refresh intent.
describe('latest event list query', () => {
  afterEach(() => { vi.resetAllMocks(); document.body.replaceChildren(); });
  const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body }) as Response;
  it.each(['tab', 'page', 'action'])('keeps latest %s result when older GET finishes last', async kind => {
    const page = new EventManagementPage() as any;
    const finish: Array<(r: Response) => void> = [];
    vi.mocked(authFetch).mockImplementation(() => new Promise(resolve => finish.push(resolve)));
    const old = page._loadEvents();
    if (kind === 'tab') page.activeListTab = 'resolved';
    if (kind === 'page') page.eventsPage = 1;
    const write = vi.fn(async () => {});
    const current = kind === 'action' ? page._action(write) : page._loadEvents();
    await Promise.resolve();
    const urls = vi.mocked(authFetch).mock.calls.map(call => String(call[0]));
    expect(urls.filter(url => url.includes('events?'))).toHaveLength(2);
    if (kind === 'tab') expect(urls[3]).toContain('status=resolved,closed');
    if (kind === 'page') expect(urls[3]).toContain('offset=50');
    finish[3](response({ items: [{ id: 'new' }], total: 1 }));
    finish[4](response({ open: 1 })); finish[5](response({ value: 'new' }));
    await current;
    finish[0](response({ items: [{ id: 'old' }], total: 2 }));
    finish[1](response({ open: 2 })); finish[2](response({ value: 'old' }));
    await old;
    expect(page.events).toEqual([{ id: 'new' }]);
    expect(page.eventsTotal).toBe(1);
    expect(page.stats).toEqual({ open: 1 });
    expect(page.mttr).toEqual({ value: 'new' });
    expect(page.retryLoading).toBe(false);
    expect(write).toHaveBeenCalledTimes(kind === 'action' ? 1 : 0);
  });
  it('ignores an older failure while latest GET is pending', async () => {
    const page = new EventManagementPage() as any;
    const finish: Array<(r: Response) => void> = [];
    vi.mocked(authFetch).mockImplementation(() => new Promise(resolve => finish.push(resolve)));
    const old = page._loadEvents();
    const current = page._loadEvents();
    finish[0](response({}, false)); finish[1](response({})); finish[2](response({}));
    await old;
    expect(page.loadError).toBeNull();
    expect(page.retryLoading).toBe(true);
    finish[3](response({ items: [], total: 0 })); finish[4](response({})); finish[5](response({}));
    await current;
    expect(page.retryLoading).toBe(false);
  });
  it.each([{ items: [] }, { items: [{ id: '1', title: 'recovered', severity: 'warning', status: 'open' }] }])('renders healthy empty state only after successful retry %j', async ({ items }) => {
    vi.mocked(authFetch).mockResolvedValue(response({}, false));
    const page = new EventManagementPage() as any;
    document.body.append(page);
    await new Promise(resolve => setTimeout(resolve, 0));
    await page.updateComplete;
    expect(page.shadowRoot.textContent).toContain('重试加载');
    expect(page.shadowRoot.textContent).not.toContain('系统运行正常');
    expect(page.shadowRoot.textContent).not.toContain('暂无活跃事件');
    vi.mocked(authFetch).mockResolvedValue(response({ items, total: items.length }));
    await page._loadEvents(); await page.updateComplete;
    expect(page.shadowRoot.textContent).not.toContain('加载失败:');
    expect(page.shadowRoot.textContent.includes('系统运行正常')).toBe(items.length === 0);
    if (items.length) expect(page.shadowRoot.textContent).toContain('recovered');
  });
});

describe('current-page event filter counts', () => {
  afterEach(() => { document.body.replaceChildren(); vi.mocked(authFetch).mockReset(); });

  it('counts only the displayed rows and retains the server total when paging from zero matches', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: index + 2, title: `事件 ${index + 2}`, severity: 'warning', status: 'open',
    }));
    const secondPage = [{ id: 1, title: '磁盘告警', severity: 'critical', status: 'open' }];
    const api = vi.mocked(authFetch);
    const listRequests: string[] = [];
    api.mockImplementation(async url => {
      const path = String(url);
      if (!path.includes('/alerts/events?')) return Response.json({});
      listRequests.push(path);
      const items = path.includes('offset=50') ? secondPage : firstPage;
      return Response.json({ items, total: 51 });
    });

    const page = new EventManagementPage();
    document.body.append(page);
    const root = page.shadowRoot!;
    const summary = () => root.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, ' ').trim();
    await vi.waitFor(() => expect(summary()).toBe('本页命中 50 条 · 当前状态可见事件共 51 条'));

    const search = root.querySelector<HTMLInputElement>('[aria-label="搜索本页事件"]')!;
    search.value = '磁盘';
    search.dispatchEvent(new Event('input'));
    await page.updateComplete;
    expect(summary()).toBe('本页命中 0 条 · 当前状态可见事件共 51 条');
    expect(root.textContent).toContain('暂无匹配的事件');

    root.querySelector<HTMLButtonElement>('.pagination button:last-child')!.click();
    await vi.waitFor(() => expect(summary()).toBe('本页命中 1 条 · 当前状态可见事件共 51 条'));
    expect(root.querySelectorAll('.event-item')).toHaveLength(1);

    const severity = root.querySelector<HTMLSelectElement>('[aria-label="本页严重度"]')!;
    severity.value = 'warning';
    severity.dispatchEvent(new Event('change'));
    await page.updateComplete;
    expect(summary()).toBe('本页命中 0 条 · 当前状态可见事件共 51 条');
    expect(listRequests).toEqual([
      '/api/alerts/events?limit=50&offset=0&status=open,investigating,handled',
      '/api/alerts/events?limit=50&offset=50&status=open,investigating,handled',
    ]);
  });
});
