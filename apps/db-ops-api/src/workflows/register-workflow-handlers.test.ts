import { afterEach, expect, it, vi } from 'vitest';
import { deliveryStore } from './delivery-store.js';
import { workflowExecution } from './execution-context.js';
import { JobRegistry } from './job-registry.js';
import { registerWorkflowHandlers } from './register-workflow-handlers.js';

const keys = [
  'fault.diagnose-unhealthy', 'capacity.collect', 'baseline.cleanup', 'alert.evaluate',
  'capacity.consistency', 'report.schedule', 'notification.dispatch', 'notification.deliver', 'report.notify',
];
function setup() {
  const events: string[] = [];
  const controller = new AbortController();
  const context = { signal: controller.signal, workerId: 'test', fencingToken: 7 };
  const step = (name: string) => vi.fn(async (..._args: unknown[]) => {
    expect(workflowExecution.getStore()).toBe(context);
    events.push(name);
  });
  const actions = {
    fault: step('fault'), collect: step('collect'), cleanup: step('cleanup'), evaluate: step('evaluate'),
    capacityEnqueue: step('capacityEnqueue'), consistency: step('consistency'),
    pending: step('pending'), dispatchEnqueue: step('dispatchEnqueue'), reportEnqueue: step('reportEnqueue'),
  };
  const occurrences = { lastOccurrence: vi.fn(async () => null), claim: vi.fn(async () => true), complete: vi.fn(), fail: vi.fn() };
  const deps = {
    faultDiagnosisService: { diagnoseUnhealthyInstances: actions.fault },
    monitorCollector: { collectCapacityNow: actions.collect },
    baselineCalculator: { cleanupOldBaselines: actions.cleanup },
    alertEngine: { triggerEvaluation: actions.evaluate },
    workflowStore: { enqueue: actions.capacityEnqueue },
    capacityConsistencyMonitor: { runOnce: actions.consistency },
    notificationScheduler: { enqueuePending: actions.pending },
    enqueueNotificationDispatch: actions.dispatchEnqueue,
    reportSchedule: {
      reportConfigService: { getEnabledConfigs: vi.fn(async () => []), getConfigById: vi.fn() },
      serverReportService: { generateAndPersist: vi.fn() }, reportService: { generateReport: vi.fn() },
      enqueueReportSchedule: actions.reportEnqueue, enqueueReportNotifications: vi.fn(),
      createOccurrenceStore: vi.fn(() => occurrences),
    },
    notificationDatabaseService: { getAlertById: vi.fn(async () => null), getChannelById: vi.fn(async () => null) },
    notificationService: { send: vi.fn(), buildMessage: vi.fn() },
    reportDatabaseService: { getReportById: vi.fn(async () => null) },
  } satisfies Parameters<typeof registerWorkflowHandlers>[1];
  const registry = new JobRegistry();
  const register = vi.spyOn(registry, 'register');
  registerWorkflowHandlers(registry, deps);
  const run = (type: string, payload = {}) => registry.execute({ id: 'job', type, payload, attempts: 1, maxAttempts: 5, fencingToken: 7 }, context);
  return { events, controller, context, actions, deps, occurrences, registry, register, run };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('registers exactly the ordered keys without executing handlers, querying stores or creating occurrence stores', () => {
  const h = setup();
  expect(h.register.mock.calls.map(([key]) => key)).toEqual(keys);
  for (const key of keys) expect(h.registry.has(key)).toBe(true);
  for (const action of Object.values(h.actions)) expect(action).not.toHaveBeenCalled();
  for (const service of [h.deps.reportSchedule.reportConfigService, h.deps.notificationDatabaseService, h.deps.reportDatabaseService, h.deps.notificationService]) {
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  }
  expect(h.deps.reportSchedule.createOccurrenceStore).not.toHaveBeenCalled();
  expect(h.events).toEqual([]);
});

const simple = [
  ['fault.diagnose-unhealthy', 'fault'], ['capacity.collect', 'collect'],
  ['baseline.cleanup', 'cleanup'], ['alert.evaluate', 'evaluate'],
] as const;
it.each(simple)('%s awaits its service with no arguments and propagates the same rejection', async (key, action) => {
  const h = setup();
  let release!: () => void;
  h.actions[action].mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  let completed = false;
  const running = h.run(key).then(() => { completed = true; });
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(h.actions[action]).toHaveBeenCalledWith();
  release(); await running;
  const error = new Error(action);
  h.actions[action].mockRejectedValueOnce(error);
  await expect(h.run(key)).rejects.toBe(error);
  await h.run(key);
  expect(h.events).toEqual([action]);
});
it.each(keys)('%s does not invoke dependencies when already cancelled', async key => {
  const h = setup(); const reason = new Error('cancelled'); h.controller.abort(reason);
  await expect(h.run(key)).rejects.toBe(reason);
  expect(h.events).toEqual([]);
  expect(h.deps.reportSchedule.createOccurrenceStore).not.toHaveBeenCalled();
  expect(h.deps.notificationDatabaseService.getChannelById).not.toHaveBeenCalled();
});
it.each(simple)('%s preserves cancellation after its awaited service', async (key, action) => {
  const h = setup(); const reason = new Error('cancelled');
  h.actions[action].mockImplementationOnce(async () => { h.controller.abort(reason); });
  await expect(h.run(key)).rejects.toBe(reason);
  expect(h.actions[action]).toHaveBeenCalledWith();
});
it('enqueues the 300-second capacity successor before running the monitor with the original signal', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000);
  const h = setup(); await h.run('capacity.consistency');
  expect(h.events).toEqual(['capacityEnqueue', 'consistency']);
  expect(h.actions.capacityEnqueue).toHaveBeenCalledWith({
    id: 'capacity-consistency-1', type: 'capacity.consistency', schemaVersion: 1,
    payload: {}, idempotencyKey: 'capacity-consistency:1', maxAttempts: 5, availableAt: new Date(301_000),
  });
  expect(h.actions.consistency).toHaveBeenCalledWith(h.context.signal);
});
it('enqueues pending notifications before computing the 10-second successor from the current time', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000);
  const h = setup();
  h.actions.pending.mockImplementationOnce(async () => { h.events.push('pending'); vi.setSystemTime(5_000); });
  await h.run('notification.dispatch');
  expect(h.events).toEqual(['pending', 'dispatchEnqueue']);
  expect(h.actions.pending).toHaveBeenCalledWith(h.context.signal);
  expect(h.actions.dispatchEnqueue).toHaveBeenCalledWith(new Date(15_000));
});
const recurring = [
  ['capacity.consistency', 'capacityEnqueue', 'consistency'],
  ['notification.dispatch', 'pending', 'dispatchEnqueue'],
] as const;
it.each(recurring)('%s waits for the first step and honours cancellation before the second', async (key, first, second) => {
  const h = setup(); let release!: () => void;
  h.actions[first].mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const running = h.run(key);
  expect(h.actions[second]).not.toHaveBeenCalled();
  const reason = new Error('cancelled'); h.controller.abort(reason); release();
  await expect(running).rejects.toBe(reason);
  expect(h.actions[second]).not.toHaveBeenCalled();
});
it.each(recurring)('%s propagates either awaited failure without doing later work', async (key, first, second) => {
  for (const stage of [first, second]) {
    const h = setup(); const reason = new Error(stage);
    h.actions[stage].mockRejectedValueOnce(reason);
    await expect(h.run(key)).rejects.toBe(reason);
    expect(h.actions[first]).toHaveBeenCalledTimes(1);
    expect(h.actions[second]).toHaveBeenCalledTimes(stage === first ? 0 : 1);
  }
});
it.each(recurring)('%s awaits the final step and preserves cancellation at completion', async (key, _first, second) => {
  const h = setup(); let release!: () => void;
  h.actions[second].mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  let completed = false;
  const running = h.run(key).finally(() => { completed = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(h.actions[second]).toHaveBeenCalledTimes(1); expect(completed).toBe(false);
  const reason = new Error('cancelled'); h.controller.abort(reason); release();
  await expect(running).rejects.toBe(reason);
});
it('connects the existing report registrar to the supplied lazy dependencies', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000);
  const h = setup(); await h.run('report.schedule');
  expect(h.actions.reportEnqueue).toHaveBeenCalledWith(new Date(61_000));
  expect(h.deps.reportSchedule.createOccurrenceStore).toHaveBeenCalledTimes(1);
  expect(h.deps.reportSchedule.reportConfigService.getEnabledConfigs).toHaveBeenCalledWith();
  expect(h.actions.reportEnqueue).toHaveBeenCalledBefore(h.deps.reportSchedule.createOccurrenceStore);
});
it.each(['notification.deliver', 'report.notify'])('connects %s to the existing sender registrar without real delivery', async key => {
  const snapshot = vi.spyOn(deliveryStore, 'snapshot').mockResolvedValue(null);
  const acquire = vi.spyOn(deliveryStore, 'acquire').mockResolvedValue(null);
  const h = setup(); await h.run(key, { alertId: 12, reportId: 13, channelId: 8 });
  expect(snapshot).toHaveBeenCalledWith(key === 'report.notify' ? 'report:13:8' : 'notification:12:8');
  expect(h.deps.notificationDatabaseService.getChannelById).toHaveBeenCalledWith(8);
  if (key === 'report.notify') expect(h.deps.reportDatabaseService.getReportById).toHaveBeenCalledWith(13);
  else expect(h.deps.notificationDatabaseService.getAlertById).toHaveBeenCalledWith(12);
  expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ type: key }), h.context, null);
  expect(h.deps.notificationService.send).not.toHaveBeenCalled();
});
