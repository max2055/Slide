import { describe, expect, it } from 'vitest';
import { createReportScheduleJob, MysqlReportOccurrenceStore, ReportScheduler, nextReportOccurrence } from '../src/report-scheduler.js';

describe('report schedule occurrence', () => {
  const config = { id: 3, cron: '0 * * * * *', created_at: '2026-07-18T00:00:00.000Z' };
  it('creates exactly one due occurrence and never reclaims the same occurrence', async () => {
    const claimed = new Set<string>();
    const store = { lastOccurrence: async () => null, claim: async (item: any) => { const key = `${item.configId}:${item.occurrenceAt.toISOString()}`; if (claimed.has(key)) return false; claimed.add(key); return true; }, complete: async () => {}, fail: async () => {} };
    const scheduler = new ReportScheduler({ getEnabledConfigs: async () => [config as any] }, store);
    await expect(scheduler.claimDue(new Date('2026-07-18T00:01:01.000Z'))).resolves.toHaveLength(1);
    await expect(scheduler.claimDue(new Date('2026-07-18T00:01:01.000Z'))).resolves.toEqual([]);
  });
  it('does not run before the first configured schedule time', () => {
    expect(nextReportOccurrence(config as any, null, new Date('2026-07-18T00:00:30.000Z'))).toBeNull();
  });
  it('claims persisted occurrences with insert-ignore uniqueness', async () => {
    const calls: string[] = [];
    const store = new MysqlReportOccurrenceStore(() => ({ execute: async (sql: string) => { calls.push(sql); return [{ affectedRows: 1 } as any]; } }));
    await expect(store.claim({ configId: 3, occurrenceAt: new Date('2026-07-18T00:01:00Z') })).resolves.toBe(true);
    expect(calls[0]).toContain('INSERT IGNORE');
  });

  it('uses one durable idempotency key per minute schedule slot', () => {
    const first = createReportScheduleJob(new Date('2026-07-19T00:00:01.000Z'));
    const restart = createReportScheduleJob(new Date('2026-07-19T00:00:59.999Z'));
    const next = createReportScheduleJob(new Date('2026-07-19T00:01:00.000Z'));
    expect(restart).toMatchObject({ id: first.id, idempotencyKey: first.idempotencyKey, type: 'report.schedule' });
    expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
