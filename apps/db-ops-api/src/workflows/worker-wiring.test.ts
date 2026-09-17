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
    'await initializeControlPlane()',
    'await engine.start()',
    'await metricRegistry.initialize()',
    'new MysqlWorkflowStore(() => dbConnection.getPool() as any)',
    'notificationWorkflowStore = workflowStore',
    'new JobRegistry()',
    'new NotificationDispatchScheduler(',
    'new CapacityConsistencyMonitor(',
    'registerWorkflowHandlers(workflowRegistry, {',
    'new WorkerRuntime(',
    'stopWorkflow = async () => await workflowRuntime.shutdown()',
    'await enqueueNotificationDispatch()',
    'await enqueueReportSchedule()',
    'await workflowStore.enqueue(createCapacityConsistencyJob())',
    'workflowTimer = setInterval(',
    'monitorCollector.start()',
    'new WorkerLease(',
    'if (await workerLease.acquire())',
    'await startWorkers()',
  ];
  let previous = -1;
  for (const marker of ordered) {
    const position = server.indexOf(marker, previous + 1);
    expect(position, marker).toBeGreaterThan(previous);
    previous = position;
  }
  expect(server).not.toContain('workflowRegistry.register(');
  expect(server).toContain('workflowRegistry.execute(job, context)).catch');
  expect(server).toContain("}, 1_000);");
  const shutdown = server.slice(server.indexOf('const shutdown = async () => {'));
  let prior = -1;
  for (const marker of [
    'clearInterval(heartbeat)', 'clearInterval(workflowTimer)', 'await stopWorkflow()',
    'monitorCollector.stop()', 'networkDeviceCollector.stop()', 'await configBackupScheduler.stop()',
    'alertEngine.stopEvaluationLoop()', 'alertEscalationService.stop()', 'stopSessionCleanup()',
    'promptManager.stopWatch()', 'await cronManager?.stop()', 'await engine?.dispose?.()',
    'await workerLease.release()', 'await fastify.close()', 'await dbConnection.close()',
    "process.once('SIGTERM'", "process.once('SIGINT'",
  ]) {
    const position = shutdown.indexOf(marker);
    expect(position, marker).toBeGreaterThan(prior); prior = position;
  }
  expect(server).toContain('createOccurrenceStore: () => new MysqlReportOccurrenceStore(() => dbConnection.getPool() as any)');
});
