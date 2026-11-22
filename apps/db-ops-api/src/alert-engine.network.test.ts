import { afterEach, expect, it, vi } from 'vitest';

const { network, getPool, evaluateTemplateClock } = vi.hoisted(() => ({
  network: vi.fn(), getPool: vi.fn(() => null), evaluateTemplateClock: vi.fn(),
}));
vi.mock('./alert-evaluator', () => ({ evaluateAllRules: async () => [] }));
vi.mock('./db-connection', () => ({ dbConnection: { getPool } }));
vi.mock('./metrics/triggers/runtime.js', () => ({ evaluateTemplateClock }));
vi.mock('./alert-database-service', () => ({ alertDatabaseService: { getActiveAlerts: async () => [] } }));
vi.mock('./event-aggregator', () => ({ eventAggregator: { aggregate: async () => ({ eventsCreated: 0 }) } }));
vi.mock('./server-alert-evaluator', () => ({ serverAlertEvaluator: {
  evaluateServerRules: async () => {}, checkUnreachable: async () => {},
} }));
vi.mock('./network-devices/network-device-alert-evaluator.js', () => ({ networkDeviceAlertEvaluator: { evaluateNetworkDeviceRules: network } }));
import { alertEngine } from './alert-engine.js';
afterEach(() => vi.restoreAllMocks());

it.each(['partial', 'failed'])('MAX-567 records an incomplete network cycle (%s) in AlertEngine', async status => {
  const result = { status, failed: 1, failures: [{ phase: 'evaluation', deviceId: 1, ruleId: 11 }] };
  network.mockResolvedValue(result);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await alertEngine.evaluateAndCreateAlerts();
  expect(log).toHaveBeenCalledWith('[AlertEngine] Network-device rule evaluation incomplete:', result);
});

it('still evaluates device rules when scanning template bindings fails', async () => {
  const pool = {};
  getPool.mockImplementationOnce(() => pool as never);
  evaluateTemplateClock.mockRejectedValueOnce(new Error('connection failure'));
  network.mockClear().mockResolvedValue({ status: 'ok' });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await alertEngine.evaluateAndCreateAlerts();
  expect(evaluateTemplateClock).toHaveBeenCalledWith(pool);
  expect(network).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith('[TemplateTriggers] Clock could not read applied template bindings');
});
