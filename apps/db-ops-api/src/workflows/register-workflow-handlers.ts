import { createCapacityConsistencyJob } from '../capacity-consistency-monitor.js';
import type { JobRegistry } from './job-registry.js';
import type { WorkflowEnqueuer } from './notification-dispatch.js';
import { registerNotificationHandlers } from './notification-handlers.js';
import { registerReportScheduleHandler } from './report-schedule-handler.js';

interface WorkflowHandlerDependencies {
  faultDiagnosisService: { diagnoseUnhealthyInstances(): Promise<unknown> };
  monitorCollector: { collectCapacityNow(): Promise<unknown> };
  baselineCalculator: { cleanupOldBaselines(): Promise<unknown> };
  alertEngine: { triggerEvaluation(): Promise<unknown> };
  workflowStore: WorkflowEnqueuer;
  capacityConsistencyMonitor: { runOnce(signal: AbortSignal): Promise<unknown> };
  notificationScheduler: { enqueuePending(signal: AbortSignal): Promise<unknown> };
  enqueueNotificationDispatch: (availableAt: Date) => Promise<void>;
  reportSchedule: Parameters<typeof registerReportScheduleHandler>[1];
  notificationDatabaseService: Parameters<typeof registerNotificationHandlers>[1];
  notificationService: Parameters<typeof registerNotificationHandlers>[2];
  reportDatabaseService: Parameters<typeof registerNotificationHandlers>[3];
}

/** Register handlers only; server retains service construction and worker lifecycle. */
export function registerWorkflowHandlers(registry: JobRegistry, deps: WorkflowHandlerDependencies): void {
  const {
    faultDiagnosisService, monitorCollector, baselineCalculator, alertEngine,
    workflowStore, capacityConsistencyMonitor, notificationScheduler, enqueueNotificationDispatch,
    reportSchedule, notificationDatabaseService, notificationService, reportDatabaseService,
  } = deps;
  registry.register('fault.diagnose-unhealthy', async () => { await faultDiagnosisService.diagnoseUnhealthyInstances(); });
  registry.register('capacity.collect', async () => { await monitorCollector.collectCapacityNow(); });
  registry.register('baseline.cleanup', async () => { await baselineCalculator.cleanupOldBaselines(); });
  registry.register('alert.evaluate', async () => { await alertEngine.triggerEvaluation(); });
  registry.register('capacity.consistency', async (_payload, _job, { signal }) => {
    signal.throwIfAborted();
    await workflowStore.enqueue(createCapacityConsistencyJob(new Date(Date.now() + 300_000)));
    signal.throwIfAborted();
    await capacityConsistencyMonitor.runOnce(signal);
  });
  registerReportScheduleHandler(registry, reportSchedule);
  registry.register('notification.dispatch', async (_payload, _job, { signal }) => {
    signal.throwIfAborted();
    await notificationScheduler.enqueuePending(signal);
    // The next durable tick is committed before this job is completed. A
    // restart therefore resumes the current or next tick without an in-memory timer.
    signal.throwIfAborted();
    await enqueueNotificationDispatch(new Date(Date.now() + 10_000));
  });
  registerNotificationHandlers(registry, notificationDatabaseService, notificationService, reportDatabaseService);
}
