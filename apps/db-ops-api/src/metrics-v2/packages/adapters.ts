import type { Client } from 'ssh2';
import type { Pool } from 'mysql2/promise';
import type { SshSessionPool } from '../../ssh-session-pool.js';
import serverMetricProvider from '../../server-metric-provider.js';
import { DEFAULT_HUAWEI_MIB_CATALOG } from '../../network-devices/huawei-mib-catalog.js';
import type { SnmpClient } from '../../network-devices/snmp-client.js';
import type { SnmpConfig, SnmpTableRow, SnmpVarbind } from '../../network-devices/snmp-types.js';
import type { RawObservation } from '../../contracts/metrics-v2/index.js';
import type { SnmpDiscovery } from '../snmp/collector.js';
import { MYSQL_STATUS_SQL } from '../../collectors/mysql-status-query.js';

/** Same read-only status operation as MySQLProvider; batch once without its legacy Number/rate path. */
export { MYSQL_STATUS_SQL };
export type Transport =
  | { method: 'sql'; pool: { query(options: { sql: string; timeout: number }): Promise<[unknown, unknown]> } }
  | { method: 'ssh'; client: Client; pool: Pick<SshSessionPool, 'execCommands'> }
  | { method: 'snmp'; get?(oids: string[], timeoutMs: number): Promise<SnmpVarbind[]>; table(root: string, timeoutMs: number): Promise<SnmpTableRow[]> };
export function bindMySql(pool: Pick<Pool, 'query'>): Transport {
  return { method: 'sql', pool: { query: options => pool.query(options) } };
}
/** Existing SnmpClient owns configuration validation, response bounds, session closure and read allowlist. */
export function bindSnmp(client: Pick<SnmpClient, 'table'> & Partial<Pick<SnmpClient, 'get'>>, config: SnmpConfig): Transport {
  return { method: 'snmp', ...(client.get ? { get: (oids: string[], timeoutMs: number) => client.get!({ ...config, timeoutMs }, oids) } : {}), table: (root, timeoutMs) => client.table({ ...config, timeoutMs }, root) };
}
export interface DriverEvidence {
  snmp?: SnmpDiscovery;
  /** Trusted startup/discontinuity evidence, retained by the driver; never invent an epoch per sample. */
  counter?: RawObservation['counter'];
  /** Stable identity for each interface generation, supplied by discovery ownership, not display name. */
  interface_epochs?: Record<string, string>;
}
export interface DecodedRow {
  observed_at?: string;
  dimensions: Record<string, string>;
  fields: Record<string, RawObservation['value']>;
  counter?: RawObservation['counter'];
  field_evidence?: Record<string, { counter?: RawObservation['counter']; max_increment_per_second?: string; quality?: RawObservation['quality']; capability?: 'supported' | 'unsupported' | 'unknown'; error?: AdapterError['code'] }>;
}
export class AdapterError extends Error {
  constructor(readonly code: 'permission_denied' | 'timeout' | 'connection_error' | 'parse_error') { super(code); }
}
export function classifyError(error: unknown): AdapterError['code'] {
  if (error instanceof AdapterError) return error.code;
  const level = error && typeof error === 'object' && 'level' in error ? error.level : undefined;
  if (level === 'client-authentication') return 'permission_denied';
  if (level === 'client-timeout') return 'timeout';
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : '';
  if (['ER_ACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR', 'EACCES', 'SNMP_AUTH_FAILED', 'SSH_AUTH_FAILED', 'SSH_AUTHENTICATION_FAILED'].includes(code)) return 'permission_denied';
  if (['ETIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'SNMP_TIMEOUT', 'SSH_COMMAND_TIMEOUT'].includes(code)) return 'timeout';
  if (['SNMP_RESPONSE_INVALID', 'SNMP_RESPONSE_LIMIT', 'SSH_COMMAND_OUTPUT_LIMIT', 'SSH_COMMAND_PROTOCOL_ERROR'].includes(code)) return 'parse_error';
  return 'connection_error';
}
async function read<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { throw new AdapterError(classifyError(error)); }
}
function uint(value: unknown): RawObservation['value'] {
  const raw = typeof value === 'bigint' ? value.toString() : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw) || raw.length > 20 || BigInt(raw) >= (1n << 64n)) throw new AdapterError('parse_error');
  return { encoding: 'uint64', value: raw };
}

/** Only fixed implementation IDs reach transports. Packages never carry executable commands or OIDs. */
export async function collectFixed(id: string, transport: Transport, evidence: DriverEvidence, timeoutMs: number, maxRows: number): Promise<DecodedRow[]> {
  if (id.startsWith('builtin:snmp.') && transport.method === 'snmp' && evidence.snmp) {
    return evidence.snmp.collect(id, transport, timeoutMs, maxRows);
  }
  if (id === 'builtin:mysql.status.v1' && transport.method === 'sql') {
    const [response] = await read(() => transport.pool.query({ sql: MYSQL_STATUS_SQL, timeout: timeoutMs }));
    if (!Array.isArray(response) || response.length !== 2) throw new AdapterError('parse_error');
    const values = new Map<string, unknown>();
    for (const item of response) {
      if (!item || typeof item !== 'object' || !['Queries', 'Uptime'].includes(item.Variable_name) || values.has(item.Variable_name)) throw new AdapterError('parse_error');
      values.set(item.Variable_name, item.Value);
    }
    if (!evidence.counter || evidence.counter.bits !== '64') throw new AdapterError('parse_error');
    const up = uint(values.get('Uptime'))!;
    const seconds = Number((up as { value: string }).value);
    if (!Number.isSafeInteger(seconds)) throw new AdapterError('parse_error');
    return [{ dimensions: {}, fields: { Uptime: { encoding: 'float64', value: seconds }, Queries: uint(values.get('Queries')) }, counter: evidence.counter }];
  }
  if (id === 'builtin:linux.basic.v1' && transport.method === 'ssh') {
    // These two procfs commands are shared by all existing Linux distribution profiles.
    const definitions = serverMetricProvider.getDefinitions('rhel');
    const selected = ['uptime', 'load_1min'].map(name => definitions.find(d => d.name === name));
    if (selected.some(d => !d)) throw new AdapterError('parse_error');
    const results = await read(() => transport.pool.execCommands(transport.client, selected.map(d => d!.command), { timeoutMs, maxOutputBytes: 65536 }));
    if (results.length !== 2) throw new AdapterError('parse_error');
    const fields: DecodedRow['fields'] = {};
    results.forEach((result, i) => {
      if (result.truncated || Buffer.byteLength(result.stdout) > 65536) throw new AdapterError('parse_error');
      if (result.exitCode !== 0) throw new AdapterError(/permission denied/i.test(result.stderr) ? 'permission_denied' : 'parse_error');
      const value = selected[i]!.parse(result.stdout);
      if (value === null || value < 0) throw new AdapterError('parse_error');
      fields[selected[i]!.name] = { encoding: 'float64', value };
    });
    return [{ dimensions: {}, fields }];
  }
  if (id === 'builtin:if_mib.status.v1' && transport.method === 'snmp') {
    const catalog = DEFAULT_HUAWEI_MIB_CATALOG.interfaces;
    const rows = await read(() => transport.table(catalog.tableOid, timeoutMs));
    if (!Array.isArray(rows) || rows.length > maxRows) throw new AdapterError('parse_error');
    const seen = new Set<string>();
    return rows.map(row => {
      if (!/^[1-9]\d{0,9}$/.test(row.index) || BigInt(row.index) > 2147483647n || seen.has(row.index)) throw new AdapterError('parse_error');
      seen.add(row.index);
      const epoch = evidence.interface_epochs?.[row.index];
      if (!epoch || epoch.length > 128) throw new AdapterError('parse_error');
      let value = row.values?.[catalog.ifOperStatus.oid] ?? row.values?.['8'];
      if (value && typeof value === 'object' && 'value' in value) value = value.value;
      if (Buffer.isBuffer(value)) value = value.toString('utf8');
      const status = typeof value === 'string' && /^[1-7]$/.test(value) ? Number(value) : value;
      if (typeof status !== 'number' || !Number.isInteger(status) || status < 1 || status > 7) throw new AdapterError('parse_error');
      return { dimensions: { if_index: row.index, interface_epoch: epoch }, fields: {
        ifOperStatus: status === 1 || status === 2 ? { encoding: 'float64' as const, value: status === 1 ? 1 : 0 } : null,
      } };
    });
  }
  throw new AdapterError('parse_error');
}
