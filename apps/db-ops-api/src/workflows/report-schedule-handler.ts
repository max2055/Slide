import { assertReportTarget } from '../report-target.js';
import type { reportConfigService } from '../report-config-database-service.js';
import type { reportService } from '../report-service.js';
import type { ServerReportService } from '../server-report-service.js';
import { ReportScheduler, type ReportOccurrenceStore } from '../report-scheduler.js';
import { scheduledReportPersistence } from './scheduled-report-context.js';
import type { JobRegistry } from './job-registry.js';

interface ReportScheduleDependencies {
  reportConfigService: Pick<typeof reportConfigService, 'getEnabledConfigs'>;
  serverReportService: Pick<ServerReportService, 'generateAndPersist'>;
  reportService: Pick<typeof reportService, 'generateReport'>;
  enqueueReportSchedule: (availableAt: Date) => Promise<void>;
  createOccurrenceStore: () => ReportOccurrenceStore;
}

export function registerReportScheduleHandler(registry: JobRegistry, deps: ReportScheduleDependencies): void {
  const { reportConfigService, serverReportService, reportService, enqueueReportSchedule, createOccurrenceStore } = deps;
  registry.register('report.schedule', async (_payload, _job, { signal }) => {
    // Persist the successor before scanning; each occurrence gets its own job.
    signal.throwIfAborted();
    await enqueueReportSchedule(new Date(Date.now() + 60_000));
    signal.throwIfAborted();
    await new ReportScheduler(reportConfigService, createOccurrenceStore()).scheduleDue();
  });
  registry.register('report.occurrence', async (payload, job, context) => {
    const { signal } = context;
    const configId = Number(payload.configId);
    const occurrenceAt = new Date(String(payload.occurrenceAt));
    if (!Number.isSafeInteger(configId) || configId <= 0 || !Number.isFinite(occurrenceAt.getTime())) throw new Error('REPORT_OCCURRENCE_PAYLOAD_INVALID');
    signal.throwIfAborted();
    const store = createOccurrenceStore();
    const occurrence = await store.claim({ configId, occurrenceAt }, job, context);
    if (!occurrence) return; // Commit succeeded before the worker acknowledged it.
    try {
      signal.throwIfAborted();
      const config = occurrence.config;
      assertReportTarget(config);
      const saved = await store.savedReport(occurrence);
      if (saved?.status === 'completed') {
        await store.complete(occurrence, saved.id);
        return;
      }
      const reportId = await scheduledReportPersistence.run({
        create: data => store.createReport(occurrence, data),
        update: (id, status, content, data) => store.updateReport(occurrence, id, status, content, data),
      }, async () => {
        signal.throwIfAborted();
        if (config.type === 'server_health') {
          const result = await serverReportService.generateAndPersist([config.server_id!]);
          if (!result.success || !result.reportId) throw new Error(result.error || 'REPORT_GENERATION_FAILED');
          return result.reportId;
        }
        return (await reportService.generateReport(config.type as any, config.instance_id, { format: config.format as any })).id;
      });
      if (!reportId) throw new Error('REPORT_GENERATION_FAILED');
      signal.throwIfAborted();
      await store.complete(occurrence, reportId);
    } catch (error) {
      signal.throwIfAborted();
      await store.fail(occurrence, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  });
}
