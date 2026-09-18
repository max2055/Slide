import type { MetricDefinition } from '../../contracts/metrics-v2/index.js';
import { PackageRegistry, sealRelease, type ImplementationSpec, type PackageRelease } from './model.js';

const dims = (names: string[]) => ({ keys: names.map(name => ({ name, meaning: `${name} stable resource-local identity`, required: true })), max_series_per_resource: 100, max_value_length: 128, overflow: 'reject' as const });
function gauge(id: string, resource_type: MetricDefinition['resource_type'], unit: MetricDefinition['unit'], meaning: string): MetricDefinition {
  return { category: 'extension', namespace: id.split('.')[0], id, semantic_version: '1.0.0', meaning, resource_type, unit,
    scope: 'resource', kind: 'gauge', roles: ['diagnostic'], temporality: 'instant', monotonic: false, value_type: 'float64',
    dimensions: dims([]), aggregation: { time: ['last', 'min', 'max', 'mean'], space: ['none'], missing: 'preserve_null', min_coverage: 1, quantiles: 'not_applicable' }, lifecycle: 'active' };
}
// Product-owned definitions from the frozen MAX-64 catalog, not supplied by template documents.
// Equality with the contract fixtures is tested to prevent semantic drift.
const { namespace: _namespace, ...uptime } = gauge('db.uptime_seconds', 'instance', 's', 'Elapsed seconds since database instance startup; not management-agent uptime.') as Extract<MetricDefinition, { category: 'extension' }>;
const { namespace: _networkNamespace, ...oper } = gauge('network.interface.oper_up', 'network_device', '1', 'IF-MIB operStatus up=1, down=0; all other enumerants unknown.') as Extract<MetricDefinition, { category: 'extension' }>;
export const canonicalDefinitions: MetricDefinition[] = [
  { ...uptime, category: 'canonical', roles: ['core'] },
  { ...oper, category: 'canonical', roles: ['core'], scope: 'interface', dimensions: dims(['if_index', 'interface_epoch']) },
];
const queries: MetricDefinition = {
  ...gauge('mysql.queries.total', 'instance', 'count', 'MySQL Queries status counter: statements executed by clients and stored programs; not committed transactions.'),
  kind: 'counter', temporality: 'cumulative', monotonic: true, value_type: 'uint64',
  aggregation: { time: ['last', 'rate'], space: ['none'], missing: 'preserve_null', min_coverage: 1, quantiles: 'not_applicable' },
};
const queryRate = gauge('mysql.queries.per_second', 'instance', 'count/s', 'Rate of mysql.queries.total over a valid interval in the same database counter epoch.');
export const implementationSpecs: ImplementationSpec[] = [
  { id: 'builtin:mysql.status.v1', method: 'sql', resource_type: 'instance',
    applicability: [{ attribute: 'db.engine', values: ['mysql'] }, { attribute: 'db.version', values: ['5.7', '8.0', '8.4'] }],
    outputs: [{ raw_field: 'Uptime', definition: canonicalDefinitions[0], input_unit: 's' }, { raw_field: 'Queries', definition: queries, input_unit: 'count' }],
    permissions: ['SHOW GLOBAL STATUS'], discovery: 'singleton database status row; no database enumeration' },
  { id: 'builtin:linux.basic.v1', method: 'ssh', resource_type: 'server',
    applicability: [{ attribute: 'os.family', values: ['linux'] }],
    outputs: [
      { raw_field: 'uptime', definition: gauge('linux.uptime.seconds', 'server', 's', 'Linux /proc/uptime first field: seconds since host boot, including suspend.'), input_unit: 's' },
      { raw_field: 'load_1min', definition: gauge('linux.load.one_minute', 'server', '1', 'Linux /proc/loadavg one-minute runnable/uninterruptible task load average; not CPU utilization.'), input_unit: '1' },
    ], permissions: ['SSH login', 'read /proc/uptime and /proc/loadavg'], discovery: 'singleton Linux procfs; fixed commands from ServerMetricProvider; no path parameters' },
  { id: 'builtin:if_mib.status.v1', method: 'snmp', resource_type: 'network_device',
    applicability: [{ attribute: 'snmp.version', values: ['2', '3'] }],
    outputs: [{ raw_field: 'ifOperStatus', definition: canonicalDefinitions[1], input_unit: '1' }],
    permissions: ['SNMP read IF-MIB ifTable'], discovery: 'standard IF-MIB ifTable index; requires driver-provided interface generation; reject duplicates/overflow; all vendors; no enterprise OIDs' },
];

export function builtinReleases(): PackageRelease[] {
  return implementationSpecs.map((spec, i) => {
    const extensions = spec.outputs.map(o => o.definition).filter((d): d is Extract<MetricDefinition, { category: 'extension' }> => d.category === 'extension');
    if (i === 0) extensions.push(queryRate as Extract<MetricDefinition, { category: 'extension' }>);
    const collectorId = ['mysql-status', 'linux-basic', 'if-mib-status'][i];
    return sealRelease({
      package: { id: ['mysql-basic', 'linux-basic', 'if-mib-basic'][i], version: '1.0.0', contract_version: '1.0.0', digest: `sha256:${'0'.repeat(64)}`,
        resource_type: spec.resource_type, applicability: spec.applicability,
        collectors: [{ id: collectorId, implementation_ref: spec.id, method: spec.method, timeout_ms: 5000, estimated_cost: 'low',
          mappings: spec.outputs.map(o => ({ metric: { id: o.definition.id, semantic_version: o.definition.semantic_version }, raw_field: o.raw_field,
            input_unit: o.input_unit, output_unit: o.definition.unit, transform_version: '1.0.0', steps: ['decode', 'normalize'] })) }] },
      extensions,
      derived: i === 0 ? [{ id: 'mysql-query-rate', output: { id: queryRate.id, semantic_version: '1.0.0' },
        transform_version: '1.0.0', inputs: [{ id: queries.id, semantic_version: '1.0.0' }], operation: 'rate',
        join: 'same_resource_and_dimensions', max_skew_ms: 1000, on_missing: 'null', on_zero_denominator: 'null',
        quality_propagation: 'worst_input', accuracy_propagation: 'least_certain_input' }] : [],
      transforms: [{ id: 'normalize', version: '1.0.0' }, ...(i === 0 ? [{ id: 'derive' as const, version: '1.0.0' }] : [])],
      recommendations: { interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000, max_counter_gap_ms: 300000, max_rows: 100, enabled: true },
      documentation: [{ collector_id: collectorId, permissions: spec.permissions, discovery: spec.discovery }],
    });
  });
}
export function createBuiltinRegistry(): PackageRegistry {
  const registry = new PackageRegistry(canonicalDefinitions, implementationSpecs);
  builtinReleases().forEach(r => registry.install(r));
  return registry;
}
