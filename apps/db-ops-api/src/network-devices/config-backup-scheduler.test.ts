import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigBackupError } from './config-backup-service.js';
import { beijingDateTime, ConfigBackupScheduler, MysqlBackupScheduleStore, parseBackupSchedule, type BackupScheduleStore } from './config-backup-scheduler.js';

function fixture() {
  const claims = new Set<string>();
  const targets = [{ deviceId: 7, enabled: true, dailyTime: '00:00' }];
  const store: BackupScheduleStore = {
    get: vi.fn(), save: vi.fn(), expire: vi.fn(async () => {}),
    targets: vi.fn(async () => targets),
    claim: vi.fn(async (target, date) => {
      const key = `${target.deviceId}:${date}`;
      if (claims.has(key)) return false;
      claims.add(key); return true;
    }),
    finish: vi.fn(async () => {}),
  };
  const collect = vi.fn(async (_id: number): Promise<unknown> => ({}));
  let now = new Date('2026-09-14T15:59:59Z');
  const create = () => new ConfigBackupScheduler(store, collect, () => now);
  return { store, targets, collect, create, setTime: (value: string) => { now = new Date(value); } };
}

afterEach(() => vi.useRealTimers());

describe('daily configuration backups', () => {
  it('uses Beijing dates across UTC day/year boundaries', () => {
    expect(beijingDateTime(new Date('2026-12-31T16:00:00Z'))).toEqual({ date: '2027-01-01', time: '00:00' });
  });
  it.each([null, {}, { enabled: 'false', dailyTime: '00:00' }, { enabled: true, dailyTime: '24:00' },
    { enabled: true, dailyTime: '1:30' }, { enabled: true, dailyTime: '12:60' }, { enabled: true, dailyTime: '00:00', secret: 'x' }])('rejects invalid schedule %j', input => {
    expect(() => parseBackupSchedule(input)).toThrow('CONFIG_BACKUP_SCHEDULE_INVALID');
  });
  it('accepts disabled schedules and minute precision', () => {
    expect(parseBackupSchedule({ enabled: false, dailyTime: '23:59' })).toEqual({ enabled: false, dailyTime: '23:59' });
  });
  it('claims once per Beijing day across ticks, restart and concurrent workers', async () => {
    const f = fixture();
    const scheduler = f.create();
    f.setTime('2026-09-14T16:00:00Z');
    await Promise.all([scheduler.tick(), scheduler.tick(), f.create().tick()]);
    await f.create().tick();
    expect(f.collect).toHaveBeenCalledTimes(1);
    expect(f.store.finish).toHaveBeenCalledWith(7, '2026-09-15', null);
    f.setTime('2026-09-15T16:00:00Z');
    await scheduler.tick();
    expect(f.collect).toHaveBeenCalledTimes(2);
  });
  it('respects configured time, disabled devices and same-day catch-up', async () => {
    const f = fixture();
    f.targets[0].dailyTime = '03:30';
    f.setTime('2026-09-14T19:29:59Z');
    await f.create().tick();
    expect(f.collect).not.toHaveBeenCalled();
    f.setTime('2026-09-14T19:30:00Z');
    await f.create().tick();
    expect(f.collect).toHaveBeenCalledOnce();
    f.targets[0].enabled = false;
    f.setTime('2026-09-16T20:00:00Z');
    await f.create().tick();
    expect(f.collect).toHaveBeenCalledOnce();
    f.targets[0].enabled = true;
    await f.create().tick();
    expect(f.store.finish).toHaveBeenLastCalledWith(7, '2026-09-17', null);
    expect(f.collect).toHaveBeenCalledTimes(2);
  });
  it('records safe failures without same-day automatic retries and continues other devices', async () => {
    const f = fixture();
    f.targets.push({ deviceId: 8, enabled: true, dailyTime: '00:00' });
    f.collect.mockRejectedValueOnce(new ConfigBackupError('SSH_CONNECT_FAILED'));
    await f.create().tick();
    await f.create().tick();
    expect(f.store.finish).toHaveBeenCalledWith(7, '2026-09-14', 'SSH_CONNECT_FAILED');
    expect(f.store.finish).toHaveBeenCalledWith(8, '2026-09-14', null);
    expect(f.collect).toHaveBeenCalledTimes(2);
    f.setTime('2026-09-14T16:00:00Z');
    f.collect.mockRejectedValueOnce(new Error('password=secret'));
    await f.create().tick();
    expect(f.store.finish).toHaveBeenCalledWith(7, '2026-09-15', 'CONFIG_BACKUP_FAILED');
  });
  it('runs on the timer and stops future work', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const scheduler = f.create();
    scheduler.start();
    await scheduler.tick();
    f.setTime('2026-09-14T16:00:00Z');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.collect).toHaveBeenCalledTimes(2);
    await scheduler.stop();
    f.setTime('2026-09-15T16:00:00Z');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.collect).toHaveBeenCalledTimes(2);
  });
  it('returns default settings without storing credentials', async () => {
    const execute = vi.fn(async () => [[], []] as [any, any]);
    const store = new MysqlBackupScheduleStore(() => ({ execute }));
    await expect(store.get(7)).resolves.toEqual({ enabled: true, dailyTime: '00:00', timeZone: 'Asia/Shanghai', lastRun: null });
    await store.save(7, { enabled: false, dailyTime: '03:30' });
    expect(execute.mock.calls.at(-1)).toEqual([expect.stringContaining('ON DUPLICATE KEY UPDATE'), [7, 0, '03:30']]);
  });
});
