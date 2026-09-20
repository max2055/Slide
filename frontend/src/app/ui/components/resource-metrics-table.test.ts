import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import { ResourceMetricsTable } from './resource-metrics-table.js';
import { collectionState, metricSummary, diskSummary } from './resource-metric-summary.js';
const sample = (value: number | null = 0, state = 'available'): any => ({ profile: { columns: [] }, window: { from: '2026-09-20T00:00:00Z', to: '2026-09-20T00:01:00Z' }, metrics: [{ definition: { id: 'db.uptime_seconds', unit: 's' }, state, series: [{ dimensions: {}, buckets: [{ value: value == null ? null : { value }, unit: 's', quality: { status: 'good' }, coverage: 1, freshness: 'fresh' }] }] }] });
const response = (data: unknown, status = 200) => ({ ok: status === 200, status, json: async () => data });
const mount = async (count = 1) => { const el = new ResourceMetricsTable(); el.entries = Array.from({ length: count }, (_, i) => ({ id: i + 1, type: i % 2 ? null : 'MySQL', version: '8' })); document.body.append(el); await el.updateComplete; return el as any; };
afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); sessionStorage.clear(); history.replaceState({}, '', '/'); });
it('distinguishes zero from missing and retains stale and partial evidence', () => {
  expect(metricSummary(sample(), 'db.uptime_seconds')).toBe('0 天 0 小时');
  expect(collectionState(sample())).toBe('available');
  expect(collectionState(sample(null))).toBe('partial');
  for (const state of ['not_configured', 'disabled', 'permission_denied', 'temporary_failure', 'capability_unknown']) expect(collectionState(sample(null, state))).toBe(state);
  const stale = sample(); stale.metrics[0].series[0].buckets[0].freshness = 'stale';
  expect(metricSummary(stale, 'db.uptime_seconds')).toContain('已过期');
});
it('does not turn counters into rates or unknown interfaces into healthy interfaces', () => {
  const data = sample(123); data.metrics[0].definition.id = 'host.network.bytes_total'; data.metrics[0].series[0].buckets[0].unit = 'By';
  expect(metricSummary(data, 'host.network.bytes_total')).toBe('等待速率计算');
  data.metrics[0].definition.id = 'network.interface.oper_up'; data.metrics[0].series[0].buckets[0].value = null;
  expect(metricSummary(data, 'network.interface.oper_up')).toContain('在线 0 / 1，离线 0，未知 1');
});
it('bounds visible-page work, updates independent rows, and discards old page responses', async () => {
  let release!: (r: unknown) => void;
  authFetch.mockImplementation(async (url: string, init: any) => {
    if (url.endsWith('/attempts')) return response([]);
    const id = JSON.parse(init.body).resource.id;
    if (id === 1) return new Promise(resolve => { release = resolve; });
    return response(sample(id));
  });
  const el = await mount(25);
  await vi.waitFor(() => expect(el.rows.has(20)).toBe(true));
  expect(el.rows.has(1)).toBe(false); expect(el.rows.has(21)).toBe(false);
  expect(authFetch.mock.calls.filter(c => c[0].endsWith('/query'))).toHaveLength(20);
  el.page = 2; await el.load();
  release(response(sample(999))); await new Promise(r => setTimeout(r, 0));
  expect(el.rows.has(1)).toBe(false); expect(el.rows.has(25)).toBe(true);
});
it('keeps failures visible, clears revoked values and leaves health untouched', async () => {
  authFetch.mockImplementation(async (url: string) => response(url.endsWith('/attempts') ? [] : sample()));
  const el = await mount(); await vi.waitFor(() => expect(el.rows.get(1)?.result).toBeDefined());
  el.entries[0].health = '健康'; authFetch.mockResolvedValue(response({}, 403)); await el.load(true);
  expect(el.rows.get(1)).toEqual({ state: 'forbidden' }); expect(el.visible).toHaveLength(1); expect(el.entries[0].health).toBe('健康');
});
it('unknown type and collection filters cover all pages, including failed rows', async () => {
  authFetch.mockImplementation(async (url: string, init: any) => url.endsWith('/attempts') ? response([]) : JSON.parse(init.body).resource.id === 24 ? response({}, 503) : response(sample()));
  const el = await mount(25); await vi.waitFor(() => expect(el.pending).toBe(false));
  el.search = '指标加载失败'; await el.updateComplete; await vi.waitFor(() => expect(el.pending).toBe(false)); expect(el.filtered.map((r: any) => r.id)).toEqual([24]);
  el.search = '未知 指标加载失败'; await el.updateComplete; await vi.waitFor(() => expect(el.pending).toBe(false)); expect(el.filtered.map((r: any) => r.id)).toEqual([24]);
});
it('success-time transport errors do not erase successful metric evidence', async () => {
  authFetch.mockImplementation(async (url: string) => { if (url.endsWith('/attempts')) throw new Error('network'); return response(sample()); });
  const el = await mount(); await vi.waitFor(() => expect(el.pending).toBe(false)); expect(el.rows.get(1).state).toBe('available'); expect(el.rows.get(1).timeUnavailable).toBe(true);
});

it('disk maximum requires complete matching dimensions and sample windows', () => {
  const data = sample(0); const used = data.metrics[0]; used.definition.id = 'host.filesystem.used_bytes'; used.series[0].dimensions = { mount: '/' }; const a = used.series[0].buckets[0]; a.unit = 'By'; a.window = data.window;
  const size = structuredClone(used); size.definition.id = 'host.filesystem.size_bytes'; size.series[0].buckets[0].value.value = 100; data.metrics.push(size);
  expect(diskSummary(data)).toContain('最高 0.0%');
  size.series[0].buckets[0].window.to = '2026-09-20T00:02:00Z'; expect(diskSummary(data)).toContain('缺少同窗口完整容量');
});

it('combines search terms across metadata and ignores obsolete saved filters', async () => {
  sessionStorage.setItem('resource-list:instance', JSON.stringify({ filters: { type: 'PostgreSQL' }, collection: 'disabled', hiddenColumns: ['version'] }));
  authFetch.mockResolvedValue(response(sample()));
  const el = await mount(25);
  el.search = 'mysql 8'; await el.updateComplete;
  expect(el.filtered).toHaveLength(13);
  expect(el.hiddenColumns).toEqual(['version']);
  expect(el.shadowRoot.querySelectorAll('select')).toHaveLength(0);
  el.search = '未知'; await el.updateComplete;
  expect(el.filtered).toHaveLength(12);
  el.search = 'unknown-no-match'; await el.updateComplete;
  expect(el.filtered).toHaveLength(0);
  el.page = 2; el.search = ''; await el.updateComplete;
  expect(el.page).toBe(1);
});
