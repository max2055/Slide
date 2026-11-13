import { readFileSync } from 'node:fs';
import { createSocket, type Socket } from 'node:dgram';
import { once } from 'node:events';
import * as snmp from 'net-snmp';
import { describe, expect, it } from 'vitest';
import { createHuaweiMibCatalog } from '../../network-devices/huawei-mib-catalog.js';
import { SnmpClient } from '../../network-devices/snmp-client.js';
import { bindSnmp, type Transport } from '../packages/adapters.js';
import { runPackage, type PackageExecution } from '../packages/runner.js';
import { defaultSettings, resolvePolicy } from '../policy/resolver.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { createSnmpPackage } from './package.js';
import { OIDS, SnmpDiscovery } from './collector.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/snmp/fixtures.json', import.meta.url), 'utf8'));
function setup(size: number) {
  const b = Array.from({ length: size }, (_, i) => ({ index: String(i + 1), values: { ...fixture.ifTable[0].values,
    '1': i + 1, '2': `port-${i + 1}`, '3': 6, '6': (0x020000000000n + BigInt(i + 1)).toString(16).padStart(12, '0') } }));
  const x = b.map(row => ({ index: row.index, values: { ...fixture.ifXTable[0].values, '1': `port-${row.index}` } }));
  let now = Date.parse(fixture.at), ticks = fixture.uptime_ticks;
  const transport: Extract<Transport, { method: 'snmp' }> = { method: 'snmp',
    get: async oids => oids.map(oid => ({ oid, value: oid === OIDS.count ? b.length : ticks })),
    table: async root => root === OIDS.table ? b : x };
  const { registry, release, legacyRelease, pin } = createSnmpPackage();
  const context: PackageExecution = { resource: { id: '1', type: 'network_device', attributes: {
    'snmp.version': { value: 2, source: 'controlled-fixture', observed_at: fixture.at } } },
    binding_id: 'network_device:1', attempt_id: 'capacity', config_revision: 1, observed_at: fixture.at,
    clock: () => new Date(now).toISOString(), evidence: { snmp: new SnmpDiscovery(() => now, undefined, true) }, resolve: async () => transport };
  const run = async (maxRows?: number) => {
    context.attempt_id = `capacity-${now}`; context.observed_at = new Date(now).toISOString();
    const result = await runPackage(registry, { package: pin, credential_ref: 'credential:fixture',
      overrides: maxRows === undefined ? {} : { max_rows: maxRows } }, context);
    context.states = result.states;
    return result;
  };
  return { b, x, transport, context, registry, pin, release, legacyRelease, run,
    advance: () => { now += 60000; ticks += 6000; } };
}

describe('MAX-397 bounded complete SNMP interface discovery', () => {
  it.each([7, 24, 48, 64])('collects every status/counter and rate for %i interfaces by default', async size => {
    const s = setup(size);
    const first = await s.run();
    expect(first.attempts.every(a => a.status === 'succeeded')).toBe(true);
    expect(first.discovery_rows?.filter(r => r.collector_id === 'snmp-interfaces')).toHaveLength(size);
    expect(first.observations).toHaveLength(1 + 15 * size);
    s.advance();
    for (const row of s.x) { row.values['6'] = String(BigInt(row.values['6']) + 7500000n); row.values['10'] = String(BigInt(row.values['10']) + 15000000n); }
    const second = await s.run();
    for (const [direction, value] of [['rx', 1000000], ['tx', 2000000]] as const) {
      const rates = second.observations.filter(o => o.observation.metric.id === `snmp.interface.${direction}_bits_per_second`);
      expect(rates).toHaveLength(size);
      expect(rates.map(o => o.observation.value)).toEqual(Array.from({ length: size }, () => ({ encoding: 'float64', value })));
    }
  });
  it('keeps old pins, explicit limits and policy series budgets, including the 100-row hard limit', async () => {
    const s = setup(7), registry = createConfigurationRegistry();
    expect(registry.get(s.legacyRelease.package).recommendations.max_rows).toBe(6);
    expect(s.legacyRelease.package.digest).toBe('sha256:b1c321aed084d1d778389f6832aa29de0e0d4acc2444be5de9fdad0a22fd932d');
    const { id, version, digest } = s.legacyRelease.package;
    const legacy = await runPackage(s.registry, { package: { id, version, digest }, credential_ref: 'credential:fixture', overrides: {} }, s.context);
    expect(legacy.attempts.find(a => a.collector_id === 'snmp-interfaces')?.status).toBe('failed');
    expect(registry.get(s.pin).recommendations.max_rows).toBe(64);
    const binding = { resource: { type: 'network_device' as const, id: 1 }, package: s.pin, group_id: null, overrides: {}, revision: 1 };
    const resolve = (overrides = {}) => resolvePolicy(s.registry, { ...binding, overrides }, null, s.context.resource, [], fixture.at);
    expect(resolve().settings).toMatchObject({ max_rows: 64, max_series_per_resource: 961 });
    expect(resolve().impact.estimated_series_upper_bound).toBe(961);
    expect(() => resolve({ max_series_per_resource: { mode: 'set', value: 960 } })).toThrow('POLICY_SERIES_BUDGET');
    expect(() => resolve({ max_rows: { mode: 'set', value: 100 } })).toThrow('POLICY_SERIES_BUDGET');
    expect(resolve({ max_rows: { mode: 'set', value: 100 }, max_series_per_resource: { mode: 'set', value: 1501 } }).settings.max_rows).toBe(100);
    expect(() => resolve({ max_rows: { mode: 'set', value: 101 } })).toThrow();
    expect((await s.run(6)).attempts.find(a => a.collector_id === 'snmp-interfaces')).toMatchObject({ status: 'failed', evidence_code: 'SNMP_INTERFACE_CAPACITY_EXCEEDED' });
    const large = setup(100);
    expect((await large.run(100)).observations).toHaveLength(1501);
    expect((await setup(101).run(100)).attempts.find(a => a.collector_id === 'snmp-interfaces')?.status).toBe('failed');
  });
  it('retains the vendor package series budget as well', () => {
    const vendor = createSnmpPackage(createHuaweiMibCatalog(fixture.existing_vendor_fixture));
    expect(defaultSettings(vendor.release, vendor.registry.catalog(vendor.pin))).toMatchObject({ max_rows: 64, max_series_per_resource: 963 });
  });
  it.each(['count', 'end-count', 'base', 'extended'] as const)('rejects %s overflow atomically and recovers without false disappearance or rates', async mode => {
    const s = setup(48);
    const first = await s.run(); s.advance();
    const stateKeys = [...first.states.keys()];
    const realGet = s.transport.get!;
    let reads = 0;
    if (mode === 'count' || mode === 'end-count') s.transport.get = async oids => {
      if (oids.includes(OIDS.count)) reads++;
      return (await realGet(oids, 5000)).map(v => v.oid === OIDS.count && (mode === 'count' || reads > 1) ? { ...v, value: 65 } : v);
    };
    else {
      const rows = mode === 'base' ? s.b : s.x;
      while (rows.length < 65) rows.push({ ...structuredClone(rows[0]), index: String(rows.length + 1) });
    }
    const failed = await s.run();
    expect(failed.attempts.find(a => a.collector_id === 'snmp-interfaces')).toMatchObject({ status: 'failed', error: 'parse_error', evidence_code: 'SNMP_INTERFACE_CAPACITY_EXCEEDED', observation_ids: [] });
    expect(failed.discovery_rows?.some(r => r.collector_id === 'snmp-interfaces')).toBe(false);
    expect(failed.observations).toHaveLength(1);
    expect([...failed.states.keys()]).toEqual(stateKeys);
    s.transport.get = realGet; s.b.length = 48; s.x.length = 48; s.advance();
    const recovered = await s.run();
    expect(recovered.discovery_rows?.filter(r => r.collector_id === 'snmp-interfaces')).toHaveLength(48);
    expect(recovered.observations.filter(o => o.observation.metric.id === 'snmp.interface.rx_bits_per_second')
      .every(o => o.observation.value === null && o.observation.quality.reason === 'counter_reset')).toBe(true);
  });
  it('gives capacity diagnosis and adjustment instructions to direct callers', async () => {
    const s = setup(65);
    await expect(s.context.evidence.snmp!.collect('builtin:snmp.interfaces.v1', s.transport, 5000, 64))
      .rejects.toMatchObject({ evidenceCode: 'SNMP_INTERFACE_CAPACITY_EXCEEDED', message: expect.stringMatching(/max_rows=64.*max_series_per_resource.*100/) });
  });
  it('walks a controlled 48-port UDP endpoint through the production client and package runner', async () => {
    const s = setup(48), probe = createSocket('udp4');
    probe.bind(0, '127.0.0.1'); await once(probe, 'listening'); const endpoint = probe.address().port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const agent = snmp.createAgent({ port: endpoint, address: '127.0.0.1' }, () => {});
    try {
      agent.getAuthorizer().addCommunity('controlled-max397');
      await Promise.all(Object.values(agent.listener.sockets).map(socket => once(socket as Socket, 'listening')));
      const mib = agent.getMib(), ro = snmp.MaxAccess['read-only'];
      for (const [name, oid, value] of [['uptime', OIDS.uptime, fixture.uptime_ticks], ['count', OIDS.count, 48]] as const) {
        mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid: oid.slice(0, -2), scalarType: snmp.ObjectType.TimeTicks, maxAccess: ro });
        mib.setScalarValue(name, value);
      }
      const baseColumns = [1, 2, 3, 5, 6, 7, 8, 10, 13, 14, 16, 19, 20];
      mib.registerProvider({ name: 'base', type: snmp.MibProviderType.Table, oid: `${OIDS.table}.1`, maxAccess: 0,
        tableColumns: baseColumns.map(n => ({ number: n, name: `base${n}`, maxAccess: ro,
          type: [2, 6].includes(n) ? snmp.ObjectType.OctetString : [5, 10, 13, 14, 16, 19, 20].includes(n) ? snmp.ObjectType.Counter : snmp.ObjectType.Integer })), tableIndex: [{ columnName: 'base1' }] });
      const extendedColumns = [1, 6, 10, 15, 19];
      mib.registerProvider({ name: 'extended', type: snmp.MibProviderType.Table, oid: `${OIDS.xTable}.1`, maxAccess: 0,
        tableColumns: extendedColumns.map(n => ({ number: n, name: `extended${n}`, maxAccess: ro,
          type: n === 1 ? snmp.ObjectType.OctetString : [6, 10].includes(n) ? snmp.ObjectType.Counter64 : snmp.ObjectType.Gauge })), tableIndex: [{ columnName: 'base1', foreign: 'base' }] });
      for (let i = 0; i < 48; i++) {
        mib.addTableRow('base', baseColumns.map(n => s.b[i].values[String(n)]));
        mib.addTableRow('extended', [i + 1, ...extendedColumns.map(n => [6, 10].includes(n)
          ? Buffer.from(BigInt(s.x[i].values[String(n)]).toString(16).padStart(16, '0'), 'hex') : s.x[i].values[String(n)])]);
      }
      s.context.resolve = async () => bindSnmp(new SnmpClient(), { version: 2, host: '127.0.0.1', port: endpoint, community: 'controlled-max397', retries: 0 });
      const result = await s.run();
      expect(result.attempts.every(a => a.status === 'succeeded')).toBe(true);
      expect(result.discovery_rows?.filter(r => r.collector_id === 'snmp-interfaces')).toHaveLength(48);
      expect(result.observations).toHaveLength(721);
    } finally { await new Promise<void>(resolve => agent.close(() => resolve())); }
  }, 20000);
});
