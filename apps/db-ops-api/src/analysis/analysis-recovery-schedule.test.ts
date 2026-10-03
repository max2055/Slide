import { expect, it } from 'vitest';
import { JobRegistry } from '../workflows/job-registry.js';
import { createAnalysisRecoveryJob, registerAnalysisRecoveryHandler } from './analysis-recovery-schedule.js';

it('persists the next recovery tick before scanning and respects shutdown cancellation', async () => {
  const registry = new JobRegistry(); const events: string[] = [];
  registerAnalysisRecoveryHandler(registry, { recover: async () => { events.push('scan'); } }, async () => { events.push('enqueue'); });
  const job = { ...createAnalysisRecoveryJob(), attempts: 1, maxAttempts: 5, fencingToken: 1 };
  await registry.execute(job); expect(events).toEqual(['enqueue', 'scan']);
  const controller = new AbortController(); controller.abort(new Error('WORKFLOW_SHUTDOWN'));
  await expect(registry.execute(job, { workerId: 'a', fencingToken: 1, signal: controller.signal })).rejects.toThrow('WORKFLOW_SHUTDOWN');
  expect(events).toEqual(['enqueue', 'scan']);
});

it('concurrent restarts use the same durable tick identity within a slot', () => {
  expect(createAnalysisRecoveryJob(new Date(10_001)).id).toBe(createAnalysisRecoveryJob(new Date(19_999)).id);
  expect(createAnalysisRecoveryJob(new Date(20_000)).id).not.toBe(createAnalysisRecoveryJob(new Date(19_999)).id);
});
