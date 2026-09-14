import { dbConnection } from '../db-connection.js';
import { configBackupService, ConfigBackupError } from './config-backup-service.js';

export const BACKUP_TIME_ZONE = 'Asia/Shanghai';
export interface BackupScheduleInput { enabled: boolean; dailyTime: string; }
export interface BackupSchedule extends BackupScheduleInput {
  timeZone: typeof BACKUP_TIME_ZONE;
  lastRun: { date: string; status: 'running' | 'success' | 'failed'; errorCode: string | null } | null;
}
interface BackupTarget extends BackupScheduleInput { deviceId: number; }
export interface BackupScheduleStore {
  get(deviceId: number): Promise<BackupSchedule>;
  save(deviceId: number, input: BackupScheduleInput): Promise<void>;
  targets(): Promise<BackupTarget[]>;
  claim(target: BackupTarget, date: string): Promise<boolean>;
  finish(deviceId: number, date: string, errorCode: string | null): Promise<void>;
  expire(): Promise<void>;
}

export function parseBackupSchedule(value: unknown): BackupScheduleInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONFIG_BACKUP_SCHEDULE_INVALID');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'enabled' && key !== 'dailyTime') ||
    typeof input.enabled !== 'boolean' || typeof input.dailyTime !== 'string' ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.dailyTime)) throw new Error('CONFIG_BACKUP_SCHEDULE_INVALID');
  return { enabled: input.enabled, dailyTime: input.dailyTime };
}

export function beijingDateTime(now: Date): { date: string; time: string } {
  // Beijing has no daylight-saving transitions; compute independently of the host timezone.
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

interface SqlPool { execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>; }
export class MysqlBackupScheduleStore implements BackupScheduleStore {
  constructor(private readonly poolProvider: () => SqlPool | null = () => dbConnection.getPool() as unknown as SqlPool | null) {}
  private pool(): SqlPool {
    const pool = this.poolProvider();
    if (!pool) throw new Error('CONFIG_BACKUP_STORE_UNAVAILABLE');
    return pool;
  }
  async get(deviceId: number): Promise<BackupSchedule> {
    const [rows] = await this.pool().execute<Array<{ enabled: number; daily_time: string }>>(
      'SELECT enabled, daily_time FROM network_config_backup_schedules WHERE device_id = ?', [deviceId]);
    const [runs] = await this.pool().execute<Array<{ scheduled_date: string; status: 'running' | 'success' | 'failed'; error_code: string | null }>>(
      'SELECT scheduled_date, status, error_code FROM network_config_backup_runs WHERE device_id = ? ORDER BY scheduled_date DESC LIMIT 1', [deviceId]);
    return {
      enabled: rows[0] ? Boolean(rows[0].enabled) : true, dailyTime: rows[0]?.daily_time ?? '00:00', timeZone: BACKUP_TIME_ZONE,
      lastRun: runs[0] ? { date: runs[0].scheduled_date, status: runs[0].status, errorCode: runs[0].error_code } : null,
    };
  }
  async save(deviceId: number, input: BackupScheduleInput): Promise<void> {
    await this.pool().execute(`INSERT INTO network_config_backup_schedules (device_id, enabled, daily_time) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), daily_time = VALUES(daily_time)`, [deviceId, input.enabled ? 1 : 0, input.dailyTime]);
  }
  async targets(): Promise<BackupTarget[]> {
    const [rows] = await this.pool().execute<Array<{ id: number; daily_time: string }>>(`
      SELECT d.id, COALESCE(s.daily_time, '00:00') AS daily_time FROM network_devices d
      LEFT JOIN network_config_backup_schedules s ON s.device_id = d.id
      WHERE COALESCE(s.enabled, 1) = 1
      AND EXISTS (SELECT 1 FROM network_device_credentials c WHERE c.device_id = d.id AND c.protocol = 'ssh')`);
    return rows.map(row => ({ deviceId: row.id, dailyTime: row.daily_time, enabled: true }));
  }
  async claim(target: BackupTarget, date: string): Promise<boolean> {
    // The daily primary key arbitrates multiple API workers. Recheck settings to avoid stale scans.
    const [result] = await this.pool().execute<{ affectedRows: number }>(`
      INSERT IGNORE INTO network_config_backup_runs (device_id, scheduled_date, status)
      SELECT d.id, ?, 'running' FROM network_devices d
      LEFT JOIN network_config_backup_schedules s ON s.device_id = d.id
      WHERE d.id = ? AND COALESCE(s.enabled, 1) = 1 AND COALESCE(s.daily_time, '00:00') = ?
      AND EXISTS (SELECT 1 FROM network_device_credentials c WHERE c.device_id = d.id AND c.protocol = 'ssh')`,
    [date, target.deviceId, target.dailyTime]);
    return result.affectedRows === 1;
  }
  async finish(deviceId: number, date: string, errorCode: string | null): Promise<void> {
    await this.pool().execute(`UPDATE network_config_backup_runs SET status = ?, error_code = ?, finished_at = CURRENT_TIMESTAMP
      WHERE device_id = ? AND scheduled_date = ? AND status = 'running'`, [errorCode ? 'failed' : 'success', errorCode, deviceId, date]);
  }
  async expire(): Promise<void> {
    // Do not retry an uncertain SSH operation after process termination.
    await this.pool().execute(`UPDATE network_config_backup_runs SET status = 'failed', error_code = 'CONFIG_BACKUP_INTERRUPTED', finished_at = CURRENT_TIMESTAMP
      WHERE status = 'running' AND started_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE)`);
  }
}

export class ConfigBackupScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  constructor(
    private readonly store: BackupScheduleStore,
    private readonly collect: (deviceId: number) => Promise<unknown>,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const run = () => { void this.tick().catch(() => console.error('[ConfigBackupScheduler] CONFIG_BACKUP_SCHEDULE_FAILED')); };
    this.timer = setInterval(run, 30_000);
    run();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  private async run(): Promise<void> {
    await this.store.expire();
    for (const target of await this.store.targets()) {
      if (this.stopped) break;
      const local = beijingDateTime(this.clock());
      if (!target.enabled || local.time < target.dailyTime) continue;
      try {
        if (!await this.store.claim(target, local.date)) continue;
        let errorCode: string | null = null;
        try { await this.collect(target.deviceId); }
        catch (error) { errorCode = error instanceof ConfigBackupError ? error.code : 'CONFIG_BACKUP_FAILED'; }
        await this.store.finish(target.deviceId, local.date, errorCode);
      } catch {
        console.error(`[ConfigBackupScheduler] device #${target.deviceId}: CONFIG_BACKUP_SCHEDULE_FAILED`);
      }
    }
  }
}

export const backupScheduleStore = new MysqlBackupScheduleStore();
export const configBackupScheduler = new ConfigBackupScheduler(backupScheduleStore, id => configBackupService.collect(id));
