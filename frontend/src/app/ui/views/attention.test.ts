import { afterEach, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.ts';
import { AttentionPage, sortAttentionItems } from './investigations.ts';
import '../components/app-data-table.ts';
import '../components/app-empty-state.ts';

vi.mock('../../../api/index.ts', () => ({ authFetch: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });

const event = (id: string | number, overrides = {}) => ({ id, title: `事项 ${id}`, severity: 'critical', status: 'open', updated_at: '2026-10-15T00:00:00Z', ...overrides });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
async function flush(page: AttentionPage) {
  await page.updateComplete;
  await Promise.all([...page.querySelectorAll('app-data-table')].map(table => (table as any).updateComplete));
}
async function view(permissions: Set<string> | null = new Set(['alert:view'])) {
  const page = new AttentionPage(); page.permissions = permissions; document.body.append(page);
  await flush(page); return page;
}
async function settled(page: AttentionPage) {
  await vi.waitFor(() => expect((page as any).loading).toBe(false)); await flush(page);
}
function empty(page: AttentionPage) { return page.querySelector('app-empty-state[title="暂无关注事项"]'); }
function refresh(page: AttentionPage) { [...page.querySelectorAll('button')].find(button => button.textContent?.includes('刷新事项'))!.click(); }

it('orders a bounded attention set by severity, newest time, then stable ID without mutation', () => {
  const items = [{ id: 'z', title: '', severity: 'warning', status: 'open', updated_at: '2026-10-13' },
    { id: 'b', title: '', severity: 'critical', status: 'open', updated_at: '2026-10-12' },
    { id: 'a', title: '', severity: 'critical', status: 'open', updated_at: '2026-10-12' }];
  expect(sortAttentionItems(items).map(i => i.id)).toEqual(['a', 'b', 'z']);
  expect(items[0].id).toBe('z');
});

it('sorts numeric and legacy string IDs with equal timestamps deterministically without mutating input', () => {
  const items = [event(2), event('1'), event(3, { severity: 'warning' }), event(4, { updated_at: '2026-10-16T00:00:00Z' }), event('unknown', { severity: 'future' })];
  expect(sortAttentionItems(items).map(item => item.id)).toEqual([4, '1', 2, 3, 'unknown']);
  expect(items.map(item => item.id)).toEqual([2, '1', 3, 4, 'unknown']);
});

it.each([{ items: [event(2), event(1)] }, [event(2), event(1)]])('renders numeric IDs from supported list envelopes', async data => {
  vi.mocked(authFetch).mockResolvedValue(response(data));
  const page = await view(); await settled(page);
  expect(page.querySelector('[role="alert"]')).toBeNull();
  expect([...page.querySelectorAll('tbody tr')].map(row => row.textContent?.trim().replace(/\s+/g, ' '))).toEqual(['事项 1 严重 待处理', '事项 2 严重 待处理']);
  expect(empty(page)).toBeNull();
});

it.each([{ items: [] }, []])('shows the empty state only after a successful empty response', async data => {
  vi.mocked(authFetch).mockResolvedValue(response(data));
  const page = await view(); await settled(page); expect(empty(page)).not.toBeNull();
});

it.each([401, 403, 500])('HTTP %s never renders an empty list or stale rows and can retry', async status => {
  vi.mocked(authFetch).mockResolvedValueOnce(response({ items: [event(1)] })).mockResolvedValueOnce(response({}, status)).mockResolvedValueOnce(response({ items: [] }));
  const page = await view(); await settled(page); refresh(page); await settled(page);
  expect(page.querySelector('[role="alert"]')).not.toBeNull();
  expect(empty(page)).toBeNull(); expect(page.querySelector('app-data-table')).toBeNull();
  if (status !== 401) { refresh(page); await settled(page); expect(empty(page)).not.toBeNull(); }
});

it.each([{}, null, { items: null }, { items: {} }])('rejects an unknown response shape instead of claiming there are no items', async data => {
  vi.mocked(authFetch).mockResolvedValue(response(data));
  const page = await view(); await settled(page);
  expect(page.querySelector('[role="alert"]')).not.toBeNull(); expect(empty(page)).toBeNull();
});

it('network failure exposes an error without the empty state', async () => {
  vi.mocked(authFetch).mockRejectedValue(new Error('network offline'));
  const page = await view(); await settled(page);
  expect(page.querySelector('[role="alert"]')).not.toBeNull(); expect(empty(page)).toBeNull();
});

it('loading hides previous data and the empty state', async () => {
  let deliver!: (value: Response) => void;
  vi.mocked(authFetch).mockResolvedValueOnce(response({ items: [event(1)] })).mockImplementationOnce(() => new Promise(resolve => deliver = resolve));
  const page = await view(); await settled(page); refresh(page); await flush(page);
  expect(page.querySelector('app-data-table')?.loading).toBe(true); expect(empty(page)).toBeNull(); expect(page.textContent).not.toContain('事项 1');
  deliver(response({ items: [] })); await settled(page); expect(empty(page)).not.toBeNull();
});

it.each([null, new Set<string>()])('unknown or absent permissions do not fetch or imply an empty result', async permissions => {
  const page = await view(permissions);
  expect(authFetch).not.toHaveBeenCalled(); expect(page.querySelector('app-data-table')).toBeNull(); expect(empty(page)).toBeNull();
  expect(page.textContent).toContain(permissions ? '无访问权限' : '正在确认访问权限');
});

it.each(['slide-session-expired', 'slide-permissions-loaded'])('%s invalidates in-flight data and clears old errors', async boundary => {
  let deliver!: (value: Response) => void;
  vi.mocked(authFetch).mockResolvedValueOnce(response({}, 500)).mockImplementationOnce(() => new Promise(resolve => deliver = resolve));
  const page = await view(); await settled(page); refresh(page); await flush(page);
  window.dispatchEvent(new CustomEvent(boundary, { detail: { permissions: [] } })); await flush(page);
  deliver(response({ items: [event('sensitive')] })); await settled(page);
  expect(page.textContent).not.toContain('sensitive'); expect(empty(page)).toBeNull(); expect(page.querySelector('app-data-table')).toBeNull();
  expect(page.textContent).toContain(boundary === 'slide-session-expired' ? '登录已失效' : '无访问权限');
});
