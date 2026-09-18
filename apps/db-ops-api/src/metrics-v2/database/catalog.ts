import type { DerivedMetric, MetricDefinition } from '../../contracts/metrics-v2/index.js';
import { canonicalDefinitions, implementationSpecs, builtinReleases } from '../packages/builtins.js';
import { PackageRegistry, sealRelease, type ImplementationSpec, type PackageRelease } from '../packages/model.js';

export type Engine = 'mysql' | 'postgresql' | 'oracle' | 'dameng';
interface Field { name: string; definition: MetricDefinition; estimated?: boolean }
export interface DatabaseRead { engine: Engine; name: string; sql: string; shape: 'status' | 'object' | 'array'; fields: Field[]; database?: boolean; cost?: 'high'; permissions: string[] }
const dimensions = (names: string[]) => ({ keys: names.map(name => ({ name, meaning: `${name} stable resource-local identity`, required: true })), max_series_per_resource: 100, max_value_length: 128, overflow: 'reject' as const });
function metric(id: string, meaning: string, unit: MetricDefinition['unit'] = 'count', counter = false, dims: string[] = []): MetricDefinition {
  return { category: 'extension', namespace: id.split('.')[0], id, semantic_version: '1.0.0', meaning, resource_type: 'instance', scope: 'resource', unit,
    kind: counter ? 'counter' : 'gauge', roles: ['diagnostic'], temporality: counter ? 'cumulative' : 'instant', monotonic: counter,
    value_type: 'uint64', dimensions: dimensions(dims), aggregation: { time: counter ? ['last', 'rate'] : ['last', 'min', 'max', 'mean'], space: ['none'], missing: 'preserve_null', min_coverage: 1, quantiles: 'not_applicable' }, lifecycle: 'active' };
}
const field = (name: string, id: string, meaning: string, unit: MetricDefinition['unit'] = 'count', counter = false, dims: string[] = []): Field => ({ name, definition: metric(id, meaning, unit, counter, dims) });
export const databaseReads: DatabaseRead[] = [
  { engine: 'mysql', name: 'connections', shape: 'object', sql: 'SELECT COUNT(*) AS connections FROM information_schema.PROCESSLIST', permissions: ['PROCESS for all sessions'], fields: [field('connections', 'mysql.processlist.count', 'Rows visible in information_schema.PROCESSLIST, including idle sessions; requires PROCESS for complete instance scope.')] },
  { engine: 'mysql', name: 'limit', shape: 'object', sql: 'SELECT @@GLOBAL.max_connections AS capacity', permissions: ['read global max_connections'], fields: [field('capacity', 'mysql.connections.limit', 'Configured MySQL max_connections; not an operating-system process limit.')] },
  { engine: 'mysql', name: 'transactions', shape: 'status', sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Com_commit', 'Com_rollback')", permissions: ['SHOW GLOBAL STATUS'], fields: [
    field('Com_commit', 'mysql.transaction_commands.commit_total', 'Com_commit explicit COMMIT commands; excludes implicit autocommit transactions.', 'count', true),
    field('Com_rollback', 'mysql.transaction_commands.rollback_total', 'Com_rollback explicit ROLLBACK commands; not all aborted transactions.', 'count', true),
  ] },
  { engine: 'mysql', name: 'size', shape: 'object', cost: 'high', sql: "SELECT SUM(data_length + index_length) AS bytes FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')", permissions: ['metadata visibility for all non-system schemas'], fields: [{ ...field('bytes', 'mysql.tables.estimated_allocated_bytes', 'Estimated data_length plus index_length across visible non-system schemas; engine allocation statistics, not logical data bytes or host disk capacity.', 'By'), estimated: true }] },
  { engine: 'postgresql', name: 'connections', shape: 'object', sql: 'SELECT COUNT(*) AS connections FROM pg_stat_activity', permissions: ['read pg_stat_activity'], fields: [field('connections', 'postgresql.activity.count', 'Cluster pg_stat_activity backend rows, including background and idle backends; not MySQL connections.')] },
  { engine: 'postgresql', name: 'limit', shape: 'object', sql: "SELECT current_setting('max_connections') AS capacity", permissions: ['read max_connections'], fields: [field('capacity', 'postgresql.connections.limit', 'Configured max_connections client connection limit; not capacity for all pg_stat_activity backend rows.')] },
  { engine: 'postgresql', name: 'transactions', shape: 'object', database: true, sql: 'SELECT datname AS database, xact_commit AS commits, xact_rollback AS rollbacks FROM pg_stat_database WHERE datname = current_database()', permissions: ['read pg_stat_database', 'driver startup and stats_reset evidence'], fields: [
    field('commits', 'postgresql.transactions.commit_total', 'Current database xact_commit, including autocommit transactions; epoch includes pg_stat_database.stats_reset.', 'count', true, ['database']),
    field('rollbacks', 'postgresql.transactions.rollback_total', 'Current database xact_rollback; epoch includes pg_stat_database.stats_reset.', 'count', true, ['database']),
  ] },
  { engine: 'postgresql', name: 'size', shape: 'object', database: true, cost: 'high', sql: 'SELECT current_database() AS database, pg_database_size(current_database()) AS bytes', permissions: ['pg_database_size for bound database'], fields: [field('bytes', 'postgresql.database.disk_bytes', 'pg_database_size of the bound current database including its physical files; not logical row size or host disk usage.', 'By', false, ['database'])] },
  { engine: 'oracle', name: 'connections', shape: 'array', sql: 'SELECT COUNT(*) FROM V$SESSION', permissions: ['SELECT V_$SESSION'], fields: [field('connections', 'oracle.sessions.count', 'V$SESSION rows including background and idle sessions in the bound Oracle container.')] },
  { engine: 'oracle', name: 'limit', shape: 'array', sql: "SELECT VALUE FROM V$PARAMETER WHERE NAME = 'processes'", permissions: ['SELECT V_$PARAMETER'], fields: [field('capacity', 'oracle.processes.limit', 'Oracle processes parameter: process limit, not session or client connection capacity.')] },
  { engine: 'oracle', name: 'transactions', shape: 'array', sql: "SELECT TO_CHAR(VALUE, 'FM99999999999999999999') FROM V$SYSSTAT WHERE NAME = 'user commits'", permissions: ['SELECT V_$SYSSTAT', 'driver instance startup evidence'], fields: [field('commits', 'oracle.transactions.commit_total', 'V$SYSSTAT user commits in the bound instance/container; excludes rollbacks.', 'count', true)] },
  { engine: 'dameng', name: 'connections', shape: 'array', sql: 'SELECT COUNT(*) FROM V$SESSIONS', permissions: ['SELECT V$SESSIONS'], fields: [field('connections', 'dameng.sessions.count', 'DM V$SESSIONS rows; not operating-system processes.')] },
  { engine: 'dameng', name: 'limit', shape: 'array', sql: "SELECT VALUE FROM V$PARAMETER WHERE NAME = 'max_sessions'", permissions: ['SELECT V$PARAMETER'], fields: [field('capacity', 'dameng.sessions.limit', 'DM max_sessions configured session capacity; no synthetic default on missing value.')] },
  { engine: 'dameng', name: 'transactions', shape: 'array', sql: "SELECT CAST(STAT_VAL AS VARCHAR(20)) FROM V$SYSSTAT WHERE NAME = 'transaction commit count'", permissions: ['SELECT V$SYSSTAT', 'driver instance startup evidence'], fields: [field('commits', 'dameng.transactions.commit_total', 'DM transaction commit count; excludes rollbacks and is not SQL execution count.', 'count', true)] },
];
// Deliberately bounded version families, matched by the existing major.minor applicability contract.
export const databaseVersions: Record<Engine, string[]> = { mysql: ['5.7', '8.0', '8.4'], postgresql: ['16.4'], oracle: ['19.3'], dameng: ['8.1'] };
export const implementationId = (read: DatabaseRead) => `builtin:database.${read.engine}.${read.name}.v1`;
export const databaseSpecs: ImplementationSpec[] = databaseReads.map(read => ({ id: implementationId(read), method: 'sql', resource_type: 'instance',
  applicability: [{ attribute: 'db.engine', values: [read.engine] }, { attribute: 'db.version', values: databaseVersions[read.engine] }],
  outputs: read.fields.map(f => ({ raw_field: f.name, definition: f.definition, input_unit: f.definition.unit })), permissions: read.permissions,
  discovery: read.database ? 'one row for the bound current database; database name required' : 'singleton in the authorized instance/container; no schema enumeration' }));
const ref = (id: string) => ({ id, semantic_version: '1.0.0' });
export function databaseReleases(): PackageRelease[] {
  return (Object.keys(databaseVersions) as Engine[]).map(engine => {
    const reads = databaseReads.filter(r => r.engine === engine), specs = databaseSpecs.filter(s => reads.some(r => implementationId(r) === s.id));
    const extensions = reads.flatMap(r => r.fields.map(f => f.definition)).filter((d): d is Extract<MetricDefinition, { category: 'extension' }> => d.category === 'extension');
    const derived: DerivedMetric[] = [];
    for (const counter of [...extensions].filter(d => d.kind === 'counter')) {
      const rate = { ...counter, id: counter.id.replace(/_total$/, '_rate'), meaning: `Per-second rate of ${counter.id}, only within a valid counter epoch.`, kind: 'gauge' as const, temporality: 'instant' as const, monotonic: false, value_type: 'float64' as const, unit: 'count/s' as const, aggregation: { ...counter.aggregation, time: ['last', 'min', 'max', 'mean'] as Array<'last' | 'min' | 'max' | 'mean'> } };
      extensions.push(rate);
      derived.push({ id: rate.id, output: ref(rate.id), inputs: [ref(counter.id)], operation: 'rate', transform_version: '1.0.0', join: 'same_resource_and_dimensions', max_skew_ms: 1000, on_missing: 'null', on_zero_denominator: 'null', quality_propagation: 'worst_input', accuracy_propagation: 'least_certain_input' });
    }
    if (engine === 'mysql' || engine === 'postgresql') {
      const prefix = engine === 'mysql' ? 'mysql.transaction_commands' : 'postgresql.transactions';
      const rates = extensions.filter(d => d.id === `${prefix}.commit_rate` || d.id === `${prefix}.rollback_rate`);
      const total = { ...rates[0], id: `${prefix}.completed_rate`, meaning: engine === 'mysql'
        ? 'Sum of separately reset-checked explicit COMMIT and ROLLBACK command rates; excludes implicit autocommit.'
        : 'Sum of separately reset-checked xact_commit and xact_rollback rates in the bound current database.' };
      extensions.push(total);
      derived.push({ id: total.id, output: ref(total.id), inputs: rates.map(d => ref(d.id)), operation: 'sum', transform_version: '1.0.0', join: 'same_resource_and_dimensions', max_skew_ms: 1000, on_missing: 'null', on_zero_denominator: 'null', quality_propagation: 'worst_input', accuracy_propagation: 'least_certain_input' });
    }
    const base = builtinReleases()[0];
    if (engine === 'mysql') { extensions.push(...base.extensions); derived.push(...base.derived); }
    return sealRelease({ package: { id: `${engine}-representative`, version: '1.0.0', contract_version: '1.0.0', digest: `sha256:${'0'.repeat(64)}`, resource_type: 'instance', applicability: specs[0].applicability,
      collectors: [...(engine === 'mysql' ? base.package.collectors : []), ...reads.map((r, i) => ({ id: `${engine}-${r.name}`, implementation_ref: specs[i].id, method: 'sql' as const, timeout_ms: 5000, estimated_cost: r.cost ?? 'low' as const,
        mappings: r.fields.map(f => ({ metric: ref(f.definition.id), raw_field: f.name, input_unit: f.definition.unit, output_unit: f.definition.unit, transform_version: '1.0.0', steps: ['decode', 'normalize'] as Array<'decode' | 'normalize'> })) }))] },
      extensions, derived, transforms: base.transforms, recommendations: base.recommendations,
      documentation: [...(engine === 'mysql' ? base.documentation : []), ...reads.map((r, i) => ({ collector_id: `${engine}-${r.name}`, permissions: specs[i].permissions, discovery: specs[i].discovery }))] });
  });
}
/** Opt-in registry for the existing PolicyService/MetricScheduler. Old package pins remain immutable. */
export function createDatabaseRegistry(): PackageRegistry {
  const registry = new PackageRegistry(canonicalDefinitions, [...implementationSpecs, ...databaseSpecs]);
  [...builtinReleases(), ...databaseReleases()].forEach(r => registry.install(r));
  return registry;
}
