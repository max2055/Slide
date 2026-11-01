import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createHuaweiMibCatalog } from '../../network-devices/huawei-mib-catalog.js';
import { runPackage, type PackageExecution } from '../packages/runner.js';
import { AdapterError, type Transport } from '../packages/adapters.js';
import { SnmpDiscovery, unsigned, OIDS } from './collector.js';
import { createSnmpPackage } from './package.js';
import { aggregate } from '../query.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/snmp/fixtures.json', import.meta.url), 'utf8'));
const metric = (r: Awaited<ReturnType<typeof runPackage>>, id: string) => r.observations.find(o => o.observation.metric.id === id)!.observation;
function setup() {
  let now = Date.parse(fixture.at), ticks = fixture.uptime_ticks;
  const b = structuredClone(fixture.ifTable), x = structuredClone(fixture.ifXTable);
  const transport: Extract<Transport, { method: 'snmp' }> = { method: 'snmp',
    get: vi.fn(async oids => oids.map(oid => ({ oid, type: 67, value: ticks }))),
    table: vi.fn(async root => root === OIDS.table ? b : x) };
  const { registry, pin } = createSnmpPackage();
  const discovery = new SnmpDiscovery(() => now);
  const context: PackageExecution = { resource: { id: '1', type: 'network_device', attributes: { 'snmp.version': { value: 2, source: 'fixture', observed_at: fixture.at } } },
    binding_id: 'network_device:1', attempt_id: 'test-1', config_revision: 1, observed_at: fixture.at, clock: () => new Date(now).toISOString(),
    evidence: { snmp: discovery }, resolve: async () => transport };
  const run = async () => {
    context.attempt_id = `test-${now}`; context.observed_at = new Date(now).toISOString();
    const r = await runPackage(registry, { package: pin, credential_ref: 'credential:test', overrides: {} }, context);
    context.states = r.states; return r;
  };
  const advance = (ms = 60000) => { now += ms; ticks += ms / 10; };
  return { b, x, transport, context, run, advance, reset: () => { ticks = 100; }, discovery };
}
describe('SNMP V2 precision and continuity', () => {
  it('decodes Counter64 binary without Number; rejects unsafe and out-of-range integers', () => {
    expect(unsigned(Buffer.from('0020000000000001', 'hex'), 64)).toBe('9007199254740993');
    expect(unsigned(Buffer.from('ffffffffffffffff', 'hex'), 64)).toBe('18446744073709551615');
    for (const v of [9007199254740992, -1, '18446744073709551616', '1e3']) expect(() => unsigned(v, 64)).toThrow();
    expect(() => unsigned('4294967296', 32)).toThrow();
  });
  it('uses shared Counter Processor for independent rx/tx and retains versions/source/width', async () => {
    const s = setup();
    s.x[0].values['6'] = Buffer.from('0020000000000001', 'hex');
    const first = await s.run();
    expect(metric(first, 'snmp.interface.rx_octets_total').value).toEqual({ encoding: 'uint64', value: fixture.ifXTable[0].values['6'] });
    expect(metric(first, 'snmp.interface.rx_bits_per_second').quality.reason).toBe('counter_baseline');
    s.advance(); s.x[0].values['6'] = String(BigInt(fixture.ifXTable[0].values['6']) + BigInt(fixture.second_delta.rx));
    s.x[0].values['10'] = String(BigInt(fixture.ifXTable[0].values['10']) + BigInt(fixture.second_delta.tx));
    const r = await s.run();
    for (const d of ['rx', 'tx']) expect(metric(r, `snmp.interface.${d}_bits_per_second`)).toMatchObject({ unit: 'bit/s', value: { value: fixture.expected_bits_per_second[d] }, versions: { config_revision: 1, package_id: 'snmp-standard' } });
    expect(metric(r, 'snmp.interface.speed_bits_per_second').value).toEqual({ encoding: 'uint64', value: '1000000000' });
    expect(metric(r, 'snmp.interface.rx_octets_total').counter?.bits).toBe('64');
    expect(metric(r, 'snmp.interface.rx_errors_total').counter?.bits).toBe('32');
    expect(metric(r, 'snmp.interface.rx_errors_per_second').value).toBeNull();
    expect(r.observations.every(o => o.input_provenance.length > 0 && o.observation.lineage.length > 0)).toBe(true);
    expect(r.attempts.every(a => a.status === 'succeeded')).toBe(true);
    expect(s.transport.table).toHaveBeenCalledTimes(4);
  });
  it('uses 32-bit fallback only when HC absent and refuses ambiguous or invisible wraps', async () => {
    const s = setup(); delete s.x[0].values['6']; s.b[0].values['5'] = 1000000; s.x[0].values['15'] = 1;
    await s.run(); s.advance(); s.b[0].values['10'] += 6000;
    expect(metric(await s.run(), 'snmp.interface.rx_bits_per_second').value).toEqual({ encoding: 'float64', value: 800 });
    s.advance(); s.b[0].values['10'] = 5;
    expect(metric(await s.run(), 'snmp.interface.rx_bits_per_second').quality.reason).toBe('counter_reset');
    s.advance(); s.x[0].values['15'] = 1000; s.b[0].values['10'] = 10;
    expect(metric(await s.run(), 'snmp.interface.rx_bits_per_second').value).toBeNull();
  });
  it.each(['reboot', 'reuse', 'discontinuity', 'disappear', 'restart', 'gap', 'width'] as const)('suppresses rates across %s', async change => {
    const s = setup(); const first = await s.run(); s.advance();
    if (change === 'reboot') s.reset();
    if (change === 'reuse') s.x[0].values['1'] = 'replacement-port';
    if (change === 'discontinuity') s.x[0].values['19'] = 1234;
    if (change === 'disappear') { const b = s.b.pop(); await s.run(); s.b.push(b); s.advance(); }
    if (change === 'restart') s.context.evidence.snmp = new SnmpDiscovery(() => Date.parse(s.context.observed_at));
    if (change === 'gap') s.advance(360000);
    if (change === 'width') delete s.x[0].values['6'];
    const r = await s.run(); expect(metric(r, 'snmp.interface.rx_bits_per_second').value).toBeNull();
    if (['reboot', 'reuse', 'disappear', 'restart'].includes(change)) expect(metric(r, 'snmp.interface.rx_octets_total').dimensions.interface_epoch).not.toBe(metric(first, 'snmp.interface.rx_octets_total').dimensions.interface_epoch);
  });
  it('does not fall back from malformed HC and isolates a single field failure', async () => {
    const s = setup(); s.x[0].values['6'] = 9007199254740992;
    const r = await s.run(); expect(metric(r, 'snmp.interface.rx_octets_total').value).toBeNull();
    expect(metric(r, 'snmp.interface.tx_octets_total').value).not.toBeNull();
    expect(r.attempts.find(a => a.collector_id === 'snmp-interfaces')?.status).toBe('partial');
  });
  it('retains unknown/unsupported field quality and does not equate SNMP with SSH backup', async () => {
    const s = setup(); delete s.b[0].values['14']; s.b[0].values['8'] = 3;
    const r = await s.run();
    expect(metric(r, 'network.interface.oper_up').value).toBeNull();
    expect(r.capabilities.find(c => c.metric.id === 'snmp.interface.rx_errors_total')?.status).toBe('unsupported');
    expect(r.observations.some(o => /ssh|backup/.test(o.observation.metric.id))).toBe(false);
  });
  it('permission failure on ifX preserves standard statuses, but not counter continuity', async () => {
    const s = setup(); s.transport.table = async root => { if (root === OIDS.xTable) throw new AdapterError('permission_denied'); return s.b; };
    const r = await s.run(); expect(metric(r, 'network.interface.oper_up').value).toEqual({ encoding: 'float64', value: 1 });
    expect(metric(r, 'snmp.interface.rx_octets_total').value).toBeNull();
    expect(r.attempts.find(a => a.collector_id === 'snmp-interfaces')).toMatchObject({ status: 'partial', error: 'permission_denied' });
  });
  it('does not issue another SNMP read after cancellation', async () => {
    const s = setup(), controller = new AbortController(); s.context.signal = controller.signal;
    s.transport.get = vi.fn(async oids => { controller.abort(); return oids.map(oid => ({ oid, value: 1 })); });
    await expect(s.run()).rejects.toThrow(); expect(s.transport.table).not.toHaveBeenCalled(); expect(s.transport.get).toHaveBeenCalledTimes(1);
  });
  it('bounds 64-bit deltas by physical link speed and invalidates on capacity changes', async () => {
    const s = setup(); await s.run(); s.advance(); s.x[0].values['6'] = '18014398509481986';
    expect(metric(await s.run(), 'snmp.interface.rx_bits_per_second').value).toBeNull();
    s.advance(); s.x[0].values['15'] = 10;
    expect(metric(await s.run(), 'snmp.interface.rx_bits_per_second').quality.reason).toBe('counter_reset');
  });
  it('requires persisted bounded rates for historical bandwidth, not raw-counter recomputation', async () => {
    const s = setup(), r = await s.run(), o = metric(r, 'snmp.interface.rx_octets_total');
    const { registry, pin } = createSnmpPackage();
    expect(() => aggregate({ definition: registry.catalog(pin).find(d => d.id === o.metric.id)!,
      series: [{ resource_type: o.resource_type, resource_id: o.resource_id, metric: o.metric, dimensions: o.dimensions }],
      from: fixture.at, to: '2026-09-01T00:01:00.000Z', now: '2026-09-01T00:01:00.000Z',
      interval_ms: 60000, max_gap_ms: 300000, stale_after_ms: 120000, mode: 'rate', space: 'none' }, [[o]])).toThrow();
  });
  it.each(['identity', 'discontinuity', 'speed'] as const)('does not invent continuity when %s evidence is missing', async field => {
    const s = setup();
    if (field === 'identity') { delete s.b[0].values['2']; delete s.b[0].values['6']; delete s.x[0].values['1']; }
    if (field === 'discontinuity') delete s.x[0].values['19'];
    if (field === 'speed') { delete s.x[0].values['6']; delete s.b[0].values['5']; delete s.x[0].values['15']; }
    await s.run(); s.advance(); s.b[0].values['10'] += 500;
    expect(metric(await s.run(), 'snmp.interface.rx_bits_per_second').value).toBeNull();
  });
  it.each(['timeout', 'permission_denied'] as const)('records %s without leaking remote messages, then rediscovers', async code => {
    const s = setup(); await s.run(); s.advance(); const original = s.transport.get;
    s.transport.get = async () => { throw new AdapterError(code); };
    const r = await s.run(); expect(r.attempts.every(a => a.status === 'failed' && a.error === code)).toBe(true);
    s.transport.get = original; s.advance();
    expect(metric(await s.run(), 'snmp.interface.rx_bits_per_second').quality.reason).toBe('counter_baseline');
  });
  it('removes retired interface counter baselines after a complete empty discovery', async () => {
    const s = setup(); expect((await s.run()).states.size).toBe(6); s.advance(); s.b.length = 0;
    const r = await s.run(); expect(r.states.size).toBe(0); expect(r.observations).toHaveLength(1);
  });
  it('rejects duplicate or excess discovery rows without partially replacing identity', async () => {
    const s = setup(); s.b.push(s.b[0]);
    const r = await s.run(); expect(r.attempts.find(a => a.collector_id === 'snmp-interfaces')?.error).toBe('parse_error');
    expect(r.observations).toHaveLength(1);
  });
  it('maps only existing reviewed vendor extensions with immutable catalog provenance', async () => {
    const catalog = createHuaweiMibCatalog(fixture.existing_vendor_fixture), { registry, pin } = createSnmpPackage(catalog), s = setup();
    s.context.evidence.snmp = new SnmpDiscovery(() => Date.parse(fixture.at), catalog);
    s.context.resource.attributes['snmp.vendor_fixture'] = { value: catalog.fixtureVersion, source: 'reviewed-catalog', observed_at: fixture.at };
    const original = s.transport.get!;
    s.transport.get = async (oids, timeout) => oids[0] === OIDS.uptime ? original(oids, timeout) : oids.map((oid, i) => ({ oid, value: i ? 655 : 42 }));
    const r = await runPackage(registry, { package: pin, credential_ref: 'credential:test', overrides: {} }, s.context);
    expect(metric(r, 'huawei.device.cpu_percent')).toMatchObject({ value: { value: 42 }, quality: { status: 'good' }, versions: { package_id: 'snmp-huawei-vrp-test-1' } });
    expect(metric(r, 'huawei.device.memory_percent').value).toEqual({ encoding: 'float64', value: 65.5 });
    expect(registry.get(pin).documentation[2].discovery).toContain(catalog.vendorMetrics.cpu!.oid);
    expect(r.observations.some(o => /temperature/.test(o.observation.metric.id))).toBe(false);
  });
});
