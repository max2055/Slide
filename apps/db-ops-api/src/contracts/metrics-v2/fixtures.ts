import type { MetricDefinition, Resource, CoreProfile } from './definitions.js';
import type { Capability, NormalizedObservation, RawObservation, CollectionAttempt } from './observations.js';
import type { CollectorPackage, CollectionBinding, CollectionPolicy, MetricBinding, DerivedMetric } from './configuration.js';
import { observationIdentity } from './validation.js';

export const fixtureTime = '2026-09-01T00:01:00Z';
const ref = (id: string) => ({ id, semantic_version: '1.0.0' });
const dimensions = (names: string[]) => ({ keys: names.map(name => ({ name, meaning: `${name} stable resource-local identity`, required: true, ...(name === 'direction' ? { allowed_values: ['in', 'out'] } : {}) })), max_series_per_resource: 100, max_value_length: 128, overflow: 'reject' as const });
function definition(id: string, resource_type: MetricDefinition['resource_type'], unit: MetricDefinition['unit'], options: Partial<MetricDefinition> = {}): MetricDefinition {
  return {
    category: 'canonical', id, semantic_version: '1.0.0', meaning: id, resource_type, unit,
    scope: 'resource', kind: 'gauge', roles: ['core'], temporality: 'instant', monotonic: false,
    value_type: 'float64', dimensions: dimensions([]),
    aggregation: { time: ['last', 'min', 'max', 'mean'], space: ['none'], missing: 'preserve_null', min_coverage: 1, quantiles: 'not_applicable' },
    lifecycle: 'active', ...options,
  } as MetricDefinition;
}
export const definitions: MetricDefinition[] = [
  definition('db.uptime_seconds', 'instance', 's', { meaning: 'Elapsed seconds since database instance startup; not management-agent uptime.' }),
  definition('host.filesystem.used_bytes', 'server', 'By', { meaning: 'Filesystem used bytes reported by df; excludes available and reserved free space.', scope: 'filesystem', value_type: 'uint64', dimensions: dimensions(['mount', 'device', 'fs_type']) }),
  definition('host.filesystem.size_bytes', 'server', 'By', { meaning: 'Filesystem total bytes reported by df including reserved capacity.', scope: 'filesystem', value_type: 'uint64', dimensions: dimensions(['mount', 'device', 'fs_type']) }),
  definition('host.network.bytes_total', 'server', 'By', { meaning: 'Cumulative bytes transferred by interface and direction in the current counter epoch.', scope: 'interface', kind: 'counter', temporality: 'cumulative', monotonic: true, value_type: 'uint64', dimensions: dimensions(['interface', 'direction']), aggregation: { time: ['last', 'rate'], space: ['none'], missing: 'preserve_null', min_coverage: 1, quantiles: 'not_applicable' } }),
  definition('network.interface.traffic_bps', 'network_device', 'bit/s', { meaning: 'Directional bits per second over a valid interval of the same IF-MIB interface generation.', scope: 'interface', dimensions: dimensions(['if_index', 'interface_epoch', 'direction']) }),
  definition('network.interface.oper_up', 'network_device', '1', { meaning: 'IF-MIB operStatus up=1, down=0; all other enumerants unknown.', scope: 'interface', dimensions: dimensions(['if_index', 'interface_epoch']) }),
  definition('mysql.cpu.heuristic_percent', 'instance', '%', { category: 'extension', namespace: 'mysql', meaning: 'Legacy MySQL CPU heuristic including baseline; not host CPU utilization.', roles: ['diagnostic'] }),
  definition('linux.filesystem.used_ratio', 'server', '1', { category: 'extension', namespace: 'linux', meaning: 'df used bytes divided by total bytes; not df percent based on non-reserved capacity.', scope: 'filesystem', dimensions: dimensions(['mount', 'device', 'fs_type']), roles: ['diagnostic'] }),
];
export const resources: Resource[] = [
  { id: 'db-1', type: 'instance', attributes: { 'db.version': { value: '8.0.fixture', observed_at: fixtureTime, source: 'inventory' }, 'db.engine': { value: 'mysql', observed_at: fixtureTime, source: 'inventory' } } },
  { id: 'host-1', type: 'server', attributes: { 'os.family': { value: 'linux', observed_at: fixtureTime, source: 'inventory' } } },
  { id: 'net-1', type: 'network_device', attributes: { 'device.model': { value: 'synthetic-switch', observed_at: fixtureTime, source: 'inventory' } } },
];
export const profile: CoreProfile = { id: 'database-core', version: '1.0.0', resource_type: 'instance', owner: 'product', columns: [{ key: 'uptime', label: '运行时长', metric: ref('db.uptime_seconds') }] };
export const collectorPackage: CollectorPackage = {
  id: 'mysql-basic', version: '1.0.0', contract_version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`,
  resource_type: 'instance', applicability: [{ attribute: 'db.engine', values: ['mysql'] }],
  collectors: [{ id: 'mysql-status', method: 'sql', implementation_ref: 'builtin:mysql.status', timeout_ms: 1000, estimated_cost: 'low', mappings: [{ metric: ref('db.uptime_seconds'), raw_field: 'Uptime', input_unit: 's', output_unit: 's', transform_version: '1.0.0', steps: ['decode', 'normalize'] }] }],
};
export const policy: CollectionPolicy = { id: 'default', revision: 1, enabled: true, interval_ms: 60000, timeout_ms: 1000, stale_after_ms: 120000, max_counter_gap_ms: 300000, max_concurrency: 2, max_series_per_resource: 100 };
export const collection: CollectionBinding = { id: 'cb-db', resource_id: 'db-1', resource_type: 'instance', package: { id: collectorPackage.id, version: collectorPackage.version, digest: collectorPackage.digest }, policy_id: policy.id, policy_revision: 1, config_revision: 1, enabled: true };
export const metricBinding: MetricBinding = { id: 'mb-db', collection_binding_id: collection.id, resource_id: 'db-1', metric: ref('db.uptime_seconds'), dimensions: {}, enabled: true, source: { kind: 'collector', collector_id: 'mysql-status', raw_field: 'Uptime' } };
export const capability: Capability = { resource_id: 'db-1', metric: metricBinding.metric, status: 'supported', method: 'sql', basis: [{ kind: 'version', evidence: 'MySQL 8.0 Uptime exists' }, { kind: 'permission', evidence: 'SHOW GLOBAL STATUS permitted' }], evaluated_at: '2026-09-01T00:00:00Z', valid_until: '2026-09-02T00:00:00Z' };
export const timeoutAttempt: CollectionAttempt = { id: 'attempt-timeout', resource_id: 'db-1', binding_id: 'cb-db', collector_id: 'mysql-status', config_revision: 1, started_at: fixtureTime, ended_at: '2026-09-01T00:01:01Z', status: 'failed', error: 'timeout', observation_ids: [] };
export const derived: DerivedMetric = { id: 'fs-ratio', output: ref('linux.filesystem.used_ratio'), transform_version: '1.0.0', inputs: [ref('host.filesystem.used_bytes'), ref('host.filesystem.size_bytes')], operation: 'ratio', join: 'same_resource_and_dimensions', max_skew_ms: 1000, on_missing: 'null', on_zero_denominator: 'null', quality_propagation: 'worst_input', accuracy_propagation: 'least_certain_input' };

export function identify<T extends RawObservation | NormalizedObservation>(o: T): T { return { ...o, id: observationIdentity(o) }; }
export function sample(id: string): NormalizedObservation {
  const d = definitions.find(d => d.id === id)!;
  const resource = resources.find(r => r.type === d.resource_type)!;
  const dims = d.scope === 'filesystem' ? { mount: '/data', device: '/dev/fixture1', fs_type: 'ext4' } : d.id === 'host.network.bytes_total' ? { interface: 'fixture0', direction: 'in' } : d.scope === 'interface' ? { if_index: '7', interface_epoch: 'boot1-port7', ...(d.id.endsWith('traffic_bps') ? { direction: 'in' } : {}) } : {};
  return identify({
    id: 'pending', stage: 'normalized', resource_type: d.resource_type, resource_id: resource.id, metric: ref(d.id), dimensions: dims as Record<string, string>,
    observed_at: fixtureTime, collected_at: fixtureTime, stored_at: '2026-09-01T00:01:02Z', unit: d.unit,
    value: d.value_type === 'uint64' ? { encoding: 'uint64', value: d.id.includes('size') ? '1073741824' : d.kind === 'counter' ? '9007199254746993' : '268435456' } : { encoding: 'float64', value: d.id.endsWith('used_ratio') ? 0.25 : d.id.endsWith('oper_up') ? 1 : d.id.endsWith('traffic_bps') ? 800 : d.id.startsWith('mysql.') ? 20 : 3600 },
    quality: { status: 'good', reason: 'none' }, accuracy: d.id.startsWith('mysql.') ? 'estimated' : 'exact', production: d.id.endsWith('used_ratio') || d.id.endsWith('traffic_bps') ? 'derived' : 'measured',
    source: { binding_id: `cb-${resource.id}`, metric_binding_id: `mb-${d.id}`, collector_id: 'fixture', attempt_id: 'attempt-1' },
    versions: { contract: '1.0.0', package_id: 'fixture', package_version: '1.0.0', transform_version: '1.0.0', config_revision: 1 },
    ...(d.kind === 'counter' ? { counter: { start_at: '2026-09-01T00:00:00Z', bits: '64' as const } } : {}),
    lineage: [{ id: `raw-${id}`, stage: 'raw' }],
  });
}
export const observations = definitions.map(d => sample(d.id));
const fsInputs = observations.filter(o => ['host.filesystem.used_bytes', 'host.filesystem.size_bytes'].includes(o.metric.id));
observations[7] = identify({ ...observations[7], lineage: fsInputs.map(o => ({ id: o.id, stage: 'normalized' as const })) });
export const rawObservation: RawObservation = identify({
  ...(() => { const { lineage: _lineage, ...o } = observations[0]; return o; })(),
  stage: 'raw', raw_field: 'Uptime',
});

observations[0] = identify({ ...observations[0], lineage: [{ id: rawObservation.id, stage: 'raw' }] });

export const invalidExamples = [
  { name: 'illegal-unit', validator: 'definition', expected: 'schema', input: { ...definitions[0], unit: 'GB' } },
  { name: 'unit-conflict', validator: 'observation', expected: 'UNIT_CONFLICT', input: { ...observations[0], unit: 'ms' } },
  { name: 'resource-identity-conflict', validator: 'observation', expected: 'OBSERVATION_IDENTITY', input: { ...observations[0], resource_type: 'server' } },
  { name: 'unknown-quality-enum', validator: 'observation', expected: 'schema', input: { ...observations[0], quality: { status: 'perfect', reason: 'none' } } },
  { name: 'incompatible-contract', validator: 'observation', expected: 'CONTRACT_VERSION', input: { ...observations[0], versions: { ...observations[0].versions, contract: '2.0.0' } } },
  { name: 'incompatible-semantics', validator: 'catalog', expected: 'IDENTITY_SEMANTIC_CONFLICT', input: [definitions[0], { ...definitions[0], semantic_version: '2.0.0', meaning: 'management subsystem uptime' }] },
];
