import type { ObservationQuality } from '../resources/types.js';
import {
  DEFAULT_HUAWEI_MIB_CATALOG,
  getHuaweiMibCatalog,
  type HuaweiMibCatalog,
  type HuaweiOidDefinition,
} from './huawei-mib-catalog.js';
import type { SnmpClient } from './snmp-client.js';
import type { SnmpTableRow, SnmpV3Config, SnmpVarbind } from './snmp-types.js';

export interface HuaweiSnmpTransport {
  get(config: SnmpV3Config, oids: string[]): Promise<SnmpVarbind[]>;
  table(config: SnmpV3Config, rootOid: string): Promise<SnmpTableRow[]>;
}

export interface HuaweiMetricObservation {
  metricId: string;
  value: number | null;
  dimensions?: Record<string, string>;
  observedAt: Date;
  quality: ObservationQuality;
  source: 'snmpv3';
  reason?: string;
  rawValue?: number;
}

export interface HuaweiProbeResult {
  reachable: boolean;
  sysName?: string;
  sysDescr?: string;
  uptimeSeconds?: number;
  observedAt: Date;
  quality: ObservationQuality;
  reason?: string;
}

export interface HuaweiInterfaceSnapshot {
  ifIndex: number;
  name: string;
  alias?: string;
  speedBps: number | null;
  adminStatus: 'up' | 'down' | 'testing' | 'unknown';
  operStatus: 'up' | 'down' | 'testing' | 'unknown';
}

export interface HuaweiInterfaceCollection {
  interfaces: HuaweiInterfaceSnapshot[];
  observations: HuaweiMetricObservation[];
  observedAt: Date;
}

interface CounterState {
  value: bigint;
  bits: 32 | 64;
  observedAt: number;
}

type Clock = () => Date;

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) return (value as { value: unknown }).value;
  return value;
}

function numberValue(value: unknown): number | null {
  const raw = unwrap(value);
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (Buffer.isBuffer(raw)) {
    const parsed = Number(raw.toString('utf8'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function integerValue(value: unknown): bigint | null {
  const raw = unwrap(value);
  if (typeof raw === 'bigint') return raw >= 0n ? raw : null;
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw) : null;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    try { return BigInt(raw.trim()); } catch { return null; }
  }
  if (Buffer.isBuffer(raw) && /^\d+$/.test(raw.toString('utf8').trim())) {
    try { return BigInt(raw.toString('utf8').trim()); } catch { return null; }
  }
  return null;
}

function textValue(value: unknown): string | undefined {
  const raw = unwrap(value);
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  return raw == null ? undefined : String(raw);
}

function mapStatus(value: unknown): HuaweiInterfaceSnapshot['operStatus'] {
  const numeric = numberValue(value);
  if (numeric === 1 || String(unwrap(value)).toLowerCase() === 'up') return 'up';
  if (numeric === 2 || String(unwrap(value)).toLowerCase() === 'down') return 'down';
  if (numeric === 3 || String(unwrap(value)).toLowerCase() === 'testing') return 'testing';
  return 'unknown';
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function byOid(varbinds: SnmpVarbind[]): Map<string, SnmpVarbind> {
  return new Map(varbinds.map((varbind) => [varbind.oid, varbind]));
}

function rowValue(row: SnmpTableRow, definition: HuaweiOidDefinition, column: number, names: string[] = []): unknown {
  const values = row.values ?? {};
  const suffix = definition.oid.split('.').at(-1)!;
  const candidates = [definition.oid, suffix, String(column), ...names];
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
  }
  return undefined;
}

function qualityFor(value: number | null, reason?: string): ObservationQuality {
  return value == null ? 'unknown' : reason ? 'degraded' : 'good';
}

export class HuaweiAdapter {
  private readonly counters = new Map<string, CounterState>();
  private lastUptimeSeconds: number | null = null;

  constructor(
    private readonly client: Pick<SnmpClient, 'get' | 'table'> | HuaweiSnmpTransport,
    private readonly catalog: HuaweiMibCatalog = DEFAULT_HUAWEI_MIB_CATALOG,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async probe(config: SnmpV3Config): Promise<HuaweiProbeResult> {
    const observedAt = this.clock();
    const varbinds = await this.client.get(config, [
      this.catalog.scalars.sysUpTime.oid,
      this.catalog.scalars.sysName.oid,
      this.catalog.scalars.sysDescr.oid,
    ]);
    const values = byOid(varbinds);
    const uptime = this.scaledNumber(values.get(this.catalog.scalars.sysUpTime.oid), this.catalog.scalars.sysUpTime);
    return {
      reachable: true,
      sysName: textValue(values.get(this.catalog.scalars.sysName.oid)),
      sysDescr: textValue(values.get(this.catalog.scalars.sysDescr.oid)),
      uptimeSeconds: uptime ?? undefined,
      observedAt,
      quality: uptime == null ? 'degraded' : 'good',
      reason: uptime == null ? 'uptime_missing' : undefined,
    };
  }

  async collectSystemMetrics(config: SnmpV3Config, firmware?: string): Promise<HuaweiMetricObservation[]> {
    const catalog = firmware ? getHuaweiMibCatalog(firmware, [this.catalog]) : this.catalog;
    const definitions: Array<[string, HuaweiOidDefinition | undefined]> = [
      ['device_uptime_seconds', catalog.scalars.sysUpTime],
      ['device_cpu_percent', catalog.vendorMetrics.cpu],
      ['device_memory_percent', catalog.vendorMetrics.memory],
      ['device_temperature_celsius', catalog.vendorMetrics.temperature],
    ];
    const oids = definitions.flatMap(([, definition]) => definition ? [definition.oid] : []);
    const values = byOid(await this.client.get(config, oids));
    const observedAt = this.clock();
    const observations: HuaweiMetricObservation[] = [];
    for (const [metricId, definition] of definitions) {
      if (!definition) {
        observations.push(this.metric(metricId, null, observedAt, 'unknown', 'mib_unsupported'));
        continue;
      }
      const raw = values.get(definition.oid);
      const numeric = this.scaledNumber(raw, definition);
      let reason: string | undefined;
      let value = numeric;
      if (numeric == null) reason = 'value_missing';
      if (value != null && (metricId.includes('percent') && (value < 0 || value > 100))) {
        value = null;
        reason = 'value_out_of_range';
      }
      if (metricId === 'device_uptime_seconds' && value != null) {
        if (this.lastUptimeSeconds != null && value < this.lastUptimeSeconds) reason = 'device_rebooted';
        this.lastUptimeSeconds = value;
      }
      observations.push(this.metric(metricId, value, observedAt, qualityFor(value, reason), reason, numeric ?? undefined));
    }
    return observations;
  }

  async collectInterfaces(config: SnmpV3Config): Promise<HuaweiInterfaceCollection> {
    const observedAt = this.clock();
    const rows = await this.client.table(config, this.catalog.interfaces.tableOid);
    if (!Array.isArray(rows) || rows.length > 2_000) throw new Error('SNMP_TABLE_LIMIT');
    const interfaces: HuaweiInterfaceSnapshot[] = [];
    const observations: HuaweiMetricObservation[] = [];
    for (const row of rows) {
      const ifIndex = numberValue(row.index) ?? numberValue(rowValue(row, this.catalog.interfaces.ifIndex, 1));
      if (ifIndex == null || !Number.isSafeInteger(ifIndex) || ifIndex < 1) continue;
      const name = textValue(rowValue(row, this.catalog.interfaces.ifDescr, 2, ['ifDescr', 'ifName'])) || `if-${ifIndex}`;
      const alias = textValue(rowValue(row, this.catalog.interfaces.ifAlias, 18, ['ifAlias']));
      const speed = numberValue(rowValue(row, this.catalog.interfaces.ifSpeed, 5, ['ifSpeed']));
      const adminStatus = mapStatus(rowValue(row, this.catalog.interfaces.ifAdminStatus, 7, ['ifAdminStatus']));
      const operStatus = mapStatus(rowValue(row, this.catalog.interfaces.ifOperStatus, 8, ['ifOperStatus']));
      interfaces.push({ ifIndex, name, alias, speedBps: speed, adminStatus, operStatus });
      const baseDimensions = { interface: name, if_index: String(ifIndex) };
      observations.push(this.metric('interface_oper_status', operStatus === 'up' ? 1 : operStatus === 'down' ? 0 : null, observedAt, operStatus === 'unknown' ? 'unknown' : 'good', operStatus === 'unknown' ? 'status_unknown' : undefined, undefined, baseDimensions));
      const counter = (metricId: string, direction: 'in' | 'out', preferred: HuaweiOidDefinition, fallback: HuaweiOidDefinition, preferredColumn: number, fallbackColumn: number, names: string[]) => {
        const [current, bits] = this.counterValue(row, preferred, fallback, preferredColumn, fallbackColumn, names);
        return { metricId, direction, current, bits };
      };
      const counters: Array<{ metricId: string; direction: 'in' | 'out'; current: bigint | null; bits: 32 | 64 }> = [
        counter('interface_in_bps', 'in', this.catalog.interfaces.ifHCInOctets, this.catalog.interfaces.ifInOctets, 6, 10, ['ifHCInOctets', 'ifInOctets']),
        counter('interface_out_bps', 'out', this.catalog.interfaces.ifHCOutOctets, this.catalog.interfaces.ifOutOctets, 10, 16, ['ifHCOutOctets', 'ifOutOctets']),
        counter('interface_error_rate', 'in', this.catalog.interfaces.ifInErrors, this.catalog.interfaces.ifInErrors, 14, 14, ['ifInErrors']),
        counter('interface_error_rate', 'out', this.catalog.interfaces.ifOutErrors, this.catalog.interfaces.ifOutErrors, 20, 20, ['ifOutErrors']),
        counter('interface_drop_rate', 'in', this.catalog.interfaces.ifInDiscards, this.catalog.interfaces.ifInDiscards, 13, 13, ['ifInDiscards']),
        counter('interface_drop_rate', 'out', this.catalog.interfaces.ifOutDiscards, this.catalog.interfaces.ifOutDiscards, 19, 19, ['ifOutDiscards']),
      ];
      for (const counter of counters) {
        const result = this.rate(`${ifIndex}:${counter.metricId}:${counter.direction}`, counter.current, counter.bits, observedAt.getTime());
        const dimensions = { ...baseDimensions, direction: counter.direction };
        observations.push(this.metric(counter.metricId, counter.metricId.endsWith('_bps') && result.value != null ? result.value * 8 : result.value, observedAt, result.quality, result.reason, counter.current == null || counter.current > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(counter.current), dimensions));
      }
    }
    return { interfaces, observations, observedAt };
  }

  private counterValue(row: SnmpTableRow, preferred: HuaweiOidDefinition, fallback: HuaweiOidDefinition, preferredColumn: number, fallbackColumn: number, names: string[]): [bigint | null, 32 | 64] {
    const preferredValue = integerValue(rowValue(row, preferred, preferredColumn, names));
    if (preferredValue != null) return [preferredValue, 64];
    return [integerValue(rowValue(row, fallback, fallbackColumn, names)), 32];
  }

  private rate(key: string, current: bigint | null, bits: 32 | 64, observedAt: number): { value: number | null; quality: ObservationQuality; reason?: string } {
    if (current == null || current < 0n) return { value: null, quality: 'unknown', reason: 'counter_missing' };
    const previous = this.counters.get(key);
    this.counters.set(key, { value: current, bits, observedAt });
    if (!previous) return { value: null, quality: 'unknown', reason: 'counter_baseline' };
    const elapsedSeconds = Math.max(1, (observedAt - previous.observedAt) / 1_000);
    let delta = current - previous.value;
    if (delta < 0n) {
      const modulus = 2n ** BigInt(previous.bits);
      if (previous.value > (modulus * 9n) / 10n) delta = current + modulus - previous.value;
      else return { value: null, quality: 'unknown', reason: 'counter_reset' };
    }
    const numericDelta = Number(delta);
    if (!Number.isFinite(numericDelta)) return { value: null, quality: 'unknown', reason: 'counter_overflow' };
    return { value: roundMetric(numericDelta / elapsedSeconds), quality: 'good' };
  }

  private scaledNumber(value: unknown, definition: HuaweiOidDefinition): number | null {
    const numeric = numberValue(value);
    return numeric == null ? null : roundMetric(numeric * definition.scale);
  }

  private metric(metricId: string, value: number | null, observedAt: Date, quality: ObservationQuality, reason?: string, rawValue?: number, dimensions?: Record<string, string>): HuaweiMetricObservation {
    return { metricId, value, observedAt, quality, source: 'snmpv3', ...(dimensions ? { dimensions } : {}), ...(reason ? { reason } : {}), ...(rawValue === undefined ? {} : { rawValue }) };
  }
}
