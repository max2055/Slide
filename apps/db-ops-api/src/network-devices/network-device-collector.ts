import { dbConnection } from '../db-connection.js';
import { canonicalDimensions } from '../resources/types.js';
import { authorizeNetworkDeviceTarget } from '../security/network-device-target-policy.js';
import {
  networkDeviceDatabaseService,
  type NetworkDeviceCredentials,
} from './network-device-database-service.js';
import { HuaweiAdapter, type HuaweiInterfaceSnapshot, type HuaweiMetricObservation } from './huawei-adapter.js';
import { SnmpClient } from './snmp-client.js';
import type { SnmpConfig, SnmpV3Config } from './snmp-types.js';
import { type CollectionScheduleStore } from '../collection-scheduler.js';
import type { Pool } from 'mysql2/promise';
import { legacyMetricSourceActive } from '../metrics/rollout/legacy-write-fence.js';

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
  legacySourceActive?(id: number): Promise<boolean>;
}

interface SqlPool {
  execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>;
}

export interface NetworkDeviceCollectorOptions {
  heartbeatMs?: number;
  maxFailuresBeforeUnreachable?: number;
  commandTimeoutMs?: number;
  scheduleStore?: CollectionScheduleStore;
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

export function toSnmpConfig(target: NetworkDeviceCollectionTarget, credentials: NetworkDeviceCredentials, authorizedHost = target.host): SnmpConfig {
  if (credentials.protocol === 'snmpv2c') {
    if (!credentials.community) throw Object.assign(new Error('SNMP_AUTH_FAILED'), { code: 'SNMP_AUTH_FAILED' });
    return { version: 2, host: authorizedHost, port: target.snmpPort, community: credentials.community };
  }
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

/** One-shot diagnostics only. Periodic metric jobs belong to MetricScheduler. */
export class NetworkDeviceCollector {
  constructor(private readonly store: NetworkDeviceCollectionStore,
    private readonly adapter: Pick<HuaweiAdapter,'probe'|'collectSystemMetrics'|'collectInterfaces'>,
    private readonly options: NetworkDeviceCollectorOptions = {}) {}
  start():void {}
  stop():void {}
  async collectDevice(id:number,requestedMetricIds?:readonly string[]):Promise<{success:boolean;error?:string;succeededMetricIds?:string[]}> {
    if (requestedMetricIds?.length !== 0) {
      const {metricConfigurationService}=await import('../metrics/config/routes.js');
      const trial=await metricConfigurationService.trialCurrent({userId:0,username:'network-collection',roles:[],permissions:['network_devices:view','network_devices:manage','collector:manage'],instanceScopes:{},sessionVersion:0,requestId:`network-collection:${id}`},{type:'network_device',id});
      return {success:trial.decision==='attempted'};
    }
    const target=await this.store.getDevice(id);
    if(!target)return {success:false,error:'NETWORK_DEVICE_NOT_FOUND'};
    if(!target.collectionEnabled)return {success:false,error:'COLLECTION_DISABLED'};
    try {
      const authorized=await (this.options.authorizeTarget??authorizeNetworkDeviceTarget)({host:target.host,port:target.snmpPort},this.options.targetPolicy??{});
      const credentials=await this.store.getCredentials(id);if(!credentials)return {success:false,error:'SNMP_AUTH_FAILED'};
      const probe=await this.adapter.probe({...toSnmpConfig(target,credentials,authorized.address),timeoutMs:this.options.commandTimeoutMs??15000});
      if(!probe.reachable)return {success:false,error:'SNMP_RESPONSE_INVALID'};
      await this.store.updateStatus(id,'online');return {success:true,succeededMetricIds:[]};
    } catch(error){return {success:false,error:stableError(error)};}
  }
}

export class MysqlNetworkDeviceCollectionStore implements NetworkDeviceCollectionStore {
  constructor(private readonly poolProvider: () => Pool | null = () => dbConnection.getPool()) {}

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
    return networkDeviceDatabaseService.getCredentials(id);
  }

  async updateStatus(id: number, status: 'online' | 'error' | 'unreachable'): Promise<void> {
    await networkDeviceDatabaseService.updateStatus(id, status);
  }

  legacySourceActive(id: number): Promise<boolean> {
    return legacyMetricSourceActive(this.pool(), { type: 'network_device', id });
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

  async insertObservations(_id:number,_observations:HuaweiMetricObservation[]):Promise<void> { throw new Error('METRIC_HISTORY_READ_ONLY'); }

  private pool(): Pool {
    const pool = this.poolProvider();
    if (!pool) throw new Error('RESOURCE_STORE_UNAVAILABLE');
    return pool;
  }
}

export const networkDeviceCollector = new NetworkDeviceCollector(
  new MysqlNetworkDeviceCollectionStore(),
  new HuaweiAdapter(new SnmpClient()),
);
