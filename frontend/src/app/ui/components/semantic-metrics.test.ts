import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import { SemanticMetrics } from './semantic-metrics.js';
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const result = { profile: { columns: [{ key: 'uptime', metric: { id: 'db.uptime_seconds' }, label: '运行时长' }] }, window: { from: 'start', to: 'end' }, metrics: [
  { definition: { id: 'db.uptime_seconds', category: 'canonical', meaning: 'Database uptime', unit: 's' }, state: 'available', series: [{ dimensions: {}, buckets: [{ value: { encoding: 'uint64', value: '9007199254740993' }, unit: 's', coverage: 1, quality: { status: 'good', reason: 'none' }, freshness: 'fresh', accuracy: 'exact', sources: [{ id: 'source' }], window: { from: 'start', to: 'end' } }] }] },
] };
afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });
const mount = async () => { const el = new SemanticMetrics(); el.resourceId = 1; document.body.append(el); await settle(); return el; };
it('uses standard API, renders exact integers and preserves quality metadata', async () => {
  authFetch.mockResolvedValue({ ok: true, json: async () => result }); const el = await mount();
  expect(authFetch.mock.calls[0][0]).toBe('/api/metrics-v2/query');
  expect(JSON.parse(authFetch.mock.calls[0][1].body)).toMatchObject({ resource: { type: 'instance', id: 1 }, view: 'all' });
  const table = el.shadowRoot!.querySelector('app-data-table') as any;
  expect(table.rows[0].metric).toBeDefined(); expect(el.result).toEqual(result);
  expect(table.textContent).toContain('9007199254740993');
  expect(table.textContent).toContain('覆盖率 100%');
});
it('keeps metric cards on temporary failure, clears values on permission denial', async () => {
  authFetch.mockResolvedValue({ ok: true, json: async () => result }); const el = await mount();
  authFetch.mockResolvedValue({ ok: false, status: 503 }); await el.load(); await el.updateComplete;
  expect(el.result).toEqual(result); expect(el.error).toContain('不能据此判断健康');
  expect(el.shadowRoot!.querySelectorAll('app-card')).toHaveLength(2);
  authFetch.mockResolvedValue({ ok: false, status: 403 }); await el.load(); await el.updateComplete;
  expect(el.result).toBeNull(); expect(el.error).toContain('权限');
});
it('discards late data after changing resource', async () => {
  let finish!: (value: unknown) => void;
  authFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ok: false, status: 403 });
  const el = await mount(); el.resourceId = 2; await settle();
  finish({ ok: true, json: async () => result }); await settle(); expect(el.result).toBeNull();
});
it('fixed product core columns remain visible even if all resource queries fail', async () => {
  authFetch.mockResolvedValue({ ok: false, status: 503 });
  const el = document.createElement('semantic-core-list') as any; el.resourceType = 'server'; el.resources = [{ id: 2 }]; document.body.append(el); await settle();
  const columns = el.shadowRoot.querySelector('app-data-table').columns;
  expect(columns.map((c: any) => c.key)).toEqual(['resource', 'host.filesystem.used_bytes', 'host.filesystem.size_bytes', 'host.network.bytes_total', 'error']);
});
