import { describe, expect, it, vi } from 'vitest';
import { createReportScheduleJob, createReportOccurrenceJob, ReportScheduler, nextReportOccurrence } from '../src/report-scheduler.js';
import type { ReportOccurrenceStore } from '../src/workflows/report-occurrence-store.js';

describe('report schedule occurrence', () => {
  const config = { id: 3, cron: '0 * * * * *', created_at: '2026-07-18T00:00:00.000Z' };
  it('schedules all due configurations without pre-claiming them', async () => {
    const schedule = vi.fn(async () => true);
    const store = { lastOccurrence: async () => null, schedule } as unknown as ReportOccurrenceStore;
    const scheduler = new ReportScheduler({ getEnabledConfigs: async () => [config, { ...config, id: 4 }] as any }, store);
    await expect(scheduler.scheduleDue(new Date('2026-07-18T00:01:01.000Z'))).resolves.toHaveLength(2);
    expect(schedule).toHaveBeenCalledTimes(2);
  });
  it('does not run before the first configured schedule time', () => {
    expect(nextReportOccurrence(config as any, null, new Date('2026-07-18T00:00:30.000Z'))).toBeNull();
  });
  it('has a stable, bounded job identity for each business occurrence', () => {
    const occurrence = { configId: 3, occurrenceAt: new Date('2026-07-18T00:01:00Z') };
    const job = createReportOccurrenceJob(occurrence);
    expect(job.id).toHaveLength(36);
    expect(createReportOccurrenceJob(occurrence)).toEqual(job);
    expect(createReportOccurrenceJob({ ...occurrence, configId: 4 }).id).not.toBe(job.id);
  });
  it('uses one durable idempotency key per minute schedule slot', () => {
    const first = createReportScheduleJob(new Date('2026-07-19T00:00:01.000Z'));
    const restart = createReportScheduleJob(new Date('2026-07-19T00:00:59.999Z'));
    const next = createReportScheduleJob(new Date('2026-07-19T00:01:00.000Z'));
    expect(restart).toMatchObject({ id: first.id, idempotencyKey: first.idempotencyKey, type: 'report.schedule' });
    expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
