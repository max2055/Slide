import { afterEach, expect, it, vi } from 'vitest';
import { ReportScheduler } from '../report-scheduler.js';
import type { ReportConfig } from '../report-config-database-service.js';
import { workflowExecution } from './execution-context.js';
import { JobRegistry } from './job-registry.js';
import { registerReportScheduleHandler } from './report-schedule-handler.js';

const due = [1, 2].map(configId => ({ configId, occurrenceAt: new Date('2026-09-17') }));
function setup() {
  const events: string[] = [];
  const controller = new AbortController();
  const context = { signal: controller.signal, workerId: 'test', fencingToken: 7 };
  const step = (name: string) => { expect(workflowExecution.getStore()).toBe(context); events.push(name); };
  const config = { id: 1, type: 'server_health', server_id: 9, instance_id: 4, format: 'html', notification_channel_ids: [8, 3] } as ReportConfig;
  const store = {
    lastOccurrence: vi.fn(async () => null), claim: vi.fn(async () => true),
    complete: vi.fn(async () => { step('complete'); }), fail: vi.fn(async () => { step('fail'); }),
  };
  const deps = {
    reportConfigService: {
      getEnabledConfigs: vi.fn(async () => [] as ReportConfig[]),
      getConfigById: vi.fn(async () => { step('config'); return config as ReportConfig | null; }),
    },
    serverReportService: { generateAndPersist: vi.fn(async () => { step('generate'); return { success: true, reportId: 42 as number | undefined }; }) },
    reportService: { generateReport: vi.fn(async () => { step('generate'); return { id: 43 } as Awaited<ReturnType<Parameters<typeof registerReportScheduleHandler>[1]['reportService']['generateReport']>>; }) },
    enqueueReportSchedule: vi.fn(async (_date: Date) => { step('enqueue'); }),
    enqueueReportNotifications: vi.fn(async (_id: number, _channels: readonly number[]) => { step('notify'); }),
    createOccurrenceStore: vi.fn(() => { step('store'); return store; }),
  };
  const claim = vi.spyOn(ReportScheduler.prototype, 'claimDue').mockImplementation(async () => { step('claim'); return due; });
  const registry = new JobRegistry();
  const register = vi.spyOn(registry, 'register');
  registerReportScheduleHandler(registry, deps);
  const run = () => registry.execute({ id: 'job', type: 'report.schedule', payload: {}, attempts: 1, maxAttempts: 5, fencingToken: 7 }, context);
  return { events, controller, config, store, deps, claim, register, run };
}
afterEach(() => vi.restoreAllMocks());

it('registers only report.schedule without executing dependencies', () => {
  const h = setup();
  expect(h.register.mock.calls.map(call => call[0])).toEqual(['report.schedule']);
  expect(h.events).toEqual([]);
  expect(h.claim).not.toHaveBeenCalled();
  expect(h.deps.reportConfigService.getEnabledConfigs).not.toHaveBeenCalled();
});
it('enqueues the 60-second successor, then processes occurrences serially with the original context', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const h = setup(); await h.run();
  expect(h.deps.enqueueReportSchedule).toHaveBeenCalledWith(new Date(61000));
  expect(h.events).toEqual(['enqueue', 'store', 'claim', 'config', 'generate', 'complete', 'notify', 'config', 'generate', 'complete', 'notify']);
  expect(h.deps.serverReportService.generateAndPersist).toHaveBeenCalledWith([9]);
  expect(h.store.complete.mock.calls[0]).toEqual([due[0], 42]);
  expect(h.deps.enqueueReportNotifications).toHaveBeenCalledWith(42, h.config.notification_channel_ids);
  expect(h.deps.enqueueReportNotifications.mock.calls[0][1]).toBe(h.config.notification_channel_ids);
  await h.run(); expect(h.deps.createOccurrenceStore).toHaveBeenCalledTimes(2);
});
it('preserves undefined server selection and database report arguments', async () => {
  const h = setup(); h.config.server_id = undefined;
  await h.run(); expect(h.deps.serverReportService.generateAndPersist).toHaveBeenCalledWith(undefined);
  h.config.type = 'performance'; await h.run();
  expect(h.deps.reportService.generateReport).toHaveBeenCalledWith('performance', 4, { format: 'html' });
  expect(h.store.complete).toHaveBeenCalledWith(due[0], 43);
});
it.each(['missing-config', 'missing-id', 'generate', 'notify', 'complete', 'non-error'])('fails the first occurrence and preserves rejection: %s', async kind => {
  const h = setup(); let error: unknown = new Error(kind);
  if (kind === 'missing-config') { h.deps.reportConfigService.getConfigById.mockResolvedValue(null); error = new Error('REPORT_CONFIG_NOT_FOUND'); }
  else if (kind === 'missing-id') { h.deps.serverReportService.generateAndPersist.mockResolvedValue({ success: false, reportId: undefined }); error = new Error('REPORT_GENERATION_FAILED'); }
  else if (kind === 'notify') h.deps.enqueueReportNotifications.mockRejectedValue(error);
  else if (kind === 'complete') h.store.complete.mockRejectedValue(error);
  else { if (kind === 'non-error') error = 'raw failure'; h.deps.serverReportService.generateAndPersist.mockRejectedValue(error); }
  const rejection = await h.run().catch(value => value);
  if (kind.startsWith('missing')) expect(rejection.message).toBe((error as Error).message);
  else expect(rejection).toBe(error);
  expect(h.store.fail).toHaveBeenCalledWith(due[0], expect.objectContaining({ message: error instanceof Error ? error.message : error }));
  expect(h.deps.reportConfigService.getConfigById).toHaveBeenCalledTimes(1);
  if (kind === 'notify') expect(h.store.complete).toHaveBeenCalledBefore(h.store.fail);
});
it.each(['enqueue', 'claim'])('propagates %s failure without occurrence.fail', async kind => {
  const h = setup(); const error = new Error(kind);
  (kind === 'enqueue' ? h.deps.enqueueReportSchedule : h.claim).mockRejectedValue(error);
  await expect(h.run()).rejects.toBe(error);
  expect(h.store.fail).not.toHaveBeenCalled(); expect(h.deps.reportConfigService.getConfigById).not.toHaveBeenCalled();
  if (kind === 'enqueue') expect(h.deps.createOccurrenceStore).not.toHaveBeenCalled();
});
it.each(['before', 'enqueue', 'claim', 'config', 'generate', 'complete'])('stops at the existing cancellation boundary after %s', async boundary => {
  const h = setup(); const reason = new Error('cancelled');
  const abort = () => h.controller.abort(reason);
  if (boundary === 'before') abort();
  if (boundary === 'enqueue') h.deps.enqueueReportSchedule.mockImplementation(async () => { h.events.push('enqueue'); abort(); });
  if (boundary === 'claim') h.claim.mockImplementation(async () => { h.events.push('claim'); abort(); return due; });
  if (boundary === 'config') h.deps.reportConfigService.getConfigById.mockImplementation(async () => { h.events.push('config'); abort(); return h.config; });
  if (boundary === 'generate') h.deps.serverReportService.generateAndPersist.mockImplementation(async () => { h.events.push('generate'); abort(); return { success: true, reportId: 42 }; });
  if (boundary === 'complete') h.store.complete.mockImplementation(async () => { h.events.push('complete'); abort(); });
  await expect(h.run()).rejects.toBe(reason);
  const expected = ['enqueue', 'store', 'claim', 'config', 'generate', 'complete'];
  expect(h.events).toEqual(boundary === 'before' ? [] : expected.slice(0, boundary === 'enqueue' ? 2 : expected.indexOf(boundary) + 1));
  expect(h.store.fail).not.toHaveBeenCalled(); expect(h.deps.enqueueReportNotifications).not.toHaveBeenCalled();
});
