import { afterEach, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => vi.fn());
vi.mock('./alert-evaluator', () => ({ evaluateAllRules: async () => [] }));
vi.mock('./db-connection', () => ({ dbConnection: { getPool: () => null } }));
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
