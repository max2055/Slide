import { dbConnection } from '../db-connection.js';
import { canonicalDimensions } from '../resources/types.js';
import { authorizeNetworkDeviceTarget } from '../security/network-device-target-policy.js';
import {
  networkDeviceDatabaseService,
  type NetworkDeviceCredentials,
} from './network-device-database-service.js';
import { HuaweiAdapter, type HuaweiInterfaceSnapshot, type HuaweiMetricObservation, type HuaweiSnmpTransport } from './huawei-adapter.js';
import { SnmpClient } from './snmp-client.js';
import type { SnmpV3Config } from './snmp-types.js';

export interface NetworkDeviceCollectionTarget {
  id: number;
  host: string;
  snmpPort: number;
  model?: string | null;
  osVersion?: string | null;
  collectionEnabled: boolean;
}

export interface NetworkDeviceCollectionStore {
  getDevice(id: number): Promise<NetworkDeviceCollectionTarget | null>;
  getCollectionEnabledDevices?(): Promise<NetworkDeviceCollectionTarget[]>;
  getCredentials(id: number): Promise<NetworkDeviceCredentials | null>;
  updateStatus(id: number, status: 'online' | 'error' | 'unreachable'): Promise<void>;
  upsertInterface(id: number, snapshot: HuaweiInterfaceSnapshot, observedAt: Date): Promise<void>;
  insertObservations(id: number, observations: HuaweiMetricObservation[]): Promise<void>;
}

interface SqlPool {
  execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>;
}

export interface NetworkDeviceCollectorOptions {
  collectionIntervalMs?: number;
  maxFailuresBeforeUnreachable?: number;
  commandTimeoutMs?: number;
  authorizeTarget?: typeof authorizeNetworkDeviceTarget;
  targetPolicy?: {
    allowedCidrs?: string;
    allowedPorts?: readonly number[];
    production?: boolean;
    lookup?: (hostname: string) => Promise<Array<{ address: string }>>;
  };
}

function stableError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as any).code) : '';
  if (/^SNMP_[A-Z0-9_]+$/.test(code)) return code;
  const reasonCode = error && typeof error === 'object' && 'reasonCode' in error ? String((error as any).reasonCode) : '';
  if (reasonCode === 'SNMP_TARGET_POLICY_NOT_CONFIGURED') return reasonCode;
  if (/^SNMP_TARGET_/.test(reasonCode)) return 'SNMP_TARGET_DENIED';
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) return 'SNMP_TIMEOUT';
  if (/auth|usm|security/i.test(message)) return 'SNMP_AUTH_FAILED';
  return 'SNMP_RESPONSE_INVALID';
}

function toSnmpConfig(target: NetworkDeviceCollectionTarget, credentials: NetworkDeviceCredentials, authorizedHost = target.host): SnmpV3Config {
  if (credentials.protocol !== 'snmpv3' || !credentials.username || !credentials.securityLevel) {
    throw Object.assign(new Error('SNMP_AUTH_FAILED'), { code: 'SNMP_AUTH_FAILED' });
  }
  if (credentials.authProtocol && !['SHA', 'MD5'].includes(credentials.authProtocol)) {
    throw Object.assign(new Error('SNMP_UNSUPPORTED_SECURITY'), { code: 'SNMP_UNSUPPORTED_SECURITY' });
  }
  if (credentials.privacyProtocol && !['AES', 'DES'].includes(credentials.privacyProtocol)) {
    throw Object.assign(new Error('SNMP_UNSUPPORTED_SECURITY'), { code: 'SNMP_UNSUPPORTED_SECURITY' });
  }
  return {
    host: authorizedHost,
    port: target.snmpPort,
    username: credentials.username,
    securityLevel: credentials.securityLevel,
    authProtocol: credentials.authProtocol as SnmpV3Config['authProtocol'],
    authSecret: credentials.authSecret,
    privacyProtocol: credentials.privacyProtocol as SnmpV3Config['privacyProtocol'],
    privacySecret: credentials.privacySecret,
  };
}

export class NetworkDeviceCollector {
  private readonly failures = new Map<number, number>();
  private readonly inFlight = new Set<number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly options: {
    collectionIntervalMs: number;
    maxFailuresBeforeUnreachable: number;
    commandTimeoutMs: number;
    authorizeTarget: typeof authorizeNetworkDeviceTarget;
    targetPolicy: NonNullable<NetworkDeviceCollectorOptions['targetPolicy']>;
  };

  constructor(
    private readonly store: NetworkDeviceCollectionStore,
    private readonly adapter: Pick<HuaweiAdapter, 'probe' | 'collectSystemMetrics' | 'collectInterfaces'>,
    options: NetworkDeviceCollectorOptions = {},
  ) {
    this.options = {
      collectionIntervalMs: options.collectionIntervalMs ?? (Number(process.env.NETWORK_DEVICE_COLLECTION_INTERVAL_MS) || 300_000),
      maxFailuresBeforeUnreachable: options.maxFailuresBeforeUnreachable ?? 3,
      commandTimeoutMs: options.commandTimeoutMs ?? 15_000,
      authorizeTarget: options.authorizeTarget ?? authorizeNetworkDeviceTarget,
      targetPolicy: options.targetPolicy ?? {},
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => undefined); }, this.options.collectionIntervalMs);
    this.tick().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.inFlight.clear();
    this.failures.clear();
  }

  async tick(): Promise<void> {
    const targets = await this.store.getCollectionEnabledDevices?.() ?? [];
    for (const target of targets) {
      await this.collectDevice(target.id);
    }
  }

  async collectDevice(id: number): Promise<{ success: boolean; observations?: number; interfaces?: number; error?: string }> {
    if (this.inFlight.has(id)) return { success: false, error: 'COLLECTION_IN_PROGRESS' };
    this.inFlight.add(id);
    try {
      const target = await this.store.getDevice(id);
      if (!target) return { success: false, error: 'NETWORK_DEVICE_NOT_FOUND' };
      if (!target.collectionEnabled) return { success: false, error: 'COLLECTION_DISABLED' };
      let authorizedTarget: { address: string; port: number };
      try {
        authorizedTarget = await this.options.authorizeTarget(
          { host: target.host, port: target.snmpPort },
          {
            allowedCidrs: this.options.targetPolicy.allowedCidrs,
            allowedPorts: this.options.targetPolicy.allowedPorts,
            production: this.options.targetPolicy.production,
            lookup: this.options.targetPolicy.lookup,
          },
        );
      } catch (error) {
        return this.recordFailure(id, stableError(error));
      }
      const credentials = await this.store.getCredentials(id);
      if (!credentials) return this.recordFailure(id, 'SNMP_AUTH_FAILED');
      let config: SnmpV3Config;
      try { config = toSnmpConfig(target, credentials, authorizedTarget.address); } catch (error) { return this.recordFailure(id, stableError(error)); }

      try {
        const probe = await this.adapter.probe(config);
        if (!probe.reachable) return this.recordFailure(id, 'SNMP_RESPONSE_INVALID');
        const system = await this.adapter.collectSystemMetrics(config, target.osVersion ?? undefined);
        const interfaces = await this.adapter.collectInterfaces(config);
        for (const snapshot of interfaces.interfaces) await this.store.upsertInterface(id, snapshot, interfaces.observedAt);
        const observations = [...system, ...interfaces.observations];
        await this.store.insertObservations(id, observations);
        await this.store.updateStatus(id, 'online');
        this.failures.delete(id);
        return { success: true, observations: observations.length, interfaces: interfaces.interfaces.length };
      } catch (error) {
        return this.recordFailure(id, stableError(error));
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async recordFailure(id: number, error: string): Promise<{ success: false; error: string }> {
    const failures = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, failures);
    const authFailure = error === 'SNMP_AUTH_FAILED' || error === 'SNMP_UNSUPPORTED_SECURITY';
    if (authFailure || failures >= this.options.maxFailuresBeforeUnreachable) {
      await this.store.updateStatus(id, authFailure ? 'error' : 'unreachable');
    } else {
      await this.store.updateStatus(id, 'error');
    }
    return { success: false, error };
  }
}

export class MysqlNetworkDeviceCollectionStore implements NetworkDeviceCollectionStore {
  constructor(private readonly poolProvider: () => SqlPool | null = () => dbConnection.getPool() as unknown as SqlPool | null) {}

  async getDevice(id: number): Promise<NetworkDeviceCollectionTarget | null> {
    const [rows] = await this.pool().execute<Array<any>>(
      'SELECT id, host, snmp_port AS snmpPort, model, os_version AS osVersion, collection_enabled AS collectionEnabled FROM network_devices WHERE id = ? LIMIT 1', [id],
    );
    const row = rows[0];
    return row ? { ...row, id: Number(row.id), snmpPort: Number(row.snmpPort), collectionEnabled: Boolean(row.collectionEnabled) } : null;
  }

  async getCollectionEnabledDevices(): Promise<NetworkDeviceCollectionTarget[]> {
    const [rows] = await this.pool().execute<Array<any>>(
      'SELECT id, host, snmp_port AS snmpPort, model, os_version AS osVersion, collection_enabled AS collectionEnabled FROM network_devices WHERE collection_enabled = 1 ORDER BY id',
    );
    return rows.map((row) => ({ ...row, id: Number(row.id), snmpPort: Number(row.snmpPort), collectionEnabled: true }));
  }

  async getCredentials(id: number): Promise<NetworkDeviceCredentials | null> {
    return networkDeviceDatabaseService.getCredentials(id, 'snmpv3');
  }

  async updateStatus(id: number, status: 'online' | 'error' | 'unreachable'): Promise<void> {
    await networkDeviceDatabaseService.updateStatus(id, status);
  }

  async upsertInterface(id: number, snapshot: HuaweiInterfaceSnapshot, observedAt: Date): Promise<void> {
    await this.pool().execute(
      `INSERT INTO network_device_interfaces
       (device_id, if_index, if_name, if_alias, speed_bps, admin_status, oper_status, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE if_name = VALUES(if_name), if_alias = VALUES(if_alias), speed_bps = VALUES(speed_bps),
         admin_status = VALUES(admin_status), oper_status = VALUES(oper_status), last_seen_at = VALUES(last_seen_at)`,
      [id, snapshot.ifIndex, snapshot.name, snapshot.alias ?? null, snapshot.speedBps, snapshot.adminStatus, snapshot.operStatus, observedAt],
    );
  }

  async insertObservations(id: number, observations: HuaweiMetricObservation[]): Promise<void> {
    if (observations.length === 0) return;
    const rows = observations.map((observation) => {
      const dimensions = canonicalDimensions(observation.dimensions);
      const validUntil = new Date(observation.observedAt.getTime() + 5 * 60_000);
      return [id, observation.metricId, dimensions ? JSON.stringify(dimensions) : null, observation.value, observation.observedAt, validUntil, observation.quality, observation.source, observation.reason ?? null];
    });
    const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    await this.pool().execute(
      `INSERT INTO network_device_observations
       (device_id, metric_id, dimensions, metric_value, observed_at, valid_until, quality, source, reason)
       VALUES ${placeholders}`,
      rows.flat(),
    );
  }

  private pool(): SqlPool {
    const pool = this.poolProvider();
    if (!pool) throw new Error('RESOURCE_STORE_UNAVAILABLE');
    return pool;
  }
}

export const networkDeviceCollector = new NetworkDeviceCollector(
  new MysqlNetworkDeviceCollectionStore(),
  new HuaweiAdapter(new SnmpClient()),
);
