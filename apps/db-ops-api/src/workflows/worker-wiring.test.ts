import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('wires the execution context and drains the runtime during server shutdown', () => {
  const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  expect(server).toContain('workflowRegistry.execute(job, context)');
  expect(server).toContain('await workflowRuntime.shutdown()');
});
it('retains server lifecycle ownership and orders assembly before runtime creation', () => {
  const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  const ordered = [
    "fastify.addHook('onClose'",
    'const startWorkers = async () => {',
    'await initializeLeaderConnections()',
    'await startup.assertOwned()',
    'await startup.step(() => engine!.start()',
    'new MysqlWorkflowStore(() => dbConnection.getPool() as any)',
    'notificationWorkflowStore = workflowStore',
    'new JobRegistry()',
    'new NotificationDispatchScheduler(',
    'new CapacityConsistencyMonitor(',
    'registerWorkflowHandlers(workflowRegistry, {',
    'new WorkerRuntime(',
    'stopWorkflow = async () => await workflowRuntime.shutdown()',
    'await startup.step(() => enqueueNotificationDispatch())',
    'await startup.step(() => enqueueReportSchedule())',
    'await startup.step(() => workflowStore.enqueue(createCapacityConsistencyJob()))',
    'monitorCollector.start()',
    'registerCronRunHandler(workflowRegistry',
    'await startup.step(() => cronManager!.start())',
    'workflowTimer = setInterval(',
    'await startup.start(initializeApi, startWorkers)',
  ];
  let previous = -1;
  for (const marker of ordered) {
    const position = server.indexOf(marker, previous + 1);
    expect(position, marker).toBeGreaterThan(previous);
    previous = position;
  }
  expect(server).not.toContain('workflowRegistry.register(');
  expect(server).toContain('startup.assertOwned().then(() => workflowRuntime.runOnce');
  expect(server).toContain("}, 1_000);");
  const close = server.slice(server.indexOf('const stopWorkers ='), server.indexOf('const readiness ='));
  for (const marker of [
    'clearInterval(workflowTimer)', 'stopWorkflow?.()',
    'monitorCollector.stop()', 'networkDeviceCollector.stop()', 'configBackupScheduler.stop()',
    'alertEngine.stopEvaluationLoop()', 'alertEscalationService.stop()', 'stopSessionCleanup()',
    'promptManager.stopWatch()', 'cronManager?.stop()', 'engine?.dispose?.()',
    'maintenanceWindowService.stopCacheRefresh()', 'await fastify.close()', 'await dbConnection.close()',
  ]) expect(close).toContain(marker);
  expect(server).toContain("process.once('SIGTERM'");
  expect(server).toContain("process.once('SIGINT'");
  expect(server.indexOf('new WorkerLease(')).toBeLessThan(server.indexOf('const initializeApi ='));
  expect(server.indexOf('metricRegistry.initialize()')).toBeLessThan(server.indexOf('const startWorkers ='));
  expect(server).toContain('createOccurrenceStore: () => new MysqlReportOccurrenceStore(() => dbConnection.getPool() as any)');
});
