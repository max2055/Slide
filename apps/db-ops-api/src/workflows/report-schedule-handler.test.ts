import { afterEach, expect, it, vi } from 'vitest';
import { ReportScheduler } from '../report-scheduler.js';
import type { ReportConfig } from '../report-config-database-service.js';
import type { Report } from '../report-database-service.js';
import { JobRegistry } from './job-registry.js';
import { registerReportScheduleHandler } from './report-schedule-handler.js';
import { scheduledReportPersistence } from './scheduled-report-context.js';

function setup() {
  const events: string[] = [];
  const controller = new AbortController();
  const context = { signal: controller.signal, workerId: 'test', fencingToken: 7 };
  const config = { id: 1, type: 'server_health', server_id: 9, instance_id: 4, format: 'html', notification_channel_ids: [8, 3] } as ReportConfig;
  const occurrence = { configId: 1, occurrenceAt: new Date('2026-10-03'), config, context,
    job: { id: 'job', type: 'report.occurrence', payload: {}, attempts: 1, maxAttempts: 5, fencingToken: 7 } };
  const store = {
    lastOccurrence: vi.fn(async () => null), schedule: vi.fn(async () => true),
    claim: vi.fn(async () => occurrence as typeof occurrence | null),
    savedReport: vi.fn(async () => null as Report | null),
    createReport: vi.fn(), updateReport: vi.fn(),
    complete: vi.fn(async () => { events.push('complete'); }), fail: vi.fn(async () => { events.push('fail'); }),
  };
  const deps = {
    reportConfigService: { getEnabledConfigs: vi.fn(async () => [] as ReportConfig[]) },
    serverReportService: { generateAndPersist: vi.fn(async () => {
      expect(scheduledReportPersistence.getStore()).toBeDefined(); events.push('generate');
      return { success: true, reportId: 42 as number | undefined };
    }) },
    reportService: { generateReport: vi.fn(async () => { events.push('generate'); return { id: 43 } as Report; }) },
    enqueueReportSchedule: vi.fn(async (_date: Date) => { events.push('enqueue'); }),
    createOccurrenceStore: vi.fn(() => store),
  };
  const scheduler = vi.spyOn(ReportScheduler.prototype, 'scheduleDue').mockResolvedValue([]);
  const registry = new JobRegistry();
  registerReportScheduleHandler(registry, deps);
  const run = (type = 'report.occurrence', payload = { configId: 1, occurrenceAt: '2026-10-03T00:00:00Z' }) =>
    registry.execute({ ...occurrence.job, type, payload }, context);
  return { events, controller, config, occurrence, store, deps, scheduler, run };
}
afterEach(() => vi.restoreAllMocks());

it('scan durably enqueues its successor and schedules independent jobs without generating reports', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const h = setup(); await h.run('report.schedule');
  expect(h.deps.enqueueReportSchedule).toHaveBeenCalledWith(new Date(61000));
  expect(h.scheduler).toHaveBeenCalledOnce();
  expect(h.store.claim).not.toHaveBeenCalled();
  expect(h.deps.serverReportService.generateAndPersist).not.toHaveBeenCalled();
});
it('generates one occurrence through the fenced persistence boundary', async () => {
  const h = setup(); await h.run();
  expect(h.events).toEqual(['generate', 'complete']);
  expect(h.store.complete).toHaveBeenCalledWith(h.occurrence, 42);
  expect(h.deps.serverReportService.generateAndPersist).toHaveBeenCalledWith([9]);
  expect(h.deps.enqueueReportSchedule).not.toHaveBeenCalled();
});
it('reuses completed content without generating or charging again', async () => {
  const h = setup(); h.store.savedReport.mockResolvedValue({ id: 99, status: 'completed' } as Report);
  await h.run();
  expect(h.store.complete).toHaveBeenCalledWith(h.occurrence, 99);
  expect(h.deps.serverReportService.generateAndPersist).not.toHaveBeenCalled();
});
it('acknowledges an already finalized occurrence without any report writes', async () => {
  const h = setup(); h.store.claim.mockResolvedValue(null); await h.run();
  expect(h.store.complete).not.toHaveBeenCalled(); expect(h.store.savedReport).not.toHaveBeenCalled();
});
it('preserves server and database report arguments', async () => {
  const h = setup(); h.config.server_id = undefined; await h.run();
  expect(h.deps.serverReportService.generateAndPersist).toHaveBeenCalledWith(undefined);
  h.config.type = 'performance'; await h.run();
  expect(h.deps.reportService.generateReport).toHaveBeenCalledWith('performance', 4, { format: 'html' });
  expect(h.store.complete).toHaveBeenCalledWith(h.occurrence, 43);
});
it.each(['missing-id', 'generate', 'complete', 'non-error'])('fails only its own occurrence: %s', async kind => {
  const h = setup(); let error: unknown = new Error(kind);
  if (kind === 'missing-id') { h.deps.serverReportService.generateAndPersist.mockResolvedValue({ success: false, reportId: undefined }); error = new Error('REPORT_GENERATION_FAILED'); }
  else if (kind === 'complete') h.store.complete.mockRejectedValue(error);
  else { if (kind === 'non-error') error = 'raw failure'; h.deps.serverReportService.generateAndPersist.mockRejectedValue(error); }
  const rejection = await h.run().catch(value => value);
  if (kind === 'missing-id') expect(rejection.message).toBe((error as Error).message);
  else expect(rejection).toBe(error);
  expect(h.store.fail).toHaveBeenCalledWith(h.occurrence, expect.objectContaining({ message: error instanceof Error ? error.message : error }));
});
it.each(['before', 'claim', 'saved', 'generate'])('honours cancellation after %s', async boundary => {
  const h = setup(); const reason = new Error('cancelled');
  const abort = () => h.controller.abort(reason);
  if (boundary === 'before') abort();
  if (boundary === 'claim') h.store.claim.mockImplementation(async () => { abort(); return h.occurrence; });
  if (boundary === 'saved') h.store.savedReport.mockImplementation(async () => { abort(); return null; });
  if (boundary === 'generate') h.deps.serverReportService.generateAndPersist.mockImplementation(async () => { abort(); return { success: true, reportId: 42 }; });
  await expect(h.run()).rejects.toBe(reason);
  expect(h.store.fail).not.toHaveBeenCalled(); expect(h.store.complete).not.toHaveBeenCalled();
});
