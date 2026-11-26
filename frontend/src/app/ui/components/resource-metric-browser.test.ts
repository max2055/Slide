import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('./metric-chart.js', () => {
  if (!customElements.get('metric-chart')) customElements.define('metric-chart', class extends HTMLElement {});
  return {};
});
vi.mock('./metric-study.js', () => ({}));
import { ResourceMetricBrowser } from './resource-metric-browser.js';

const at = '2026-11-20T05:00:01.000Z';
const metricRef = { id: 'mysql.innodb.deadlocks_total', semantic_version: '1.0.0' };
const dimensions = { target: 'primary' };
const counter = {
  definition: { ...metricRef, kind: 'counter', value_type: 'uint64', unit: 'count', meaning: 'deadlocks' },
  state: 'available',
  series: [{ dimensions, observed_at: at, value: { encoding: 'uint64', value: '0' }, unit: 'count',
    quality: { status: 'good' }, freshness: 'fresh', accuracy: 'exact' }],
};
const textMetric = {
  definition: { id: 'fixture.device.message', semantic_version: '1.0.0', kind: 'text', value_type: 'text', unit: '1', meaning: 'message' },
  state: 'available',
  series: [{ ...counter.series[0], dimensions: {}, value: { encoding: 'text', value: '<log>\n设备恢复' }, unit: '1' }],
};
const response = (value: unknown) => ({ ok: true, json: async () => value });
const calls = (route: string) => authFetch.mock.calls
  .filter(([path]) => path === '/api/metrics/' + route).map(([, options]) => JSON.parse(options.body));
const button = (element: ResourceMetricBrowser, label: string) => Array.from(element.shadowRoot!.querySelectorAll<HTMLButtonElement>('button'))
  .find(item => item.textContent?.trim() === label)!;
const waitForText = (element: ResourceMetricBrowser, text: string) =>
  vi.waitFor(() => expect(element.shadowRoot!.textContent).toContain(text));
const mount = async (type = 'instance') => {
  const element = new ResourceMetricBrowser();
  element.resourceType = type; element.resourceId = 1;
  document.body.append(element);
  await waitForText(element, '最新采集数据');
  await vi.waitFor(() => expect(element.shadowRoot!.querySelector('app-data-table')).not.toBeNull());
  return element;
};

beforeEach(() => {
  history.replaceState({}, '', '/instance-detail');
  authFetch.mockImplementation(async (path, options) => {
    const body = JSON.parse(options.body);
    if (path.endsWith('/latest')) return response({ resource: body, evaluated_at: at, metrics: [counter, textMetric] });
    const window = { from: body.from, to: body.to };
    if (path.endsWith('/query')) return response({ resource: body.resource, window, metrics: [{ definition: counter.definition,
      series: [{ dimensions, buckets: [{ value: { encoding: 'uint64', value: '0' }, unit: 'count', quality: { status: 'good' }, window }] }] }] });
    return response({ resource: body.resource, metric: body.metric, dimensions: body.dimensions, window,
      observations: [body.metric.id === metricRef.id ? counter.series[0] : textMetric.series[0]],
      total: 51, has_more: !body.cursor, next_cursor: body.cursor ? undefined : 'fixture-next' });
  });
});
afterEach(() => {
  document.body.replaceChildren();
  vi.resetAllMocks();
});

it.each(['instance', 'server', 'network_device'])('starts %s at the same exact-value list without requesting history', async type => {
  const element = await mount(type);
  expect(calls('latest')).toEqual([{ type, id: 1 }]);
  expect(calls('query')).toHaveLength(0);
  expect(calls('observations')).toHaveLength(0);
  expect(element.shadowRoot!.querySelector('time')?.getAttribute('datetime')).toBe(at);
  expect(element.shadowRoot!.textContent).toContain('0 次');
  expect(button(element, '图形')).toBeDefined();
  expect(button(element, '历史记录')).toBeDefined();
});

it('switches the exact series from graph to raw values and maintains the same custom window and page cursor', async () => {
  const element = await mount();
  button(element, '图形').click();
  await vi.waitFor(() => expect(element.shadowRoot!.querySelector('metric-chart')).not.toBeNull());
  expect(calls('query')[0]).toMatchObject({ series: { metric: metricRef, dimensions }, history: true, include_retained_trends: true });
  button(element, '查看采集详情').click();
  await waitForText(element, '第 1 页 · 按采样时间升序');
  expect(calls('observations')[0]).toMatchObject({ metric: metricRef, dimensions,
    from: calls('query')[0].from, to: calls('query')[0].to });

  button(element, '下一页').click();
  await waitForText(element, '第 2 页');
  expect(calls('observations').at(-1)?.cursor).toBe('fixture-next');
  const select = element.shadowRoot!.querySelector('select')!;
  select.value = '15'; select.dispatchEvent(new Event('change'));
  await waitForText(element, '第 1 页');
  const window = calls('observations').at(-1)!;
  expect(window.cursor).toBeUndefined();
  expect(Date.parse(window.to) - Date.parse(window.from)).toBe(15 * 60_000);
  button(element, '返回指标列表').click();
  await vi.waitFor(() => expect(element.shadowRoot!.activeElement).toBe(button(element, '图形')));
});

it('plots retained mean and bounds alongside detail, while long windows stay chart-only', async () => {
  const element = await mount();
  authFetch.mockImplementationOnce(async (_path, options) => {
    const { resource, from, to } = JSON.parse(options.body), window = { from, to };
    const bucket = (value: number | null) => ({ window, unit: 'count', quality: { status: 'good' },
      value: value === null ? null : { encoding: 'float64', value } });
    return response({ resource, window, metrics: [{ definition: counter.definition, series: [{ dimensions, buckets: [
      { ...bucket(4.5), retained_sample_count: 4, stats: { min: { encoding: 'uint64', value: '1' }, max: { encoding: 'uint64', value: '8' } } },
      bucket(null), bucket(0),
    ] }] }] });
  });
  button(element, '图形').click();
  await waitForText(element, '含保留趋势的桶显示平均值');
  const chart = element.shadowRoot!.querySelector('metric-chart') as unknown as { series: unknown };
  expect(chart.series).toMatchObject([{ data: [4.5, null, 0], min: [1, null, null], max: [8, null, null], showIsolatedPoints: true }]);
  const select = element.shadowRoot!.querySelector('select')!;
  select.value = '129600'; select.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(calls('query')).toHaveLength(2));
  const beforeSwitch = calls('query').at(-1)!;
  expect(Date.parse(beforeSwitch.to) - Date.parse(beforeSwitch.from)).toBe(90 * 86_400_000);
  button(element, '查看采集详情').click();
  await waitForText(element, '数值查询最长 31 天');
  expect(calls('observations')).toHaveLength(0);
});

it('plots trend evidence at a failed detail bucket as markers and keeps the detail line broken', async () => {
  const element = await mount();
  authFetch.mockImplementationOnce(async (_path, options) => {
    const { resource, from, to } = JSON.parse(options.body), window = { from, to };
    const value = (value: number) => ({ encoding: 'float64', value });
    return response({ resource, window, metrics: [{ definition: counter.definition, series: [{ dimensions, buckets: [
      { window, unit: 'count', value: null, quality: { status: 'unknown' }, retained_sample_count: 2,
        stats: { avg: value(4.5), min: value(1), max: value(8) } },
      { window, unit: 'count', value: null, quality: { status: 'unknown' } },
    ] }] }] });
  });
  button(element, '图形').click();
  await waitForText(element, '含保留趋势的桶显示平均值');
  const chart = element.shadowRoot!.querySelector('metric-chart') as unknown as { series: unknown };
  expect(chart.series).toMatchObject([{ data: [null, null] },
    { data: [4.5, null], min: [1, null], max: [8, null], pointsOnly: true }]);
});

it.each([{ value_type: 'float64', visible: true }, { value_type: 'uint64', visible: false }] as const)
('uses the series encoding to decide whether large $value_type trend values can be plotted', async ({ value_type, visible }) => {
  const definition = { ...counter.definition, value_type };
  authFetch.mockImplementationOnce(async (_path, options) =>
    response({ resource: JSON.parse(options.body), evaluated_at: at, metrics: [{ ...counter, definition }] }));
  const element = await mount();
  authFetch.mockImplementationOnce(async (_path, options) => {
    const { resource, from, to } = JSON.parse(options.body), window = { from, to };
    return response({ resource, window, metrics: [{ definition, series: [{ dimensions, buckets: [
      { window, unit: 'count', value: { encoding: 'float64', value: 2 ** 54 }, quality: { status: 'good' }, retained_sample_count: 2 },
    ] }] }] });
  });
  button(element, '图形').click();
  await waitForText(element, visible ? '含保留趋势的桶显示平均值' : '该时段没有可绘制的数值');
  expect(Boolean(element.shadowRoot!.querySelector('metric-chart'))).toBe(visible);
});

it('uses text history with time filtering and renders characters as text', async () => {
  const element = await mount();
  button(element, '历史记录').click();
  await waitForText(element, '<log>\n设备恢复');
  const select = element.shadowRoot!.querySelector('select')!;
  select.value = 'custom'; select.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(element.shadowRoot!.querySelectorAll('input[type=datetime-local]')).toHaveLength(2));
  const inputs = [...element.shadowRoot!.querySelectorAll<HTMLInputElement>('input[type=datetime-local]')];
  for (const [input, value] of inputs.map((input, index) => [input, '2026-11-19T10:0' + index] as const)) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  button(element, '应用').click();
  await waitForText(element, '<log>\n设备恢复');
  expect(calls('query')).toHaveLength(0);
  expect(calls('observations')).toHaveLength(2);
  expect(calls('observations')[1].from).toBe(new Date(inputs[0].value).toISOString());
  expect(element.shadowRoot!.querySelector('metric-chart')).toBeNull();
  expect(element.shadowRoot!.querySelector('log')).toBeNull();
});

it('shows large byte counts exactly in the raw value column', async () => {
  const definition = { ...counter.definition, id: 'host.filesystem.used_bytes', unit: 'By', kind: 'gauge' };
  const sample = { ...counter.series[0], unit: 'By', value: { encoding: 'uint64', value: '9007199254740993' } };
  authFetch.mockImplementationOnce(async (_path, options) =>
    response({ resource: JSON.parse(options.body), evaluated_at: at, metrics: [{ ...counter, definition, series: [sample] }] }));
  const element = await mount('server');
  button(element, '图形').click();
  await element.updateComplete;
  authFetch.mockImplementationOnce(async (_path, options) => {
    const { from, to, resource, metric, dimensions } = JSON.parse(options.body);
    return response({ resource, metric, dimensions, window: { from, to }, observations: [sample], total: 1, has_more: false });
  });
  button(element, '查看采集详情').click();
  await vi.waitFor(() => expect(element.shadowRoot!.querySelector('tbody .number')?.textContent).toBe('9007199254740993 B'));
});

it('rejects a raw page for a different dimension even when the window matches', async () => {
  const element = await mount();
  button(element, '图形').click();
  await element.updateComplete;
  authFetch.mockImplementationOnce(async (_path, options) => {
    const { from, to, resource, metric } = JSON.parse(options.body);
    return response({ resource, metric, dimensions: { target: 'other' }, window: { from, to },
      observations: [{ ...counter.series[0], value: { encoding: 'uint64', value: '8675309' } }], total: 1, has_more: false });
  });
  button(element, '查看采集详情').click();
  await vi.waitFor(() => expect(element.shadowRoot!.querySelector('[role="alert"]')?.textContent ?? '').toContain('指标历史'));
  expect(element.shadowRoot!.textContent).not.toContain('8675309');
});

it('shows a structured histogram without changing exact count strings', async () => {
  const definition = { ...textMetric.definition, id: 'fixture.device.histogram', kind: 'histogram', value_type: 'histogram' };
  const sample = { ...textMetric.series[0], value: { encoding: 'histogram', count: '9007199254740993', sum: 19,
    buckets: [{ upper_bound: '+Inf', count: '9007199254740993' }] } };
  authFetch.mockImplementationOnce(async (_path, options) =>
    response({ resource: JSON.parse(options.body), evaluated_at: at, metrics: [{ ...textMetric, definition, series: [sample] }] }));
  const element = await mount('network_device');
  authFetch.mockImplementationOnce(async (_path, options) => {
    const { from, to, resource, metric, dimensions } = JSON.parse(options.body);
    return response({ resource, metric, dimensions, window: { from, to }, observations: [sample], total: 1, has_more: false });
  });
  button(element, '历史记录').click();
  await waitForText(element, '查看结构化值');
  const details = [...element.shadowRoot!.querySelectorAll('tbody details')].find(node => node.textContent?.includes('查看结构化值'));
  expect(JSON.parse(details!.querySelector('pre')!.textContent!)).toEqual(sample.value);
  expect(calls('query')).toHaveLength(0);
});

it('does not show a late history reply after the authorization context changes', async () => {
  const element = await mount();
  let complete!: (value: unknown) => void;
  authFetch.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  button(element, '图形').click();
  await vi.waitFor(() => expect(calls('query')).toHaveLength(1));
  authFetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: 'FORBIDDEN' }) });
  window.dispatchEvent(new Event('slide-permissions-loaded'));
  complete(response({ window: calls('query')[0], metrics: [] }));
  await waitForText(element, '没有此资源的查看权限');
  expect(element.shadowRoot!.querySelector('metric-chart')).toBeNull();
  expect(element.shadowRoot!.querySelector('app-data-table')).toBeNull();
});
