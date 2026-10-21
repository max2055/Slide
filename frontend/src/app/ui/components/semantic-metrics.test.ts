import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import { SemanticMetrics } from './semantic-metrics.js';
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const result = { profile: { columns: [{ key: 'uptime', metric: { id: 'db.uptime_seconds' }, label: '运行时长' }] }, window: { from: 'start', to: 'end' }, metrics: [
  { definition: { id: 'db.uptime_seconds', category: 'canonical', meaning: 'Database uptime', unit: 's' }, state: 'available', series: [{ dimensions: {}, buckets: [{ value: { encoding: 'uint64', value: '9007199254740993' }, unit: 's', coverage: 1, quality: { status: 'good', reason: 'none' }, freshness: 'fresh', accuracy: 'exact', sources: [{ id: 'source' }], window: { from: 'start', to: 'end' } }] }] },
] };
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); vi.resetAllMocks(); });
const mount = async () => { const el = new SemanticMetrics(); el.resourceId = 1; document.body.append(el); await settle(); return el; };
it('uses standard API, renders exact integers and preserves quality metadata', async () => {
  authFetch.mockResolvedValue({ ok: true, json: async () => result }); const el = await mount();
  expect(authFetch.mock.calls[0][0]).toBe('/api/metrics/query');
  expect(JSON.parse(authFetch.mock.calls[0][1].body)).toMatchObject({ resource: { type: 'instance', id: 1 }, view: 'all' });
  const table = el.shadowRoot!.querySelector('app-data-table') as any;
  expect(table.rows[0].metric).toBeDefined(); expect(el.result).toEqual(result);
  expect(table.textContent).toContain('9007199254740993');
  expect(table.textContent).toContain('覆盖率 100%');
});
it('keeps a relative query window exactly divisible by its bucket when the clock advances', async () => {
  authFetch.mockResolvedValue({ ok: true, json: async () => result });
  const el = await mount();
  let now = Date.parse('2026-10-15T11:00:00.000Z');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  vi.spyOn(Date, 'now').mockImplementation(() => { const captured = now; vi.setSystemTime(++now); return captured; });
  await el.load();
  const query = JSON.parse(authFetch.mock.lastCall![1].body);
  expect(Date.parse(query.to) - Date.parse(query.from)).toBe(3_600_000);
  expect((Date.parse(query.to) - Date.parse(query.from)) % query.bucket_ms).toBe(0);
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
it.each(['fresh', 'stale', 'unknown'])('shows actual observation time alongside %s metadata, independently of the window', async freshness => {
  const data = structuredClone(result);
  const bucket = data.metrics[0].series[0].buckets[0] as any;
  bucket.observed_at = '2026-10-14T01:02:03.000Z'; bucket.freshness = freshness;
  authFetch.mockResolvedValue({ ok: true, json: async () => data }); const el = await mount();
  const table = el.shadowRoot!.querySelector('app-data-table')!;
  expect(table.textContent).toContain('观测时间');
  expect(table.querySelector('time')?.getAttribute('datetime')).toBe(bucket.observed_at);
  expect(table.textContent).toContain({ fresh: '新鲜', stale: '过期', unknown: '未知' }[freshness]);
  await el.load(); await settle();
  expect(table.querySelector('time')?.getAttribute('datetime')).toBe(bucket.observed_at);
});
it('old backends without observation timestamps remain unknown instead of using window.to', async () => {
  authFetch.mockResolvedValue({ ok: true, json: async () => result }); const el = await mount();
  expect(el.shadowRoot!.querySelector('app-data-table')!.textContent).toContain('观测时间：未知');
  expect(el.shadowRoot!.querySelector('time')).toBeNull();
});
it('keeps the selected metric through window loading, refresh, empty series and missing definitions', async () => {
  const data = structuredClone(result);
  data.metrics.push({ ...structuredClone(data.metrics[0]), definition: { ...data.metrics[0].definition, id: 'mysql.key_cache.used_percent' }, series: [] });
  authFetch.mockResolvedValue({ ok: true, json: async () => data });
  const el = await mount();
  const select = el.shadowRoot!.querySelector<HTMLSelectElement>('select[aria-label="指标"]')!;
  select.value = 'mysql.key_cache.used_percent'; select.dispatchEvent(new Event('change'));
  await el.updateComplete;
  let finish!: (value: unknown) => void;
  authFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const window = el.shadowRoot!.querySelector<HTMLSelectElement>('select[aria-label="时间范围"]')!;
  window.value = '6'; window.dispatchEvent(new Event('change')); await el.updateComplete;
  expect(select.value).toBe('mysql.key_cache.used_percent');
  finish({ ok: true, json: async () => data }); await settle();
  expect(select.value).toBe('mysql.key_cache.used_percent');
  expect(el.shadowRoot!.querySelectorAll('.metric-name')).toHaveLength(1);
  const query = JSON.parse(authFetch.mock.lastCall![1].body);
  expect(query.view).toBe('all'); // Selection filters the all-metric response locally.
  expect(Date.parse(query.to) - Date.parse(query.from)).toBe(6 * 3600000);
  await el.load(); await el.updateComplete; expect(select.value).toBe('mysql.key_cache.used_percent');
  authFetch.mockResolvedValue({ ok: true, json: async () => result });
  await el.load(); await el.updateComplete;
  expect(select.value).toBe('mysql.key_cache.used_percent');
  expect(el.shadowRoot!.textContent).toContain('当前窗口未返回所选指标');
  select.value = ''; select.dispatchEvent(new Event('change')); await el.updateComplete;
  expect(select.value).toBe(''); expect(el.shadowRoot!.querySelectorAll('.metric-name')).toHaveLength(1);
});
