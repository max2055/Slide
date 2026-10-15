import { afterEach, expect, it, vi } from 'vitest';
import { InvestigationCreate, InvestigationResourcePicker } from './investigation-create.ts';
import { InvestigationsController } from '../controllers/investigations.ts';
import { investigationApi } from '../controllers/investigation-api.ts';
import { authFetch } from '../../../api/index.ts';
vi.mock('../../../api/index.ts', () => ({ authFetch: vi.fn(), apiClient: { getToken: () => null } }));
vi.mock('../controllers/investigation-api.ts', async original => ({ ...await original<object>(), investigationApi: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });
const inventory = { items: [{ resource: { type: 'instance', id: 101 }, label: '生产订单长名称', status: 'unknown' }, { resource: { type: 'server', id: 102 }, label: '应用节点', status: 'offline' }], dataQuality: 'complete' };
async function picker() {
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify(inventory)));
  const view = new InvestigationResourcePicker(); document.body.append(view); await vi.waitFor(() => expect(view.querySelectorAll('[type=checkbox]')).toHaveLength(2)); return view;
}
it('name/type search preserves multi-selection outside the current results', async () => {
  const view = await picker(); const change = vi.fn(); view.addEventListener('resource-selection-change', change);
  (view.querySelector('[type=checkbox]') as HTMLInputElement).click(); await view.updateComplete;
  const search = view.querySelector('[aria-label="搜索资源"]') as HTMLInputElement;
  search.value = '服务器'; search.dispatchEvent(new Event('input')); await view.updateComplete;
  expect(view.querySelectorAll('[type=checkbox]')).toHaveLength(1);
  (view.querySelector('[type=checkbox]') as HTMLInputElement).click(); await view.updateComplete;
  expect(view.value).toEqual(['instance:101', 'server:102']); expect(change).toHaveBeenCalledTimes(2);
});
it('late inventory after revocation cannot restore names', async () => {
  let resolve!: (value: Response) => void; vi.mocked(authFetch).mockImplementation(() => new Promise(done => resolve = done));
  const view = new InvestigationResourcePicker(); document.body.append(view); await view.updateComplete;
  window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: [] } }));
  resolve(new Response(JSON.stringify(inventory))); await vi.waitFor(() => expect(view.textContent).not.toContain('正在加载'));
  expect(view.textContent).not.toContain('生产订单长名称'); expect(view.value).toEqual([]);
});
it('mixed resources deduplicate, preserve explicit primary, session and time, and clear on Profile change', async () => {
  const view = new InvestigationCreate(); document.body.append(view); const form = view as any;
  form.investigationTitle = '订单延迟'; form.goal = '核对证据'; form.selected = ['server:102', 'instance:101']; form.advancedRefs = 'instance:101, network_device:3';
  form.ids = '101'; form.sessionId = 'agent:ops:original'; form.from = '2026-10-15T10:00'; form.to = '2026-10-15T11:00';
  vi.mocked(investigationApi).mockResolvedValue(undefined); await form.submit();
  const request = JSON.parse(vi.mocked(investigationApi).mock.calls[0][1]!.body as string);
  expect(request).toMatchObject({ sessionId: 'original', subject: { resource: { type: 'server', id: 102 } }, resourceRefs: [{ type: 'server', id: 102, role: 'primary' }, { type: 'instance', id: 101, role: 'related' }, { type: 'network_device', id: 3, role: 'related' }] });
  expect(Date.parse(request.to)).toBeGreaterThan(Date.parse(request.from)); await view.updateComplete;
  const profile = view.querySelector('[aria-label="调查 Profile"]') as HTMLSelectElement; profile.value = 'system'; profile.dispatchEvent(new Event('change')); await view.updateComplete;
  expect(form.selected).toEqual([]); expect(form.advancedRefs).toBe(''); expect(form.ids).toBe('');
});
it('multi-resource pagination deduplicates overlaps and preserves independent cursors', async () => {
  const row = (id: string) => ({ id, updatedAt: id });
  const api = vi.mocked(investigationApi); api.mockResolvedValueOnce({ items: [row('b')], authorizedCounts: { total: 2 }, nextCursor: 'next-instance' }).mockResolvedValueOnce({ items: [row('b'), row('c')], authorizedCounts: { total: 2 }, nextCursor: null });
  const c = new InvestigationsController(() => {}, null); await c.loadList('', false, ['instance:101', 'server:102']);
  expect(c.list.items.map(r => r.id)).toEqual(['c', 'b']); expect(c.list.authorizedCounts.total).toBe(2);
  api.mockResolvedValueOnce({ items: [row('a')], authorizedCounts: { total: 2 }, nextCursor: null }); await c.loadList(undefined, true);
  expect(api.mock.calls[2][0]).toContain('next-instance'); expect(api).toHaveBeenCalledTimes(3); expect(c.list.items.map(r => r.id)).toEqual(['c', 'b', 'a']);
});
it('failed list read never becomes the first-use empty state', async () => {
  vi.mocked(investigationApi).mockRejectedValue(new Error('network')); const c = new InvestigationsController(() => {}, null); await c.loadList();
  expect(c.listLoaded).toBe(false); expect(c.listError).toContain('连接失败');
});
