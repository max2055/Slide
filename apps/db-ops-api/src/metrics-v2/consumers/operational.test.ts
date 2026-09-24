import { beforeEach, expect, it, vi } from 'vitest';
import { PolicyError } from '../policy/model.js';
const mocks = vi.hoisted(() => ({ effective: vi.fn(), query: vi.fn(), source: vi.fn(), connected: vi.fn() }));
vi.mock('../../db-connection.js', () => ({ dbConnection: { isConnected: mocks.connected } }));
vi.mock('../policy/service.js', () => ({ policyService: { effective: mocks.effective } }));
vi.mock('./runtime.js', () => ({ metricConsumerService: { query: mocks.query }, operationalSource: mocks.source }));
import { evaluateOperationalRule, migrateOperationalChecks } from './operational.js';
const rule = { metric_name: 'connections', operator: '>' as const, threshold: 50, severity: 'warning' as const, duration_seconds: 60 };
beforeEach(() => { vi.resetAllMocks(); mocks.connected.mockReturnValue(true); mocks.source.mockResolvedValue('v2'); mocks.effective.mockResolvedValue({ resolved: { plan: { binding: { package: { id: 'mysql-representative' } } }, settings: { interval_ms: 60000 } } }); });
it('a missing V2 binding never authorizes a legacy fallback after formal cutover', async () => {
  mocks.effective.mockRejectedValueOnce(new PolicyError('POLICY_NOT_FOUND', 404)).mockRejectedValueOnce(new Error('storage failure'));
  expect(await evaluateOperationalRule({ type: 'instance', id: 1 }, rule, 60)).toMatchObject({ handled: true, state: 'unknown' });
  expect(await evaluateOperationalRule({ type: 'instance', id: 1 }, rule, 60)).toMatchObject({ handled: true, state: 'unknown', recovery: false });
  expect(mocks.query).not.toHaveBeenCalled();
});
it('preserves count threshold, returns matching value and migration trace, scopes the internal reader', async () => {
  const to = new Date().toISOString(), from = new Date(Date.parse(to) - 60000).toISOString();
  mocks.query.mockResolvedValue({ metrics: [{ definition: { id: 'mysql.processlist.count', unit: 'count' }, state: 'available', series: [{ dimensions: {}, buckets: [{ value: { encoding: 'uint64', value: '80' }, unit: 'count', window: { from, to }, freshness: 'fresh', coverage: 1, quality: { status: 'good' }, accuracy: 'exact' }] }] }] });
  expect(await evaluateOperationalRule({ type: 'instance', id: 7 }, rule, 60)).toMatchObject({ handled: true, level: 'warning', value: 80, migration: { metric_id: 'mysql.processlist.count', threshold_conversion: 'none', resource: { type: 'instance', id: 7 } } });
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

it('shadow publication leaves legacy alerts and scores active until formal source cutover', async () => {
  mocks.source.mockResolvedValue('legacy');
  const ref = { type: 'instance' as const, id: 1 }, checks = [{ name: '连接数使用率', status: 'ok', score: 100 }];
  expect(await evaluateOperationalRule(ref, rule, 60)).toMatchObject({ handled: false });
  expect(await migrateOperationalChecks(1, checks)).toEqual(checks);
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
