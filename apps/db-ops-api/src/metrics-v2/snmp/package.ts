import type { DerivedMetric, ExtensionMetricDefinition, MetricDefinition } from '../../contracts/metrics-v2/index.js';
import type { HuaweiMibCatalog } from '../../network-devices/huawei-mib-catalog.js';
import { canonicalDefinitions, implementationSpecs, builtinReleases } from '../packages/builtins.js';
import { PackageRegistry, sealRelease, type ImplementationSpec } from '../packages/model.js';
import { vendorImplementation } from './collector.js';

const oper = canonicalDefinitions.find(d => d.id === 'network.interface.oper_up')!;
function gauge(id: string, unit: MetricDefinition['unit'], meaning: string, scope: 'resource' | 'interface' = 'interface'): ExtensionMetricDefinition {
  return { ...structuredClone(oper), category: 'extension', namespace: id.split('.')[0], id, unit, meaning, scope,
    roles: ['diagnostic'], dimensions: scope === 'interface' ? structuredClone(oper.dimensions) : { ...oper.dimensions, keys: [] } };
}
const counter = (id: string, unit: MetricDefinition['unit'], meaning: string): ExtensionMetricDefinition => ({ ...gauge(id, unit, meaning),
  kind: 'counter', temporality: 'cumulative', monotonic: true, value_type: 'uint64',
  aggregation: { ...oper.aggregation, time: ['last'] },
});
export function createSnmpPackage(vendor?: HuaweiMibCatalog) {
  if (vendor && [vendor.vendorMetrics.cpu, vendor.vendorMetrics.memory].some(d => d && d.unit !== 'percent')) throw new Error('SNMP_VENDOR_UNIT');
  const uptime = gauge('snmp.agent.uptime_seconds', 's', 'MIB-II sysUpTime centiseconds converted to seconds since management subsystem initialization, not device boot time.', 'resource');
  const admin = gauge('snmp.interface.admin_up', '1', 'IF-MIB adminStatus up=1, down=0; testing unknown.');
  const speed = { ...gauge('snmp.interface.speed_bits_per_second', 'bit/s', 'IF-MIB nominal per-direction link capacity, ifHighSpeed preferred; rx and tx each use this denominator on full-duplex links.'), value_type: 'uint64' as const };
  const outputs: ImplementationSpec['outputs'] = [{ raw_field: 'ifOperStatus', definition: oper, input_unit: '1' as const },
    { raw_field: 'ifAdminStatus', definition: admin, input_unit: '1' as const }, { raw_field: 'ifSpeed', definition: speed, input_unit: 'bit/s' as const }];
  const derived: DerivedMetric[] = [], rates: ExtensionMetricDefinition[] = [];
  for (const direction of ['rx', 'tx']) for (const [suffix, raw, unit] of [['octets', 'Octets', 'By'], ['errors', 'Errors', 'count'], ['discards', 'Discards', 'count']] as const) {
    const d = counter(`snmp.interface.${direction}_${suffix}_total`, unit,
      `IF-MIB ${direction === 'rx' ? 'received' : 'transmitted'} ${suffix}; octets prefer Counter64 and fall back to Counter32; errors/discards use standard Counter32.`);
    const rate = gauge(`snmp.interface.${direction}_${suffix === 'octets' ? 'bits' : suffix}_per_second`, unit === 'By' ? 'bit/s' : 'count/s',
      `Public Counter Processor ${direction} rate; octets converted to bits/s. Full-duplex directions are independent; never add rx+tx then divide by one link capacity.`);
    outputs.push({ raw_field: direction + raw, definition: d, input_unit: unit });
    rates.push(rate);
    derived.push({ id: `${direction}-${suffix}-rate`, output: { id: rate.id, semantic_version: '1.0.0' }, transform_version: '1.0.0',
      inputs: [{ id: d.id, semantic_version: '1.0.0' }], operation: 'rate', join: 'same_resource_and_dimensions', max_skew_ms: 1000,
      on_missing: 'null', on_zero_denominator: 'null', quality_propagation: 'worst_input', accuracy_propagation: 'least_certain_input' });
  }
  const applicability = [{ attribute: 'snmp.version', values: ['2', '3'] },
    ...(vendor ? [{ attribute: 'snmp.vendor_fixture', values: [vendor.fixtureVersion] }] : [])];
  const spec = (id: string, values: ImplementationSpec['outputs'], discovery: string): ImplementationSpec => ({
    id, method: 'snmp', resource_type: 'network_device', applicability, outputs: values,
    permissions: ['SNMP read-only authorized target'], discovery,
  });
  const specs = [spec('builtin:snmp.system.v1', [{ raw_field: 'sysUpTime', definition: uptime, input_unit: 's' }], 'MIB-II sysUpTime; independent of SSH backup status'),
    spec('builtin:snmp.interfaces.v1', outputs, 'IF-MIB ifTable + ifXTable + uptime bracket; bounded resource-scoped rediscovery; no enterprise OIDs')];
  if (vendor) specs.push(spec(vendorImplementation(vendor), ['cpu', 'memory'].map(key => ({ raw_field: key,
    definition: gauge(`huawei.device.${key}_percent`, '%', `Existing reviewed ${vendor.fixtureVersion} ${key} mapping; extension only, no cross-vendor equivalence.`, 'resource'), input_unit: '%' })),
  `Existing versioned catalog only: ${JSON.stringify(vendor)}; no temperature conversion without a supported contract unit`));
  const extensions = [...specs.flatMap(s => s.outputs.map(o => o.definition).filter((d): d is ExtensionMetricDefinition => d.category === 'extension')), ...rates];
  const release = sealRelease({
    package: { id: vendor ? `snmp-huawei-${vendor.fixtureVersion}` : 'snmp-standard', version: '1.0.0', contract_version: '1.0.0', digest: `sha256:${'0'.repeat(64)}`,
      resource_type: 'network_device', applicability, collectors: specs.map((s, i) => ({ id: ['snmp-system', 'snmp-interfaces', 'snmp-vendor'][i],
        implementation_ref: s.id, method: s.method, timeout_ms: 5000, estimated_cost: i === 1 ? 'medium' : 'low',
        mappings: s.outputs.map(o => ({ raw_field: o.raw_field, metric: { id: o.definition.id, semantic_version: o.definition.semantic_version },
          input_unit: o.input_unit, output_unit: o.definition.unit, transform_version: '1.0.0', steps: ['decode', 'normalize'] })) })) },
    extensions, derived, transforms: [{ id: 'normalize', version: '1.0.0' }, { id: 'derive', version: '1.0.0' }],
    recommendations: { interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000, max_counter_gap_ms: 300000, max_rows: 6, enabled: true },
    documentation: specs.map((s, i) => ({ collector_id: ['snmp-system', 'snmp-interfaces', 'snmp-vendor'][i], permissions: s.permissions, discovery: s.discovery })),
  });
  const registry = new PackageRegistry(canonicalDefinitions, [...implementationSpecs, ...specs]);
  builtinReleases().forEach(r => registry.install(r));
  registry.install(release);
  const pin = { id: release.package.id, version: release.package.version, digest: release.package.digest };
  return { registry, release, pin };
}
