import { dbConnection } from '../db-connection.js';
import { PlatformUnavailableError } from '../lifecycle/platform-unavailable.js';

export const SESSION_IDLE_TIMEOUT_CONFIG_KEY = 'auth.session_idle_timeout_minutes';
export const DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES = 7 * 24 * 60;
export const MIN_SESSION_IDLE_TIMEOUT_MINUTES = 5;
export const MAX_SESSION_IDLE_TIMEOUT_MINUTES = 30 * 24 * 60;

const CONFIG_DESCRIPTION = '登录会话无操作超时时间（分钟）；每次刷新令牌轮换后重新计时';

interface ConfigExecutor {
  execute(sql: string, values?: unknown[]): Promise<[any, unknown?]>;
}

export interface AuthSessionConfig {
  idleTimeoutMinutes: number;
  minIdleTimeoutMinutes: number;
  maxIdleTimeoutMinutes: number;
}

function configResponse(idleTimeoutMinutes: number): AuthSessionConfig {
  return {
    idleTimeoutMinutes,
    minIdleTimeoutMinutes: MIN_SESSION_IDLE_TIMEOUT_MINUTES,
    maxIdleTimeoutMinutes: MAX_SESSION_IDLE_TIMEOUT_MINUTES,
  };
}

export class AuthSessionConfigService {
  constructor(
    private readonly executorProvider: () => ConfigExecutor | null = () => dbConnection.getPool() as ConfigExecutor | null,
  ) {}

  async get(): Promise<AuthSessionConfig> {
    let rows: unknown;
    try {
      const executor = this.executorProvider();
      if (!executor) throw new Error('POOL_UNAVAILABLE');
      [rows] = await executor.execute(
        'SELECT config_value FROM system_config WHERE config_key = ? LIMIT 1',
        [SESSION_IDLE_TIMEOUT_CONFIG_KEY],
      );
    } catch {
      // Do not log the driver error: it may contain SQL, config values or credentials.
      console.warn('SESSION_CONFIG_READ_FAILED');
      throw new PlatformUnavailableError();
    }
    if (Array.isArray(rows) && rows.length === 0) return configResponse(DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES);
    const raw = Array.isArray(rows) ? rows[0]?.config_value : undefined;
    const value = typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw))
      ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value)
      || value < MIN_SESSION_IDLE_TIMEOUT_MINUTES
      || value > MAX_SESSION_IDLE_TIMEOUT_MINUTES) {
      console.warn('SESSION_CONFIG_INVALID');
      throw new PlatformUnavailableError();
    }
    return configResponse(value);
  }

  async set(idleTimeoutMinutes: number, actorId: number): Promise<AuthSessionConfig> {
    if (!Number.isSafeInteger(idleTimeoutMinutes)
      || idleTimeoutMinutes < MIN_SESSION_IDLE_TIMEOUT_MINUTES
      || idleTimeoutMinutes > MAX_SESSION_IDLE_TIMEOUT_MINUTES
      || !Number.isSafeInteger(actorId)
      || actorId <= 0) {
      throw new Error('SESSION_CONFIG_UPDATE_INVALID');
    }

    const executor = this.executorProvider();
    if (!executor) throw new Error('SESSION_CONFIG_UPDATE_FAILED');
    try {
      await executor.execute(
        `INSERT INTO system_config (config_key, config_value, value_type, description, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), value_type = VALUES(value_type),
           description = VALUES(description), updated_by = VALUES(updated_by)`,
        [SESSION_IDLE_TIMEOUT_CONFIG_KEY, String(idleTimeoutMinutes), 'number', CONFIG_DESCRIPTION, actorId],
      );
      return configResponse(idleTimeoutMinutes);
    } catch {
      throw new Error('SESSION_CONFIG_UPDATE_FAILED');
    }
  }

  expiresAt(config: AuthSessionConfig, now = Date.now()): Date {
    return new Date(now + config.idleTimeoutMinutes * 60_000);
  }
}

export const authSessionConfigService = new AuthSessionConfigService();
