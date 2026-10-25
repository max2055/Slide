import { beforeEach, expect, it, vi } from 'vitest';
import { PolicyError } from '../policy/model.js';
const mocks = vi.hoisted(() => ({ effective: vi.fn(), query: vi.fn(), source: vi.fn(), connected: vi.fn() }));
vi.mock('../../db-connection.js', () => ({ dbConnection: { isConnected: mocks.connected } }));
vi.mock('../policy/service.js', () => ({ policyService: { effective: mocks.effective } }));
vi.mock('./runtime.js', () => ({ metricConsumerService: { query: mocks.query }, operationalSource: mocks.source }));
import { evaluateOperationalRule, migrateOperationalChecks } from './operational.js';
const rule = { metric_name: 'connections', operator: '>' as const, threshold: 50, severity: 'warning' as const, duration_seconds: 60 };
beforeEach(() => { vi.resetAllMocks(); mocks.connected.mockReturnValue(true); mocks.source.mockResolvedValue('semantic'); mocks.effective.mockResolvedValue({ resolved: { plan: { binding: { package: { id: 'mysql-representative' } } }, settings: { interval_ms: 60000 } } }); });
it('a missing binding never authorizes a legacy fallback after formal cutover', async () => {
  mocks.effective.mockRejectedValueOnce(new PolicyError('POLICY_NOT_FOUND', 404)).mockRejectedValueOnce(new Error('storage failure'));
  expect(await evaluateOperationalRule({ type: 'instance', id: 1 }, rule, 60)).toMatchObject({ handled: true, state: 'unknown' });
  expect(await evaluateOperationalRule({ type: 'instance', id: 1 }, rule, 60)).toMatchObject({ handled: true, state: 'unknown', recovery: false });
  expect(mocks.query).not.toHaveBeenCalled();
});
it('preserves count threshold, returns matching value and migration trace, scopes the internal reader', async () => {
  const to = new Date().toISOString(), from = new Date(Date.parse(to) - 60000).toISOString();
  mocks.query.mockResolvedValue({ metrics: [{ definition: { id: 'mysql.processlist.count', unit: 'count' }, state: 'available', series: [{ dimensions: {}, buckets: [{ value: { encoding: 'uint64', value: '80' }, unit: 'count', window: { from, to }, freshness: 'fresh', coverage: 1, quality: { status: 'good' }, accuracy: 'exact' }] }] }] });
  expect(await evaluateOperationalRule({ type: 'instance', id: 7 }, rule, 60)).toMatchObject({ handled: true, level: 'warning', value: 80, observation:{from,to,observedAt:null,quality:'good'}, migration: { metric_id: 'mysql.processlist.count', threshold_conversion: 'none', resource: { type: 'instance', id: 7 } } });
  expect(mocks.query.mock.calls[0][0].instanceScopes).toEqual({ 7: 'read-only' });
  expect(mocks.query.mock.calls[0][0].permissions).not.toContain('*');
});
it('retains legacy score policies but marks unsupported ratios unknown instead of healthy', async () => {
  const checks = [{ name: '连接状态', status: 'ok', score: 100 }, { name: '连接数使用率', status: 'ok', score: 100 }];
  expect(await migrateOperationalChecks(1, checks)).toMatchObject([{ status: 'ok' }, { status: 'unknown', score: 0 }]);
  expect(checks[1].score).toBe(100);
  mocks.effective.mockRejectedValue(new PolicyError('POLICY_NOT_FOUND', 404));
  expect(await migrateOperationalChecks(1, checks)).toMatchObject([{ status: 'ok' }, { status: 'unknown' }]);
});

it('historical sources cannot reactivate retired alert and score readers', async () => {
  mocks.source.mockResolvedValue('legacy');
  const ref = { type: 'instance' as const, id: 1 }, checks = [{ name: '连接数使用率', status: 'ok', score: 100 }];
  expect(await evaluateOperationalRule(ref, rule, 60)).toMatchObject({ handled: true, state: 'unknown' });
  expect(await migrateOperationalChecks(1, checks)).toMatchObject([{ status: 'unknown', score: 0 }]);
  expect(mocks.effective).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  expect(await evaluateOperationalRule(ref, { ...rule, metric_name: 'mysql.processlist.count' }, 60)).toMatchObject({ handled: true, state: 'unknown', recovery: false });
});
it.each(['pending', 'failure'])('does not recover alerts or use legacy healthy scores when formal source is %s', async state => {
  if (state === 'failure') mocks.source.mockRejectedValue(new Error('private storage error'));
  else mocks.source.mockResolvedValue(state);
  expect(await evaluateOperationalRule({ type: 'instance', id: 1 }, rule, 60)).toMatchObject({ handled: true, state: 'unknown', recovery: false });
  expect(await migrateOperationalChecks(1, [{ name: '连接数使用率', status: 'ok', score: 100 }])).toMatchObject([{ status: 'unknown', score: 0 }]);
  expect(mocks.query).not.toHaveBeenCalled();
});

it('loss of the source store cannot authorize legacy fallback or recovery', async () => {
  mocks.connected.mockReturnValue(false);
  expect(await evaluateOperationalRule({ type: 'instance', id: 1 }, rule, 60)).toMatchObject({ handled: true, state: 'unknown', recovery: false });
  expect(await migrateOperationalChecks(1, [{ name: '连接数使用率', status: 'ok', score: 100 }])).toMatchObject([{ status: 'unknown', score: 0 }]);
  expect(mocks.source).not.toHaveBeenCalled();
});

function rateMetric(value: { encoding: 'float64'; value: number } | null, quality: string, accuracy = 'estimated') {
  const to = new Date().toISOString(), from = new Date(Date.parse(to) - 60000).toISOString();
  return { metrics: [{ definition: { id: 'mysql.queries.per_second', unit: 'count/s', kind: 'gauge' }, state: 'available',
    series: [{ dimensions: {}, buckets: [{ value, unit: 'count/s', window: { from, to }, freshness: 'fresh', coverage: 1,
      quality: quality === 'good' ? { status: 'good', reason: 'none' } : quality === 'partial'
        ? { status: 'partial', reason: 'precision_loss' } : { status: 'unknown', reason: 'counter_reset' }, accuracy }] }] }] };
}
const rateRule = { metric_name: 'mysql.queries.per_second', operator: '>=' as const, threshold: 0,
  severity: 'warning' as const, duration_seconds: 0, threshold_template: { warning: 0 } };

it('accepts a derived rate whose float encoding is partial/estimated', async () => {
  mocks.query.mockResolvedValue(rateMetric({ encoding: 'float64', value: 630 }, 'partial'));
  expect(await evaluateOperationalRule({ type: 'instance', id: 1 }, { ...rateRule, threshold: 100,
    threshold_template: { warning: 100 } }, 0)).toMatchObject({
    handled: true, level: 'warning', value: 630,
    migration: { metric_id: 'mysql.queries.per_second', threshold_conversion: 'none' },
  });
});

it('distinguishes a real zero from an unknown counter reset', async () => {
  mocks.query.mockResolvedValue(rateMetric({ encoding: 'float64', value: 0 }, 'good', 'exact'));
  expect(await evaluateOperationalRule({ type: 'instance', id: 1 }, rateRule, 0)).toMatchObject({
    handled: true, level: 'warning', value: 0,
  });

  mocks.query.mockResolvedValue(rateMetric(null, 'unknown', 'unknown'));
  expect(await evaluateOperationalRule({ type: 'instance', id: 1 }, rateRule, 0)).toMatchObject({
    handled: true, state: 'unknown', level: null, value: null,
  });
});

it('drops only the empty trailing bucket at the query edge, never a stale or missing middle bucket', async () => {
  const now = Date.now(), one = 60_000;
  const bucket = (index: number, value: string | null, freshness: string, sample_count: number) => ({
    contract_version: '1.0.0', metric: { id: 'mysql.processlist.count', semantic_version: '1.0.0' }, unit: 'count',
    dimensions: {}, window: { from: new Date(now - (3 - index) * one).toISOString(), to: new Date(now - (2 - index) * one).toISOString() },
    value: value === null ? null : { encoding: 'uint64', value }, quality: value === null
      ? { status: 'unknown', reason: 'missing_input' } : { status: 'good', reason: 'none' },
    accuracy: value === null ? 'unknown' : 'exact', coverage: value === null ? 0 : 1, freshness, sample_count,
    sources: [],
  });
  mocks.query.mockResolvedValue({ metrics: [{ definition: { id: 'mysql.processlist.count', unit: 'count', kind: 'gauge' },
    state: 'available', series: [{ dimensions: {}, buckets: [bucket(0, '80', 'fresh', 1), bucket(1, null, 'unknown', 0)] }] }] });
  expect(await evaluateOperationalRule({ type: 'instance', id: 1 }, rule, 60)).toMatchObject({
    handled: true, level: 'warning', value: 80,
  });

  mocks.query.mockResolvedValue({ metrics: [{ definition: { id: 'mysql.processlist.count', unit: 'count', kind: 'gauge' },
    state: 'available', series: [{ dimensions: {}, buckets: [bucket(0, '80', 'stale', 1)] }] }] });
  expect(await evaluateOperationalRule({ type: 'instance', id: 1 }, rule, 60)).toMatchObject({
    handled: true, state: 'unknown', level: null, value: null,
  });
});

it('keeps the legacy qps name blocked instead of silently evaluating the new rate', async () => {
  const result = await evaluateOperationalRule({ type: 'instance', id: 1 },
    { ...rule, metric_name: 'qps' }, 60);
  expect(result).toMatchObject({ handled: true, state: 'unknown', level: null, value: null,
    migration: { metric_id: null, status: 'review_required', threshold_conversion: 'none' } });
  expect(mocks.query).not.toHaveBeenCalled();
});
