import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
// jsdom cannot initialize the ECharts canvas; the chart element only needs to accept its inputs here.
vi.mock('./metric-chart.js', () => {
  if (!customElements.get('metric-chart')) customElements.define('metric-chart', class extends HTMLElement {});
  return {};
});
import { SemanticMetrics, bucketMsFor } from './semantic-metrics.js';
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const result = { profile: { columns: [{ key: 'uptime', metric: { id: 'db.uptime_seconds' }, label: '运行时长' }] }, window: { from: 'start', to: 'end' }, metrics: [
  { definition: { id: 'db.uptime_seconds', category: 'canonical', meaning: 'Database uptime', unit: 's' }, state: 'available', series: [{ dimensions: {}, buckets: [{ value: { encoding: 'uint64', value: '9007199254740993' }, unit: 's', coverage: 1, quality: { status: 'good', reason: 'none' }, freshness: 'fresh', accuracy: 'exact', sources: [{ id: 'source' }], window: { from: 'start', to: 'end' } }] }] },
] };
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); vi.resetAllMocks(); });
const mount = async () => { const el = new SemanticMetrics(); el.resourceId = 1; document.body.append(el); await settle(); return el; };
// Status and attempt reads follow the query; assertions bind to the query call itself.
const lastQuery = () => JSON.parse(authFetch.mock.calls.filter(([url]: [string]) => url === '/api/metrics/query').at(-1)![1].body);
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
  const query = lastQuery();
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
  const query = lastQuery();
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

// ---- MAX240-HISTORY-UI regression coverage ----
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
const instant = '2026-10-14T01:02:03.000Z';
const bucketAt = (index: number, span = 60_000, overrides: Record<string, unknown> = {}) => ({
  value: { encoding: 'float64', value: 10 + index }, unit: 's', coverage: 1,
  quality: { status: 'good', reason: 'none' }, freshness: 'stale', observed_at: instant, accuracy: 'exact', sources: [],
  window: { from: new Date(Date.parse(instant) + index * span).toISOString(), to: new Date(Date.parse(instant) + (index + 1) * span).toISOString() },
  sample_count: 1, stats: { count: 1, min: { encoding: 'float64', value: 10 + index }, max: { encoding: 'float64', value: 10 + index }, avg: { encoding: 'float64', value: 10 + index } }, ...overrides,
});
const withBuckets = (buckets: unknown[], state = 'available') => {
  const data = structuredClone(result);
  (data.metrics[0] as any).state = state;
  (data.metrics[0].series[0] as any).buckets = buckets;
  if (buckets.length) data.window = { from: (buckets[0] as any).window.from, to: (buckets.at(-1) as any).window.to };
  return data;
};
const chartOf = (el: SemanticMetrics) => el.shadowRoot!.querySelector('metric-chart') as any;
const preset = (el: SemanticMetrics, value: string) => {
  const select = el.shadowRoot!.querySelector<HTMLSelectElement>('select[aria-label="时间范围"]')!;
  select.value = value; select.dispatchEvent(new Event('change'));
};
const customInput = (el: SemanticMetrics, label: string, value: string) => {
  const input = el.shadowRoot!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  input.value = value; input.dispatchEvent(new Event('input'));
};
const localInput = (ms: number) => {
  const d = new Date(ms), pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
it('requests complete minute buckets for the 6h, 24h and 7d presets', async () => {
  authFetch.mockResolvedValue(ok(result)); const el = await mount();
  for (const [value, hours] of [['6', 6], ['24', 24], ['168', 168]] as const) {
    preset(el, value); await settle();
    const query = lastQuery();
    expect(query.bucket_ms).toBe(60_000);
    expect(Date.parse(query.to) - Date.parse(query.from)).toBe(hours * 3_600_000);
    expect((Date.parse(query.to) - Date.parse(query.from)) % query.bucket_ms).toBe(0);
  }
});
it('widens the bucket instead of truncating a custom window above the 10,080 bucket limit', () => {
  expect(bucketMsFor(Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-10-08T00:00:00Z'))).toBe(60_000);
  expect(bucketMsFor(Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-10-09T00:00:00Z'))).toBe(120_000);
  expect(bucketMsFor(Date.parse('2026-09-01T00:00:00Z'), Date.parse('2026-10-02T00:00:00Z'))).toBe(300_000);
});
it('validates the custom window with Chinese feedback before querying, then keeps its exact window', async () => {
  authFetch.mockResolvedValue(ok(result)); const el = await mount();
  preset(el, 'custom'); await el.updateComplete;
  const calls = authFetch.mock.calls.length;
  customInput(el, '自定义开始时间', localInput(Date.now() - 3_600_000));
  customInput(el, '自定义结束时间', localInput(Date.now() - 7_200_000));
  el.shadowRoot!.querySelector<HTMLButtonElement>('button.btn')!.click(); await el.updateComplete;
  expect(el.shadowRoot!.textContent).toContain('开始时间必须早于结束时间');
  expect(authFetch.mock.calls.length).toBe(calls);
  customInput(el, '自定义结束时间', localInput(Date.now() + 3_600_000));
  el.shadowRoot!.querySelector<HTMLButtonElement>('button.btn')!.click(); await el.updateComplete;
  expect(el.shadowRoot!.textContent).toContain('结束时间不能晚于当前时间');
  customInput(el, '自定义开始时间', localInput(Date.now() - 32 * 86_400_000));
  customInput(el, '自定义结束时间', localInput(Date.now() - 60_000));
  el.shadowRoot!.querySelector<HTMLButtonElement>('button.btn')!.click(); await el.updateComplete;
  expect(el.shadowRoot!.textContent).toContain('最长 31 天');
  expect(authFetch.mock.calls.length).toBe(calls);
  const from = localInput(Date.now() - 8 * 86_400_000 + 60_000), to = localInput(Date.now() - 60_000);
  customInput(el, '自定义开始时间', from); customInput(el, '自定义结束时间', to);
  el.shadowRoot!.querySelector<HTMLButtonElement>('button.btn')!.click(); await settle();
  const query = lastQuery();
  expect(Date.parse(query.from)).toBe(Date.parse(from));
  expect(Date.parse(query.to)).toBe(Date.parse(to));
  expect(query.bucket_ms).toBe(120_000);
  // Leaving the applied custom range returns to the preset window and refetches.
  preset(el, '24'); await settle();
  const next = lastQuery();
  expect(next.bucket_ms).toBe(60_000);
  expect(Date.parse(next.to) - Date.parse(next.from)).toBe(24 * 3_600_000);
});
it('keeps historical good buckets when freshness is stale and current collection fails', async () => {
  authFetch.mockResolvedValue(ok(withBuckets([bucketAt(0), bucketAt(1), bucketAt(2)], 'temporary_failure')));
  const el = await mount(); await el.updateComplete;
  expect(chartOf(el).series[0].data).toEqual([10, 11, 12]);
  expect(chartOf(el).timeData).toHaveLength(3);
  expect(el.shadowRoot!.textContent).toContain('当前状态不代表历史');
  expect(el.shadowRoot!.textContent).toContain('最近时间桶');
});
it('keeps gaps as breaks and passes the bucket min/max envelope to the chart', async () => {
  const gap = bucketAt(1, 60_000, { value: null, coverage: 0, quality: { status: 'unknown', reason: 'missing_input' }, stats: null, freshness: 'unknown' });
  authFetch.mockResolvedValue(ok(withBuckets([bucketAt(0, 60_000, { stats: { count: 2, min: { encoding: 'float64', value: 1 }, max: { encoding: 'float64', value: 9 }, avg: { encoding: 'float64', value: 5 } } }), gap, bucketAt(2)])));
  const el = await mount(); await el.updateComplete;
  const series = chartOf(el).series[0];
  expect(series.data).toEqual([10, null, 12]);
  expect(series.min).toEqual([1, null, 12]);
  expect(series.max).toEqual([9, null, 12]);
  expect(el.shadowRoot!.textContent).toContain('不补 0');
});
it('does not plot a bucket whose unit does not match the metric definition, but keeps a valid rate unit', async () => {
  const mismatch = withBuckets([bucketAt(0, 60_000, { unit: 'ms' }), bucketAt(1, 60_000, { unit: 'ms' })]);
  (mismatch.metrics[0].definition as any).kind = 'gauge';
  authFetch.mockResolvedValue(ok(mismatch));
  const el = await mount(); await el.updateComplete;
  expect(chartOf(el).series[0].data).toEqual([null, null]);
  expect(el.shadowRoot!.textContent).toContain('单位不符');

  const rate = withBuckets([bucketAt(0, 60_000, { unit: 'By/s' }), bucketAt(1, 60_000, { unit: 'By/s' })]);
  const counter = rate.metrics[0].definition as any;
  counter.kind = 'counter'; counter.unit = 'By'; counter.aggregation = { time: ['rate'], space: ['none'] };
  authFetch.mockResolvedValue(ok(rate)); await el.load(); await el.updateComplete;
  expect(chartOf(el).series[0].data).toEqual([10, 11]);
});
it('renders non-scalar buckets as records instead of forcing a line or a gap', async () => {
  const record = bucketAt(0, 60_000, { value: { encoding: 'histogram', buckets: [{ upper_bound: 1, count: '2' }] } });
  const scalar = bucketAt(1, 60_000);
  authFetch.mockResolvedValue(ok(withBuckets([record, scalar])));
  const el = await mount(); await el.updateComplete;
  expect(chartOf(el).series[0].data).toEqual([null, 11]);
  expect(el.shadowRoot!.textContent).toContain('非标量记录 1');
});
it('bounds the observation detail: no bucket rows by default and at most 200 after opening', async () => {
  const buckets = Array.from({ length: 10_080 }, (_, i) => bucketAt(i));
  authFetch.mockResolvedValue(ok(withBuckets(buckets)));
  const el = await mount(); await el.updateComplete;
  expect(chartOf(el).timeData).toHaveLength(10_080);
  expect(el.shadowRoot!.textContent).toContain('共 10080 个');
  expect(el.shadowRoot!.querySelectorAll('.bucket-row')).toHaveLength(0);
  const details = [...el.shadowRoot!.querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent?.includes('时间桶明细'))!;
  details.open = true; details.dispatchEvent(new Event('toggle')); await el.updateComplete; await settle();
  expect(el.shadowRoot!.querySelectorAll('.bucket-row')).toHaveLength(200);
  expect(el.shadowRoot!.textContent).toContain('仅渲染最近 200 个时间桶');
}, 20_000);
it('discards a late response from an earlier window after a fast switch', async () => {
  let finish!: (value: unknown) => void;
  authFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(ok(withBuckets([bucketAt(0), bucketAt(1)])));
  const el = await mount();
  preset(el, '24'); await settle(); await el.updateComplete;
  expect(chartOf(el).timeData).toHaveLength(2);
  finish(ok(withBuckets([bucketAt(0)]))); await settle();
  expect(chartOf(el).timeData).toHaveLength(2);
});

// ---- MAX240-LATEST-DATA regression coverage ----
const status = (overrides: Record<string, unknown> = {}) => ({
  contract_version: '1.0.0', resource: { type: 'instance', id: 1 }, evaluated_at: instant, can_manage: false,
  binding: { state: 'bound', package: { id: 'mysql-basic', version: '1.1.0', digest: 'sha256:abc' }, published_revision: 3, applied_revision: 3, application: 'applied' },
  effective_enabled: { enabled: true, global_enabled: true, asset_enabled: true, policy_enabled: true, source: 'policy' },
  collection: { state: 'failed', last_attempt_at: '2026-10-14T01:05:00.000Z', last_success_at: '2026-10-14T01:02:03.000Z', in_flight: false },
  formal_visibility: { state: 'available', source: 'semantic', last_observed_at: instant, generation: 1 },
  blockers: ['COLLECTION_FAILED'], coverage: [], ...overrides,
});
const attempt = (overrides: Record<string, unknown> = {}) => ({
  id: 'attempt-1', resource_id: '1', binding_id: 'binding-1', collector_id: 'mysql.basic', config_revision: 1,
  started_at: '2026-10-14T01:05:00.000Z', ended_at: '2026-10-14T01:05:10.000Z',
  status: 'failed', error: 'permission_denied', evidence_code: 'MYSQL_ACCESS_DENIED', observation_ids: [], ...overrides,
});
const route = (data: unknown, statusData: unknown = status(), attemptsData: unknown = [attempt()]) => authFetch.mockImplementation((url: string) => Promise.resolve(
  url.endsWith('/status') ? ok(statusData) : url.endsWith('/attempts') ? ok(attemptsData) : ok(data)));
it('puts the current failure, last attempt reason, last success time and bound template beside the latest value', async () => {
  const data = withBuckets([bucketAt(0, 60_000, { freshness: 'fresh', observed_at: instant, sources: [{ id: 'o1', source: { collector_id: 'mysql.basic' }, versions: { package_id: 'mysql-basic', package_version: '1.1.0' } }] })], 'temporary_failure');
  route(data); const el = await mount(); await el.updateComplete;
  const text = el.shadowRoot!.textContent!;
  expect(text).toContain('最新数据与当前采集状态');
  expect(text).toContain('失败（最近采集失败）');
  expect(text).toContain('最后尝试');
  expect(text).toContain('失败 · 采集权限不足 · MYSQL_ACCESS_DENIED');
  expect(text).toContain('最近成功采集');
  expect(text).toContain('绑定模板');
  expect(text).toContain('MySQL 基础采集 1.1.0');
  expect(text).toContain('当前错误与最近成功值并列显示');
  // A fresh bucket under a failing metric is still not live health.
  expect(el.shadowRoot!.querySelector('.old-value')).not.toBeNull();
  expect(text).toContain('非实时');
  expect(el.shadowRoot!.querySelector('.live-value')).toBeNull();
});
it('keeps an older successful value beside a newer gap and greys it', async () => {
  const gap = bucketAt(1, 60_000, { value: null, coverage: 0, quality: { status: 'unknown', reason: 'missing_input' }, stats: null, freshness: 'unknown' });
  route(withBuckets([bucketAt(0, 60_000, { freshness: 'fresh' }), gap]));
  const el = await mount(); await el.updateComplete;
  const card = el.shadowRoot!.querySelector('.current')!;
  expect(card.textContent).toContain('最近成功值来自较早或已过期的时间桶');
  expect(card.querySelector('.old-value')?.textContent).toContain('10 s');
  expect(card.textContent).toContain('非实时');
});
it('marks a fresh newest value as live and shows its package and collector source', async () => {
  const source = { id: 'o1', source: { collector_id: 'mysql.basic' }, versions: { package_id: 'mysql-basic', package_version: '1.1.0' } };
  route(withBuckets([bucketAt(0, 60_000), bucketAt(1, 60_000, { freshness: 'fresh', sources: [source] })]), status({ collection: { state: 'succeeded', last_attempt_at: '2026-10-14T01:05:00.000Z', last_success_at: '2026-10-14T01:05:00.000Z', in_flight: false }, blockers: [] }), [attempt({ status: 'succeeded', error: null, evidence_code: undefined })]);
  const el = await mount(); await el.updateComplete;
  const card = el.shadowRoot!.querySelector('.current')!;
  expect(card.querySelector('.live-value')?.textContent).toContain('11 s');
  expect(card.textContent).toContain('当前');
  expect(card.textContent).toContain('模板来源：模板 MySQL 基础采集 1.1.0 · 采集器 mysql.basic');
  expect(card.textContent).not.toContain('非实时');
});
it('does not invent a template source when the bucket carries no evidence', async () => {
  route(withBuckets([bucketAt(0, 60_000)]));
  const el = await mount(); await el.updateComplete;
  expect(el.shadowRoot!.querySelector('.current')!.textContent).not.toContain('模板来源');
});
it('shows no success value when every bucket is a gap', async () => {
  const gap = (i: number) => bucketAt(i, 60_000, { value: null, coverage: 0, quality: { status: 'unknown', reason: 'missing_input' }, stats: null, freshness: 'unknown' });
  route(withBuckets([gap(0), gap(1)]));
  const el = await mount(); await el.updateComplete;
  const card = el.shadowRoot!.querySelector('.current')!;
  expect(card.textContent).toContain('暂无最近成功值');
  expect(card.querySelector('.old-value, .live-value')).toBeNull();
});
it('keeps latest values visible when the collection state cannot be read', async () => {
  authFetch.mockImplementation((url: string) => Promise.resolve(url.endsWith('/status')
    ? { ok: false, status: 500, json: async () => ({ error: 'STATUS_UNAVAILABLE' }) } : ok(withBuckets([bucketAt(0)]))));
  const el = await mount(); await el.updateComplete;
  expect(el.shadowRoot!.textContent).toContain('当前采集状态暂不可用');
  expect(el.shadowRoot!.textContent).toContain('10 s');
});
it('clears values when reading the current collection state reveals revoked access', async () => {
  authFetch.mockImplementation((url: string) => Promise.resolve(url.endsWith('/status')
    ? { ok: false, status: 403, json: async () => ({ error: 'POLICY_FORBIDDEN' }) } : ok(withBuckets([bucketAt(0)]))));
  const el = await mount(); await el.updateComplete;
  expect(el.result).toBeNull();
  expect(el.shadowRoot!.textContent).toContain('权限');
});
