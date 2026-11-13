import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertReportCron } from './report-cron.js';
import { ReportScheduler, ReportSchedulePartialFailure } from './report-scheduler.js';
import type { ReportConfig } from './report-config-database-service.js';
import { reportConfigService } from './report-config-database-service.js';
import { dbConnection } from './db-connection.js';
import { workflowExecution } from './workflows/execution-context.js';

const config = (id: number, cron = '* * * * *') => ({ id, cron, created_at: '2026-01-01T00:00:00Z' }) as ReportConfig;
const now = new Date('2026-01-01T00:01:00Z');
function setup(configs = [config(1), config(2)]) {
  const store = { lastOccurrence: vi.fn(async (_id: number): Promise<Date | null> => null), schedule: vi.fn(async () => true) };
  return { store, scheduler: new ReportScheduler({ getEnabledConfigs: async () => configs }, store) };
}
afterEach(() => vi.restoreAllMocks());
describe('MAX-411 report cron', () => {
  it.each(['* * * * *', '0 */5 * * * *', '0 9 * JAN MON', '@daily', '@hourly', '0 0 29 2 *'])('preserves runtime syntax %s', cron => expect(() => assertReportCron(cron)).not.toThrow());
  it.each(['', ' ', 'bad', '* * * *', '61 * * * * *', '0 0 * 13 *', null, 42])('rejects invalid %j', cron => expect(() => assertReportCron(cron)).toThrow('报表 cron'));
  it('rejects invalid writes before SQL and allows disabling a historical row', async () => {
    const execute = vi.fn(async () => [{ affectedRows: 1 }]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    vi.spyOn(reportConfigService, 'getConfigById').mockResolvedValue({ ...config(1, 'bad'), instance_id: 1, server_id: null });
    await expect(reportConfigService.createConfig({ name: 'bad', cron: 'bad', type: 'health', instance_id: 1 })).rejects.toThrow('报表 cron');
    await expect(reportConfigService.updateConfig(1, { cron: 'bad' })).rejects.toThrow('报表 cron');
    await expect(reportConfigService.updateConfig(1, { enabled: true })).rejects.toThrow('报表 cron');
    expect(execute).not.toHaveBeenCalled();
    await expect(reportConfigService.updateConfig(1, { enabled: false })).resolves.toBe(true);
    await expect(reportConfigService.updateConfig(1, { cron: '@daily', enabled: true })).resolves.toBe(true);
  });
  it('isolates historical bad cron and reports partial failure after scheduling healthy rows', async () => {
    const h = setup([config(1, 'bad'), config(2)]);
    const error = await h.scheduler.scheduleDue(now).catch(e => e);
    expect(error).toBeInstanceOf(ReportSchedulePartialFailure);
    expect(error.failures).toMatchObject([{ configId: 1, stage: 'nextOccurrence' }]);
    expect(error.due).toMatchObject([{ configId: 2 }]);
    expect(h.store.schedule).toHaveBeenCalledOnce();
  });
  it.each(['lastOccurrence', 'schedule'] as const)('isolates single-item %s failure', async stage => {
    const h = setup(); h.store[stage].mockRejectedValueOnce(new Error('storage failed'));
    const error = await h.scheduler.scheduleDue(now).catch(e => e);
    expect(error.failures).toMatchObject([{ configId: 1, stage }]);
    expect(error.due).toMatchObject([{ configId: 2 }]);
  });
  it.each(['WORKFLOW_LEASE_LOST', 'REPORT_OCCURRENCE_LEASE_LOST'])('propagates ownership loss %s immediately', async message => {
    const h = setup(); const error = new Error(message); h.store.lastOccurrence.mockRejectedValueOnce(error);
    await expect(h.scheduler.scheduleDue(now)).rejects.toBe(error);
    expect(h.store.lastOccurrence).toHaveBeenCalledTimes(1);
  });
  it.each(['lastOccurrence', 'schedule'] as const)('preserves arbitrary cancellation during %s including the final row', async stage => {
    const h = setup([config(1)]); const controller = new AbortController(); const reason = { cancelled: true };
    h.store[stage].mockImplementationOnce(async () => { controller.abort(reason); throw new Error('storage failure'); });
    await expect(workflowExecution.run({ signal: controller.signal, workerId: 'test', fencingToken: 1 }, () => h.scheduler.scheduleDue(now))).rejects.toBe(reason);
  });
  it('propagates list failure and preserves the success array contract', async () => {
    const error = new Error('list failed');
    await expect(new ReportScheduler({ getEnabledConfigs: async () => { throw error; } }, setup().store).scheduleDue(now)).rejects.toBe(error);
    const h = setup(); expect(await h.scheduler.scheduleDue(now)).toHaveLength(2);
    h.store.schedule.mockResolvedValue(false); expect(await h.scheduler.scheduleDue(now)).toEqual([]);
  });
  it('does not turn database list errors into an empty successful scan', async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(null);
    await expect(reportConfigService.getEnabledConfigs()).rejects.toThrow('REPORT_SCHEDULE_STORE_UNAVAILABLE');
    const error = new Error('list SQL failed');
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: vi.fn().mockRejectedValue(error) } as any);
    await expect(reportConfigService.getEnabledConfigs()).rejects.toBe(error);
  });
  it('stops before scanning when cancelled, and checks cancellation after the final successful write', async () => {
    const controller = new AbortController(); const reason = new Error('cancelled');
    const h = setup([config(1)]);
    const run = () => workflowExecution.run({ signal: controller.signal, workerId: 'test', fencingToken: 1 }, () => h.scheduler.scheduleDue(now));
    h.store.schedule.mockImplementationOnce(async () => { controller.abort(reason); return true; });
    await expect(run()).rejects.toBe(reason);
    h.store.lastOccurrence.mockClear();
    await expect(run()).rejects.toBe(reason);
    expect(h.store.lastOccurrence).not.toHaveBeenCalled();
  });
});
