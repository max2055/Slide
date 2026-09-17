import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('wires the execution context and drains the runtime during server shutdown', () => {
  const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  expect(server).toContain('workflowRegistry.execute(job, context)');
  expect(server).toContain('await workflowRuntime.shutdown()');
});
it('registers report scheduling in place before runtime creation and initial enqueue', () => {
  const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  const ordered = [
    "workflowRegistry.register('capacity.consistency'",
    'registerReportScheduleHandler(workflowRegistry, {',
    "workflowRegistry.register('notification.dispatch'",
    'registerNotificationHandlers(',
    'new WorkerRuntime(',
    'await enqueueNotificationDispatch()',
    'await enqueueReportSchedule()',
    'workflowTimer = setInterval(',
  ];
  let previous = -1;
  for (const marker of ordered) {
    const position = server.indexOf(marker);
    expect(position, marker).toBeGreaterThan(previous);
    previous = position;
  }
  expect(server).not.toContain("workflowRegistry.register('report.schedule'");
  expect(server).toContain('createOccurrenceStore: () => new MysqlReportOccurrenceStore(() => dbConnection.getPool() as any)');
});
