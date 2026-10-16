import { createHash, randomUUID } from 'node:crypto';
import type { SnmpVarbind, SnmpTableRow } from '../../network-devices/snmp-types.js';
import type { HuaweiMibCatalog } from '../../network-devices/huawei-mib-catalog.js';
import { AdapterError, classifyError, type DecodedRow, type Transport } from '../packages/adapters.js';

export const OIDS = Object.freeze({ uptime: '1.3.6.1.2.1.1.3.0', table: '1.3.6.1.2.1.2.2', xTable: '1.3.6.1.2.1.31.1.1' });
type Snmp = Extract<Transport, { method: 'snmp' }>;
type Detail = NonNullable<DecodedRow['field_evidence']>[string];
const absent = (v: unknown) => v === undefined || v === null || (typeof v === 'object' && 'type' in v && [128, 129, 130, 'NoSuchObject', 'NoSuchInstance', 'EndOfMibView'].includes((v as SnmpVarbind).type!));
const unwrap = (v: unknown): unknown => v && typeof v === 'object' && !Buffer.isBuffer(v) && 'value' in v ? v.value : v;

/** Counter64 is ASN.1 unsigned big-endian bytes, never UTF-8 or Number. */
export function unsigned(input: unknown, bits: 32 | 64): string {
  let v = unwrap(input);
  if (Buffer.isBuffer(v)) {
    if (!v.length || v.length > bits / 8) throw new AdapterError('parse_error');
    v = BigInt(`0x${v.toString('hex')}`).toString();
  }
  if (typeof v === 'bigint') v = v.toString();
  if (typeof v === 'number' && Number.isSafeInteger(v)) v = String(v);
  if (typeof v !== 'string' || !/^(0|[1-9]\d*)$/.test(v) || v.length > 20 || BigInt(v) >= 1n << BigInt(bits)) throw new AdapterError('parse_error');
  return v;
}
const text = (v: unknown) => { const raw = unwrap(v); return Buffer.isBuffer(raw) ? raw.toString('hex') : typeof raw === 'string' ? raw.slice(0, 512) : ''; };
function column(row: SnmpTableRow | undefined, root: string, n: number): unknown {
  return row?.values[`${root}.1.${n}`] ?? row?.values[String(n)];
}
function table(rows: SnmpTableRow[], max: number): Map<string, SnmpTableRow> {
  if (!Array.isArray(rows) || rows.length > max) throw new AdapterError('parse_error');
  const result = new Map<string, SnmpTableRow>();
  for (const row of rows) {
    if (!/^[1-9]\d{0,9}$/.test(row.index) || BigInt(row.index) > 2147483647n || result.has(row.index)) throw new AdapterError('parse_error');
    result.set(row.index, row);
  }
  return result;
}
async function get(t: Snmp, oids: string[], timeout: number): Promise<Map<string, SnmpVarbind>> {
  if (!t.get) throw new AdapterError('parse_error');
  const rows = await t.get(oids, timeout), result = new Map<string, SnmpVarbind>();
  for (const row of rows) {
    if (!oids.includes(row.oid) || result.has(row.oid)) throw new AdapterError('parse_error');
    result.set(row.oid, row);
  }
  return result;
}
export const vendorImplementation = (catalog: HuaweiMibCatalog) => `builtin:snmp.vendor.v1:${createHash('sha256').update(JSON.stringify(catalog)).digest('hex')}`;
interface Identity { fingerprint: string; epoch: string; discontinuity: string; at: string; counterEpoch: string; reason: 'initial' | 'boot' | 'reset' | 'source_change' }

/** One instance per authorized resource/target. Recreate on target/credential change.
 * Restart deliberately resets baselines. No rates are inferred across discovery loss.
 */
export class SnmpDiscovery {
  private interfaces = new Map<string, Identity>();
  private previous?: { ticks: number; at: number };
  constructor(private readonly clock = Date.now, private readonly vendor?: HuaweiMibCatalog) {}

  async collect(id: string, t: Snmp, timeout: number, maxRows: number): Promise<DecodedRow[]> {
    try {
      if (id === 'builtin:snmp.system.v1') {
        const values = await get(t, [OIDS.uptime], timeout);
        const row: DecodedRow = { observed_at: new Date(this.clock()).toISOString(), dimensions: {}, fields: {}, field_evidence: {} };
        this.field(row, 'sysUpTime', values.get(OIDS.uptime), v => ({ encoding: 'float64', value: Number(unsigned(v, 32)) / 100 }));
        return [row];
      }
      if (this.vendor && id === vendorImplementation(this.vendor)) return this.vendorRows(t, timeout);
      if (id !== 'builtin:snmp.interfaces.v1') throw new AdapterError('parse_error');
      return await this.interfaceRows(t, timeout, maxRows);
    } catch (error) {
      if (id === 'builtin:snmp.interfaces.v1') { this.interfaces.clear(); this.previous = undefined; }
      throw new AdapterError(classifyError(error));
    }
  }
  private field(row: DecodedRow, name: string, raw: unknown, decode: (v: unknown) => DecodedRow['fields'][string], detail: Detail = {}): void {
    row.field_evidence![name] = { ...detail, capability: 'supported' };
    if (absent(raw)) {
      row.fields[name] = null;
      row.field_evidence![name] = { ...detail, capability: 'unsupported', quality: { status: 'unknown', reason: 'missing_input' } };
      return;
    }
    try { row.fields[name] = decode(raw); }
    catch { row.fields[name] = null; row.field_evidence![name] = { ...detail, capability: 'unknown', error: 'parse_error', quality: { status: 'invalid', reason: 'source_error' } }; }
  }
  private async interfaceRows(t: Snmp, timeout: number, max: number): Promise<DecodedRow[]> {
    const start = await get(t, [OIDS.uptime], timeout);
    const ticks = Number(unsigned(start.get(OIDS.uptime), 32));
    const base = table(await t.table(OIDS.table, timeout), max);
    let extended = new Map<string, SnmpTableRow>(), xError: AdapterError['code'] | undefined;
    try { extended = table(await t.table(OIDS.xTable, timeout), max); }
    catch (e) { xError = classifyError(e); }
    const end = await get(t, [OIDS.uptime], timeout);
    const endTicks = Number(unsigned(end.get(OIDS.uptime), 32)), now = this.clock(), at = new Date(now).toISOString();
    // Uptime wrapping, reboot during walk, or an implausible clock delta all break continuity.
    if (endTicks < ticks) throw new AdapterError('parse_error');
    const reboot = !!this.previous && (ticks < this.previous.ticks || now <= this.previous.at
      || Math.abs((ticks - this.previous.ticks) * 10 - (now - this.previous.at)) > Math.max(2000, timeout * 2));
    if (reboot) this.interfaces.clear();
    const next = new Map<string, Identity>();
    const rows: DecodedRow[] = [];
    for (const [index, b] of base) {
      const x = extended.get(index), bc = (n: number) => column(b, OIDS.table, n), xc = (n: number) => column(x, OIDS.xTable, n);
      const identityParts = [text(xc(1)), text(bc(2)), text(bc(6))];
      const fingerprint = createHash('sha256').update(JSON.stringify(identityParts)).digest('hex');
      let discontinuity = '';
      try { if (!absent(xc(19))) { const value = unsigned(xc(19), 32); if (Number(value) <= endTicks) discontinuity = value; } } catch { /* unknown continuity */ }
      let identity = this.interfaces.get(index);
      if (!identity || identity.fingerprint !== fingerprint || identityParts.every(v => !v)) {
        identity = { fingerprint, epoch: randomUUID(), discontinuity, at, counterEpoch: randomUUID(), reason: reboot ? 'boot' : identity ? 'source_change' : 'initial' };
      } else if (!discontinuity || identity.discontinuity !== discontinuity) {
        identity = { ...identity, discontinuity, at, counterEpoch: randomUUID(), reason: 'reset' };
      }
      next.set(index, identity);
      const row: DecodedRow = { observed_at: at, dimensions: { if_index: index, interface_epoch: identity.epoch }, fields: {}, field_evidence: {} };
      const evidence = (bits: '32' | '64') => ({ bits, discontinuity: { epoch: `${identity.counterEpoch}:ifCounterDiscontinuityTime=${discontinuity || 'unknown'}`, observed_at: identity.at, reason: identity.reason } });
      for (const [field, n] of [['ifOperStatus', 8], ['ifAdminStatus', 7]] as const) this.field(row, field, bc(n), v => {
        const value = Number(unsigned(v, 32));
        if (value < 1 || value > (n === 8 ? 7 : 3)) throw new Error('STATUS');
        return value > 2 ? null : { encoding: 'float64', value: value === 1 ? 1 : 0 };
      });
      let speed: string | undefined;
      try {
        const high = absent(xc(15)) ? 0n : BigInt(unsigned(xc(15), 32));
        const low = absent(bc(5)) ? 0n : BigInt(unsigned(bc(5), 32));
        const value = high > 0n ? high * 1000000n : low === 4294967295n ? 0n : low;
        if (value > 0n) speed = value.toString();
      } catch { /* no trustworthy speed bound */ }
      this.field(row, 'ifSpeed', speed, v => ({ encoding: 'uint64', value: String(v) }));
      for (const [field, hc, low] of [['rxOctets', 6, 10], ['txOctets', 10, 16]] as const) {
        const wide = !absent(xc(hc)), bits = wide ? '64' : '32';
        const bound = speed ? (BigInt(speed) / 8n).toString() : undefined;
        this.field(row, field, wide ? xc(hc) : bc(low), v => ({ encoding: 'uint64', value: unsigned(v, wide ? 64 : 32) }), {
          counter: evidence(bits), ...(bound ? { max_increment_per_second: bound } : {}),
        });
      }
      for (const [field, n] of [['rxErrors', 14], ['txErrors', 20], ['rxDiscards', 13], ['txDiscards', 19]] as const) {
        // No standard physical upper bound for vendor error accounting; keep 32-bit rates unknown.
        this.field(row, field, bc(n), v => ({ encoding: 'uint64', value: unsigned(v, 32) }), { counter: evidence('32') });
      }
      if (xError) for (const field of ['rxOctets', 'txOctets']) {
        row.field_evidence![field] = { ...row.field_evidence![field], error: xError, capability: 'unknown', quality: { status: 'unknown', reason: 'source_error' } };
        row.fields[field] = null;
      }
      rows.push(row);
    }
    this.interfaces = next; this.previous = { ticks: endTicks, at: now };
    return rows;
  }
  private async vendorRows(t: Snmp, timeout: number): Promise<DecodedRow[]> {
    const row: DecodedRow = { observed_at: new Date(this.clock()).toISOString(), dimensions: {}, fields: {}, field_evidence: {} };
    // The frozen metric unit catalog has no Celsius; do not mislabel temperature as dimensionless.
    const entries = (['cpu', 'memory'] as const).flatMap(key => this.vendor?.vendorMetrics[key] ? [[key, this.vendor.vendorMetrics[key]!] as const] : []);
    const values = entries.length ? await get(t, entries.map(([, d]) => d.oid), timeout) : new Map<string, SnmpVarbind>();
    for (const key of ['cpu', 'memory']) {
      const definition = entries.find(([k]) => k === key)?.[1];
      this.field(row, key, definition ? values.get(definition.oid) : undefined, v => {
        const raw = unwrap(v), value = typeof raw === 'number' ? raw * definition!.scale : NaN;
        if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('VENDOR_VALUE');
        return { encoding: 'float64', value };
      });
    }
    return [row];
  }
}
