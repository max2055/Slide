import type { DerivedMetric, MetricDefinition } from '../../contracts/metrics-v2/index.js';
import { PackageRegistry, sealRelease, type ImplementationSpec, type PackageRelease } from './model.js';

const dims = (names: string[]) => ({ keys: names.map(name => ({ name, meaning: `${name} stable resource-local identity`, required: true,
  ...(name === 'direction' ? { allowed_values: ['in', 'out'] } : {}) })), max_series_per_resource: 100, max_value_length: 128, overflow: 'reject' as const });
function gauge(id: string, resource_type: MetricDefinition['resource_type'], unit: MetricDefinition['unit'], meaning: string): MetricDefinition {
  return { category: 'extension', namespace: id.split('.')[0], id, semantic_version: '1.0.0', meaning, resource_type, unit,
    scope: 'resource', kind: 'gauge', roles: ['diagnostic'], temporality: 'instant', monotonic: false, value_type: 'float64',
    dimensions: dims([]), aggregation: { time: ['last', 'min', 'max', 'mean'], space: ['none'], missing: 'preserve_null', min_coverage: 1, quantiles: 'not_applicable' }, lifecycle: 'active' };
}
// Product-owned definitions from the frozen MAX-64 catalog, not supplied by template documents.
// Equality with the contract fixtures is tested to prevent semantic drift.
const { namespace: _namespace, ...uptime } = gauge('db.uptime_seconds', 'instance', 's', 'Elapsed seconds since database instance startup; not management-agent uptime.') as Extract<MetricDefinition, { category: 'extension' }>;
const { namespace: _networkNamespace, ...oper } = gauge('network.interface.oper_up', 'network_device', '1', 'IF-MIB operStatus up=1, down=0; all other enumerants unknown.') as Extract<MetricDefinition, { category: 'extension' }>;
const canonical = (id: string, unit: MetricDefinition['unit'], meaning: string, scope: MetricDefinition['scope'], names: string[], options: Partial<MetricDefinition> = {}): MetricDefinition => ({
  category: 'canonical', id, semantic_version: '1.0.0', meaning, resource_type: 'server', unit, scope,
  kind: 'gauge', roles: ['core'], temporality: 'instant', monotonic: false, value_type: 'float64', dimensions: dims(names),
  aggregation: { time: ['last', 'min', 'max', 'mean'], space: ['none'], missing: 'preserve_null', min_coverage: 1, quantiles: 'not_applicable' },
  lifecycle: 'active', ...options,
} as MetricDefinition);
const filesystemUsed = canonical('host.filesystem.used_bytes', 'By', 'Filesystem used bytes reported by df; excludes available and reserved free space.', 'filesystem', ['mount', 'device', 'fs_type'], { value_type: 'uint64' });
const filesystemSize = canonical('host.filesystem.size_bytes', 'By', 'Filesystem total bytes reported by df including reserved capacity.', 'filesystem', ['mount', 'device', 'fs_type'], { value_type: 'uint64' });
const networkBytes = canonical('host.network.bytes_total', 'By', 'Cumulative bytes transferred by interface and direction in the current counter epoch.', 'interface', ['interface', 'direction'], {
  kind: 'counter', temporality: 'cumulative', monotonic: true, value_type: 'uint64',
  aggregation: { time: ['last', 'rate'], space: ['none'], missing: 'preserve_null', min_coverage: 1, quantiles: 'not_applicable' },
});
export const canonicalDefinitions: MetricDefinition[] = [
  { ...uptime, category: 'canonical', roles: ['core'] },
  filesystemUsed,
  filesystemSize,
  networkBytes,
  { ...oper, category: 'canonical', roles: ['core'], scope: 'interface', dimensions: dims(['if_index', 'interface_epoch']) },
];
const queries: MetricDefinition = {
  ...gauge('mysql.queries.total', 'instance', 'count', 'MySQL Queries status counter: statements executed by clients and stored programs; not committed transactions.'),
  kind: 'counter', temporality: 'cumulative', monotonic: true, value_type: 'uint64',
  aggregation: { time: ['last', 'rate'], space: ['none'], missing: 'preserve_null', min_coverage: 1, quantiles: 'not_applicable' },
};
const queryRate = gauge('mysql.queries.per_second', 'instance', 'count/s', 'Rate of mysql.queries.total over a valid interval in the same database counter epoch.');
const linuxCpu = gauge('linux.cpu.user_system_percent', 'server', '%', 'Linux top user plus system CPU percentage over its sampling interval; denominator is total logical CPU time, not a database process share.');
const linuxMemory = gauge('linux.memory.used_percent', 'server', '%', 'Linux free used memory divided by MemTotal; used is MemTotal minus MemAvailable and excludes no database-specific attribution.');
const filesystemRatio = {
  ...gauge('linux.filesystem.used_ratio', 'server', '1', 'Filesystem used bytes divided by total bytes; not df capacity percent based on non-reserved capacity.'),
  scope: 'filesystem', dimensions: dims(['mount', 'device', 'fs_type']),
} as Extract<MetricDefinition, { category: 'extension' }>;
const blockCounter = (id: string, unit: MetricDefinition['unit'], meaning: string): MetricDefinition => ({
  ...gauge(id, 'server', unit, meaning), scope: 'resource', kind: 'counter', temporality: 'cumulative', monotonic: true,
  value_type: 'uint64', dimensions: dims(['device']),
  aggregation: { time: ['last', 'rate'], space: ['none'], missing: 'preserve_null', min_coverage: 1, quantiles: 'not_applicable' },
});
const blockRead = blockCounter('linux.block.read_bytes_total', 'By', 'Cumulative bytes read from one Linux block accounting device in the current device epoch.');
const blockWrite = blockCounter('linux.block.write_bytes_total', 'By', 'Cumulative bytes written to one Linux block accounting device in the current device epoch.');
const blockIoTime = blockCounter('linux.block.io_time_ms_total', 'ms', 'Cumulative milliseconds with I/O in progress for one Linux block accounting device in the current device epoch.');
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
  { id: 'builtin:linux.host-gauges.v1', method: 'ssh', resource_type: 'server',
    applicability: [{ attribute: 'os.family', values: ['linux'] }],
    outputs: [
      { raw_field: 'cpu_usage', definition: linuxCpu, input_unit: '%' },
      { raw_field: 'memory_usage', definition: linuxMemory, input_unit: '%' },
    ], permissions: ['SSH login', 'run fixed top and free commands from ServerMetricProvider'],
    discovery: 'singleton Linux host gauges; no process or database attribution; no command or path parameters' },
  { id: 'builtin:linux.filesystem.v1', method: 'ssh', resource_type: 'server',
    applicability: [{ attribute: 'os.family', values: ['linux'] }],
    outputs: [
      { raw_field: 'filesystem_used_bytes', definition: filesystemUsed, input_unit: 'By' },
      { raw_field: 'filesystem_size_bytes', definition: filesystemSize, input_unit: 'By' },
    ], permissions: ['SSH login', 'run fixed df and findmnt commands'],
    discovery: 'mounted filesystems returned by bounded df output; mount, device and filesystem type remain separate dimensions' },
  { id: 'builtin:linux.network.v1', method: 'ssh', resource_type: 'server',
    applicability: [{ attribute: 'os.family', values: ['linux'] }],
    outputs: [{ raw_field: 'network_bytes', definition: networkBytes, input_unit: 'By' }],
    permissions: ['SSH login', 'read /proc/net/dev'],
    discovery: 'bounded non-loop interfaces; interface and direction stay separate and require driver lifecycle epochs' },
  { id: 'builtin:linux.block.v1', method: 'ssh', resource_type: 'server',
    applicability: [{ attribute: 'os.family', values: ['linux'] }],
    outputs: [
      { raw_field: 'disk_read_bytes', definition: blockRead, input_unit: 'By' },
      { raw_field: 'disk_write_bytes', definition: blockWrite, input_unit: 'By' },
      { raw_field: 'disk_io_time_ms', definition: blockIoTime, input_unit: 'ms' },
    ], permissions: ['SSH login', 'read /proc/diskstats'],
    discovery: 'bounded whole-device accounting rows; partitions and memory/loop devices excluded; layered devices remain distinct and require driver lifecycle epochs' },
  { id: 'builtin:if_mib.status.v1', method: 'snmp', resource_type: 'network_device',
    applicability: [{ attribute: 'snmp.version', values: ['2', '3'] }],
    outputs: [{ raw_field: 'ifOperStatus', definition: canonicalDefinitions.find(definition => definition.id === 'network.interface.oper_up')!, input_unit: '1' }],
    permissions: ['SNMP read IF-MIB ifTable'], discovery: 'standard IF-MIB ifTable index; requires driver-provided interface generation; reject duplicates/overflow; all vendors; no enterprise OIDs' },
];

export function builtinReleases(): PackageRelease[] {
  const collectorId = (spec: ImplementationSpec) => ({
    'builtin:mysql.status.v1': 'mysql-status',
    'builtin:linux.basic.v1': 'linux-basic',
    'builtin:linux.host-gauges.v1': 'linux-host-gauges',
    'builtin:linux.filesystem.v1': 'linux-filesystem',
    'builtin:linux.network.v1': 'linux-network',
    'builtin:linux.block.v1': 'linux-block',
    'builtin:if_mib.status.v1': 'if-mib-status',
  }[spec.id]!);
  const release = (packageId: string, specs: ImplementationSpec[], derived: DerivedMetric[] = [], extraExtensions: MetricDefinition[] = []) => {
    const collectors = specs.map(spec => ({ id: collectorId(spec), implementation_ref: spec.id,
      method: spec.method, timeout_ms: 5000, estimated_cost: spec.id.includes('filesystem') ? 'medium' as const : 'low' as const,
      mappings: spec.outputs.map(o => ({ metric: { id: o.definition.id, semantic_version: o.definition.semantic_version }, raw_field: o.raw_field,
        input_unit: o.input_unit, output_unit: o.definition.unit, transform_version: '1.0.0', steps: ['decode', 'normalize'] as ('decode' | 'normalize')[] })) }));
    const extensions = [...specs.flatMap(spec => spec.outputs.map(o => o.definition)), ...extraExtensions]
      .filter((d): d is Extract<MetricDefinition, { category: 'extension' }> => d.category === 'extension');
    return sealRelease({
      package: { id: packageId, version: '1.0.0', contract_version: '1.0.0', digest: `sha256:${'0'.repeat(64)}`,
        resource_type: specs[0].resource_type, applicability: specs[0].applicability, collectors },
      extensions, derived,
      transforms: [{ id: 'normalize', version: '1.0.0' }, ...(derived.length ? [{ id: 'derive' as const, version: '1.0.0' }] : [])],
      recommendations: { interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000, max_counter_gap_ms: 300000, max_rows: 100, enabled: true },
      documentation: specs.map(spec => ({ collector_id: collectorId(spec), permissions: spec.permissions, discovery: spec.discovery })),
    });
  };
  const mysql = implementationSpecs.filter(spec => spec.id === 'builtin:mysql.status.v1');
  const linux = implementationSpecs.filter(spec => spec.id === 'builtin:linux.basic.v1');
  const host = implementationSpecs.filter(spec => spec.id.startsWith('builtin:linux.') && spec.id !== 'builtin:linux.basic.v1');
  const snmp = implementationSpecs.filter(spec => spec.id === 'builtin:if_mib.status.v1');
  return [
    release('mysql-basic', mysql, [{ id: 'mysql-query-rate', output: { id: queryRate.id, semantic_version: '1.0.0' },
      transform_version: '1.0.0', inputs: [{ id: queries.id, semantic_version: '1.0.0' }], operation: 'rate',
      join: 'same_resource_and_dimensions', max_skew_ms: 1000, on_missing: 'null', on_zero_denominator: 'null',
      quality_propagation: 'worst_input', accuracy_propagation: 'least_certain_input' }], [queryRate]),
    release('linux-basic', linux),
    release('if-mib-basic', snmp),
    release('linux-host', host, [{ id: 'linux-filesystem-used-ratio', output: { id: filesystemRatio.id, semantic_version: '1.0.0' },
      transform_version: '1.0.0', inputs: [{ id: filesystemUsed.id, semantic_version: '1.0.0' }, { id: filesystemSize.id, semantic_version: '1.0.0' }],
      operation: 'ratio', join: 'same_resource_and_dimensions', max_skew_ms: 1000, on_missing: 'null', on_zero_denominator: 'null',
      quality_propagation: 'worst_input', accuracy_propagation: 'least_certain_input' }], [filesystemRatio]),
  ];
}
export function createBuiltinRegistry(): PackageRegistry {
  const registry = new PackageRegistry(canonicalDefinitions, implementationSpecs);
  builtinReleases().forEach(r => registry.install(r));
  return registry;
}
