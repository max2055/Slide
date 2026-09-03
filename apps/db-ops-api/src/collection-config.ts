import { dbConnection } from './db-connection.js';

export const SERVER_COLLECTION_INTERVAL_CONFIG_KEY = 'monitor.server_collection_interval_seconds';
export const NETWORK_DEVICE_COLLECTION_INTERVAL_CONFIG_KEY = 'monitor.network_device_collection_interval_seconds';
export const DEFAULT_COLLECTION_INTERVAL_SECONDS = 300;
export const MIN_COLLECTION_INTERVAL_SECONDS = 10;
export const MAX_COLLECTION_INTERVAL_SECONDS = 86_400;

const SERVER_DESCRIPTION = '服务器 SSH 指标采集间隔（秒）';
const NETWORK_DEVICE_DESCRIPTION = '网络设备 SNMP 指标采集间隔（秒）';

interface ConfigExecutor {
  execute(sql: string, values?: unknown[]): Promise<[any, unknown?]>;
}

export interface CollectionConfig {
  serverIntervalSeconds: number;
  networkDeviceIntervalSeconds: number;
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
}

function response(serverIntervalSeconds: number, networkDeviceIntervalSeconds: number): CollectionConfig {
  return {
    serverIntervalSeconds,
    networkDeviceIntervalSeconds,
    minIntervalSeconds: MIN_COLLECTION_INTERVAL_SECONDS,
    maxIntervalSeconds: MAX_COLLECTION_INTERVAL_SECONDS,
  };
}

function validInterval(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && Number(value) >= MIN_COLLECTION_INTERVAL_SECONDS
    && Number(value) <= MAX_COLLECTION_INTERVAL_SECONDS;
}

function storedInterval(value: unknown): number {
  const parsed = Number(value);
  return validInterval(parsed) ? parsed : DEFAULT_COLLECTION_INTERVAL_SECONDS;
}

export class CollectionConfigService {
  constructor(
    private readonly executorProvider: () => ConfigExecutor | null = () => dbConnection.getPool() as ConfigExecutor | null,
  ) {}

  async get(): Promise<CollectionConfig> {
    const executor = this.executorProvider();
    if (!executor) return response(DEFAULT_COLLECTION_INTERVAL_SECONDS, DEFAULT_COLLECTION_INTERVAL_SECONDS);

    try {
      const [rows] = await executor.execute(
        `SELECT config_key, config_value FROM system_config
         WHERE config_key IN (?, ?)`,
        [SERVER_COLLECTION_INTERVAL_CONFIG_KEY, NETWORK_DEVICE_COLLECTION_INTERVAL_CONFIG_KEY],
      );
      const values = new Map<string, unknown>();
      if (Array.isArray(rows)) {
        for (const row of rows) values.set(String(row.config_key), row.config_value);
      }
      return response(
        storedInterval(values.get(SERVER_COLLECTION_INTERVAL_CONFIG_KEY)),
        storedInterval(values.get(NETWORK_DEVICE_COLLECTION_INTERVAL_CONFIG_KEY)),
      );
    } catch {
      return response(DEFAULT_COLLECTION_INTERVAL_SECONDS, DEFAULT_COLLECTION_INTERVAL_SECONDS);
    }
  }

  async set(
    config: Pick<CollectionConfig, 'serverIntervalSeconds' | 'networkDeviceIntervalSeconds'>,
    actorId: number,
  ): Promise<CollectionConfig> {
    if (!validInterval(config.serverIntervalSeconds)
      || !validInterval(config.networkDeviceIntervalSeconds)
      || !Number.isSafeInteger(actorId)
      || actorId <= 0) {
      throw new Error('COLLECTION_CONFIG_UPDATE_INVALID');
    }

    const executor = this.executorProvider();
    if (!executor) throw new Error('COLLECTION_CONFIG_UPDATE_FAILED');
    try {
      await executor.execute(
        `INSERT INTO system_config (config_key, config_value, value_type, description, updated_by)
         VALUES (?, ?, 'number', ?, ?), (?, ?, 'number', ?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), value_type = VALUES(value_type),
           description = VALUES(description), updated_by = VALUES(updated_by)`,
        [
          SERVER_COLLECTION_INTERVAL_CONFIG_KEY,
          String(config.serverIntervalSeconds),
          SERVER_DESCRIPTION,
          actorId,
          NETWORK_DEVICE_COLLECTION_INTERVAL_CONFIG_KEY,
          String(config.networkDeviceIntervalSeconds),
          NETWORK_DEVICE_DESCRIPTION,
          actorId,
        ],
      );
      return response(config.serverIntervalSeconds, config.networkDeviceIntervalSeconds);
    } catch {
      throw new Error('COLLECTION_CONFIG_UPDATE_FAILED');
    }
  }
}

export const collectionConfigService = new CollectionConfigService();
